/**
 * Runtime identity and lifecycle semantics.
 */

/**
 * Identity of a runtime instance. The JSONL file (or whatever the backend
 * persists to) is the source of truth; `sessionFile` is its canonical path.
 */
export interface RuntimeIdentity {
  sessionId: string;
  sessionFile: string;
  createdAt?: number;
}

/**
 * Canonical close reasons. Adapters map backend shutdown/termination states
 * into these normalized reasons.
 */
export type RuntimeCloseReason =
  | "user"
  | "idle"
  | "error"
  | "crashed"
  | "forked"
  | "replaced"
  | "shutdown"
  | "session_deleted";
