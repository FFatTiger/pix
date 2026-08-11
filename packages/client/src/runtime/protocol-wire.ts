/**
 * Pure, browser-safe Runtime wire helpers: WS URL derivation, strict handshake
 * construction, protocol-error classification, and the reconnect backoff curve.
 *
 * No IO, no globals read except the injected `location`-like object passed to
 * {@link buildRuntimeWsUrl}. Everything here is unit-testable without a socket.
 */
import {
  PROTOCOL_VERSION,
  safeParseWsHostMessage,
  type ClientIdentity,
  type HostLimits,
  type HostMode,
  type ProtocolError,
  type ProtocolHandshakeRequest,
  type WsHostMessage,
} from "@fffattiger/pix-protocol";
import { FATAL_HANDSHAKE_CODES } from "./lifecycle.js";

/** Minimal same-origin location shape needed to derive the WS URL. */
export interface RuntimeLocation {
  readonly href: string;
}

/**
 * Derive the runtime WebSocket URL from the current location. The host serves
 * the runtime WS at the ROOT path `/v1/runtime` (matching the HTTP client's
 * root `/v1` surface), so the URL is origin-relative and independent of the
 * document's base path: http→ws, https→wss, same host, path `/v1/runtime`.
 * This makes no-trailing-slash and trailing-slash inputs produce the SAME url.
 */
export function buildRuntimeWsUrl(location: RuntimeLocation): string {
  const base = new URL(location.href);
  const wsProto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${base.host}/v1/runtime`;
}

/**
 * Build the strict first-frame handshake request. The client identifies its
 * shell/platform and advertised feature tokens; auth is left to same-origin
 * cookies (omitted here).
 */
export function buildHandshakeRequest(identity: ClientIdentity, features: readonly string[] = []): ProtocolHandshakeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    client: identity,
    features: [...features],
  };
}

/** True when a ProtocolError code marks a handshake as fatal (non-retryable). */
export function isFatalHandshakeError(error: ProtocolError): boolean {
  return FATAL_HANDSHAKE_CODES.includes(error.code);
}

/** True when a ProtocolError is retryable (network/runtime hiccups). */
export function isRetryableError(error: ProtocolError): boolean {
  return error.retryable === true;
}

/**
 * Exponential backoff with full jitter (base 500ms, factor 2, cap 30s), using an
 * injected `random()` in [0,1). Returns the delay in ms for attempt `attempt`
 * (1-based). Pure and deterministic given `random`.
 */
export interface BackoffOptions {
  readonly baseMs?: number;
  readonly factor?: number;
  readonly capMs?: number;
}

export function computeBackoffDelay(attempt: number, random: () => number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 500;
  const factor = options.factor ?? 2;
  const cap = options.capMs ?? 30_000;
  const exp = base * Math.pow(factor, Math.max(0, attempt - 1));
  const upper = Math.min(cap, exp);
  return Math.floor(random() * upper);
}

/**
 * Parse and validate an incoming host frame, FAILING CLOSED on anything the
 * frozen schema does not accept. Never coerces with `as any`; an invalid frame
 * is reported as a parse failure so the caller can drop/close.
 */
export function parseHostFrame(raw: string): { ok: true; message: WsHostMessage } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const result = safeParseWsHostMessage(json);
  return result.success ? { ok: true, message: result.data } : { ok: false };
}

/** Resolve HostMode/Limits from a handshake ack payload (typed already). */
export interface NegotiatedHost {
  readonly mode: HostMode;
  readonly limits: HostLimits;
}

export { safeParseWsHostMessage };
