import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeCommand, RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { PRODUCTION_AGENT_CAPABILITIES } from "../src/agent/index.js";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { DriverEventListener, DriverState, DriverUiRequest, PiRuntimeDriver } from "../src/internal/types.js";

/**
 * D2-P8 adapter extension-UI slice. The canonical boundary:
 *  - opens `runtime.extension_ui` on the production surface (exactly one token);
 *  - correlates every response/input to the pending request's EXACT method
 *    (wrong method ⇒ structured invalid_input, request stays pending/usable,
 *    no SDK settle/input call, no close; unknown id ⇒ not_found);
 *  - emits EXACTLY ONE canonical `extension_ui_request` close tombstone
 *    (`closed: true`) whenever a pending request settles for ANY reason, then
 *    removes it — race-safe, idempotent, never before publish, never duplicate;
 *  - never leaks user text into errors (only the request id appears).
 */

interface UiControls {
  requestUi(request: Omit<DriverUiRequest, "settle" | "input" | "cancel" | "onSettled">): string;
  settle(id: string, value?: { value?: string; confirmed?: boolean; cancelled?: true }): void;
  input(id: string, data: string): void;
  cancel(id: string): void;
  settleCalls: { id: string; value?: { value?: string; confirmed?: boolean; cancelled?: true } }[];
  inputCalls: { id: string; data: string }[];
  cancelCalls: string[];
  abortCalls: number;
}

function makeDriver(): { driver: PiRuntimeDriver; controls: UiControls } {
  const identity = { sessionId: "ext-ui", sessionFile: "/tmp/ext-ui.jsonl", cwd: "/workspace" };
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
  const requests = new Map<string, DriverUiRequest>();
  let onRequest: ((request: DriverUiRequest) => void) | undefined;
  const controls: UiControls = {
    settleCalls: [],
    inputCalls: [],
    cancelCalls: [],
    abortCalls: 0,
    requestUi(body) {
      const id = body.id;
      let settled = false;
      const settleListeners = new Set<() => void>();
      const fireSettled = (): void => {
        if (settled) return;
        settled = true;
        for (const listener of [...settleListeners]) listener();
        settleListeners.clear();
      };
      const request: DriverUiRequest = {
        ...body,
        settle: (value) => { controls.settleCalls.push({ id, value }); fireSettled(); },
        input: (data) => { controls.inputCalls.push({ id, data }); },
        cancel: () => { controls.cancelCalls.push(id); fireSettled(); },
        onSettled: (listener) => { if (settled) listener(); else settleListeners.add(listener); },
      };
      requests.set(id, request);
      // Route through the adapter's registerUiRequest (wired in bindUi) exactly
      // like the real SDK: publish + pending-map + onSettled registration.
      onRequest?.(request);
      return id;
    },
    settle(id, value) { requests.get(id)?.settle(value ?? { confirmed: true }); },
    input(id, data) { requests.get(id)?.input?.(data); },
    cancel(id) { requests.get(id)?.cancel(); },
  };
  const emit = (event: unknown): void => { for (const listener of [...listeners]) listener(structuredClone(event)); };
  const driver: PiRuntimeDriver = {
    identity,
    capabilities: PRODUCTION_AGENT_CAPABILITIES,
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => { controls.abortCalls += 1; },
    setModel: async () => {},
    setThinkingLevel: () => {},
    compact: async () => {},
    abortCompaction: () => {},
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => PRODUCTION_AGENT_CAPABILITIES,
    bash: async () => ({ output: "" }),
    abortBash: () => {},
    navigate: async () => {},
    fork: async () => ({ sessionId: "x", sessionFile: "y" }),
    generateSessionTitle: async () => "t",
    bindUi: async (requestCb) => { onRequest = requestCb; },
    close: async () => {},
  };
  return { driver, controls };
}

async function collectEvents(adapter: CanonicalAgentRuntimeAdapter): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return events;
}

function isRequestEvent(event: RuntimeEvent): event is Extract<RuntimeEvent, { type: "extension_ui_request" }> {
  return event.type === "extension_ui_request";
}

const uiRequests = (events: RuntimeEvent[]) => events.filter(isRequestEvent).map((event) => event.request);
const pendingIds = async (adapter: CanonicalAgentRuntimeAdapter): Promise<string[]> =>
  (await adapter.getSnapshot()).state.pendingExtensionUi?.map((r) => r.id) ?? [];

describe("adapter extension UI (D2-P8)", () => {
  it("PRODUCTION_AGENT_CAPABILITIES opens extension_ui_response/input + navigate + fork + auto_name (20 tokens, full command surface)", () => {
    assert.ok(PRODUCTION_AGENT_CAPABILITIES.includes("runtime.extension_ui"));
    assert.ok(PRODUCTION_AGENT_CAPABILITIES.includes("runtime.navigate"));
    assert.ok(PRODUCTION_AGENT_CAPABILITIES.includes("runtime.fork"));
    assert.ok(PRODUCTION_AGENT_CAPABILITIES.includes("runtime.auto_name"));
    assert.equal(PRODUCTION_AGENT_CAPABILITIES.length, 20);
  });

  it("add → correct response → single close tombstone removes the pending request", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    controls.requestUi({ id: "ui-1", method: "confirm", title: "Confirm", message: "Continue?" });
    const snap1 = await adapter.getSnapshot();
    assert.deepEqual(snap1.state.pendingExtensionUi?.map((r) => r.id), ["ui-1"]);
    assert.deepEqual(uiRequests(events).map((r) => r.id), ["ui-1"]);
    assert.ok(uiRequests(events).every((r) => r.closed === undefined), "published request must not carry closed");

    const result = await adapter.execute({ type: "extension_ui_response", id: "ui-1", method: "confirm", confirmed: true } as RuntimeCommand);
    assert.equal(result.ok, true);
    assert.deepEqual(controls.settleCalls, [{ id: "ui-1", value: { confirmed: true } }]);
    const requests = uiRequests(events);
    assert.equal(requests.length, 2, "publish + exactly one close");
    const close = requests[1];
    assert.ok(close, "close tombstone must be present");
    assert.equal(close.closed, true, "settle must emit a close tombstone");
    assert.equal(close.id, "ui-1");
    assert.deepEqual(await pendingIds(adapter), [], "settled request must be removed from the snapshot");
  });

  it("wrong-method response is invalid_input, request stays pending, later correct method works", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);

    controls.requestUi({ id: "ui-2", method: "confirm", title: "Confirm", message: "Continue?" });
    const wrong = await adapter.execute({ type: "extension_ui_response", id: "ui-2", method: "input", value: "x" } as RuntimeCommand);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) {
      assert.equal(wrong.type, "extension_ui_response");
      assert.equal(wrong.error.code, "invalid_input");
    }
    assert.deepEqual(controls.settleCalls, [], "wrong-method response must never settle");
    assert.deepEqual(await pendingIds(adapter), ["ui-2"], "request must remain pending/usable");
    assert.equal(uiRequests(events).length, 1, "no close on wrong-method rejection");

    const correct = await adapter.execute({ type: "extension_ui_response", id: "ui-2", method: "confirm", confirmed: true } as RuntimeCommand);
    assert.equal(correct.ok, true);
    assert.deepEqual(controls.settleCalls, [{ id: "ui-2", value: { confirmed: true } }]);
    assert.deepEqual(await pendingIds(adapter), []);
    assert.equal(uiRequests(events).filter((r) => r.closed === true).length, 1);
  });

  it("unknown id is not_found and does not emit a close", async () => {
    const { driver } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    const result = await adapter.execute({ type: "extension_ui_response", id: "missing", method: "confirm", confirmed: true } as RuntimeCommand);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not_found");
    assert.equal(uiRequests(events).length, 0, "unknown id must not produce any close event");
  });

  it("cancelled response is allowed for interactive methods and closes exactly once", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.requestUi({ id: "ui-3", method: "select", title: "Pick", options: ["a", "b"] });
    const result = await adapter.execute({ type: "extension_ui_response", id: "ui-3", method: "select", cancelled: true } as RuntimeCommand);
    assert.equal(result.ok, true);
    assert.deepEqual(controls.settleCalls, [{ id: "ui-3", value: { cancelled: true } }]);
    const closes = uiRequests(events).filter((r) => r.closed === true);
    assert.equal(closes.length, 1);
    assert.deepEqual(await pendingIds(adapter), []);
  });

  it("custom incremental input: exact-method key data reaches the driver in order, final response closes, late input is not_found", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.requestUi({ id: "ui-custom-1", method: "custom", lines: ["terminal"] });
    assert.deepEqual(await pendingIds(adapter), ["ui-custom-1"]);

    // E15: a custom panel streams raw terminal key data — arrows, characters,
    // Ctrl+C — and every chunk must reach driver.input in send order.
    const keys = ["\x1b[A", "a", "b", "\x03"];
    for (const data of keys) {
      const result = await adapter.execute({ type: "extension_ui_input", id: "ui-custom-1", method: "custom", data } as RuntimeCommand);
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.deepEqual(
      controls.inputCalls.map((call) => call.data),
      keys,
      "custom input chunks must be delivered to the driver in exact FIFO order",
    );
    assert.deepEqual(await pendingIds(adapter), ["ui-custom-1"], "incremental custom input must NOT close the request");
    assert.equal(uiRequests(events).filter((r) => r.closed === true).length, 0);

    // Wrong-method input against the custom request: invalid_input, no driver
    // call, request stays pending (exact method correlation).
    const wrong = await adapter.execute({ type: "extension_ui_input", id: "ui-custom-1", method: "editor", data: "x" } as RuntimeCommand);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error.code, "invalid_input");
    assert.equal(controls.inputCalls.length, keys.length, "wrong-method input must never reach the driver");

    // Final response settles the driver with the accumulated value → exactly
    // one close tombstone + snapshot removal.
    const response = await adapter.execute({ type: "extension_ui_response", id: "ui-custom-1", method: "custom", value: "done" } as RuntimeCommand);
    assert.equal(response.ok, true);
    assert.deepEqual(controls.settleCalls, [{ id: "ui-custom-1", value: { value: "done" } }]);
    const closes = uiRequests(events).filter((r) => r.closed === true);
    assert.equal(closes.length, 1);
    assert.ok(closes[0], "close tombstone must be present");
    assert.equal(closes[0]!.id, "ui-custom-1");
    assert.deepEqual(await pendingIds(adapter), []);

    // Late input after close: not_found, never reaches the driver, no second close.
    const late = await adapter.execute({ type: "extension_ui_input", id: "ui-custom-1", method: "custom", data: "z" } as RuntimeCommand);
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.error.code, "not_found");
    assert.equal(controls.inputCalls.length, keys.length, "late input must never reach the driver");
    assert.equal(uiRequests(events).filter((r) => r.closed === true).length, 1);

    // Key data never leaks into errors (only the request id appears).
    for (const failure of [wrong, late]) {
      const serialized = JSON.stringify(failure);
      assert.ok(!serialized.includes("\\u001b") && !serialized.includes("\\u0003"), "raw key data must never leak into errors");
    }
  });

  it("input forwards only for the exact method and never closes; final response closes", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.requestUi({ id: "ui-4", method: "input", title: "Enter", placeholder: "v" });

    const wrong = await adapter.execute({ type: "extension_ui_input", id: "ui-4", method: "editor", data: "x" } as RuntimeCommand);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.error.code, "invalid_input");
    assert.deepEqual(controls.inputCalls, [], "wrong-method input must never reach the driver");

    const okInput = await adapter.execute({ type: "extension_ui_input", id: "ui-4", method: "input", data: "hello" } as RuntimeCommand);
    assert.equal(okInput.ok, true);
    assert.deepEqual(controls.inputCalls, [{ id: "ui-4", data: "hello" }]);
    assert.deepEqual(await pendingIds(adapter), ["ui-4"], "incremental input must NOT close the request");
    assert.equal(uiRequests(events).filter((r) => r.closed === true).length, 0);

    const response = await adapter.execute({ type: "extension_ui_response", id: "ui-4", method: "input", value: "hello" } as RuntimeCommand);
    assert.equal(response.ok, true);
    assert.equal(uiRequests(events).filter((r) => r.closed === true).length, 1);
    assert.deepEqual(await pendingIds(adapter), []);
  });

  it("settle-then-cancel race emits exactly one close (idempotent duplicate path)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.requestUi({ id: "ui-5", method: "confirm", title: "Confirm", message: "m" });
    await adapter.execute({ type: "extension_ui_response", id: "ui-5", method: "confirm", confirmed: true } as RuntimeCommand);
    controls.cancel("ui-5"); // late cancel after settle: no second close
    controls.settle("ui-5"); // late settle: no second close
    const closes = uiRequests(events).filter((r) => r.closed === true);
    assert.equal(closes.length, 1, "settle+cancel+settle must close exactly once");
    assert.deepEqual(await pendingIds(adapter), []);
  });

  it("late response after close is not_found", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    controls.requestUi({ id: "ui-6", method: "confirm", title: "Confirm", message: "m" });
    await adapter.execute({ type: "extension_ui_response", id: "ui-6", method: "confirm", confirmed: true } as RuntimeCommand);
    const late = await adapter.execute({ type: "extension_ui_response", id: "ui-6", method: "confirm", confirmed: false } as RuntimeCommand);
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.error.code, "not_found");
    assert.deepEqual(controls.settleCalls.length, 1, "late response must not settle again");
  });

  it("abort cancels pending requests, emits a close per request, and clears the snapshot", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.requestUi({ id: "ui-7", method: "confirm", title: "Confirm", message: "m" });
    controls.requestUi({ id: "ui-8", method: "input", title: "Enter" });
    const result = await adapter.execute({ type: "abort" } as RuntimeCommand);
    assert.equal(result.ok, true);
    assert.deepEqual(controls.cancelCalls.sort(), ["ui-7", "ui-8"]);
    assert.equal(controls.abortCalls, 1);
    const closes = uiRequests(events).filter((r) => r.closed === true);
    assert.equal(closes.length, 2, "each pending request must emit its own close");
    assert.deepEqual(closes.map((r) => r.id).sort(), ["ui-7", "ui-8"]);
    assert.deepEqual(await pendingIds(adapter), []);
  });

  it("close() cancels every pending request and emits one close tombstone each", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events = await collectEvents(adapter);
    controls.requestUi({ id: "ui-close-1", method: "confirm", title: "Confirm", message: "m" });
    controls.requestUi({ id: "ui-close-2", method: "input", title: "Enter" });
    await adapter.close("shutdown");
    const closes = uiRequests(events).filter((r) => r.closed === true);
    assert.equal(closes.length, 2, "close must emit one tombstone per pending request");
    assert.deepEqual(closes.map((r) => r.id).sort(), ["ui-close-1", "ui-close-2"]);
    assert.deepEqual(controls.cancelCalls.sort(), ["ui-close-1", "ui-close-2"]);
  });

  it("subscribe replay reflects only active pending requests (never closed ones)", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    controls.requestUi({ id: "ui-9", method: "confirm", title: "Confirm", message: "m" });
    // Close ui-9, leave ui-10 pending.
    await adapter.execute({ type: "extension_ui_response", id: "ui-9", method: "confirm", confirmed: true } as RuntimeCommand);
    controls.requestUi({ id: "ui-10", method: "input", title: "Enter" });

    const replayed: RuntimeEvent[] = [];
    adapter.subscribe((event) => replayed.push(event));
    assert.deepEqual(replayed.filter(isRequestEvent).map((r) => r.request.id), ["ui-10"], "replay must include only the active pending request");
    assert.ok(replayed.every((r) => !isRequestEvent(r) || r.request.closed !== true), "replay must never include closed tombstones");
  });

  it("errors expose the request id only — never user text from the request", async () => {
    const { driver, controls } = makeDriver();
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    // A pending request whose title/message/options carry user text.
    controls.requestUi({ id: "ui-11", method: "select", title: "SECRET-TITLE-xyz", options: ["SECRET-OPT-1"] });
    const wrong = await adapter.execute({ type: "extension_ui_response", id: "ui-11", method: "confirm", confirmed: true } as RuntimeCommand);
    assert.equal(wrong.ok, false);
    const serialized = JSON.stringify(wrong);
    assert.ok(!serialized.includes("SECRET-TITLE-xyz"));
    assert.ok(!serialized.includes("SECRET-OPT-1"));
    const notFound = await adapter.execute({ type: "extension_ui_response", id: "ui-11b", method: "confirm", confirmed: true } as RuntimeCommand);
    assert.equal(notFound.ok, false);
    assert.ok(!JSON.stringify(notFound).includes("SECRET-TITLE-xyz"));
  });
});
