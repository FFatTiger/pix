import type { ThinkingLevel } from "./messages.js";
import type { ModelRef } from "./model.js";

export const SIDE_CHAT_MODES = ["read_only", "edit"] as const;
export type SideChatMode = (typeof SIDE_CHAT_MODES)[number];

export const SIDE_CHAT_STATUSES = ["idle", "running", "awaiting_overlap"] as const;
export type SideChatStatus = (typeof SIDE_CHAT_STATUSES)[number];

export const SIDE_CHAT_MESSAGE_ROLES = ["user", "assistant", "toolResult"] as const;
export type SideChatMessageRole = (typeof SIDE_CHAT_MESSAGE_ROLES)[number];

export const SIDE_CHAT_TOOL_STATUSES = ["running", "completed", "failed"] as const;
export type SideChatToolStatusKind = (typeof SIDE_CHAT_TOOL_STATUSES)[number];

export const MAX_SIDE_CHAT_MESSAGES = 64;
export const MAX_SIDE_CHAT_MESSAGE_CHARS = 16_384;
export const MAX_SIDE_CHAT_STREAM_CHARS = 16_384;
export const MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS = 262_144;
export const MAX_SIDE_CHAT_TOOLS = 64;
export const MAX_SIDE_CHAT_ID_CHARS = 128;
export const MAX_SIDE_CHAT_TOOL_NAME_CHARS = 128;
export const MAX_SIDE_CHAT_PATH_CHARS = 4_096;

export interface SideChatMessage {
  id: string;
  role: SideChatMessageRole;
  text: string;
  thinking?: string;
  toolName?: string;
  isError?: boolean;
  textTruncated: boolean;
  thinkingTruncated: boolean;
}

export interface SideChatStream {
  text: string;
  thinking: string;
  textTruncated: boolean;
  thinkingTruncated: boolean;
}

export interface SideChatToolStatus {
  toolCallId: string;
  name: string;
  status: SideChatToolStatusKind;
  nameTruncated: boolean;
}

export interface SideChatOverlap {
  id: string;
  runId: string;
  path: string;
  pathTruncated: boolean;
}

export interface SideChatError {
  code: "run_failed";
  message: "Side chat request failed";
}

/** Bounded reconnect/display projection. Model input remains unmodified inside the controller. */
export interface SideChatState {
  conversationId: string;
  revision: number;
  runId?: string;
  capturedModel: ModelRef;
  capturedThinkingLevel: ThinkingLevel;
  mode: SideChatMode;
  status: SideChatStatus;
  messages: readonly SideChatMessage[];
  messagesTruncated: boolean;
  totalCharsTruncated: boolean;
  stream: SideChatStream;
  tools: readonly SideChatToolStatus[];
  pendingOverlap?: SideChatOverlap;
  error?: SideChatError;
}

export interface SideChatDelta {
  conversationId: string;
  runId: string;
  previousRevision: number;
  revision: number;
  kind: "text" | "thinking";
  delta: string;
}

function bounded(value: string, max: number): { value: string; truncated: boolean } {
  return value.length <= max
    ? { value, truncated: false }
    : { value: value.slice(0, max), truncated: true };
}

function sideChatId(value: string, field: string): string {
  if (value.length === 0 || value.length > MAX_SIDE_CHAT_ID_CHARS || !/[^\s]/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

/** Clamp a trusted adapter projection to the canonical display budgets. */
export function boundSideChatState(input: Omit<SideChatState, "messagesTruncated" | "totalCharsTruncated"> & {
  messagesTruncated?: boolean;
  totalCharsTruncated?: boolean;
}): SideChatState {
  const sourceMessages = input.messages.slice(-MAX_SIDE_CHAT_MESSAGES);
  let remaining = MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS;
  let totalCharsTruncated = input.totalCharsTruncated === true;

  // Preserve the live answer first. Old transcript context is useful, but an
  // in-flight response must never disappear merely because history filled the
  // aggregate display budget.
  const streamText = bounded(input.stream.text, Math.min(MAX_SIDE_CHAT_STREAM_CHARS, remaining));
  remaining -= streamText.value.length;
  const streamThinking = bounded(input.stream.thinking, Math.min(MAX_SIDE_CHAT_STREAM_CHARS, remaining));
  remaining -= streamThinking.value.length;
  if (streamText.truncated || streamThinking.truncated) totalCharsTruncated = true;

  const reverseMessages: SideChatMessage[] = [];
  let omittedMessages = false;
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    const message = sourceMessages[index]!;
    const sourceThinking = message.thinking ?? "";
    if (remaining === 0 && (message.text.length > 0 || sourceThinking.length > 0)) {
      totalCharsTruncated = true;
      omittedMessages = true;
      continue;
    }
    const textLimit = Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, remaining);
    const text = bounded(message.text, textLimit);
    remaining -= text.value.length;
    const thinkingLimit = Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, remaining);
    const thinking = bounded(sourceThinking, thinkingLimit);
    remaining -= thinking.value.length;
    if (text.truncated || thinking.truncated) totalCharsTruncated = true;
    reverseMessages.push({
      id: sideChatId(message.id, "side chat message id"),
      role: message.role,
      text: text.value,
      ...(message.thinking === undefined ? {} : { thinking: thinking.value }),
      ...(message.toolName === undefined ? {} : { toolName: bounded(message.toolName, MAX_SIDE_CHAT_TOOL_NAME_CHARS).value }),
      ...(message.isError === undefined ? {} : { isError: message.isError }),
      textTruncated: message.textTruncated || text.truncated,
      thinkingTruncated: message.thinkingTruncated || thinking.truncated,
    });
  }
  const messages = reverseMessages.reverse();
  return {
    conversationId: sideChatId(input.conversationId, "side chat conversation id"),
    revision: input.revision,
    ...(input.runId === undefined ? {} : { runId: sideChatId(input.runId, "side chat run id") }),
    capturedModel: { ...input.capturedModel },
    capturedThinkingLevel: input.capturedThinkingLevel,
    mode: input.mode,
    status: input.status,
    messages,
    messagesTruncated: input.messagesTruncated === true || input.messages.length > MAX_SIDE_CHAT_MESSAGES || omittedMessages,
    totalCharsTruncated,
    stream: {
      text: streamText.value,
      thinking: streamThinking.value,
      textTruncated: input.stream.textTruncated || streamText.truncated,
      thinkingTruncated: input.stream.thinkingTruncated || streamThinking.truncated,
    },
    tools: input.tools.slice(0, MAX_SIDE_CHAT_TOOLS).map((tool) => {
      const name = bounded(tool.name, MAX_SIDE_CHAT_TOOL_NAME_CHARS);
      return {
        toolCallId: sideChatId(tool.toolCallId, "side chat tool call id"),
        name: name.value,
        status: tool.status,
        nameTruncated: tool.nameTruncated || name.truncated,
      };
    }),
    ...(input.pendingOverlap === undefined ? {} : {
      pendingOverlap: {
        id: sideChatId(input.pendingOverlap.id, "side chat overlap request id"),
        runId: sideChatId(input.pendingOverlap.runId, "side chat overlap run id"),
        path: bounded(input.pendingOverlap.path, MAX_SIDE_CHAT_PATH_CHARS).value,
        pathTruncated: input.pendingOverlap.pathTruncated || input.pendingOverlap.path.length > MAX_SIDE_CHAT_PATH_CHARS,
      },
    }),
    ...(input.error === undefined ? {} : { error: { code: "run_failed", message: "Side chat request failed" } }),
  };
}

/** Fail-closed append-only stream reduction with identity/revision fences and canonical clamping. */
export function applySideChatDelta(state: SideChatState | null | undefined, delta: SideChatDelta): SideChatState {
  if (state === null || state === undefined) throw new Error("side chat delta requires state");
  if (state.conversationId !== delta.conversationId || state.runId !== delta.runId) throw new Error("stale side chat identity");
  if (state.revision !== delta.previousRevision || delta.revision <= delta.previousRevision) throw new Error("stale side chat revision");
  const current = delta.kind === "text" ? state.stream.text : state.stream.thinking;
  const combined = current + delta.delta;
  return boundSideChatState({
    ...state,
    revision: delta.revision,
    stream: delta.kind === "text"
      ? { ...state.stream, text: combined, textTruncated: state.stream.textTruncated || combined.length > MAX_SIDE_CHAT_STREAM_CHARS }
      : { ...state.stream, thinking: combined, thinkingTruncated: state.stream.thinkingTruncated || combined.length > MAX_SIDE_CHAT_STREAM_CHARS },
  });
}
