import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";

interface BashScenario {
  /** Delta chunks the driver streams via onChunk, in order. */
  readonly chunks: readonly string[];
  /** Authoritative accumulated output the driver resolves with. */
  readonly output: string;
  readonly exitCode?: number;
}

function makeDriver(scenario: BashScenario): PiRuntimeDriver {
  const identity = { sessionId: "bash-delta", sessionFile: "/tmp/bash-delta.jsonl", cwd: "/workspace" };
  const state: DriverState = {
    model: null,
    thinkingLevel: "off",
    systemPrompt: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    pendingMessageCount: 0,
    messages: [],
    tools: [],
    steering: [],
    followUp: [],
  };
  const listeners = new Set<DriverEventListener>();
  const unused = async () => { throw new Error("not used by the bash-delta scenario"); };
  return {
    identity,
    capabilities: RUNTIME_CAPABILITIES,
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prompt: unused,
    steer: unused,
    followUp: unused,
    abort: async () => {},
    setModel: unused,
    setThinkingLevel: () => {},
    compact: unused,
    abortCompaction: () => {},
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => RUNTIME_CAPABILITIES,
    bash: async (_command, _excludeFromContext, onChunk) => {
      for (const chunk of scenario.chunks) onChunk(chunk);
      return {
        output: scenario.output,
        ...(scenario.exitCode === undefined ? {} : { exitCode: scenario.exitCode }),
        cancelled: false,
        truncated: false,
      };
    },
    abortBash: () => {},
    navigate: unused,
    fork: unused,
    generateSessionTitle: async () => "title",
    bindUi: async (_onRequest: (request: DriverUiRequest) => void, _emit: (event: RuntimeEvent) => void) => {},
    close: async () => {},
  };
}

type BashUpdateEvent = Extract<RuntimeEvent, { type: "bash_update" }>;

function bashUpdates(events: readonly RuntimeEvent[]): BashUpdateEvent[] {
  return events.filter((event): event is BashUpdateEvent => event.type === "bash_update");
}

describe("bash_update delta semantics (R0 alignment)", () => {
  it("emits each chunk as a delta and keeps the accumulated snapshot — no double-splice", async () => {
    const adapter = new CanonicalAgentRuntimeAdapter(makeDriver({ chunks: ["a", "b"], output: "ab", exitCode: 0 }));
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    const result = await adapter.execute({ type: "bash", command: "echo ab" });
    assert.equal(result.ok, true);

    const updates = bashUpdates(events);
    // Two streaming deltas plus one completion metadata event.
    assert.equal(updates.length, 3);
    const outputs = updates.map((event) => event.output ?? "");
    // Concatenating every emitted output reconstructs exactly "ab": the
    // accumulated value is never spliced in more than once.
    assert.equal(outputs.join(""), "ab");
    // The streaming deltas are precisely the original chunks "a" and "b".
    assert.deepEqual(outputs.filter((value) => value !== ""), ["a", "b"]);
    // The completion metadata carries the terminal fields but NO output.
    const completion = updates.at(-1);
    assert.ok(completion);
    assert.equal(completion.output, undefined);
    assert.equal(completion.exitCode, 0);

    // The snapshot stays authoritative and accumulated.
    const snapshot = await adapter.getSnapshot();
    assert.equal(snapshot.state.bash?.output, "ab");
    assert.equal(snapshot.state.bash?.completed, true);
    assert.equal(snapshot.state.bash?.exitCode, 0);
    await adapter.close("user");
  });

  it("fail-closed: a divergent authoritative output is not re-emitted; the snapshot stays authoritative", async () => {
    // Streamed chunks "a","b" but the driver resolves with "XY", which does
    // NOT extend the streamed prefix "ab". The adapter must not re-emit the
    // accumulated/different output as a delta; it emits completion metadata
    // with no output and keeps the snapshot authoritative.
    const adapter = new CanonicalAgentRuntimeAdapter(makeDriver({ chunks: ["a", "b"], output: "XY", exitCode: 0 }));
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    const result = await adapter.execute({ type: "bash", command: "diverge" });
    assert.equal(result.ok, true);

    const updates = bashUpdates(events);
    const outputs = updates.map((event) => event.output ?? "");
    // Only the two streaming deltas are emitted; the divergent output is not.
    assert.deepEqual(outputs.filter((value) => value !== ""), ["a", "b"]);
    const completion = updates.at(-1);
    assert.ok(completion);
    assert.equal(completion.output, undefined);

    // The snapshot holds the authoritative divergent output.
    const snapshot = await adapter.getSnapshot();
    assert.equal(snapshot.state.bash?.output, "XY");
    assert.equal(snapshot.state.bash?.completed, true);
    await adapter.close("user");
  });

  it("emits the full output as a single delta when nothing was streamed", async () => {
    // No chunks streamed, but the driver resolves with "full". The streamed
    // prefix is empty, so the whole authoritative output is emitted once as a
    // delta (no double-splice, no loss).
    const adapter = new CanonicalAgentRuntimeAdapter(makeDriver({ chunks: [], output: "full", exitCode: 0 }));
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    const result = await adapter.execute({ type: "bash", command: "late" });
    assert.equal(result.ok, true);

    const updates = bashUpdates(events);
    const outputs = updates.map((event) => event.output ?? "");
    assert.equal(outputs.join(""), "full");
    const snapshot = await adapter.getSnapshot();
    assert.equal(snapshot.state.bash?.output, "full");
    await adapter.close("user");
  });
});
