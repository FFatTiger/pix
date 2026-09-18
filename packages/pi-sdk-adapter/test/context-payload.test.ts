import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type {
  DriverContextState,
  DriverEventListener,
  DriverState,
  PiRuntimeDriver,
} from "../src/internal/types.js";

// ---------------------------------------------------------------------------
// Context-usage consistency — adapter event publication.
//
// `runtime_state_changed` must carry the ATOMIC {model, leafId, contextUsage}
// payload (from ONE driver getContextState read) exactly at the transitions
// where the committed truth changed: a set_model, the microtask that resolved
// a committed message_end, a compaction terminal, and committed bash
// terminals. A driver without the accessor stays signal-only. This is the
// event-publication replacement for the old "fresh stats beat stale snapshot"
// precedence: the projection is updated by EVENTS, never by polling.
// ---------------------------------------------------------------------------

interface Controls {
  emitDriver(event: unknown): void;
  setModel(provider: string, id: string): void;
  setLeafEntry(entry: { entryId: string; parentEntryId?: string } | undefined): void;
  setContextState(context: DriverContextState | undefined): void;
}

function makeDriver(withContextState: boolean): { driver: PiRuntimeDriver; controls: Controls } {
  const identity = { sessionId: "ctx-payload", sessionFile: "/tmp/ctx.jsonl", cwd: "/workspace" };
  let model: { provider: string; id: string } | null = { provider: "acme-gpt", id: "gpt-6-astra" };
  let leafEntry: { entryId: string; parentEntryId?: string } | undefined;
  let contextState: DriverContextState | undefined = {
    model: { provider: "acme-gpt", id: "gpt-6-astra" },
    leafId: "entry-1",
    contextUsage: { percent: 79.6358, contextWindow: 1_050_000, tokens: 836_176 },
  };
  const state = (): DriverState => ({
    model,
    thinkingLevel: "off",
    systemPrompt: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    pendingMessageCount: 0,
    messageCount: 1,
    leafId: "entry-1",
    tools: [],
    steering: [],
    followUp: [],
  });
  const listeners = new Set<DriverEventListener>();
  const driver: PiRuntimeDriver = {
    identity,
    capabilities: RUNTIME_CAPABILITIES,
    getState: state,
    getTools: () => [],
    getCommands: () => [],
    getSessionStats: () => undefined,
    getLastAssistantText: () => "",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    setModel: async (next) => { model = { provider: next.provider, id: next.id }; },
    setThinkingLevel: () => {},
    compact: async () => ({}),
    abortCompaction: () => {},
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => RUNTIME_CAPABILITIES,
    bash: async () => ({ output: "", exitCode: 0 }),
    abortBash: () => {},
    resolveLeafEntry: (expectedRole?: string) =>
      expectedRole === "assistant" || expectedRole === "user" || expectedRole === "bashExecution" ? leafEntry : undefined,
    navigate: async () => {},
    fork: async () => ({ sessionId: "forked", sessionFile: "/tmp/forked.jsonl" }),
    generateSessionTitle: async () => "title",
    bindUi: async () => {},
    close: async () => {},
  };
  if (withContextState) driver.getContextState = () => contextState as DriverContextState;
  return {
    driver,
    controls: {
      emitDriver(event) { for (const listener of [...listeners]) listener(structuredClone(event)); },
      setModel(provider, id) { model = { provider, id }; },
      setLeafEntry(entry) { leafEntry = entry; },
      setContextState(context) { contextState = context; },
    },
  };
}

function stateChanged(events: readonly RuntimeEvent[]) {
  return events.filter((event): event is Extract<RuntimeEvent, { type: "runtime_state_changed" }> =>
    event.type === "runtime_state_changed");
}

/** Flush the message_end structural-correlation microtask. */
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("adapter runtime_state_changed context payload publication", () => {
  it("set_model success publishes the NEW coherent payload (model + usage from ONE read)", async () => {
    const { driver, controls } = makeDriver(true);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    controls.setContextState({
      model: { provider: "deepseek-official", id: "deepseek-v4-flash" },
      leafId: "entry-7",
      contextUsage: { percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711 },
    });
    const result = await adapter.execute({ type: "set_model", provider: "deepseek-official", modelId: "deepseek-v4-flash" });
    assert.equal(result.ok, true);

    const changed = stateChanged(events);
    assert.equal(changed.length, 1, "exactly one runtime_state_changed for the set_model");
    assert.deepEqual(changed[0]!.context, {
      model: { provider: "deepseek-official", id: "deepseek-v4-flash" },
      leafId: "entry-7",
      contextUsage: { percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711 },
    });
  });

  it("the committed message_end microtask is followed by a payload event (usage advances with the leaf, no polling)", async () => {
    const { driver, controls } = makeDriver(true);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    controls.setLeafEntry({ entryId: "entry-2", parentEntryId: "entry-1" });
    controls.setContextState({
      model: { provider: "acme-gpt", id: "gpt-6-astra" },
      leafId: "entry-2",
      contextUsage: { percent: 81.2, contextWindow: 1_050_000, tokens: 852_600 },
    });
    controls.emitDriver({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    await flushMicrotasks();

    const endIdx = events.findIndex((event) => event.type === "message_end");
    assert.notEqual(endIdx, -1);
    assert.equal(events[endIdx]!.type === "message_end" && events[endIdx].entryId, "entry-2");
    const changed = stateChanged(events);
    assert.equal(changed.length, 1, "one payload event after the committed completion");
    assert.ok(endIdx < events.indexOf(changed[0]!), "payload follows the committed message_end");
    assert.equal(changed[0]!.context?.leafId, "entry-2");
    assert.equal(changed[0]!.context?.contextUsage?.tokens, 852_600);
  });

  it("a compaction terminal publishes session_changed AND the clearing payload (unknown clears the old percentage)", async () => {
    const { driver, controls } = makeDriver(true);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    controls.setContextState({
      model: { provider: "acme-gpt", id: "gpt-6-astra" },
      leafId: "entry-compacted",
      contextUsage: null,
    });
    controls.emitDriver({ type: "compaction_end", reason: "manual", result: "ok" });

    const endIdx = events.findIndex((event) => event.type === "compaction_end");
    const changedIdx = events.findIndex((event) => event.type === "runtime_state_changed");
    assert.ok(endIdx !== -1 && changedIdx !== -1 && endIdx < changedIdx);
    const changed = stateChanged(events);
    assert.equal(changed[0]!.context?.contextUsage, null);
    assert.equal(changed[0]!.context?.leafId, "entry-compacted");
  });

  it("a committed bash terminal publishes ONE payload event after the terminal frame (usage advances with the leaf)", async () => {
    const { driver, controls } = makeDriver(true);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    controls.setLeafEntry({ entryId: "bash-entry-1", parentEntryId: "entry-7" });
    controls.setContextState({
      model: { provider: "acme-gpt", id: "gpt-6-astra" },
      leafId: "bash-entry-1",
      contextUsage: { percent: 27, contextWindow: 1_050_000, tokens: 283_500 },
    });
    // isStreaming stays false → the terminal publishes immediately after the
    // bash command settles (the committed-entry correlation is resolvable).
    const result = await adapter.execute({ type: "bash", command: "pwd" });
    assert.equal(result.ok, true);
    await flushMicrotasks();

    const bashTerminals = events.filter((event) => event.type === "bash_update");
    assert.equal(bashTerminals.length > 0, true, "a terminal bash_update was published");
    const changed = stateChanged(events);
    assert.equal(changed.length, 1, "exactly one payload event after the committed bash terminal");
    assert.equal(changed[0]!.context?.leafId, "bash-entry-1");
    assert.equal(changed[0]!.context?.contextUsage?.tokens, 283_500);
  });

  it("a driver without getContextState keeps runtime_state_changed signal-only", async () => {
    const { driver, controls } = makeDriver(false);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events: RuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    const result = await adapter.execute({ type: "set_model", provider: "p", modelId: "m" });
    assert.equal(result.ok, true);
    const changed = stateChanged(events);
    assert.equal(changed.length, 1);
    assert.equal("context" in changed[0]!, false);
    void controls;
  });
});
