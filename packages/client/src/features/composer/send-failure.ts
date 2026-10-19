/**
 * Pure send-failure judgment for the Composer submit transaction.
 *
 * The store settles every send promise with a structured ProtocolError,
 * optionally tagged with a `phase`:
 *  - `phase: "activation"` — the prompt was PROVEN non-delivered before any
 *    dispatch (pre-wire gate failure, activation-phase error). The draft must
 *    be restored/retained regardless of retryable metadata.
 *  - `phase: "uncertain"` — delivery is UNRESOLVED (admission receipt lost,
 *    RPC failed after possible dispatch, reconciliation gave up). The turn may
 *    be admitted and running server-side: this is NEVER a definite failure and
 *    the draft must NOT be restored (a manual re-send could duplicate the
 *    turn).
 *  - no phase + `retryable: false` — the authority explicitly proved
 *    non-delivery (rejected `not_delivered` admission): the only honest
 *    "not sent" outcome.
 */

/** Proven non-delivery BEFORE any dispatch (`phase: "activation"`). */
export function isActivationSendFailure(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && (cause as { phase?: unknown }).phase === "activation";
}

/** Unresolved delivery (`phase: "uncertain"`) — never "not sent". */
export function isUncertainSendSettle(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && (cause as { phase?: unknown }).phase === "uncertain";
}

/**
 * True only when the send is DEFINITELY not delivered (the authority proved
 * it): non-retryable AND not uncertain. Only then may the UI show "not sent"
 * and restore the draft.
 */
export function isDefiniteSendFailure(cause: unknown): boolean {
  if (cause !== null && typeof cause === "object") {
    const tagged = cause as { retryable?: unknown; phase?: unknown };
    if (tagged.retryable === true) return false;
    if (tagged.phase === "uncertain") return false;
  }
  return true;
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
