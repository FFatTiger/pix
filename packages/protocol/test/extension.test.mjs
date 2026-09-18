import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ExtensionUiRequestSchema,
  ExtensionUiRequestEventDataSchema,
  ExtensionUiResponseCommandSchema,
  ExtensionUiInputCommandSchema,
  ExtensionUiResponseExchangeSchema,
  ExtensionUiInputExchangeSchema,
  ExtensionUiInteractiveMethodSchema,
  reduceRuntimeEventData,
} from "../dist/index.js";

/**
 * D2-P8 extension UI backend slice — protocol-level guarantees:
 *  1. `ExtensionUiRequest` carries a strict optional canonical `closed` marker
 *     (`true` only); close tombstones are normal `extension_ui_request` events.
 *  2. The pure projection reducer upserts by requestId and REMOVES on
 *     `closed: true` (never stores the tombstone). Unknown close is an
 *     idempotent no-op; unrelated requests/order are preserved.
 *  3. Response/input commands keep exact method correlation on the wire.
 */

const baseSnapshot = (sessionId = "s") => ({
  sessionId,
  cwd: "/cwd",
  projectRoot: "/cwd",
  state: {
    sessionId,
    isStreaming: false,
    isPromptRunning: false,
    isBashRunning: false,
    isCompacting: false,
    model: null,
    messageCount: 0,
    queuedMessages: { steering: [], followUp: [] },
    pendingMessageCount: 0,
    writtenFiles: [],
  },
  capabilities: { capabilities: [], version: 0 },
  streaming: { active: false, phase: "idle" },
  messages: [],
});

const confirmRequest = (id, extra = {}) => ({ id, method: "confirm", title: "t", message: "m", ...extra });
const inputRequest = (id, extra = {}) => ({ id, method: "input", title: "t", ...extra });

describe("ExtensionUiRequestSchema — strict optional closed marker", () => {
  it("accepts a plain pending request", () => {
    const parsed = ExtensionUiRequestSchema.parse(confirmRequest("r1"));
    assert.equal(parsed.closed, undefined);
    assert.equal(parsed.id, "r1");
  });

  it("accepts a close tombstone with closed: true", () => {
    const parsed = ExtensionUiRequestSchema.parse(confirmRequest("r1", { closed: true }));
    assert.equal(parsed.closed, true);
  });

  it("rejects closed: false (fail-closed — only true is a tombstone)", () => {
    assert.throws(() => ExtensionUiRequestSchema.parse(confirmRequest("r1", { closed: false })));
  });

  it("accepts the tombstone on every method variant", () => {
    for (const request of [
      { id: "a", method: "select", title: "t", options: ["x"], closed: true },
      { id: "a", method: "confirm", title: "t", message: "m", closed: true },
      { id: "a", method: "input", title: "t", closed: true },
      { id: "a", method: "editor", title: "t", closed: true },
      { id: "a", method: "notify", message: "m", notifyType: "info", closed: true },
      { id: "a", method: "setStatus", statusKey: "k", closed: true },
      { id: "a", method: "setWidget", widgetKey: "k", closed: true },
      { id: "a", method: "setTitle", title: "t", closed: true },
      { id: "a", method: "set_editor_text", text: "t", closed: true },
      { id: "a", method: "custom", lines: ["l"], closed: true },
    ]) {
      assert.equal(ExtensionUiRequestSchema.parse(request).closed, true);
    }
  });

  it("ExtensionUiRequestEventDataSchema accepts a close tombstone event", () => {
    const event = ExtensionUiRequestEventDataSchema.parse({
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("r1", { closed: true }),
    });
    assert.equal(event.request.closed, true);
  });

  it("interactive methods are exactly select/confirm/input/editor/custom", () => {
    assert.deepEqual([...ExtensionUiInteractiveMethodSchema.options], ["select", "confirm", "input", "editor", "custom"]);
  });
});

describe("projection reducer — request add / close / replay semantics", () => {
  it("normal request upserts by requestId; unrelated requests and order preserved", () => {
    let snap = reduceRuntimeEventData(baseSnapshot(), {
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("r1"),
    });
    snap = reduceRuntimeEventData(snap, {
      type: "extension_ui_request",
      sessionId: "s",
      request: inputRequest("r2"),
    });
    assert.deepEqual(snap.state.pendingExtensionUi.map((r) => r.id), ["r1", "r2"]);
    // Upsert replaces r1 in place (moves to the end, others preserved).
    snap = reduceRuntimeEventData(snap, {
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("r1", { title: "updated" }),
    });
    assert.deepEqual(snap.state.pendingExtensionUi.map((r) => r.id), ["r2", "r1"]);
    assert.equal(snap.state.pendingExtensionUi[1].title, "updated");
  });

  it("closed:true removes exactly that requestId and never stores the tombstone", () => {
    let snap = reduceRuntimeEventData(baseSnapshot(), {
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("r1"),
    });
    snap = reduceRuntimeEventData(snap, {
      type: "extension_ui_request",
      sessionId: "s",
      request: inputRequest("r2"),
    });
    snap = reduceRuntimeEventData(snap, {
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("r2", { closed: true }),
    });
    assert.deepEqual(snap.state.pendingExtensionUi.map((r) => r.id), ["r1"]);
    // No tombstone is stored.
    assert.ok(snap.state.pendingExtensionUi.every((r) => r.closed === undefined));
  });

  it("unknown close is an idempotent no-op", () => {
    const snap = reduceRuntimeEventData(baseSnapshot(), {
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("ghost", { closed: true }),
    });
    assert.equal(snap.state.pendingExtensionUi?.length ?? 0, 0);
  });

  it("journal replay add→close cannot resurrect a settled request", () => {
    let snap = baseSnapshot();
    // Replay of the add then the close leaves nothing behind.
    snap = reduceRuntimeEventData(snap, { type: "extension_ui_request", sessionId: "s", request: confirmRequest("r1") });
    snap = reduceRuntimeEventData(snap, { type: "extension_ui_request", sessionId: "s", request: confirmRequest("r1", { closed: true }) });
    assert.equal(snap.state.pendingExtensionUi?.length ?? 0, 0);
  });

  it("multiple pending requests — only the exact closed id is removed", () => {
    let snap = baseSnapshot();
    for (const [id, method] of [["a", "confirm"], ["b", "input"], ["c", "select"]] ) {
      snap = reduceRuntimeEventData(snap, {
        type: "extension_ui_request",
        sessionId: "s",
        request: method === "select"
          ? { id, method, title: "t", options: ["x"] }
          : method === "input"
            ? { id, method, title: "t" }
            : confirmRequest(id),
      });
    }
    snap = reduceRuntimeEventData(snap, {
      type: "extension_ui_request",
      sessionId: "s",
      request: confirmRequest("b", { closed: true }),
    });
    assert.deepEqual(snap.state.pendingExtensionUi.map((r) => r.id).sort(), ["a", "c"]);
  });
});

describe("extension command correlation — exact method on the wire", () => {
  it("ExtensionUiResponseCommandSchema preserves method with responseKind", () => {
    const selected = ExtensionUiResponseCommandSchema.parse({
      commandId: "c1", type: "extension_ui_response", id: "r1", method: "select", responseKind: "selected", selected: "optA",
    });
    assert.equal(selected.method, "select");
    const value = ExtensionUiResponseCommandSchema.parse({
      commandId: "c1", type: "extension_ui_response", id: "r1", method: "editor", responseKind: "value", value: "text",
    });
    assert.equal(value.method, "editor");
    const cancelled = ExtensionUiResponseCommandSchema.parse({
      commandId: "c1", type: "extension_ui_response", id: "r1", method: "input", responseKind: "cancelled", cancelled: true,
    });
    assert.equal(cancelled.method, "input");
  });

  it("ExtensionUiResponseExchangeSchema rejects method mismatch", () => {
    const request = confirmRequest("r1");
    const command = { commandId: "c1", type: "extension_ui_response", id: "r1", method: "input", responseKind: "value", value: "x" };
    assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request, command }).success, false);
  });

  it("ExtensionUiInputExchangeSchema rejects method mismatch", () => {
    const request = inputRequest("r1");
    const command = { commandId: "c1", type: "extension_ui_input", id: "r1", method: "editor", data: "x" };
    assert.equal(ExtensionUiInputExchangeSchema.safeParse({ request, command }).success, false);
  });

  it("ExtensionUiInputCommandSchema permits input/editor/custom and rejects select/confirm + non-interactive", () => {
    assert.equal(ExtensionUiInputCommandSchema.safeParse({ commandId: "c1", type: "extension_ui_input", id: "r1", method: "input", data: "x" }).success, true);
    assert.equal(ExtensionUiInputCommandSchema.safeParse({ commandId: "c1", type: "extension_ui_input", id: "r1", method: "editor", data: "x" }).success, true);
    assert.equal(ExtensionUiInputCommandSchema.safeParse({ commandId: "c1", type: "extension_ui_input", id: "r1", method: "custom", data: "\x1b[A" }).success, true, "E15 custom incremental key data");
    assert.equal(ExtensionUiInputCommandSchema.safeParse({ commandId: "c1", type: "extension_ui_input", id: "r1", method: "confirm", data: "x" }).success, false);
    assert.equal(ExtensionUiInputCommandSchema.safeParse({ commandId: "c1", type: "extension_ui_input", id: "r1", method: "select", data: "x" }).success, false);
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      assert.equal(ExtensionUiInputCommandSchema.safeParse({ commandId: "c1", type: "extension_ui_input", id: "r1", method, data: "x" }).success, false, method);
    }
  });

  it("wrong result variant is rejected at the schema (fail-closed, no coercion)", () => {
    // select can only carry selected|cancelled — a value response is invalid.
    assert.equal(ExtensionUiResponseCommandSchema.safeParse({
      commandId: "c1", type: "extension_ui_response", id: "r1", method: "select", responseKind: "value", value: "optA",
    }).success, false);
    // input/editor/custom can only carry value|cancelled — confirmed is invalid.
    assert.equal(ExtensionUiResponseCommandSchema.safeParse({
      commandId: "c1", type: "extension_ui_response", id: "r1", method: "input", responseKind: "confirmed", confirmed: true,
    }).success, false);
    // confirm can only carry confirmed|cancelled — selected is invalid.
    assert.equal(ExtensionUiResponseCommandSchema.safeParse({
      commandId: "c1", type: "extension_ui_response", id: "r1", method: "confirm", responseKind: "selected", selected: "x",
    }).success, false);
  });
});
