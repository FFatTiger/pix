import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";
import { PiSdkAgentRuntimeFactory } from "../src/agent/factory.js";
import { tagFactoryOptions } from "../src/internal/factory-options.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

/**
 * D2 fork adapter tests.
 *
 * - Busy guard (mirrors compact/navigate): the canonical boundary must reject a
 *   fork with a structured `session_busy` BEFORE any SDK call when the real
 *   driver state is streaming / bash running / compacting / a prompt is blocked
 *   on an extension request — and must never close the runtime on rejection.
 * - Success: fork returns a NEW session id + distinct session file with
 *   fork-point history and provenance recorded in the store (via the scripted
 *   SDK store, whose fork semantics mirror the real SDK createBranchedSession).
 * - Failure sanitization: a hostile SDK error (raw entry id / transport text)
 *   is re-projected onto a FIXED sanitized message; fork params are never
 *   echoed; the runtime is NOT closed on failure.
 */

interface DriverControls {
  readonly state: DriverState;
  readonly forkCalls: string[];
  setForkImpl(impl: (entryId: string) => Promise<{ sessionId: string; sessionFile: string }>): void;
  setState(patch: Partial<DriverState>): void;
  emitDriver(event: unknown): void;
}

function makeDriver(overrides: Partial<DriverState> = {}): { driver: PiRuntimeDriver; controls: DriverControls } {
  const identity = { sessionId: "fork-busy", sessionFile: "/tmp/fork-busy.jsonl", cwd: "/workspace" };
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
  const forkCalls: string[] = [];
  let forkImpl: (entryId: string) => Promise<{ sessionId: string; sessionFile: string }> = async (entryId) => ({ sessionId: `forked-${entryId}`, sessionFile: `/tmp/forked-${entryId}.jsonl` });
  const context = {
    emit: (event: unknown) => { for (const listener of [...listeners]) listener(structuredClone(event)); },
  };
  const unused = async () => { throw new Error("not used by the fork scenario"); };
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
    compact: unused,
    abortCompaction: () => {},
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => RUNTIME_CAPABILITIES,
    bash: unused,
    abortBash: () => {},
    navigate: unused,
    fork: (entryId) => { forkCalls.push(entryId); return forkImpl(entryId); },
    generateSessionTitle: async () => "title",
    bindUi: async () => {},
    close: async () => {},
  };
  return {
    driver,
    controls: {
      state,
      forkCalls,
      setForkImpl(impl) { forkImpl = impl; },
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

describe("adapter fork busy guard (D2 fork)", () => {
  it("rejects fork while the driver is streaming — session_busy, no SDK call, no events, runtime stays open", async () => {
    const { driver, controls } = makeDriver({ isStreaming: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "fork", entryId: "entry-1" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "fork");
      assert.equal(result.error.code, "session_busy");
      assert.equal(result.error.retryable, true);
    }
    assert.equal(controls.forkCalls.length, 0, "the SDK fork must never be called while streaming");
    assert.deepEqual(events, [], "no fork/close event may be emitted on rejection");
    // The runtime must remain open on a busy rejection (no self-close).
    const after = await adapter.execute({ type: "get_state" });
    assert.equal(after.ok, true);
  });

  it("rejects fork while bash is running, compacting, or a prompt is blocked on an extension request", async () => {
    for (const patch of [
      { isBashRunning: true },
      { isCompacting: true },
    ] as const) {
      const { driver, controls } = makeDriver({ ...patch });
      const adapter = new CanonicalAgentRuntimeAdapter(driver);
      await adapter.ready();
      const result = await adapter.execute({ type: "fork", entryId: "entry-1" });
      assert.equal(result.ok, false, JSON.stringify(patch));
      if (!result.ok) {
        assert.equal(result.error.code, "session_busy");
        assert.equal(result.error.retryable, true);
      }
      assert.equal(controls.forkCalls.length, 0, "no SDK fork call on busy rejection");
      await adapter.close("user");
    }
    // promptRunning (a prompt blocked on an extension request) is adapter-local:
    // the driver is not streaming, but the canonical boundary must still reject.
    const { driver, controls } = makeDriver({ isStreaming: false });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    (adapter as unknown as { promptRunning: boolean }).promptRunning = true;
    const result = await adapter.execute({ type: "fork", entryId: "entry-1" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "session_busy");
    }
    assert.equal(controls.forkCalls.length, 0, "no SDK fork call while a prompt is in flight");
    await adapter.close("user");
  });

  it("rejects a blank fork point with fixed invalid_input and no SDK call", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const result = await adapter.execute({ type: "fork", entryId: "   " });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_input");
    }
    assert.equal(controls.forkCalls.length, 0);
    await adapter.close("user");
  });
});

describe("adapter fork success and failure (D2 fork)", () => {
  it("fork success returns a new session id + distinct file and records fork-point history + provenance in the store", async () => {
    const store = new ScriptedSdkStore();
    const options = { capabilities: RUNTIME_CAPABILITIES };
    tagFactoryOptions(options, { driverFactory: new ScriptedSdkDriverFactory(store) });
    const factory = new PiSdkAgentRuntimeFactory(options);
    const port = await factory.create({ cwd: "/workspace" });
    await port.execute({ type: "prompt", message: "hi" });
    await port.execute({ type: "prompt", message: "second turn" });
    const detail = await store.readSession(port.identity.sessionId);
    const entryId = detail.entries?.[1]?.entryId;
    assert.ok(entryId, "second-turn entry must exist");

    const result = await port.execute({ type: "fork", entryId: entryId! });
    assert.equal(result.ok, true);
    if (result.ok && result.type === "fork") {
      assert.notEqual(result.forkedSessionId, port.identity.sessionId, "fork must return a NEW session id");
      assert.equal(result.forkPointEntryId, entryId);
    }
    // The forked session exists in the store with a distinct file + history up
    // to the fork point and full provenance (parent + fork point).
    const forkedId = result.ok && result.type === "fork" ? result.forkedSessionId : "";
    const forked = await store.readSession(forkedId);
    assert.notEqual(forked.sessionFile, port.identity.sessionFile, "distinct jsonl");
    assert.equal(forked.parentSessionId, port.identity.sessionId, "parent provenance");
    assert.equal(forked.forkPointEntryId, entryId, "fork-point provenance");
    assert.equal(forked.entries?.length, 2, "history starts at the fork point (both turns)");
    assert.equal(forked.messageCount, 2);
    await port.close("user");
  });

  it("fork hostile SDK error is sanitized: fixed message, no entry id / raw text, runtime NOT closed", async () => {
    const { driver, controls } = makeDriver();
    controls.setForkImpl(async (entryId) => {
      throw Object.assign(new Error(`unknown fork point: ${entryId} — /private/tmp/session-secret`), { code: "external", retryable: true, details: { entryId } });
    });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const result = await adapter.execute({ type: "fork", entryId: "entry-7" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "external");
      assert.ok(!result.error.message.includes("entry-7"), "fork params must never be echoed");
      assert.ok(!result.error.message.includes("session-secret"), "no raw path/SDK text");
      assert.ok(!/\\n|\\tat |node:internal/i.test(result.error.message), "no raw stack text");
    }
    // The runtime must remain open on a failed fork (the old worker keeps
    // running — the sessiond stop is only triggered by a SUCCESSFUL fork).
    const after = await adapter.execute({ type: "get_state" });
    assert.equal(after.ok, true);
    await adapter.close("user");
  });
});
