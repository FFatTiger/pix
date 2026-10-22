/**
 * Durable send receipts read side (sessiond port, implemented here because the
 * Pi SDK owns the session file format).
 *
 * The adapter writes a `pix-sent-message` custom entry for every accepted user
 * message. sessiond reads the tail of the same JSONL to rebuild its idempotency
 * set, so a resend after a worker restart or an epoch rollover — where the
 * in-memory ledger is gone — is still answered as a duplicate instead of
 * delivering the message twice.
 *
 * Bounded and fail-open-to-send: only the last {@link RECEIPT_SCAN_LIMIT} lines
 * are considered, and any read/parse problem yields "no receipts", which makes
 * the send happen rather than silently swallowed.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { PIX_SENT_MESSAGE_CUSTOM_TYPE, parseSentMessageReceipt } from "@fffattiger/pix-protocol";

/** Session JSONL lines scanned from the tail when resolving receipts. */
const RECEIPT_SCAN_LIMIT = 4_000;

/**
 * Read accepted-send receipts out of one session JSONL file.
 *
 * `sessionFile` is resolved by the caller (sessiond already locates it for
 * activation); a missing file simply has no receipts.
 */
export async function readSentMessages(
  sessionFile: string,
  limit: number,
): Promise<readonly { operationId: string; turnId: string; delivery: "started" | "steer" | "follow_up" }[]> {
  const receipts: { operationId: string; turnId: string; delivery: "started" | "steer" | "follow_up" }[] = [];
  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const recent: string[] = [];
  try {
    for await (const line of lines) {
      recent.push(line);
      // Keep the window bounded without materializing the whole file.
      if (recent.length > RECEIPT_SCAN_LIMIT) recent.shift();
    }
  } catch {
    stream.destroy();
    return [];
  } finally {
    lines.close();
    stream.destroy();
  }
  for (const line of recent) {
    if (!line.includes(PIX_SENT_MESSAGE_CUSTOM_TYPE)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== PIX_SENT_MESSAGE_CUSTOM_TYPE) continue;
    const receipt = parseSentMessageReceipt(record.data);
    if (receipt !== undefined) receipts.push({ operationId: receipt.operationId, turnId: receipt.turnId, delivery: receipt.delivery });
  }
  return receipts.slice(-limit);
}
