/**
 * D2-P8 — runtime-core extension UI command method preservation.
 *
 * The wire Protocol command already carries `requestId + method`. The Core
 * response/input commands MUST preserve `method` through the worker command
 * mapper so the adapter can correlate a response/input to the pending request's
 * exact method (wrong method ⇒ structured `invalid_input`, request stays
 * pending). These compile-time exactness guards fail `tsc` if the method field
 * is ever dropped; runtime checks pin the legal method↔kind pairing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUiResponseCommand, ExtensionUiInputCommand } from "./commands.js";

/** True when A and B are the exact same type. */
type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

// The value variant may only carry methods that produce a value (select's
// "selected" collapses to value, input/editor/custom use responseKind value).
const _valueMethods: IsExact<
  Extract<ExtensionUiResponseCommand, { value: string }>["method"],
  "select" | "input" | "editor" | "custom"
> = true;

// The confirmed variant is confirm-only.
const _confirmedMethod: IsExact<
  Extract<ExtensionUiResponseCommand, { confirmed: boolean }>["method"],
  "confirm"
> = true;

// The cancelled variant is allowed for every interactive method.
const _cancelledMethods: IsExact<
  Extract<ExtensionUiResponseCommand, { cancelled: true }>["method"],
  "select" | "confirm" | "input" | "editor" | "custom"
> = true;

// Incremental input is input/editor/custom (E15: custom panels stream raw key data).
const _inputMethods: IsExact<ExtensionUiInputCommand["method"], "input" | "editor" | "custom"> = true;

test("extension_ui_response carries the exact correlated method", () => {
  const selected: ExtensionUiResponseCommand = { type: "extension_ui_response", id: "r1", method: "select", value: "optA" };
  const confirmed: ExtensionUiResponseCommand = { type: "extension_ui_response", id: "r1", method: "confirm", confirmed: true };
  const cancelled: ExtensionUiResponseCommand = { type: "extension_ui_response", id: "r1", method: "input", cancelled: true };
  assert.equal(selected.method, "select");
  assert.equal(confirmed.method, "confirm");
  assert.equal(cancelled.method, "input");
  // JSON-serializable, backend-neutral.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify([selected, confirmed, cancelled])));
});

test("extension_ui_input carries the exact correlated method", () => {
  const input: ExtensionUiInputCommand = { type: "extension_ui_input", id: "r1", method: "input", data: "x" };
  const editor: ExtensionUiInputCommand = { type: "extension_ui_input", id: "r1", method: "editor", data: "y" };
  const custom: ExtensionUiInputCommand = { type: "extension_ui_input", id: "r1", method: "custom", data: "\x1b[A" };
  assert.equal(input.method, "input");
  assert.equal(editor.method, "editor");
  assert.equal(custom.method, "custom");
  // JSON-serializable, backend-neutral (terminal control bytes survive a wire hop).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify([input, editor, custom])));
});

test("ExtensionUiRequest models the canonical closed marker", () => {
  // Type-level: `closed` is an optional boolean on the pending request.
  const request: import("./extension.js").ExtensionUiRequest = {
    id: "r1",
    method: "confirm",
    title: "t",
    message: "m",
  };
  assert.equal(request.closed, undefined);
  const tombstone: import("./extension.js").ExtensionUiRequest = { ...request, closed: true };
  assert.equal(tombstone.closed, true);
});
