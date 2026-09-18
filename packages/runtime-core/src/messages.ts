/**
 * Canonical message / content / tool models.
 *
 * These are the normalized product shapes for messages, content blocks, tool
 * calls, tool results, token usage and context usage. They deliberately never
 * reference SDK message/content types; adapters translate backend shapes into
 * these DTOs.
 */

/** Reasoning level used by the runtime. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Image attachment on prompt / steer / follow_up commands. */
export interface ImageAttachment {
  type: "image";
  /** Base64-encoded image data. */
  data: string;
  /** Image mime type, e.g. `image/png`. */
  mimeType: string;
}

/** Streaming behavior hint for queued commands. */
export type StreamingBehavior = "steer" | "followUp";

/* ------------------------------------------------------------------ */
/* Content blocks                                                      */
/* ------------------------------------------------------------------ */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContentSource {
  type: "base64" | "url";
  /** Media type for base64 sources (`image/*`) or the URL for url sources. */
  media_type?: string;
  /** Raw data for base64 sources, or the URL string. */
  data?: string;
  url?: string;
}

export interface ImageContent {
  type: "image";
  source: ImageContentSource;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  /** Tool arguments are intentionally untyped — tool schemas vary by backend. */
  input: unknown;
}

export type AssistantContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCallContent;

export type UserContent = string | readonly (TextContent | ImageContent)[];

/* ------------------------------------------------------------------ */
/* Usage / context                                                     */
/* ------------------------------------------------------------------ */

export interface TokenUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Normalized token usage. All fields are numbers and **zero values are
 * significant** — adapters must not drop a zero field; a missing field means
 * "unknown", a zero field means "zero tokens".
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: TokenUsageCost;
}

/** Context-window occupancy of a session. */
export interface ContextUsage {
  /** Percentage of the context window used (0-100). */
  percent: number;
  contextWindow?: number;
  tokens?: number;
}

/* ------------------------------------------------------------------ */
/* Complete messages                                                   */
/* ------------------------------------------------------------------ */

export interface UserMessage {
  role: "user";
  content: UserContent;
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: readonly AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: TokenUsage;
  /** Files this assistant turn wrote or modified (canonical path strings). */
  writtenFiles?: readonly string[];
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: readonly (TextContent | ImageContent)[];
  /** `true` when the tool failed; `false`/omitted means success. */
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: UserContent;
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

/** Complete normalized agent message. */
export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | BashExecutionMessage;

/* ------------------------------------------------------------------ */
/* Streaming (partial) messages                                        */
/* ------------------------------------------------------------------ */

/**
 * Streaming message projections for message_start / message_update.
 * Fields not yet known are omitted; present fields are fully typed.
 */
export interface StreamingUserMessage {
  role: "user";
  content?: UserContent;
  timestamp?: number;
}

export interface StreamingAssistantMessage {
  role: "assistant";
  content?: readonly AssistantContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: TokenUsage;
  writtenFiles?: readonly string[];
}

export interface StreamingToolResultMessage {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  content?: readonly (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface StreamingCustomMessage {
  role: "custom";
  customType?: string;
  content?: UserContent;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface StreamingBashExecutionMessage {
  role: "bashExecution";
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export type StreamingAgentMessage =
  | StreamingUserMessage
  | StreamingAssistantMessage
  | StreamingToolResultMessage
  | StreamingCustomMessage
  | StreamingBashExecutionMessage;
