/**
 * D2-P8 extension-request pure helpers.
 *
 * Pure, deterministic derivation + fixed error copy for the extension-UI
 * request panel. No React, no IO. The component and the Composer share these
 * helpers so the "is there an active interactive request" gate never diverges.
 * All error copy is FIXED — the raw Host/Protocol message, request text, user
 * input, ids and paths are NEVER rendered.
 */
import type { ExtensionUiInteractiveMethod, ExtensionUiRequest, RuntimeSnapshot } from "@fffattiger/pix-protocol";

/** The runtime capability that gates extension UI (authority = runtime snapshot). */
export const EXTENSION_UI_CAPABILITY = "runtime.extension_ui";

/** Interactive request methods — the only ones that produce a client response. */
const INTERACTIVE_METHODS = new Set<string>(["select", "confirm", "input", "editor", "custom"]);

/** An interactive extension request (select/confirm/input/editor/custom). */
export type InteractiveExtensionUiRequest = Extract<ExtensionUiRequest, { method: ExtensionUiInteractiveMethod }>;

/** A pending request is interactive when the user must answer it. */
export function isInteractiveRequest(request: ExtensionUiRequest): request is InteractiveExtensionUiRequest {
  return INTERACTIVE_METHODS.has(request.method);
}

/**
 * Passive pending requests: known non-interactive event/state methods
 * (notify/setStatus/setWidget/setTitle/set_editor_text) AND any unknown method
 * (defensive). These NEVER get a response command — a fixed passive notice only.
 */
export function isNoninteractiveRequest(request: ExtensionUiRequest): boolean {
  return !isInteractiveRequest(request);
}

/** Active interactive requests in deterministic projection order. */
export function activeInteractiveRequests(snapshot: RuntimeSnapshot | null): InteractiveExtensionUiRequest[] {
  if (snapshot === null) return [];
  const pending = snapshot.state.pendingExtensionUi;
  return Array.isArray(pending) ? pending.filter(isInteractiveRequest) : [];
}

/** True when at least one interactive request is pending. */
export function hasPendingInteractiveRequest(snapshot: RuntimeSnapshot | null): boolean {
  return activeInteractiveRequests(snapshot).length > 0;
}

/**
 * Final-response payload bound to an authoritative pending request. Mirrors the
 * store's {@link ExtensionUiReply} shape (responseKind + variant field). The
 * store mints the commandId and binds id/method from the request.
 */
export type ExtensionUiReply =
  | { responseKind: "selected"; selected: string }
  | { responseKind: "confirmed"; confirmed: boolean }
  | { responseKind: "value"; value: string }
  | { responseKind: "cancelled"; cancelled: true };

/**
 * Reply/method compatibility (mirror of the store's transport validation). Used
 * by the UI to decide which controls are offered. `cancelled` is valid for every
 * interactive method; selected/confirmed/value are method-bound.
 */
export function isExtensionReplyCompatible(
  request: ExtensionUiRequest,
  reply: ExtensionUiReply | null | undefined,
): boolean {
  if (reply === null || reply === undefined) return false;
  switch (reply.responseKind) {
    case "cancelled": return isInteractiveRequest(request);
    case "selected": return request.method === "select";
    case "confirmed": return request.method === "confirm";
    case "value": return request.method === "input" || request.method === "editor" || request.method === "custom";
    default: return false;
  }
}

/**
 * Fixed code/kind-first error copy. NEVER renders the raw Host/Protocol
 * message, request text, user input, id or path. Unknown codes collapse to a
 * fixed fallback sentence.
 */
export function describeExtensionUiError(cause: unknown): string {
  const rec = cause && typeof cause === "object" ? (cause as Record<string, unknown>) : {};
  const code = typeof rec.code === "string" ? rec.code : "";
  switch (code) {
    case "unsupported_capability":
      return "Extension UI is not available.";
    case "session_busy":
      return "Another extension response is in progress.";
    case "invalid_input":
      return "This extension request cannot be answered this way.";
    case "not_found":
      return "The extension request is no longer active.";
    case "interrupted":
      return "The extension request was interrupted.";
    case "epoch_changed":
      return "The session changed; the extension response was not re-sent.";
    case "unavailable":
      return "The runtime is temporarily unavailable.";
    default:
      return "Unable to send the extension response.";
  }
}
