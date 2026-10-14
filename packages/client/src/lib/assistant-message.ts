/**
 * First-line markers the sessiond authority writes. Single owner is
 * packages/protocol (`ASSISTANT_SENT_MESSAGE_PREFIX` /
 * `ASSISTANT_NOTIFY_MESSAGE_PREFIX`, defined in protocol/src/domain.ts).
 * The client imports them from the package export; building the protocol
 * package refreshes the workspace dist the client resolves.
 */
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX } from "@fffattiger/pix-protocol";

export { ASSISTANT_SENT_MESSAGE_PREFIX, ASSISTANT_NOTIFY_MESSAGE_PREFIX };

export type AssistantUserMessageKind = "sent" | "notice";

export function assistantUserMessageKind(text: string): AssistantUserMessageKind | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (first === ASSISTANT_SENT_MESSAGE_PREFIX) return "sent";
  if (first === ASSISTANT_NOTIFY_MESSAGE_PREFIX) return "notice";
  return null;
}

/** Drop the marker first line and the single blank line that follows it. */
export function stripAssistantMarker(text: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0) return "";
  const rest = text.slice(newline + 1);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}
