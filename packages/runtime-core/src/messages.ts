/**
 * Canonical message / content / tool models.
 *
 * These are the normalized product shapes for messages, content blocks, tool
 * calls, tool results, token usage and context usage. They deliberately never
 * reference SDK message/content types; adapters translate backend shapes into
 * these DTOs.
 */

/** Reasoning level used by the runtime. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Supported input image media types (PNG / JPEG / GIF / WebP). */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

/** Max canonical base64 characters of one image (existing per-image ceiling). */
export const MAX_IMAGE_BASE64_LENGTH = 14_000_000;
/** Max images on one prompt / steer / follow_up / submit_turn input. */
export const MAX_IMAGE_ATTACHMENTS = 8;
/** Shared aggregate base64 character budget across all input images. */
export const MAX_IMAGE_INPUT_BASE64_LENGTH = 14_000_000;
/** Preparation threshold for original source bytes; not a JPEG-quality policy. */
export const MAX_IMAGE_SOURCE_BYTES = 10 * 1024 * 1024;

/** Image attachment on prompt / steer / follow_up commands. */
export interface ImageAttachment {
  type: "image";
  /** Base64-encoded image data. */
  data: string;
  /** Image mime type, e.g. `image/png`. Vocabulary is {@link SUPPORTED_IMAGE_MEDIA_TYPES}. */
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

export const NESTED_TOOL_CALL_STATUSES = ["ok", "error", "unfinished"] as const;
export const MAX_NESTED_TOOL_CALLS = 256;
export const MAX_NESTED_TOOL_ERROR_CHARS = 500;

/** Per-call captured child output text cap (adapter-collected nested results). */
export const MAX_NESTED_RESULT_TEXT_CHARS = 4000;
/** Whole-batch budget for the persisted nested-results record (UTF-8 bytes). */
export const MAX_NESTED_RESULTS_ENTRY_BYTES = 64 * 1024;

/**
 * Bounded output of ONE nested call, collected by the adapter from the
 * runtime `tool_execution_end` event (the SDK's `nestedCalls` record never
 * carries results). Text is redacted and capped; images are counted only.
 */
export interface NestedToolCallResult {
  /** Redacted text blocks joined with `\n`, capped at {@link MAX_NESTED_RESULT_TEXT_CHARS} chars. */
  text: string;
  /** `true` when the source text exceeded the per-call cap and was cut. */
  truncated: boolean;
  /** Number of image content blocks in the child result (bytes never stored). */
  imageCount: number;
  /** Whether the child tool execution reported an error. */
  isError: boolean;
}

/** Execution summaries belong to the parent tool result; they are not transcript entries. */
export interface NestedToolCalls {
  calls: readonly {
    id: string;
    name: string;
    arguments?: unknown;
    argumentsBytes?: number;
    status: typeof NESTED_TOOL_CALL_STATUSES[number];
    durationMs?: number;
    error?: string;
    /** Adapter-collected child output; absent for old records and over-budget calls. */
    result?: NestedToolCallResult;
  }[];
  complete: boolean;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: readonly (TextContent | ImageContent)[];
  /** `true` when the tool failed; `false`/omitted means success. */
  isError?: boolean;
  details?: unknown;
  nestedCalls?: NestedToolCalls;
  structuredContent?: unknown;
  /** Usage charged by this tool, including its nested calls exactly once. */
  usage?: TokenUsage;
  /** Recorded execution time in milliseconds; absent for legacy results (Pi 1.1+). */
  durationMs?: number;
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
  nestedCalls?: NestedToolCalls;
  structuredContent?: unknown;
  usage?: TokenUsage;
  /** Recorded execution time in milliseconds; absent for legacy results (Pi 1.1+). */
  durationMs?: number;
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
