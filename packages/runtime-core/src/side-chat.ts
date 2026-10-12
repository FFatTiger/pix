import type {
  AgentMessage,
  AssistantContentBlock,
  StreamingAgentMessage,
  ThinkingLevel,
} from "./messages.js";
import type { ModelRef } from "./model.js";

export const SIDE_CHAT_STATUSES = ["idle", "running"] as const;
export type SideChatStatus = (typeof SIDE_CHAT_STATUSES)[number];

export const MAX_SIDE_CHAT_MESSAGES = 64;
export const MAX_SIDE_CHAT_MESSAGE_CHARS = 16_384;
export const MAX_SIDE_CHAT_STREAM_CHARS = 16_384;
export const MAX_SIDE_CHAT_TOTAL_DISPLAY_CHARS = 262_144;
export const MAX_SIDE_CHAT_ID_CHARS = 128;

export interface SideChatError {
  code: "run_failed";
  message: "Side chat request failed";
}

/**
 * Bounded reconnect/display projection. Messages reuse the main transcript
 * message spec verbatim; only the text/thinking prose is clamped to the
 * display budgets (tool arguments/results are adapter-sanitized, not
 * budgeted — same semantics the side chat always had). Model input remains
 * unmodified inside the controller.
 */
export interface SideChatState {
  conversationId: string;
  revision: number;
  runId?: string;
  /** Effective model for subsequent side-chat turns (captured at start, mutable via side_chat_set_model). */
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  status: SideChatStatus;
  messages: readonly AgentMessage[];
  messagesTruncated: boolean;
  totalCharsTruncated: boolean;
  /** Live streaming partial for the in-flight turn (main-session shape). */
  partialMessage: StreamingAgentMessage | null;
  error?: SideChatError;
}

export interface SideChatDelta {
  conversationId: string;
  runId: string;
  previousRevision: number;
  revision: number;
  partial: StreamingAgentMessage;
}

function boundedText(value: string, max: number): { value: string; truncated: boolean } {
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

/** Clamp one message's text/thinking prose to the remaining budget. */
function boundMessage(
  message: AgentMessage,
  remaining: number,
): { message: AgentMessage; chars: number; truncated: boolean } {
  if (message.role !== "assistant") {
    if (message.role === "user" && typeof message.content === "string") {
      const clamped = boundedText(message.content, Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, remaining));
      return {
        message: clamped.value === message.content ? message : { ...message, content: clamped.value },
        chars: clamped.value.length,
        truncated: clamped.truncated,
      };
    }
    return { message, chars: 0, truncated: false };
  }
  let left = remaining;
  let truncated = false;
  let changed = false;
  const blocks: AssistantContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      const clamped = boundedText(block.text, Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, left));
      left -= clamped.value.length;
      truncated = truncated || clamped.truncated;
      changed = changed || clamped.value !== block.text;
      blocks.push({ ...block, text: clamped.value });
    } else if (block.type === "thinking") {
      const clamped = boundedText(block.thinking, Math.min(MAX_SIDE_CHAT_MESSAGE_CHARS, left));
      left -= clamped.value.length;
      truncated = truncated || clamped.truncated;
      changed = changed || clamped.value !== block.thinking;
      blocks.push({ ...block, thinking: clamped.value });
    } else {
      blocks.push(block);
    }
  }
  return {
    message: changed ? { ...message, content: blocks } : message,
    chars: remaining - left,
    truncated,
  };
}

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

/** Clamp the live partial's text/thinking prose within the stream budget. */
function boundPartial(
  partial: StreamingAgentMessage,
  budget: number,
): { partial: StreamingAgentMessage; chars: number; truncated: boolean } {
  if (partial.role !== "assistant" || partial.content === undefined) {
    return { partial, chars: 0, truncated: false };
  }
  let left = Math.min(MAX_SIDE_CHAT_STREAM_CHARS, budget);
  let truncated = false;
  let changed = false;
  const blocks: AssistantContentBlock[] = [];
  for (const block of partial.content) {
    if (block.type === "text") {
      const clamped = boundedText(block.text, left);
      left -= clamped.value.length;
      truncated = truncated || clamped.truncated;
      changed = changed || clamped.value !== block.text;
      blocks.push({ ...block, text: clamped.value });
    } else if (block.type === "thinking") {
      const clamped = boundedText(block.thinking, left);
      left -= clamped.value.length;
      truncated = truncated || clamped.truncated;
      changed = changed || clamped.value !== block.thinking;
      blocks.push({ ...block, thinking: clamped.value });
    } else {
      blocks.push(block);
    }
  }
  return {
    partial: changed ? { ...partial, content: blocks } : partial,
    chars: Math.min(MAX_SIDE_CHAT_STREAM_CHARS, budget) - left,
    truncated,
  };
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
  let partial: StreamingAgentMessage | null = null;
  if (input.partialMessage !== null) {
    const bounded = boundPartial(input.partialMessage, remaining);
    remaining -= bounded.chars;
    if (bounded.truncated || (bounded.chars > 0 && remaining <= 0 && bounded.partial.role === "assistant")) totalCharsTruncated = true;
    partial = bounded.partial;
  }

  const reverseMessages: AgentMessage[] = [];
  let omittedMessages = false;
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    const message = sourceMessages[index]!;
    const cost = messageDisplayChars(message);
    if (remaining === 0 && cost > 0) {
      totalCharsTruncated = true;
      omittedMessages = true;
      continue;
    }
    const bounded = boundMessage(message, remaining);
    remaining -= bounded.chars;
    if (bounded.truncated) totalCharsTruncated = true;
    reverseMessages.push(bounded.message);
  }
  const messages = reverseMessages.reverse();
  return {
    conversationId: sideChatId(input.conversationId, "side chat conversation id"),
    revision: input.revision,
    ...(input.runId === undefined ? {} : { runId: sideChatId(input.runId, "side chat run id") }),
    model: { ...input.model },
    thinkingLevel: input.thinkingLevel,
    status: input.status,
    messages,
    messagesTruncated: input.messagesTruncated === true || input.messages.length > MAX_SIDE_CHAT_MESSAGES || omittedMessages,
    totalCharsTruncated,
    partialMessage: partial,
    ...(input.error === undefined ? {} : { error: { code: "run_failed" as const, message: "Side chat request failed" as const } }),
  };
}

/** Fail-closed streaming-partial replacement with identity/revision fences. */
export function applySideChatDelta(state: SideChatState | null | undefined, delta: SideChatDelta): SideChatState {
  if (state === null || state === undefined) throw new Error("side chat delta requires state");
  if (state.conversationId !== delta.conversationId || state.runId !== delta.runId) throw new Error("stale side chat identity");
  if (state.revision !== delta.previousRevision || delta.revision <= delta.previousRevision) throw new Error("stale side chat revision");
  return boundSideChatState({
    ...state,
    revision: delta.revision,
    partialMessage: delta.partial,
  });
}
