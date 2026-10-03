import { z } from "zod";
import { ModelRefSchema, NonEmptyStringSchema, ThinkingLevelSchema } from "./common.js";

export const MAX_SIDE_CHAT_MESSAGES = 64;
export const MAX_SIDE_CHAT_MESSAGE_CHARS = 16_384;
export const MAX_SIDE_CHAT_STREAM_CHARS = 16_384;
export const MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS = 262_144;
export const MAX_SIDE_CHAT_TOOLS = 64;
export const MAX_SIDE_CHAT_ID_CHARS = 128;
export const MAX_SIDE_CHAT_TOOL_NAME_CHARS = 128;
export const MAX_SIDE_CHAT_PATH_CHARS = 4_096;

export const SideChatIdSchema = NonEmptyStringSchema.max(MAX_SIDE_CHAT_ID_CHARS);
export const SideChatModeSchema = z.enum(["read_only", "edit"]);
export type SideChatMode = z.infer<typeof SideChatModeSchema>;
export const SideChatStatusSchema = z.enum(["idle", "running", "awaiting_overlap"]);
export type SideChatStatus = z.infer<typeof SideChatStatusSchema>;

export const SideChatMessageSchema = z.strictObject({
  id: SideChatIdSchema,
  role: z.enum(["user", "assistant", "toolResult"]),
  text: z.string().max(MAX_SIDE_CHAT_MESSAGE_CHARS),
  thinking: z.string().max(MAX_SIDE_CHAT_MESSAGE_CHARS).optional(),
  toolName: z.string().max(MAX_SIDE_CHAT_TOOL_NAME_CHARS).optional(),
  isError: z.boolean().optional(),
  textTruncated: z.boolean(),
  thinkingTruncated: z.boolean(),
});
export type SideChatMessage = z.infer<typeof SideChatMessageSchema>;

export const SideChatStreamSchema = z.strictObject({
  text: z.string().max(MAX_SIDE_CHAT_STREAM_CHARS),
  thinking: z.string().max(MAX_SIDE_CHAT_STREAM_CHARS),
  textTruncated: z.boolean(),
  thinkingTruncated: z.boolean(),
});
export type SideChatStream = z.infer<typeof SideChatStreamSchema>;

export const SideChatToolStatusSchema = z.strictObject({
  toolCallId: SideChatIdSchema,
  name: z.string().max(MAX_SIDE_CHAT_TOOL_NAME_CHARS),
  status: z.enum(["running", "completed", "failed"]),
  nameTruncated: z.boolean(),
});
export type SideChatToolStatus = z.infer<typeof SideChatToolStatusSchema>;

export const SideChatOverlapSchema = z.strictObject({
  id: SideChatIdSchema,
  runId: SideChatIdSchema,
  path: z.string().max(MAX_SIDE_CHAT_PATH_CHARS),
  pathTruncated: z.boolean(),
});
export type SideChatOverlap = z.infer<typeof SideChatOverlapSchema>;

export const SideChatErrorSchema = z.strictObject({
  code: z.literal("run_failed"),
  message: z.literal("Side chat request failed"),
});
export type SideChatError = z.infer<typeof SideChatErrorSchema>;

export const SideChatStateSchema = z.strictObject({
  conversationId: SideChatIdSchema,
  revision: z.number().int().nonnegative().safe(),
  runId: SideChatIdSchema.optional(),
  capturedModel: ModelRefSchema,
  capturedThinkingLevel: ThinkingLevelSchema,
  mode: SideChatModeSchema,
  status: SideChatStatusSchema,
  messages: z.array(SideChatMessageSchema).max(MAX_SIDE_CHAT_MESSAGES),
  messagesTruncated: z.boolean(),
  totalCharsTruncated: z.boolean(),
  stream: SideChatStreamSchema,
  tools: z.array(SideChatToolStatusSchema).max(MAX_SIDE_CHAT_TOOLS),
  pendingOverlap: SideChatOverlapSchema.optional(),
  error: SideChatErrorSchema.optional(),
}).superRefine((state, ctx) => {
  if ((state.status === "running" || state.status === "awaiting_overlap") && state.runId === undefined) {
    ctx.addIssue({ code: "custom", path: ["runId"], message: "active side chat requires runId" });
  }
  if ((state.status === "awaiting_overlap") !== (state.pendingOverlap !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["pendingOverlap"], message: "pending overlap must match awaiting status" });
  }
  if (state.pendingOverlap !== undefined && state.pendingOverlap.runId !== state.runId) {
    ctx.addIssue({ code: "custom", path: ["pendingOverlap", "runId"], message: "overlap runId must match state runId" });
  }
  const total = state.messages.reduce((sum, message) => sum + message.text.length + (message.thinking?.length ?? 0), 0)
    + state.stream.text.length + state.stream.thinking.length;
  if (total > MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS) {
    ctx.addIssue({ code: "custom", path: ["messages"], message: "side chat display budget exceeded" });
  }
});
export type SideChatState = z.infer<typeof SideChatStateSchema>;

export const SideChatDeltaSchema = z.strictObject({
  conversationId: SideChatIdSchema,
  runId: SideChatIdSchema,
  previousRevision: z.number().int().nonnegative().safe(),
  revision: z.number().int().positive().safe(),
  kind: z.enum(["text", "thinking"]),
  delta: z.string().max(MAX_SIDE_CHAT_STREAM_CHARS),
}).superRefine((delta, ctx) => {
  if (delta.revision <= delta.previousRevision) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "side chat delta revision must advance" });
  }
});
export type SideChatDelta = z.infer<typeof SideChatDeltaSchema>;

function bounded(value: string, max: number): { value: string; truncated: boolean } {
  return value.length <= max ? { value, truncated: false } : { value: value.slice(0, max), truncated: true };
}

/** Apply a side stream delta while preserving the live answer before newest history. */
export function applySideChatDelta(state: SideChatState | null | undefined, delta: SideChatDelta): SideChatState {
  if (state === null || state === undefined) throw new Error("side chat delta requires state");
  if (state.conversationId !== delta.conversationId || state.runId !== delta.runId) throw new Error("stale side chat identity");
  if (state.revision !== delta.previousRevision || delta.revision <= delta.previousRevision) throw new Error("stale side chat revision");

  const current = delta.kind === "text" ? state.stream.text : state.stream.thinking;
  const combined = current + delta.delta;
  const updatedStream = delta.kind === "text"
    ? { ...state.stream, text: combined, textTruncated: state.stream.textTruncated || combined.length > MAX_SIDE_CHAT_STREAM_CHARS }
    : { ...state.stream, thinking: combined, thinkingTruncated: state.stream.thinkingTruncated || combined.length > MAX_SIDE_CHAT_STREAM_CHARS };

  let remaining = MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS;
  let totalCharsTruncated = state.totalCharsTruncated;
  const text = bounded(updatedStream.text, Math.min(MAX_SIDE_CHAT_STREAM_CHARS, remaining));
  remaining -= text.value.length;
  const thinking = bounded(updatedStream.thinking, Math.min(MAX_SIDE_CHAT_STREAM_CHARS, remaining));
  remaining -= thinking.value.length;
  if (text.truncated || thinking.truncated) totalCharsTruncated = true;

  const reverseMessages: SideChatState["messages"][number][] = [];
  let omittedMessages = false;
  const sourceMessages = state.messages.slice(-MAX_SIDE_CHAT_MESSAGES);
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    const message = sourceMessages[index]!;
    const sourceThinking = message.thinking ?? "";
    if (remaining === 0 && (message.text.length > 0 || sourceThinking.length > 0)) {
      totalCharsTruncated = true;
      omittedMessages = true;
      continue;
    }
    const messageText = bounded(message.text, Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, remaining));
    remaining -= messageText.value.length;
    const messageThinking = bounded(sourceThinking, Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, remaining));
    remaining -= messageThinking.value.length;
    if (messageText.truncated || messageThinking.truncated) totalCharsTruncated = true;
    reverseMessages.push({
      ...message,
      text: messageText.value,
      ...(message.thinking === undefined ? {} : { thinking: messageThinking.value }),
      textTruncated: message.textTruncated || messageText.truncated,
      thinkingTruncated: message.thinkingTruncated || messageThinking.truncated,
    });
  }

  return {
    ...state,
    revision: delta.revision,
    messages: reverseMessages.reverse(),
    messagesTruncated: state.messagesTruncated || omittedMessages,
    totalCharsTruncated,
    stream: {
      text: text.value,
      thinking: thinking.value,
      textTruncated: updatedStream.textTruncated || text.truncated,
      thinkingTruncated: updatedStream.thinkingTruncated || thinking.truncated,
    },
  };
}
