import { z } from "zod";
import { ModelRefSchema, NonEmptyStringSchema, ThinkingLevelSchema } from "./common.js";
import { AgentMessageSchema, type AgentMessage, type StreamingAgentMessage, StreamingAgentMessageSchema } from "./messages.js";

export const MAX_SIDE_CHAT_MESSAGES = 64;
export const MAX_SIDE_CHAT_MESSAGE_CHARS = 16_384;
export const MAX_SIDE_CHAT_STREAM_CHARS = 16_384;
export const MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS = 262_144;
export const MAX_SIDE_CHAT_ID_CHARS = 128;

export const SideChatIdSchema = NonEmptyStringSchema.max(MAX_SIDE_CHAT_ID_CHARS);
export const SideChatStatusSchema = z.enum(["idle", "running"]);
export type SideChatStatus = z.infer<typeof SideChatStatusSchema>;

export const SideChatErrorSchema = z.strictObject({
  code: z.literal("run_failed"),
  message: z.literal("Side chat request failed"),
});
export type SideChatError = z.infer<typeof SideChatErrorSchema>;

/**
 * Display budget: text/thinking characters across every message plus the live
 * partial. Tool arguments/results and other structured content are sanitized
 * by the adapter and are not counted — same semantics the side chat always
 * had (only prose was budgeted).
 */
function messageDisplayChars(message: AgentMessage): number {
  let total = 0;
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") total += block.text.length;
      else if (block.type === "thinking") total += block.thinking.length;
    }
  } else if (message.role === "user" && typeof message.content === "string") {
    total += message.content.length;
  }
  return total;
}

function partialDisplayChars(partial: StreamingAgentMessage | null): number {
  if (partial === null || partial.role !== "assistant" || partial.content === undefined) return 0;
  let total = 0;
  for (const block of partial.content) {
    if (block.type === "text") total += block.text.length;
    else if (block.type === "thinking") total += block.thinking.length;
  }
  return total;
}

export const SideChatStateSchema = z.strictObject({
  conversationId: SideChatIdSchema,
  revision: z.number().int().nonnegative().safe(),
  runId: SideChatIdSchema.optional(),
  /** Effective model for subsequent side-chat turns (captured at start, mutable via side_chat_set_model). */
  model: ModelRefSchema,
  thinkingLevel: ThinkingLevelSchema,
  status: SideChatStatusSchema,
  /** Committed side conversation, reusing the main transcript message spec. */
  messages: z.array(AgentMessageSchema).max(MAX_SIDE_CHAT_MESSAGES),
  messagesTruncated: z.boolean(),
  totalCharsTruncated: z.boolean(),
  /** Live streaming partial for the in-flight turn (main-session shape). */
  partialMessage: StreamingAgentMessageSchema.nullable(),
  error: SideChatErrorSchema.optional(),
}).superRefine((state, ctx) => {
  if (state.status === "running" && state.runId === undefined) {
    ctx.addIssue({ code: "custom", path: ["runId"], message: "active side chat requires runId" });
  }
  state.messages.forEach((message, index) => {
    if (message.role === "user" && typeof message.content === "string" && message.content.length > MAX_SIDE_CHAT_MESSAGE_CHARS) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "content"], message: "side chat message exceeds per-message cap" });
    }
    if (message.role !== "assistant") return;
    message.content.forEach((block, blockIndex) => {
      const size = block.type === "text" ? block.text.length : block.type === "thinking" ? block.thinking.length : 0;
      if (size > MAX_SIDE_CHAT_MESSAGE_CHARS) {
        ctx.addIssue({ code: "custom", path: ["messages", index, "content", blockIndex], message: "side chat message exceeds per-message cap" });
      }
    });
  });
  const partial = state.partialMessage;
  if (partial !== null && partial.role === "assistant" && partial.content !== undefined) {
    partial.content.forEach((block, blockIndex) => {
      const size = block.type === "text" ? block.text.length : block.type === "thinking" ? block.thinking.length : 0;
      if (size > MAX_SIDE_CHAT_STREAM_CHARS) {
        ctx.addIssue({ code: "custom", path: ["partialMessage", "content", blockIndex], message: "side chat partial exceeds stream cap" });
      }
    });
  }
  const total = state.messages.reduce((sum, message) => sum + messageDisplayChars(message), 0)
    + partialDisplayChars(partial);
  if (total > MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS) {
    ctx.addIssue({ code: "custom", path: ["messages"], message: "side chat display budget exceeded" });
  }
});
export type SideChatState = z.infer<typeof SideChatStateSchema>;

/**
 * Revision-fenced replacement of the live streaming partial. Cheaper than a
 * full state replacement per streamed chunk while staying a single
 * authoritative shape (no text-diff reconstruction on the client).
 */
export const SideChatDeltaSchema = z.strictObject({
  conversationId: SideChatIdSchema,
  runId: SideChatIdSchema,
  previousRevision: z.number().int().nonnegative().safe(),
  revision: z.number().int().positive().safe(),
  partial: StreamingAgentMessageSchema,
}).superRefine((delta, ctx) => {
  if (delta.revision <= delta.previousRevision) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "side chat delta revision must advance" });
  }
});
export type SideChatDelta = z.infer<typeof SideChatDeltaSchema>;

/**
 * Apply a streaming-partial replacement while preserving the fences. The
 * display budget is enforced exactly like the authority: the live partial is
 * kept intact and the OLDEST whole messages are dropped when history fills
 * the aggregate budget (the adapter already published fine-clamped state;
 * this is the client-side accumulator's safety net with identical
 * semantics).
 */
export function applySideChatDelta(state: SideChatState | null | undefined, delta: SideChatDelta): SideChatState {
  if (state === null || state === undefined) throw new Error("side chat delta requires state");
  if (state.conversationId !== delta.conversationId || state.runId !== delta.runId) throw new Error("stale side chat identity");
  if (state.revision !== delta.previousRevision || delta.revision <= delta.previousRevision) throw new Error("stale side chat revision");
  let messages = state.messages;
  let messagesTruncated = state.messagesTruncated;
  let totalCharsTruncated = state.totalCharsTruncated;
  let total = messages.reduce((sum, message) => sum + messageDisplayChars(message), 0) + partialDisplayChars(delta.partial);
  while (total > MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS && messages.length > 0) {
    total -= messageDisplayChars(messages[0]!);
    messages = messages.slice(1);
    messagesTruncated = true;
    totalCharsTruncated = true;
  }
  return { ...state, revision: delta.revision, messages, messagesTruncated, totalCharsTruncated, partialMessage: delta.partial };
}
