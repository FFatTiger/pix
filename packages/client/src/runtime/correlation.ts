/**
 * Runtime correlation primitives: opaque id generation and the at-most-once /
 * resume decision helpers used by the SessionStore.
 *
 * IDs are deliberately separated (M2 C1 spec §E):
 *  - envelope id   : per-attempt transport correlation (WS `id`); the host echoes it.
 *  - createRequestId: business id for `create`, stable across retries.
 *  - command.commandId : at-most-once business id for ordinary commands (prompt),
 *                        deduplicated by the sessiond authority per epoch.
 *  - interrupt commandId: at-most-once business id for the independent interrupt path.
 *
 * A pending entry is always bound to a generation: late frames from a dead
 * socket generation are dropped before they can resolve or mutate anything.
 */
import type {
  ProtocolError,
  RuntimeEventData,
} from "@fffattiger/pix-protocol";

/** Factory for opaque non-empty ids. Default uses crypto.randomUUID when present. */
export type IdFactory = () => string;

function randomHex(byteLength: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < byteLength; i += 1) {
    out += Math.floor(random() * 256).toString(16).padStart(2, "0");
  }
  return out;
}

/** Default id factory: crypto.randomUUID when available, else timestamp+random hex. */
export function createDefaultIdFactory(random: () => number = Math.random): IdFactory {
  return () => {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${randomHex(8, random)}`;
  };
}

export type RequestKind =
  | "create"
  | "attach"
  | "detach"
  | "command"
  | "interrupt"
  | "getSnapshot"
  | "stop";

/** A pending request promise, bound to the generation it was issued under. */
export interface PendingRequest<T = unknown> {
  readonly kind: RequestKind;
  readonly generation: number;
  readonly envelopeId: string;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Result of applying cursor gating to an incoming event. */
export type EventApplyDecision =
  | { readonly decision: "apply" }
  | { readonly decision: "drop"; readonly reason: "duplicate" | "stale-generation" | "awaiting-snapshot" }
  | { readonly decision: "reattach"; readonly reason: "gap" | "epoch" | "session" };

/**
 * Decide whether an event may be applied given the current cursor. Pure.
 *
 *  - eventId === lastEventId + 1 (and matching epoch/session) → apply
 *  - eventId <= lastEventId                                   → duplicate drop
 *  - eventId > lastEventId + 1                                → gap → reattach
 *  - epoch mismatch                                           → reattach
 *  - sessionId mismatch                                       → reattach
 *  - awaiting the generation's initial snapshot               → drop
 */
export function decideEvent(
  event: RuntimeEventData & { readonly eventId: number; readonly epoch: string },
  cursor: { readonly sessionId: string | null; readonly epoch: string | null; readonly lastEventId: number; readonly snapshotReceived: boolean; readonly generation: number; readonly activeGeneration: number },
): EventApplyDecision {
  if (cursor.generation !== cursor.activeGeneration || !cursor.snapshotReceived) {
    return { decision: "drop", reason: "awaiting-snapshot" };
  }
  if (cursor.sessionId === null || cursor.epoch === null) {
    return { decision: "drop", reason: "awaiting-snapshot" };
  }
  if (event.sessionId !== cursor.sessionId) return { decision: "reattach", reason: "session" };
  if (event.epoch !== cursor.epoch) return { decision: "reattach", reason: "epoch" };
  if (event.eventId <= cursor.lastEventId) return { decision: "drop", reason: "duplicate" };
  if (event.eventId > cursor.lastEventId + 1) return { decision: "reattach", reason: "gap" };
  return { decision: "apply" };
}

/** At-most-once outcome for a pending command after a reconnect. */
export type CommandRetryDecision =
  | { readonly decision: "resend" }
  | { readonly decision: "ambiguous"; readonly error: ProtocolError };

/**
 * After a reconnect that delivered a snapshot, decide whether a pending command
 * may be safely re-sent. The sessiond authority deduplicates ordinary commands
 * per epoch via acceptedCommands + commandResults: re-sending with the SAME
 * commandId at an UNCHANGED epoch is safe (the duplicate result is evicted as
 * command_duplicate and never re-executed). After epoch_changed the prior
 * command's effect is ambiguous and must NOT be re-sent.
 */
export function decideCommandRetry(resumeStatus: "snapshot" | "gap" | "epoch_changed"): CommandRetryDecision {
  if (resumeStatus === "epoch_changed") {
    return {
      decision: "ambiguous",
      error: {
        code: "epoch_changed",
        message: "session epoch changed during reconnect; pending command not re-sent",
        retryable: false,
      },
    };
  }
  return { decision: "resend" };
}
