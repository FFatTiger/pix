/**
 * Runtime connection lifecycle primitives (pure, no IO).
 *
 * The connection state machine is intentionally explicit so the UI can never be
 * lied to: a socket is only `attached` after a strictly correlated initial
 * snapshot, never merely after a successful handshake. See M2 C1 spec §B/C/D.
 */

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

/** True when the runtime stream is usable for sending commands. */
export function canSend(state: ConnectionState): boolean {
  return state === "ready" || state === "attaching" || state === "attached";
}
