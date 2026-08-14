import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";

/**
 * D2-P7 adapter compact busy-guard tests. The canonical boundary must reject a
 * manual compact with a structured `session_busy` BEFORE any state mutation or
 * SDK call when the real driver state is streaming, bash running, or already
 * compacting — and must never leave partial compaction state/events behind.
 */

interface DriverControls {
  readonly state: DriverState;
  readonly compactCalls: (string | undefined)[];
  readonly context: {
    abortCompactionCalled: boolean;
    emit(event: unknown): void;
  };
  setCompactImpl(impl: (customInstructions?: string) => Promise<unknown>): void;
  setBashImpl(impl: (command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void) => Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }>): void;
  setState(patch: Partial<DriverState>): void;
  emitDriver(event: unknown): void;
}

function makeDriver(overrides: Partial<DriverState> = {}): { driver: PiRuntimeDriver; controls: DriverControls } {
  const identity = { sessionId: "compact-busy", sessionFile: "/tmp/compact-busy.jsonl", cwd: "/workspace" };
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
    ...overrides,
  };
  const listeners = new Set<DriverEventListener>();
  const compactCalls: (string | undefined)[] = [];
  let compactImpl: (customInstructions?: string) => Promise<unknown> = async () => {};
  let bashImpl: (command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void) => Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }> = async () => ({ output: "", exitCode: 0 });
  const context = {
    abortCompactionCalled: false,
    emit: (event: unknown) => { for (const listener of [...listeners]) listener(structuredClone(event)); },
  };
  const unused = async () => { throw new Error("not used by the compact-busy scenario"); };
  const driver: PiRuntimeDriver = {
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
    compact: (customInstructions) => { compactCalls.push(customInstructions); return compactImpl(customInstructions); },
    abortCompaction: () => { context.abortCompactionCalled = true; },
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => RUNTIME_CAPABILITIES,
    bash: (command, excludeFromContext, onChunk) => bashImpl(command, excludeFromContext, onChunk),
    abortBash: () => {},
    navigate: unused,
    fork: unused,
    generateSessionTitle: async () => "title",
    bindUi: async () => {},
    close: async () => {},
  };
  return {
    driver,
    controls: {
      state,
      compactCalls,
      context,
      setCompactImpl(impl) { compactImpl = impl; },
      setBashImpl(impl) { bashImpl = impl; },
      setState(patch) { Object.assign(state, patch); },
      emitDriver(event) { context.emit(event); },
    },
  };
}

async function collectEvents(adapter: CanonicalAgentRuntimeAdapter): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return events;
}

describe("adapter manual compact busy guard (D2-P7)", () => {
  it("rejects compact while the driver is streaming — session_busy, no SDK call, no events, no partial state", async () => {
    const { driver, controls } = makeDriver({ isStreaming: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "compact", customInstructions: "keep decisions" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "compact");
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.compactCalls.length, 0, "the SDK compact must never be called while streaming");
    assert.deepEqual(events, [], "no compaction_start/end may be emitted on rejection");

    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false, "no pending compaction in the snapshot");
    assert.equal(snap.state.compaction, undefined, "no partial compaction projection on rejection");
  });

  it("rejects compact while a bash command is running — session_busy, no SDK call, no events", async () => {
    const { driver, controls } = makeDriver({ isBashRunning: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "compact" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.compactCalls.length, 0, "the SDK compact must never overlap bash via direct wire");
    assert.deepEqual(events, []);
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false);
    assert.equal(snap.state.compaction, undefined);
  });

  it("rejects compact while the driver is already compacting — session_busy, no SDK call", async () => {
    const { driver, controls } = makeDriver({ isCompacting: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const result = await adapter.execute({ type: "compact" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.compactCalls.length, 0, "the SDK compact must never overlap an existing compaction");
  });

  it("rejects a second compact while an adapter-local compaction is in flight — session_busy, one SDK call", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    let release: (() => void) | undefined;
    controls.setCompactImpl(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = adapter.execute({ type: "compact" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await adapter.execute({ type: "compact" });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.error.code, "session_busy");
      assert.equal(second.error.retryable, true);
    }
    assert.equal(controls.compactCalls.length, 1, "only the first compact may reach the SDK");
    release!();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false);
  });

  it("a failed compact clears the running marker — structured failure, snapshot isCompacting:false, no pending compaction", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    // Real SDK failure shape: a thrown error (nothing to compact / external)
    // WITHOUT a compaction_end event. The adapter must project a structured
    // failure and clear the local running marker so the snapshot never claims a
    // pending compaction.
    controls.setCompactImpl(async () => { throw new Error("Nothing to compact"); });

    const result = await adapter.execute({ type: "compact" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "compact");
      assert.equal(typeof result.error.code, "string");
      assert.equal(typeof result.error.message, "string");
      // Structured, sanitized — never a raw stack/class dump or secret.
      assert.ok(!result.error.message.includes("sk-"), "no secret-shaped raw leak");
      assert.ok(!/\n|\tat |node:internal/i.test(result.error.message), "no raw stack text");
    }
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false, "failed compact must leave isCompacting:false");
    assert.equal(snap.state.compaction, undefined, "no pending compaction after failed compact");
    assert.deepEqual(events, [], "no compaction events on a failed compact");
  });

  it("passes customInstructions through to the SDK exactly (no trim/reinterpret)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    controls.setCompactImpl(async () => {});
    const custom = "  keep decisions  \n  and notes  ";
    const result = await adapter.execute({ type: "compact", customInstructions: custom });
    assert.equal(result.ok, true);
    assert.deepEqual(controls.compactCalls, [custom], "customInstructions must reach the SDK unchanged");
  });

  it("idle abort_compaction is an idempotent supported no-op", async () => {
    const { driver } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const a = await adapter.interrupt({ type: "abort_compaction" });
    const b = await adapter.interrupt({ type: "abort_compaction" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok) assert.equal(a.type, "abort_compaction");
    if (b.ok) assert.equal(b.type, "abort_compaction");
  });

  it("successful compact resolves ok and clears the compaction projection", async () => {
    const { driver } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "compact" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.type, "compact");
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false);
    assert.equal(snap.state.compaction, undefined);
    assert.ok(events.every((event) => event.type !== "compaction_start"), "no spurious compaction events");
  });

  it("a COMPLETED terminal bash does NOT block compact — the compact reaches the SDK (F1 fix)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    controls.setBashImpl(async () => ({ output: "done\n", exitCode: 0 }));
    const bashResult = await adapter.execute({ type: "bash", command: "echo hi" });
    assert.equal(bashResult.ok, true);
    // The terminal bash projection is retained forever (completed:true).
    const afterBash = await adapter.getSnapshot();
    assert.equal(afterBash.state.bash?.completed, true, "terminal bash projection retained");
    assert.equal(afterBash.state.isBashRunning, false);

    // compact must NOT be session_busy — it must reach the SDK exactly once.
    const compactResult = await adapter.execute({ type: "compact" });
    assert.equal(controls.compactCalls.length, 1, "compact must reach the SDK after a completed bash (F1 fix)");
    assert.equal(compactResult.ok, true, JSON.stringify(compactResult));
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false);
    assert.equal(snap.state.compaction, undefined);
  });

  it("an in-flight NONTERMINAL bash projection blocks compact even before the driver state flips (F1 fix)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    let releaseBash: (() => void) | undefined;
    controls.setBashImpl(() => new Promise<{ output: string; exitCode: number }>((resolve) => { releaseBash = () => resolve({ output: "", exitCode: 0 }); }));
    const bashP = adapter.execute({ type: "bash", command: "sleep 1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Driver state still idle (real SDK not yet flipped) but the adapter holds a
    // nonterminal bash projection — direct concurrent bash-vs-compact must be
    // rejected with zero SDK compact calls.
    const result = await adapter.execute({ type: "compact" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.compactCalls.length, 0, "the SDK compact must never overlap an in-flight bash");
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false);
    assert.equal(snap.state.compaction, undefined);
    releaseBash!();
    await bashP;
  });

  it("abort_compaction + thrown compact without an SDK end clears BOTH running/aborting and emits one synthetic end (F2 fix)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    let releaseCompact: ((value: unknown) => void) | undefined;
    controls.setCompactImpl(() => new Promise<unknown>((resolve, reject) => {
      // Realistic SDK: emit compaction_start, then hold until abort.
      controls.emitDriver({ type: "compaction_start", reason: "manual" });
      releaseCompact = (value) => {
        if (controls.context.abortCompactionCalled) reject(new Error("compaction aborted"));
        else resolve(value);
      };
    }));

    const compactP = adapter.execute({ type: "compact" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const abort = await adapter.interrupt({ type: "abort_compaction" });
    assert.equal(abort.ok, true, JSON.stringify(abort));
    if (abort.ok) assert.equal(abort.type, "abort_compaction");
    releaseCompact!(undefined);
    const result = await compactP;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "compact");
      assert.equal(result.error.code, "interrupted", "compact result preserved as interrupted");
    }
    // Adapter snapshot MUST NOT remain compacting (status aborting cleared).
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false, "snapshot must not remain compacting after aborted compact without an SDK end");
    assert.equal(snap.state.compaction, undefined, "no pending compaction projection");
    // One start forwarded + exactly one synthetic end (clears the sessiond/
    // client-facing projection), aborted:true, no duplicate end.
    const starts = events.filter((event) => event.type === "compaction_start");
    const ends = events.filter((event) => event.type === "compaction_end");
    assert.equal(starts.length, 1, "compaction_start forwarded once");
    assert.equal(ends.length, 1, "exactly one compaction_end emitted (synthetic, no duplicate)");
    assert.equal((ends[0] as { aborted?: boolean }).aborted, true);
  });

  it("an SDK compaction_start+end sequence does NOT double-emit a synthetic end (F2 fix)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.setCompactImpl(async () => {
      controls.emitDriver({ type: "compaction_start", reason: "manual" });
      controls.emitDriver({ type: "compaction_end", reason: "manual", aborted: false });
    });

    const result = await adapter.execute({ type: "compact" });
    assert.equal(result.ok, true);
    const starts = events.filter((event) => event.type === "compaction_start");
    const ends = events.filter((event) => event.type === "compaction_end");
    assert.equal(starts.length, 1, "compaction_start forwarded once");
    assert.equal(ends.length, 1, "SDK compaction_end must not be doubled by the finally cleanup");
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.isCompacting, false);
    assert.equal(snap.state.compaction, undefined);
  });
});
