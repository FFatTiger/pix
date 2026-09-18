import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";

/**
 * Model-mutation admission barrier tests (multi-tab set_model vs submitTurn
 * race). A plain set_model that already passed the turn-busy guard is awaiting
 * driver.setModel(); a submitTurn arriving in that window must fail CLOSED
 * with session_busy (never admit and interleave its activation-override model
 * application against the in-flight mutation), and vice versa a turn admitted
 * into its override window must reject plain model/thinking mutations. The
 * barrier is per-adapter (per-runtime), never global, and never blocks the
 * independent interrupt/stop control channel.
 */

interface DriverControls {
  /** Resolves when the driver receives the call (deterministic gate reached). */
  readonly setModelStarted: () => Promise<void>;
  readonly setThinkingStarted: () => Promise<void>;
  readonly promptStarted: () => Promise<void>;
  readonly setModelCalls: { provider: string; id: string }[];
  readonly setThinkingCalls: string[];
  /** Model identity captured at driver.prompt() call time (what the turn ran on). */
  readonly promptModels: ({ provider: string; id: string } | null)[];
  releaseNextSetModel(error?: Error): void;
  releaseNextSetThinking(): void;
  releaseNextPrompt(): void;
  setState(patch: Partial<DriverState>): void;
}

function makeDriver(): { driver: PiRuntimeDriver; controls: DriverControls } {
  const identity = { sessionId: "model-barrier", sessionFile: "/tmp/model-barrier.jsonl", cwd: "/workspace" };
  const state: DriverState = {
    model: { provider: "anthropic", id: "claude-sonnet-4" },
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
  };
  const listeners = new Set<DriverEventListener>();
  const setModelCalls: { provider: string; id: string }[] = [];
  const setThinkingCalls: string[] = [];
  const promptModels: ({ provider: string; id: string } | null)[] = [];
  const setModelWaiters: (() => void)[] = [];
  const setThinkingWaiters: (() => void)[] = [];
  const promptWaiters: (() => void)[] = [];
  const setModelGates: ((error?: Error) => void)[] = [];
  const setThinkingGates: (() => void)[] = [];
  const promptGates: (() => void)[] = [];
  let disposed = false;
  const unused = async () => { throw new Error("not used by the model-barrier scenario"); };
  const driver: PiRuntimeDriver = {
    identity,
    capabilities: RUNTIME_CAPABILITIES,
    getState: () => {
      // Mirror the real SDK driver: state reads after dispose throw.
      if (disposed) throw new Error("driver disposed");
      return state;
    },
    getTools: () => state.tools ?? [],
    getCommands: () => state.commands ?? [],
    getSessionStats: () => state.sessionStats,
    getLastAssistantText: () => state.lastAssistantText ?? "",
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prompt: () => {
      promptModels.push(state.model === null ? null : { provider: state.model.provider, id: state.model.id });
      setImmediate(() => { for (const waiter of promptWaiters.splice(0)) waiter(); });
      return new Promise<void>((resolve) => { promptGates.push(resolve); });
    },
    steer: unused,
    followUp: unused,
    abort: async () => {},
    setModel: (model) => {
      setModelCalls.push({ provider: model.provider, id: model.id });
      setImmediate(() => { for (const waiter of setModelWaiters.splice(0)) waiter(); });
      return new Promise<void>((resolve, reject) => {
        setModelGates.push((error) => {
          if (error) reject(error);
          else {
            state.model = { provider: model.provider, id: model.id };
            state.thinkingLevel = "off";
            resolve();
          }
        });
      });
    },
    // Typed `void` on the driver interface; returns a thenable in this fake so
    // the adapter's `await` genuinely suspends (deterministic in-flight window).
    setThinkingLevel: (level) => {
      setThinkingCalls.push(level);
      setImmediate(() => { for (const waiter of setThinkingWaiters.splice(0)) waiter(); });
      return new Promise<void>((resolve) => {
        setThinkingGates.push(() => { state.thinkingLevel = level as typeof state.thinkingLevel; resolve(); });
      });
    },
    compact: async () => {},
    abortCompaction: () => {},
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => RUNTIME_CAPABILITIES,
    bash: unused,
    abortBash: () => {},
    resolveLeafEntry: () => undefined,
    navigate: unused,
    fork: unused,
    generateSessionTitle: async () => "title",
    bindUi: async () => {},
    close: async () => { disposed = true; },
  };
  return {
    driver,
    controls: {
      setModelStarted: () => new Promise<void>((resolve) => { setModelWaiters.push(resolve); }),
      setThinkingStarted: () => new Promise<void>((resolve) => { setThinkingWaiters.push(resolve); }),
      promptStarted: () => new Promise<void>((resolve) => { promptWaiters.push(resolve); }),
      setModelCalls,
      setThinkingCalls,
      promptModels,
      releaseNextSetModel(error) { setModelGates.shift()?.(error); },
      releaseNextSetThinking() { setThinkingGates.shift()?.(); },
      releaseNextPrompt() { promptGates.shift()?.(); },
      setState(patch) { Object.assign(state, patch); },
    },
  };
}

const MODEL_A = { provider: "openai", id: "gpt-5" } as const;
const MODEL_B = { provider: "anthropic", id: "claude-opus-4" } as const;

describe("adapter model-mutation admission barrier", () => {
  it("plain set_model in flight → submitTurn with model override fails closed session_busy with zero prompts; retry after release runs on the override model", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    // Tab 1: plain set_model B admitted, now awaiting the (deferred) driver gate.
    const setModelP = adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    await controls.setModelStarted();
    assert.equal(controls.setModelCalls.length, 1);

    // Tab 2: submitTurn with an activation override must NOT be admitted while
    // the plain mutation is in flight — an admitted turn would apply its
    // override against the same driver lane and the ordering of the two model
    // writes becomes nondeterministic (the "ran under the wrong model" defect).
    const busy = await adapter.submitTurn({ prompt: "hi", activationOverrides: { model: { provider: MODEL_A.provider, modelId: MODEL_A.id } } });
    assert.equal(busy.admission.ok, false, "submitTurn must fail closed while a plain set_model is in flight");
    if (!busy.admission.ok) {
      assert.equal(busy.admission.error.code, "session_busy");
      assert.equal(busy.admission.error.retryable, true);
    }
    const busyTerminal = await busy.completion;
    assert.equal(busyTerminal.ok, false);
    assert.equal(controls.promptModels.length, 0, "no prompt may launch from the rejected turn");
    assert.deepEqual(controls.setModelCalls, [{ provider: MODEL_B.provider, id: MODEL_B.id }], "only the plain mutation reached the driver");

    // Release the plain set_model; it settles ok and clears the barrier.
    controls.releaseNextSetModel();
    assert.equal((await setModelP).ok, true);

    // Retry as a NEW operation: admitted, and the prompt actually runs on A.
    const handleP = adapter.submitTurn({ prompt: "hi", activationOverrides: { model: { provider: MODEL_A.provider, modelId: MODEL_A.id } } });
    await controls.setModelStarted();
    controls.releaseNextSetModel();
    const handle = await handleP;
    assert.equal(handle.admission.ok, true, "after the mutation settles a fresh submitTurn must be admitted");
    if (handle.admission.ok) {
      assert.equal(handle.admission.snapshot.state.model?.provider, MODEL_A.provider);
      assert.equal(handle.admission.snapshot.state.model?.id, MODEL_A.id);
    }
    await controls.promptStarted();
    assert.deepEqual(controls.promptModels, [{ provider: MODEL_A.provider, id: MODEL_A.id }], "the turn must prompt under the override model");
    controls.releaseNextPrompt();
    const terminal = await handle.completion;
    assert.equal(terminal.ok, true);
    assert.equal(terminal.snapshot.state.model?.id, MODEL_A.id);

    await adapter.close("user");
  });

  it("reverse: a turn admitted into its model-override window rejects a plain set_model with session_busy", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    // Tab 1: submitTurn with override A — admitted, awaiting the driver gate
    // inside the admission barrier (turnAdmissionBusy held).
    const handleP = adapter.submitTurn({ prompt: "hi", activationOverrides: { model: { provider: MODEL_A.provider, modelId: MODEL_A.id } } });
    await controls.setModelStarted();

    // Tab 2: plain set_model B must fail closed while the turn's override
    // application is in flight.
    const result = await adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    assert.equal(result.ok, false, "plain set_model must fail closed while a turn override is being applied");
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.deepEqual(controls.setModelCalls, [{ provider: MODEL_A.provider, id: MODEL_A.id }], "only the turn's override reached the driver");

    controls.releaseNextSetModel();
    const handle = await handleP;
    assert.equal(handle.admission.ok, true);
    await controls.promptStarted();
    controls.releaseNextPrompt();
    const terminal = await handle.completion;
    assert.equal(terminal.ok, true);
    assert.deepEqual(controls.promptModels, [{ provider: MODEL_A.provider, id: MODEL_A.id }]);

    await adapter.close("user");
  });

  it("plain set_thinking_level is inside the same barrier (model changes clamp/reset thinking)", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    // A plain thinking set in flight must also block turn admission: the
    // turn's model override resets/clamps thinking (reapplyPinnedThinking),
    // so interleaving the two writes races the effective thinking level.
    const thinkingP = adapter.execute({ type: "set_thinking_level", level: "high" });
    await controls.setThinkingStarted();
    const busy = await adapter.submitTurn({ prompt: "hi" });
    assert.equal(busy.admission.ok, false, "submitTurn must fail closed while a plain thinking mutation is in flight");
    if (!busy.admission.ok) assert.equal(busy.admission.error.code, "session_busy");
    assert.equal(controls.promptModels.length, 0);
    controls.releaseNextSetThinking();
    assert.equal((await thinkingP).ok, true);

    const handle = await adapter.submitTurn({ prompt: "hi" });
    assert.equal(handle.admission.ok, true);
    await controls.promptStarted();
    controls.releaseNextPrompt();
    assert.equal((await handle.completion).ok, true);

    await adapter.close("user");
  });

  it("two plain set_model commands are mutually exclusive (second is session_busy, one driver call)", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const first = adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    await controls.setModelStarted();
    const second = await adapter.execute({ type: "set_model", provider: MODEL_A.provider, modelId: MODEL_A.id });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.error.code, "session_busy");
      assert.equal(second.error.retryable, true);
    }
    assert.equal(controls.setModelCalls.length, 1, "the second mutation must never reach the driver");
    controls.releaseNextSetModel();
    assert.equal((await first).ok, true);
    // After release the same mutation is admissible again.
    const thirdP = adapter.execute({ type: "set_model", provider: MODEL_A.provider, modelId: MODEL_A.id });
    await controls.setModelStarted();
    controls.releaseNextSetModel();
    assert.equal((await thirdP).ok, true);

    await adapter.close("user");
  });

  it("a failed plain set_model releases the barrier (finally) — a fresh turn is admitted right after", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const failed = adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    await controls.setModelStarted();
    controls.releaseNextSetModel(new Error("unknown model"));
    const result = await failed;
    assert.equal(result.ok, false);

    const handle = await adapter.submitTurn({ prompt: "hi" });
    assert.equal(handle.admission.ok, true, "the barrier must be released even when the mutation fails");
    await controls.promptStarted();
    controls.releaseNextPrompt();
    assert.equal((await handle.completion).ok, true);

    await adapter.close("user");
  });

  it("interrupt/abort stays available while a plain set_model is in flight", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const setModelP = adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    await controls.setModelStarted();
    const abort = await adapter.interrupt({ type: "abort" });
    assert.equal(abort.ok, true, "the mutation barrier must never block the independent interrupt channel");
    const clear = await adapter.interrupt({ type: "clear_queue" });
    assert.equal(clear.ok, true);
    controls.releaseNextSetModel();
    assert.equal((await setModelP).ok, true);

    await adapter.close("user");
  });

  it("an externally streaming driver (no adapter prompt) rejects plain set_model and set_thinking_level — busy, zero driver calls", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    // External stream: the DRIVER reports streaming while no adapter-owned
    // prompt is running (promptRunning false, turnAdmissionBusy false). The
    // real SDK AgentSession.setModel has no streaming guard of its own, so the
    // adapter boundary must reject — mutating A→B mid-stream is never allowed.
    controls.setState({ isStreaming: true });
    const modelResult = await adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    assert.equal(modelResult.ok, false, "set_model must fail closed while the driver is streaming");
    if (!modelResult.ok) {
      assert.equal(modelResult.error.code, "session_busy");
      assert.equal(modelResult.error.retryable, true);
    }
    assert.equal(controls.setModelCalls.length, 0, "the mutation must never reach a streaming driver");
    const thinkingResult = await adapter.execute({ type: "set_thinking_level", level: "high" });
    assert.equal(thinkingResult.ok, false, "set_thinking_level must fail closed while the driver is streaming");
    if (!thinkingResult.ok) {
      assert.equal(thinkingResult.error.code, "session_busy");
      assert.equal(thinkingResult.error.retryable, true);
    }
    assert.equal(controls.setThinkingCalls.length, 0, "the thinking mutation must never reach a streaming driver");

    // The guard is about the stream, not a sticky flag: once idle again the
    // plain mutation is admissible.
    controls.setState({ isStreaming: false });
    const retryP = adapter.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    await controls.setModelStarted();
    controls.releaseNextSetModel();
    assert.equal((await retryP).ok, true);

    await adapter.close("user");
  });

  it("close during the admission window rejects the turn not-delivered — no prompt after close", { timeout: 10000 }, async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    // submitTurn's admission is suspended at the admission-snapshot await when
    // close() flips the runtime closed in the same synchronous turn (close is
    // never blocked by an admission). The turn must end as a clean
    // not-delivered rejection — never an accepted admission that prompts into
    // a disposed driver.
    const handleP = adapter.submitTurn({ prompt: "close-race" });
    await adapter.close("user");
    const handle = await handleP;
    assert.equal(handle.admission.ok, false, "a turn whose runtime closed during admission must not be accepted");
    if (!handle.admission.ok) {
      assert.equal(handle.admission.error.code, "unavailable");
    }
    const terminal = await handle.completion;
    assert.equal(terminal.ok, false);
    assert.equal(controls.promptModels.length, 0, "no prompt may launch after close");
  });

  it("the barrier is per-runtime: another adapter's in-flight set_model does not block this runtime's turn", { timeout: 10000 }, async () => {
    const first = makeDriver();
    const second = makeDriver();
    const adapterA = new CanonicalAgentRuntimeAdapter(first.driver);
    const adapterB = new CanonicalAgentRuntimeAdapter(second.driver);
    await adapterA.ready();
    await adapterB.ready();

    const setModelP = adapterA.execute({ type: "set_model", provider: MODEL_B.provider, modelId: MODEL_B.id });
    await first.controls.setModelStarted();

    const handleP = adapterB.submitTurn({ prompt: "hi", activationOverrides: { model: { provider: MODEL_A.provider, modelId: MODEL_A.id } } });
    await second.controls.setModelStarted();
    second.controls.releaseNextSetModel();
    const handle = await handleP;
    assert.equal(handle.admission.ok, true, "runtimes are independent — no global lock");
    await second.controls.promptStarted();
    assert.deepEqual(second.controls.promptModels, [{ provider: MODEL_A.provider, id: MODEL_A.id }]);
    second.controls.releaseNextPrompt();
    assert.equal((await handle.completion).ok, true);

    first.controls.releaseNextSetModel();
    assert.equal((await setModelP).ok, true);
    await adapterA.close("user");
    await adapterB.close("user");
  });
});
