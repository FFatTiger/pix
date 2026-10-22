/**
 * Pure send-failure judgment for the Composer submit transaction.
 *
 * A send is unconditional and retried by the outbox, so the ONLY outcomes that
 * reach the composer are the final ones:
 *  - `phase: "activation"` — local validation/activation refused the intent
 *    (the payload itself is unusable);
 *  - `{ status: "rejected", delivery: "not_delivered" }` — the authority
 *    proved it will never accept this message.
 * Anything else is still being delivered and must stay silent.
 */

/** True only for a proven-final rejection, never from an error code or retry flag. */
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
