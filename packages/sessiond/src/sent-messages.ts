/**
 * Durable send receipts (see `@fffattiger/pix-protocol` `sent-messages.ts`).
 *
 * The adapter that owns the session file writes a `pix-sent-message` custom
 * entry for every accepted user message; sessiond reads the tail of that same
 * file to rebuild the idempotency set. Splitting the read here (a sessiond
 * port, implemented by the Pi SDK adapter) keeps sessiond free of SDK types
 * while still reading the ONE truth source.
 */

/** One accepted message as persisted by the adapter. */
export interface DurableSendReceipt {
  /** Client-issued send identity; the dedupe key. */
  operationId: string;
  /** Authority turn identity the message was admitted under. */
  turnId: string;
  delivery: "started" | "steer" | "follow_up";
}

/**
 * Read access to the durable send receipts of one session JSONL. Implementations
 * must be bounded (recent entries only), must never throw for a missing or
 * partially-written session, and must fail closed (an unreadable file yields an
 * empty result, so a send is re-attempted rather than wrongly deduped).
 */
export interface SentMessageLedgerPort {
  /**
   * The most recent accepted sends recorded in `sessionFile`, newest LAST, at
   * most `limit` entries.
   */
  listSentMessages(sessionFile: string, limit: number): Promise<readonly DurableSendReceipt[]>;
}

/** How many recent receipts sessiond keeps per session record. */
export const SENT_MESSAGE_LEDGER_LIMIT = 500;

/**
 * A queued-delivery failure that means "the turn this was queued for is no
 * longer running".
 *
 * sessiond decides between starting a turn and queueing by observing the
 * session's running state, and the runtime may have finished that turn by the
 * time the queue command arrives. The message is still owed delivery, so this
 * answer is NOT a rejection: the caller starts a new turn with the same send
 * identity.
 */
export function isNotRunningQueuedSendFailure(error: { code: string; message: string }): boolean {
  return error.code === "session_busy" || error.code === "conflict";
}
