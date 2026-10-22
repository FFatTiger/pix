/**
 * Durable "this user message was accepted" receipts.
 *
 * Sending is unconditional and idempotent: the authority accepts a message
 * (starting a turn, or queueing it while the Agent runs) and the ONLY thing
 * that must never happen twice is the same `operationId` being delivered
 * twice. The in-memory operation ledger is per epoch and dies with the worker,
 * so the receipt is persisted in the session JSONL (the truth source) as a
 * custom entry that never participates in LLM context.
 *
 * Both ends use these constants — one writer (the adapter that owns the
 * session file), one reader (sessiond, which rebuilds the dedupe set on
 * worker start / epoch rollover).
 */
import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/** Custom-entry type written into the session JSONL for an accepted send. */
export const PIX_SENT_MESSAGE_CUSTOM_TYPE = "pix-sent-message" as const;

/**
 * Command-id convention for a send that was delivered as a queued turn
 * (steer / follow_up) instead of a new turn. The adapter derives the receipt
 * `operationId` from it, so a queued send dedupes with the exact identity the
 * client resends.
 */
export const QUEUED_SEND_COMMAND_ID_PREFIX = "pix-send:" as const;

/** Command id for the queued delivery of one send operation. */
export function queuedSendCommandId(operationId: string): string {
  return `${QUEUED_SEND_COMMAND_ID_PREFIX}${operationId}`;
}

/** The `data` payload of a {@link PIX_SENT_MESSAGE_CUSTOM_TYPE} entry. */
export const SentMessageReceiptSchema = z.strictObject({
  version: z.literal(1),
  operationId: NonEmptyStringSchema,
  /** Authority turn identity the message was admitted under. */
  turnId: NonEmptyStringSchema,
  /** How the authority delivered it. */
  delivery: z.enum(["started", "steer", "follow_up"]),
});
export type SentMessageReceipt = z.infer<typeof SentMessageReceiptSchema>;

/** Parse one receipt entry's `data`; unknown shapes are ignored (never fatal). */
export function parseSentMessageReceipt(data: unknown): SentMessageReceipt | undefined {
  const parsed = SentMessageReceiptSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
