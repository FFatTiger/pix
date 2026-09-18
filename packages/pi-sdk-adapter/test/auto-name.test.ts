import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";

/**
 * D2 auto_name adapter tests.
 *
 * Frozen semantics:
 * - Success: the adapter derives the title via the driver seam (which applies
 *   it to the worker/session internally), emits the canonical `session_title`
 *   event, and returns the title in the RPC result — the single source of
 *   truth sessiond uses to publish the §51 revisioned title overlay.
 * - Busy: auto_name is a lightweight QUERY-STYLE generation (no model call, no
 *   session-tree mutation, no streaming interaction) — it is ALLOWED while a
 *   prompt streams and is NOT rejected session_busy like navigate/fork/compact.
 *   This is the deliberate, frozen asymmetry.
 * - Failure sanitization: a hostile SDK error (raw title / session id / path /
 *   SDK text) is re-projected onto a FIXED sanitized message keyed by code; no
 *   raw text ever crosses the boundary; no `session_title` event is emitted.
 * - Capability gate: without `runtime.auto_name` the gate answers
 *   `unsupported_capability` and never calls the driver.
 */

interface DriverControls {
  readonly state: DriverState;
  readonly titleCalls: number[];
  setTitleImpl(impl: () => Promise<string>): void;
  setState(patch: Partial<DriverState>): void;
}

function makeDriver(
  overrides: Partial<DriverState> = {},
  capabilities: readonly string[] = RUNTIME_CAPABILITIES,
): { driver: PiRuntimeDriver; controls: DriverControls } {
  const identity = { sessionId: "auto-name-test", sessionFile: "/tmp/auto-name-test.jsonl", cwd: "/workspace" };
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
  const titleCalls: number[] = [];
  // The real seam reads the last assistant text, applies the title to the
  // worker (session.setSessionName) AND returns it — mirror that: apply to the
  // driver state so a later getSnapshot carries sessionName.
  let titleImpl: () => Promise<string> = async () => {
    const title = "Generated Title";
    state.sessionName = title;
    return title;
  };
  const context = {
    emit: (event: unknown) => { for (const listener of [...listeners]) listener(structuredClone(event)); },
  };
  const unused = async () => { throw new Error("not used by the auto-name scenario"); };
  const driver: PiRuntimeDriver = {
    identity,
    capabilities: capabilities as never,
    getState: () => state,
    getTools: () => state.tools ?? [],
    getCommands: () => state.commands ?? [],
    getSessionStats: () => state.sessionStats,
    getLastAssistantText: () => state.lastAssistantText ?? "",
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
    navigate: unused,
    fork: unused,
    generateSessionTitle: () => { titleCalls.push(1); return titleImpl(); },
    bindUi: async () => {},
    close: async () => {},
  };
  return {
    driver,
    controls: {
      state,
      titleCalls,
      setTitleImpl(impl) { titleImpl = impl; },
      setState(patch) { Object.assign(state, patch); },
    },
  };
}

async function collectEvents(adapter: CanonicalAgentRuntimeAdapter): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return events;
}

describe("adapter auto_name (D2 auto_name)", () => {
  it("success: derives the title via the driver seam, applies it to the worker, emits session_title, and returns it in the RPC result", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "generate_session_title" });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok && result.type === "generate_session_title") {
      assert.equal(result.title, "Generated Title", "the RPC result must carry the generated title (single source of truth)");
    }
    assert.equal(controls.titleCalls.length, 1, "the driver seam must be called exactly once");
    const titleEvents = events.filter((e) => e.type === "session_title");
    assert.equal(titleEvents.length, 1, "success must emit exactly one session_title event");
    assert.equal((titleEvents[0] as { name?: string }).name, "Generated Title");
    const snap = await adapter.getSnapshot();
    assert.equal(snap.state.sessionName, "Generated Title", "the snapshot must carry the applied session name");
  });

  it("allowed while a prompt streams (no session_busy): the frozen lightweight query-style busy decision", async () => {
    // Deliberate asymmetry with navigate/fork/compact: auto_name reads the last
    // assistant text and sets the session name — no model call, no tree
    // mutation, no streaming interaction — so it NEVER corrupts the in-flight
    // turn and is NOT rejected session_busy while streaming.
    const { driver, controls } = makeDriver({ isStreaming: true });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const result = await adapter.execute({ type: "generate_session_title" });
    assert.equal(result.ok, true, "auto_name must be allowed while a prompt streams");
    if (result.ok && result.type === "generate_session_title") assert.equal(result.title, "Generated Title");
    assert.equal(controls.titleCalls.length, 1);
  });

  it("failure sanitization: a hostile SDK error is re-projected onto a fixed sanitized message with no raw title/session id and no session_title event", async () => {
    const { driver, controls } = makeDriver();
    controls.setTitleImpl(async () => {
      throw Object.assign(new Error("RAW SDK FAILURE for session auto-name-test title My Secret Title"), {
        details: { token: "sk-secret-token-abc123" },
      });
    });
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    const result = await adapter.execute({ type: "generate_session_title" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "generate_session_title");
      // mapDriverError classifies "not found"-free SDK text as `external`; the
      // message is a FIXED projection, never the raw SDK text.
      assert.equal(result.error.code, "external");
      assert.equal(result.error.message, "title generation failed");
      assert.ok(!result.error.message.includes("auto-name-test"), "no raw session id in the error");
      assert.ok(!result.error.message.includes("Secret Title"), "no raw title in the error");
      assert.ok(!result.error.message.includes("sk-"), "no raw SDK text in the error");
      assert.ok(!/\n|\tat |node:internal/i.test(result.error.message), "no raw stack text");
    }
    assert.equal(events.filter((e) => e.type === "session_title").length, 0, "a failed auto_name must never emit a session_title event");
    // The runtime stays open on failure (no self-close).
    const after = await adapter.execute({ type: "get_state" });
    assert.equal(after.ok, true, "the runtime must remain usable after a failed auto_name");
  });

  it("capability gate: without runtime.auto_name the gate answers unsupported_capability and never calls the driver", async () => {
    const caps = RUNTIME_CAPABILITIES.filter((c) => c !== "runtime.auto_name");
    const { driver, controls } = makeDriver({}, caps);
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();

    const result = await adapter.execute({ type: "generate_session_title" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "generate_session_title");
      assert.equal(result.error.code, "unsupported_capability");
      assert.match(result.error.message, /runtime\.auto_name/);
    }
    assert.equal(controls.titleCalls.length, 0, "the driver must never be called when the capability is absent");
  });
});
