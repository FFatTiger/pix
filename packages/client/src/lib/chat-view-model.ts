/**
 * Narrow view-model types for the ported message rendering components
 * (components/chat/**).
 *
 * The chat view components are direct ports from the legacy desktop source.
 * They never
 * import the Pi SDK: the message shapes they consume are the pix protocol
 * message spec (`@fffattiger/pix-protocol`), which is structurally identical
 * to the source message-type mirror. Re-exporting them here keeps the
 * components source-identical while giving pix a single narrow seam.
 *
 * The branch tree below is the future `SessionTreeDto` adapter target: the
 * host does not expose a tree DTO yet, so BranchNavigator consumes this
 * narrow structural shape and a later adapter maps the DTO onto it.
 */
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@fffattiger/pix-protocol";

export type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
};

/**
 * Narrow session-tree node consumed by BranchNavigator.
 *
 * Only the fields the tree view reads: entry identity, kind, and — for
 * message entries — role plus content (for the row label). The future
 * SessionTreeDto adapter fills this in; unknown entry kinds render as their
 * `type` string exactly like the source.
 */
export interface SessionTreeEntry {
  type: string;
  id: string;
  message?: { role: string; content: unknown };
}

export interface SessionTreeNode {
  entry: SessionTreeEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
}

/** Skill metadata surfaced in the user-message skill tooltip. */
export interface ChatSkillInfo {
  description?: string;
  filePath?: string;
}

/** Skill name → tooltip metadata (future catalog/skills adapter target). */
export type ChatSkillIndex = Map<string, ChatSkillInfo>;

/**
 * Loads deferred thinking content for one thinking block of a session entry.
 * Wired to the host session-entry API by the future transcript wrapper.
 */
export type DeferredThinkingLoader = (
  sessionId: string,
  entryId: string,
  blockIndex: number,
) => Promise<string>;

/** Loads the full on-disk output of a truncated bash execution. */
export type BashFullOutputLoader = (
  sessionId: string,
  fullOutputPath: string,
) => Promise<string>;

/* —— ChatInput adapter surface (ported composer; components/chat/ChatInput.tsx) ——
 *
 * The source typed these against its useAgentSession hook / api-types module
 * (both are Next/Electron-coupled and must not be copied). pix re-declares the
 * exact shapes the composer consumes; pix-protocol's SlashCommandInfo is
 * structurally identical to the source type, so it is re-exported as-is.
 */

/** Queued steering / follow-up prompts not yet delivered by the agent. */
export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

/** Result summary shown in the composer's compact banner. */
export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

/** Outcome of a builtin /compact-style command handled by the host surface. */
export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

/** Slash-command catalog entry (pix protocol DTO ≡ source SlashCommandInfo). */
export type { SlashCommandInfo } from "@fffattiger/pix-protocol";

/** Narrow slice of the source SkillsResponse the slash palette reads: which
 *  skills are dormant (not invocable). The future integration maps the pix
 *  /v1/skills catalog onto this shape. */
export interface SkillDormancySkill {
  name: string;
  disableModelInvocation: boolean;
}

export interface SkillDormancyResponse {
  skills: SkillDormancySkill[];
}

/** Mention-highlight validity snapshot (source hooks/useProjectContext
 *  FileIndexSnapshot): lowercase cwd-relative file paths and directories. */
export interface ChatFileIndexSnapshot {
  cwd: string;
  /** Lowercased cwd-relative paths (files) and dirs, no trailing "/" */
  paths: Set<string>;
  dirs: Set<string>;
  /** True when the listing hit the server's cap — misses may be false negatives */
  truncated: boolean;
}

/** Narrow typing for the optional desktop bridge the composer probes for
 *  dropped-file absolute paths (source global.d.ts piDesktop slice). The pix
 *  web client never defines it, so the browser upload fallback runs instead. */
declare global {
  interface Window {
    piDesktop?: {
      getPathForFile: (file: File) => string;
    };
  }
}
