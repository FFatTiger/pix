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
