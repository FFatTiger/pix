/**
 * Runtime connection lifecycle primitives (pure, no IO).
 *
 * The connection state machine is intentionally explicit so the UI can never be
 * lied to: a socket is only `attached` after a strictly correlated initial
 * snapshot, never merely after a successful handshake. See M2 C1 spec §B/C/D.
 */
import type { ProtocolErrorCode } from "@fffattiger/pix-protocol";

/**
 * Coarse runtime connection state. Transitions are driven by the socket; the
 * store projects these (plus projection state) into the reactive view.
 *
 *  idle         — not started
 *  connecting   — WebSocket opening
 *  handshaking  — socket open, strict first-frame handshake in flight
 *  ready        — handshake ack received; ready to create/attach
 *  attaching    — attach request in flight, awaiting the initial snapshot
 *  attached     — initial snapshot applied; live event stream active
 *  reconnecting — retryable close; exponential backoff before re-handshake
 *  unavailable  — runtime_unavailable / network loss; backoff in progress
 *  stopped      — fatal (handshake reject) or authoritative stop; no reconnect
 */
export type ConnectionState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "attaching"
  | "attached"
  | "reconnecting"
  | "unavailable"
  | "stopped";

/**
 * Handshake reject codes that are FATAL: the connection can never recover by
 * retrying. Any other reject code is still terminal for this connection
 * (handshake cannot be retried with the same parameters), but these four are the
 * explicitly non-retryable ones called out by the protocol.
 */
export const FATAL_HANDSHAKE_CODES: readonly ProtocolErrorCode[] = [
  "protocol_mismatch",
  "unauthorized",
  "forbidden",
  "invalid_request",
];

/** True when the socket may still reach `ready` (transitive/active states). */
export function isActive(state: ConnectionState): boolean {
  return state === "connecting" || state === "handshaking" || state === "ready" || state === "attaching" || state === "attached" || state === "reconnecting";
}

/** True when the runtime stream is usable for sending commands. */
export function canSend(state: ConnectionState): boolean {
  return state === "ready" || state === "attaching" || state === "attached";
}
