import { describe, expect, it } from "vitest";
import type { ExtensionUiRequest, RuntimeSnapshot } from "@fffattiger/pix-protocol";
import {
  activeInteractiveRequests,
  describeExtensionUiError,
  hasPendingInteractiveRequest,
  isExtensionReplyCompatible,
  isInteractiveRequest,
  isNoninteractiveRequest,
} from "./extension-request";

const requests: ExtensionUiRequest[] = [
  { id: "r1", method: "select", title: "Pick", options: ["A", "B"] },
  { id: "r2", method: "confirm", title: "Go?", message: "Continue?" },
  { id: "r3", method: "input", title: "Name", placeholder: "x" },
  { id: "r4", method: "editor", title: "Edit", prefill: "seed" },
  { id: "r5", method: "custom", lines: ["line"] },
  { id: "r6", method: "notify", message: "hi", notifyType: "info" },
  { id: "r7", method: "setStatus", statusKey: "k", statusText: "working" },
  { id: "r8", method: "setWidget", widgetKey: "w", widgetLines: ["a"] },
  { id: "r9", method: "setTitle", title: "New title" },
  { id: "r10", method: "set_editor_text", text: "abc" },
];

describe("extension-request helpers — interactive/noninteractive classification", () => {
  it("classifies the five interactive methods", () => {
    for (const request of requests.slice(0, 5)) {
      expect(isInteractiveRequest(request)).toBe(true);
      expect(isNoninteractiveRequest(request)).toBe(false);
    }
  });

  it("classifies non-interactive event/state methods as passive", () => {
    for (const request of requests.slice(5)) {
      expect(isInteractiveRequest(request)).toBe(false);
      expect(isNoninteractiveRequest(request)).toBe(true);
    }
  });

  it("activeInteractiveRequests preserves deterministic projection order and only returns interactive", () => {
    const snapshot = {
      state: { pendingExtensionUi: [requests[1], requests[5], requests[0], requests[9]] },
    } as unknown as RuntimeSnapshot;
    const active = activeInteractiveRequests(snapshot);
    expect(active.map((r) => r.id)).toEqual(["r2", "r1"]);

    const malformed = { state: { pendingExtensionUi: {} } } as unknown as RuntimeSnapshot;
    expect(activeInteractiveRequests(malformed)).toEqual([]);
  });

  it("hasPendingInteractiveRequest is false for null snapshots or empty/no interactive", () => {
    expect(hasPendingInteractiveRequest(null)).toBe(false);
    const empty = { state: {} } as unknown as RuntimeSnapshot;
    expect(hasPendingInteractiveRequest(empty)).toBe(false);
    const onlyPassive = { state: { pendingExtensionUi: [requests[5]] } } as unknown as RuntimeSnapshot;
    expect(hasPendingInteractiveRequest(onlyPassive)).toBe(false);
    const mixed = { state: { pendingExtensionUi: [requests[5], requests[2]] } } as unknown as RuntimeSnapshot;
    expect(hasPendingInteractiveRequest(mixed)).toBe(true);
  });
});

describe("extension-request helpers — reply compatibility", () => {
  it("cancelled is valid for every interactive method and invalid for non-interactive", () => {
    for (const request of requests.slice(0, 5)) {
      expect(isExtensionReplyCompatible(request, { responseKind: "cancelled", cancelled: true })).toBe(true);
    }
    expect(isExtensionReplyCompatible(requests[5]!, { responseKind: "cancelled", cancelled: true })).toBe(false);
  });

  it("selected/confirmed/value are method-bound", () => {
    expect(isExtensionReplyCompatible(requests[0]!, { responseKind: "selected", selected: "A" })).toBe(true);
    expect(isExtensionReplyCompatible(requests[1]!, { responseKind: "selected", selected: "A" })).toBe(false);
    expect(isExtensionReplyCompatible(requests[1]!, { responseKind: "confirmed", confirmed: true })).toBe(true);
    expect(isExtensionReplyCompatible(requests[0]!, { responseKind: "confirmed", confirmed: true })).toBe(false);
    expect(isExtensionReplyCompatible(requests[2]!, { responseKind: "value", value: "x" })).toBe(true);
    expect(isExtensionReplyCompatible(requests[3]!, { responseKind: "value", value: "x" })).toBe(true);
    expect(isExtensionReplyCompatible(requests[4]!, { responseKind: "value", value: "x" })).toBe(true);
    expect(isExtensionReplyCompatible(requests[1]!, { responseKind: "value", value: "x" })).toBe(false);
    expect(isExtensionReplyCompatible(requests[0]!, null)).toBe(false);
    expect(isExtensionReplyCompatible(requests[0]!, { responseKind: "unknown" } as never)).toBe(false);
  });
});

describe("extension-request helpers — fixed error copy", () => {
  it("maps every known code to fixed copy and never leaks raw text", () => {
    const cases: { error: unknown; expected: string }[] = [
      { error: { code: "unsupported_capability", message: "secret capability reason", retryable: false }, expected: "Extension UI is not available." },
      { error: { code: "session_busy", message: "secret busy", retryable: false }, expected: "Another extension response is in progress." },
      { error: { code: "invalid_input", message: "secret method mismatch with request id abc", retryable: false }, expected: "This extension request cannot be answered this way." },
      { error: { code: "not_found", message: "no pending request: /secret/path", retryable: false }, expected: "The extension request is no longer active." },
      { error: { code: "interrupted", message: "secret", retryable: false }, expected: "The extension request was interrupted." },
      { error: { code: "epoch_changed", message: "secret", retryable: false }, expected: "The session changed; the extension response was not re-sent." },
      { error: { code: "unavailable", message: "secret", retryable: false }, expected: "The runtime is temporarily unavailable." },
      { error: new Error("raw transport message with user input"), expected: "Unable to send the extension response." },
      { error: "some string", expected: "Unable to send the extension response." },
      { error: null, expected: "Unable to send the extension response." },
      { error: { code: "mystery_code", message: "raw", retryable: false }, expected: "Unable to send the extension response." },
    ];
    for (const c of cases) {
      const copy = describeExtensionUiError(c.error);
      expect(copy).toBe(c.expected);
      // Never render raw Host/Protocol message, request text, id or path.
      expect(copy).not.toContain("secret");
      expect(copy).not.toContain("raw");
    }
  });
});
