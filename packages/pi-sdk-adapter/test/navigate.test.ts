import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";

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
    messageCount: 0,
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
    resolveLeafEntry: () => undefined,
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

  it("concurrent navigates are deterministic last-writer-wins (no in-flight marker needed for the quick in-memory leaf move)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    // Navigate is a quick in-memory leaf move (never blocks on a model), so
    // overlapping navigates are benign: both succeed and the final leaf is the
    // last one applied — deterministic, no corruption, no rejected sibling.
    let releases: Array<() => void> = [];
    controls.setNavigateImpl((targetId) => new Promise<void>((resolve) => {
      controls.setState({ leafId: targetId });
      releases.push(resolve);
    }));

    const first = adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = adapter.execute({ type: "navigate_tree", targetId: "entry-3" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const release of releases.splice(0)) release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    // Last writer wins deterministically: both driver calls were issued, and the
    // driver state (the source of truth) ends at the last target applied.
    assert.deepEqual(controls.navigateCalls.slice(0, 2), ["entry-2", "entry-3"]);
    assert.equal((await adapter.getSnapshot()).state.leafId, "entry-3");
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

  it("navigate while queued turns exist (streaming + non-empty steer/follow_up queue) → session_busy, no driver call", async () => {
    // Queued turns only exist while a stream is in flight (a steer/follow_up
    // on an idle session runs a turn directly). So "queued turns present"
    // implies streaming — navigate must reject session_busy and never corrupt
    // the queued turn or the running stream.
    const { driver, controls } = makeDriver({
      isStreaming: true,
      steering: [{ message: "queued steer" }],
      followUp: [{ message: "queued follow-up" }],
    });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const result = await adapter.execute({ type: "navigate_tree", targetId: "entry-2" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.navigateCalls.length, 0, "the SDK navigate must never run with queued turns + a live stream");
    // The queued turn (driver-side source of truth) must be untouched — no
    // mutation, no clear, no reorder.
    assert.equal(controls.state.steering.length, 1, "the queued turn must be untouched");
    assert.equal(controls.state.followUp.length, 1);
    assert.deepEqual(controls.state.steering[0], { message: "queued steer" });
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

  it("real-SDK navigate persistence semantics (world A): live convergence immediate; catalog diverges until the next persisted append; append lands at the navigated leaf and sessions.read/context converge; stop-without-turn loses the navigation", async () => {
    // Drives the REAL SDK SessionManager (the exact engine navigateTree calls:
    // branch(newLeafId) for a non-user target) and the REAL PiSdkSessionStore
    // (the exact catalog path sessions.read/sessions.context use). The
    // navigate-without-summarize leaf move is in-memory only; the persisted
    // file converges on the next append (a prompt turn's appendMessage), which
    // lands at the navigated leaf. This is pi-parity semantics — navigate is
    // live-convergent; stop-without-turn loses the navigation.
    type SdkMessage = Parameters<typeof SessionManager.prototype.appendMessage>[0];
    const userMsg = (content: string): SdkMessage => ({ role: "user", content, timestamp: Date.now() } as SdkMessage);
    const assistantMsg = (text: string): SdkMessage => ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "probe",
      model: "probe",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as SdkMessage);

    const agentDir = join(tmpdir(), `pix-d2nav-test-${process.pid}-${Date.now()}`);
    mkdirSync(agentDir, { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(agentDir, "agent");
    try {
      const cwdPath = join(agentDir, "workspace");
      mkdirSync(cwdPath, { recursive: true });
      const cwd = cwdPath;
      const manager = SessionManager.create(cwd);
      // Two turns exactly like the prompt loop's append step.
      manager.appendMessage(userMsg("turn 1"));
      const navigatedLeaf = manager.appendMessage(assistantMsg("a1"));
      manager.appendMessage(userMsg("turn 2"));
      const oldTail = manager.appendMessage(assistantMsg("a2"));
      const sessionId = manager.getSessionId();
      assert.equal(manager.getLeafId(), oldTail);

      // Real read-side store (sessions.read / sessions.context path).
      const store = createPiSdkSessionStore();
      let ctx = await store.readSessionContext(sessionId);
      assert.equal(ctx.leafId, oldTail, "catalog initially at the old tail");

      // (a) Live convergence is immediate: navigateTree-without-summarize moves
      //     the in-memory leaf (branch(newLeafId)).
      manager.branch(navigatedLeaf);
      assert.equal(manager.getLeafId(), navigatedLeaf, "live convergence immediate");

      // (b) Catalog divergence after navigate-without-append (honest): the
      //     persisted file still has the old tail as its last entry, so a fresh
      //     sessions.read/context open serves the PRE-navigate leaf.
      ctx = await store.readSessionContext(sessionId);
      assert.equal(ctx.leafId, oldTail, "catalog still shows the pre-navigate leaf until the next persisted append");

      // (c) Append-after-navigate (the persistence step of a prompt turn)
      //     lands at the navigated leaf and the file/catalog then converge to it.
      const newUser = manager.appendMessage(userMsg("post-navigate"));
      const entry = manager.getEntry(newUser);
      assert.equal(entry?.parentId, navigatedLeaf, "append must land at the navigated leaf");
      assert.equal(manager.getLeafId(), newUser, "live leaf advances to the appended entry");
      ctx = await store.readSessionContext(sessionId);
      assert.equal(ctx.leafId, newUser, "catalog converges to the navigated position after the append");
      const path = manager.getBranch(newUser).map((e) => e.id);
      assert.ok(path.includes(navigatedLeaf), "navigated path passes through the navigated leaf");
      assert.ok(!path.includes(oldTail), "old tail is not on the navigated path");

      // Stop-without-turn: a navigation that is never followed by an append is
      // lost on reopen (same as pi's SessionManager semantics).
      manager.branch(navigatedLeaf);
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile, "persisted session file must exist");
      const reopened = SessionManager.open(sessionFile, undefined, cwd);
      assert.notEqual(reopened.getLeafId(), navigatedLeaf, "stop-without-turn loses the in-memory navigation");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
