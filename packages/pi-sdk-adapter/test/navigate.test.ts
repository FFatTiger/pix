import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

/**
 * D2 navigate adapter tests. The canonical boundary must:
 *  - run navigate only on an idle session (in-flight prompt / bash / compaction
 *    / adapter-local compaction / pending extension-UI wait → structured
 *    `session_busy`, no SDK call, no events, no partial state),
 *  - reject blank/missing target as structured `invalid_input` BEFORE any SDK
 *    call,
 *  - surface the authoritative leaf id from the driver state in the snapshot
 *    (navigate convergence read-through),
 *  - fail closed (no false success) when the driver reports navigation
 *    cancelled / an unknown target,
 *  - stay capability-gated: without `runtime.navigate` the gate answers
 *    `unsupported_capability` and never calls the driver.
 */

interface DriverControls {
  readonly state: DriverState;
  readonly navigateCalls: string[];
  setNavigateImpl(impl: (targetId: string) => Promise<void>): void;
  setState(patch: Partial<DriverState>): void;
  emitDriver(event: unknown): void;
}

function makeDriver(
  overrides: Partial<DriverState> = {},
  capabilities: readonly string[] = RUNTIME_CAPABILITIES,
): { driver: PiRuntimeDriver; controls: DriverControls } {
  const identity = { sessionId: "navigate-test", sessionFile: "/tmp/navigate-test.jsonl", cwd: "/workspace" };
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
  const navigateCalls: string[] = [];
  let navigateImpl: (targetId: string) => Promise<void> = async () => {};
  const context = {
    emit: (event: unknown) => { for (const listener of [...listeners]) listener(structuredClone(event)); },
  };
  const unused = async () => { throw new Error("not used by the navigate scenario"); };
  const driver: PiRuntimeDriver = {
    identity,
    capabilities: capabilities as never,
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
    reload: async () => capabilities as never,
    bash: unused as never,
    abortBash: () => {},
    navigate: (targetId) => { navigateCalls.push(targetId); return navigateImpl(targetId); },
    fork: unused,
    generateSessionTitle: async () => "title",
    bindUi: async () => {},
    close: async () => {},
  };
  return {
    driver,
    controls: {
      state,
      navigateCalls,
      setNavigateImpl(impl) { navigateImpl = impl; },
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

describe("adapter navigate busy guard + convergence (D2 navigate)", () => {
  it("navigate on an idle session succeeds, reaches the driver with the exact target, emits a state change, and the snapshot carries the new leaf id", async () => {
    const { driver, controls } = makeDriver({ leafId: "entry-1" });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.setState({ leafId: "entry-3" });

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-3" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.type, "navigate_tree");
    assert.deepEqual(controls.navigateCalls, ["entry-3"], "driver must receive the exact targetId");
    assert.equal(events.filter((e) => e.type === "runtime_state_changed").length, 1, "navigate success must emit a state change");

    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.leafId, "entry-3", "snapshot must carry the authoritative leaf id after navigate");
  });

  it("navigate while the driver is streaming (in-flight prompt) → session_busy, no driver call, no events, no partial state", async () => {
    const { driver, controls } = makeDriver({ isStreaming: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "navigate_tree");
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.navigateCalls.length, 0, "the SDK navigate must never run while a prompt is in flight");
    assert.deepEqual(events, [], "no events may be emitted on rejection");
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.leafId, undefined, "no partial leaf mutation on rejection");
  });

  it("navigate while a bash command is running → session_busy, no driver call", async () => {
    const { driver, controls } = makeDriver({ isBashRunning: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.navigateCalls.length, 0, "the SDK navigate must never overlap an active bash command");
  });

  it("navigate while the driver is compacting → session_busy, no driver call", async () => {
    const { driver, controls } = makeDriver({ isCompacting: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.navigateCalls.length, 0);
  });

  it("navigate while an adapter-local compaction is in flight → session_busy, no driver call", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    // Adapter-local compaction marker (real compact in flight, driver state not
    // yet flipping) — navigate must reject on the adapter-local marker too.
    controls.emitDriver({ type: "compaction_start", sessionId: "navigate-test", reason: "manual" });
    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.navigateCalls.length, 0, "the SDK navigate must never overlap an in-flight compaction");
    // Clean up the adapter-local compaction marker.
    controls.emitDriver({ type: "compaction_end", sessionId: "navigate-test", reason: "manual" });
  });

  it("navigate with a blank/missing target → invalid_input BEFORE any SDK call", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    for (const targetId of ["", "   "]) {
      const result = await adapter.execute({ type: "navigate_tree", targetId });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.type, "navigate_tree");
        assert.equal(result.error.code, "invalid_input");
        assert.equal(result.error.retryable, false);
      }
    }
    assert.equal(controls.navigateCalls.length, 0, "blank target must never reach the driver");
  });

  it("navigate driver failure (navigation cancelled / unknown target) maps to a structured sanitized failure, never false success", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    controls.setNavigateImpl(async () => { throw new Error("navigation cancelled"); });

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-9" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "navigate_tree");
      assert.equal(result.error.code, "interrupted");
      assert.equal(result.error.retryable, false);
      // Fixed sanitized message — never the raw SDK text (which carries the
      // target id / path / transport internals).
      assert.equal(result.error.message, "navigation was cancelled");
      assert.ok(!result.error.message.includes("entry-9"), "no raw leaf id in the error message");
      assert.ok(!/\n|\tat |node:internal/i.test(result.error.message), "no raw stack text");
    }
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.leafId, undefined, "failed navigate must not mutate the snapshot");
  });

  it("navigate driver unknown target → structured invalid_input with a fixed sanitized message (no raw leaf id)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    controls.setNavigateImpl(async () => { throw new Error("Entry entry-9 not found"); });

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-9" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_input");
      assert.equal(result.error.message, "navigation target is invalid");
      assert.ok(!result.error.message.includes("entry-9"), "no raw leaf id in the error message");
    }
    assert.equal(controls.navigateCalls.length, 1);
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.leafId, undefined, "failed navigate must not mutate the snapshot");
  });

  it("snapshot carries the authoritative leaf id from driver state", async () => {
    const { driver } = makeDriver({ leafId: "entry-4" });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.leafId, "entry-4");
  });

  it("closed capability (runtime.navigate absent) → unsupported_capability, zero adapter/driver calls", async () => {
    const caps = RUNTIME_CAPABILITIES.filter((c) => c !== "runtime.navigate");
    const { driver, controls } = makeDriver({}, caps);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-1" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "unsupported_capability");
      assert.match(result.error.message, /runtime\.navigate/);
    }
    assert.equal(controls.navigateCalls.length, 0, "closed capability must never reach the driver");
    assert.deepEqual(events, [], "no events on a capability-gated rejection");
  });

  it("navigate while a prompt is blocked on an extension-UI wait (adapter promptRunning) → session_busy; the prompt continues to completion", async () => {
    const { driver, controls } = makeDriver({ isStreaming: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    // Drive a real adapter in-flight prompt that never settles until released:
    // execute() sets promptRunning while driver.prompt is awaited, which is the
    // exact state during an extension-UI wait.
    let releasePrompt: (() => void) | undefined;
    (driver as { prompt: (m: string) => Promise<void> }).prompt = () => new Promise<void>((resolve) => { releasePrompt = resolve; });
    const promptPromise = adapter.execute({ type: "prompt", message: "blocked" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.navigateCalls.length, 0, "navigate must never run concurrently with an in-flight prompt (extension-UI wait)");

    releasePrompt!();
    const promptResult = await promptPromise;
    assert.equal(promptResult.ok, true, "the blocked prompt must continue to completion");
  });

  it("read-after-navigate: the session-store context resolves to the navigated leaf (sessions.read/context convergence)", async () => {
    const store = new ScriptedSdkStore();
    const factory = new ScriptedSdkDriverFactory(store, { cwd: "/workspace" });
    const driver = await factory.create({ cwd: "/workspace" }, { capabilities: RUNTIME_CAPABILITIES });
    const sessionId = driver.identity.sessionId;
    // Build a 2-turn history (entries: user1, assistant1, user2, assistant2).
    await driver.prompt("hello");
    await driver.prompt("world");
    const ctxBefore = await store.readSessionContext(sessionId);
    assert.ok(ctxBefore.leafId, "the live leaf must be present");
    const lastLeaf = ctxBefore.leafId!;
    const firstEntryId = store.sessions.get(sessionId)!.entries[0]!.entryId;
    assert.notEqual(firstEntryId, lastLeaf, "the earlier leaf must differ from the current leaf");

    // Navigate back to the earlier leaf: the read-side catalog (same shared
    // store that backs sessions.read/sessions.context) must immediately resolve
    // to the navigated leaf — no stale leaf served after success.
    await driver.navigate(firstEntryId);
    const ctxAfter = await store.readSessionContext(sessionId);
    assert.equal(ctxAfter.leafId, firstEntryId, "read-after-navigate must resolve to the navigated leaf");
    await driver.close("user");
  });
});
