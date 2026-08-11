/**
 * Canonical side-chat main-session snapshot DTO.
 *
 * The Pi SDK snapshot for side chat contains non-serializable objects
 * (the backend session reader). Runtime Core defines this serializable DTO
 * instead; the adapter constructs it from SDK/RPC state, and workers/sessiond
 * only ever transport the canonical DTO. It is consumed by the side-chat
 * extension for `peek_main`-style tools, system-prompt injection and
 * file-overlap checks.
 */

export interface SideChatActivityItem {
  /** Entry id in the main session's JSONL. */
  entryId: string;
  role: "user" | "assistant" | "toolResult";
  /** Adapter-rendered display text (truncated). */
  text: string;
  toolName?: string;
}

export interface SideChatMainSnapshot {
  sessionId: string;
  /** Main session system prompt (for before_agent_start injection). */
  systemPrompt?: string;
  /** Files the main session has written or modified (deduped). */
  writtenFiles: readonly string[];
  /** Recent main-thread activity, oldest first. */
  activity: readonly SideChatActivityItem[];
  /** Fork leaf the snapshot was produced from (for since-fork filtering). */
  forkLeafId?: string;
  /** Monotonic version; changes when the main session advances. */
  version: number;
}
