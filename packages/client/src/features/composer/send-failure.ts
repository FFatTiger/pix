/**
 * Pure send-failure judgment for the Composer submit transaction.
 *
 *  - `phase: "activation"` — dispatch has not happened, so delivery is
 *    proven impossible (including pre-wire validation and activation errors).
 *  - `{ status: "rejected", delivery: "not_delivered" }` — a correlated
 *    authority admission explicitly proves non-delivery.
 *  - anything else — delivery is UNRESOLVED, even when `retryable` is false
 *    or the cause is a raw Error. Never restore the draft on that evidence.
 */

/** True only for proven non-delivery, never from an error code or retry flag. */
export function isDefiniteSendFailure(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const evidence = cause as { phase?: unknown; status?: unknown; delivery?: unknown };
  if (evidence.phase === "uncertain") return false;
  return evidence.phase === "activation"
    || (evidence.status === "rejected" && evidence.delivery === "not_delivered");
}

/**
 * A queued turn (steer / follow_up) whose `ok` receipt says an extension input
 * handler CONSUMED the message: nothing was queued and no user entry will ever
 * commit. The promise resolves, so a resolved `followUp` is not by itself
 * proof that the message is now waiting in the queue.
 */
export function isConsumedQueuedReceipt(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const receipt = (value as { result?: { ok?: unknown; disposition?: unknown } }).result;
  return receipt?.ok === true && receipt.disposition === "handled";
}
