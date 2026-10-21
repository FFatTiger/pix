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
import type { ExtensionUiResponseCommand } from "./commands.js";

/** True when A and B are the exact same type. */
type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

// The value variant may only carry methods that produce a value (select's
// "selected" collapses to value, input/editor use responseKind value).
const _valueMethods: IsExact<
  Extract<ExtensionUiResponseCommand, { value: string }>["method"],
  "select" | "input" | "editor"
> = true;

// The confirmed variant is confirm-only.
const _confirmedMethod: IsExact<
  Extract<ExtensionUiResponseCommand, { confirmed: boolean }>["method"],
  "confirm"
> = true;

// The cancelled variant is allowed for every interactive method.
const _cancelledMethods: IsExact<
  Extract<ExtensionUiResponseCommand, { cancelled: true }>["method"],
  "select" | "confirm" | "input" | "editor" | "questionnaire"
> = true;

const _questionnaireMethods: IsExact<
  Extract<ExtensionUiResponseCommand, { answers: readonly import("./questionnaire.js").QuestionnaireAnswer[] }> ["method"],
  "questionnaire"
> = true;

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

// The removed custom (terminal self-drawn UI) method must never come back on
// any response variant: the whole union's method set is exactly the native
// web prompts plus questionnaire.
const _responseMethods: IsExact<
  ExtensionUiResponseCommand["method"],
  "select" | "confirm" | "input" | "editor" | "questionnaire"
> = true;

test("questionnaire response carries explicit answers without collapsing custom text", () => {
  const answers: import("./questionnaire.js").QuestionnaireAnswer[] = [
    { kind: "option", questionIndex: 0, optionIndex: 1 },
    { kind: "multi", questionIndex: 1, optionIndices: [] },
    { kind: "custom", questionIndex: 2, text: "3" },
  ];
  const submitted: ExtensionUiResponseCommand = {
    type: "extension_ui_response",
    id: "r1",
    method: "questionnaire",
    answers,
  };
  const cancelled: ExtensionUiResponseCommand = {
    type: "extension_ui_response",
    id: "r1",
    method: "questionnaire",
    cancelled: true,
  };
  assert.equal(submitted.method, "questionnaire");
  assert.equal(cancelled.cancelled, true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify([submitted, cancelled])));
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
