/**
 * Canonical session DTOs for the read-side catalog and the activation-side
 * locator. No backend session objects ever cross these ports — only
 * serializable headers, contexts and locations.
 */
import type { AgentMessage, ContextUsage } from "./messages.js";

export interface SessionListFilter {
  limit?: number;
  offset?: number;
  cwd?: string;
}

export interface SessionHeader {
  sessionId: string;
  sessionFile?: string;
  /** Canonical working directory recorded by the session. */
  cwd: string;
  /** Canonical project root used for grouping and trust policy. */
  projectRoot: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  lastMessageAt?: number;
  messageCount?: number;
  /** Session this one was forked from (fork provenance). */
  parentSessionId?: string;
  /** Entry id the fork was created at. */
  forkPointEntryId?: string;
}

export interface SessionDetail extends SessionHeader {
  /** Complete entry list of the session (truth source projection). */
  entries?: readonly SessionEntry[];
}

export interface SessionEntry {
  entryId: string;
  parentEntryId?: string;
  message: AgentMessage;
}

export interface SessionContext {
  sessionId: string;
  leafId?: string;
  entries: readonly SessionEntry[];
}

/* ------------------------------------------------------------------ */
/* Normalized session branch tree (read-only navigation projection)    */
/* ------------------------------------------------------------------ */

/**
 * Normalized entry classification for a branch-tree node. Message-like
 * entries keep the canonical AgentMessage role vocabulary (user / assistant /
 * toolResult / bashExecution / custom); structural entries (model/thinking/
 * label/session-info changes, plain custom state, compaction and branch
 * summaries) are `system`. This is the pix canonical vocabulary — never a
 * backend SDK role or entry-type string.
 */
export type SessionTreeNodeKind =
  | "user"
  | "assistant"
  | "toolResult"
  | "bashExecution"
  | "custom"
  | "system";

/**
 * A single node of the normalized branch tree.
 *
 * The tree keeps roots, branch points and leaves; single-child linear chains
 * between them are contracted into the next kept node via `skippedEntryIds`
 * (the compressed entry ids stay addressable so a selected leaf inside a
 * contracted chain still resolves). No backend SDK node object, raw file
 * path, raw message object, thinking text or tool input/output is ever
 * carried — only the entry id, structural links, a normalized kind and a
 * length-capped safe preview label.
 */
export interface SessionTreeNode {
  /** Canonical entry id (same id space as SessionEntry / context leafId). */
  entryId: string;
  /** Parent entry id; absent on roots (including malformed/orphan roots). */
  parentEntryId?: string;
  /** Normalized classification driving rendering (never a backend string). */
  kind: SessionTreeNodeKind;
  /** Safe, single-line preview; length-capped (see truncated). */
  label: string;
  /** True when `label` was length-capped (display may add an ellipsis). */
  truncated: boolean;
  /** Child nodes; more than one child marks a branch point. */
  children: readonly SessionTreeNode[];
  /** Entry ids contracted into this node from a linear chain above it. */
  skippedEntryIds?: readonly string[];
}

/**
 * Normalized read-only branch tree of a whole session.
 *
 * `currentLeafId` is the PERSISTED catalog head (the JSONL file-order last
 * entry — exactly the leaf a leaf-less context read resolves). It is NOT the
 * live worker leaf: a live runtime may hold an in-memory navigated leaf that
 * has not been persisted, so live consumers must take the active leaf from
 * the runtime snapshot (`RuntimeState.leafId`) and treat this field as the
 * history-mode default. The tree never fabricates persistence.
 */
export interface SessionTree {
  sessionId: string;
  /** Persisted catalog head leaf; absent when the session has no entries. */
  currentLeafId?: string;
  /** Root nodes (malformed/orphaned entries surface as roots, never dropped). */
  roots: readonly SessionTreeNode[];
  /** Total number of entries represented by the tree (incl. contracted). */
  entryCount: number;
}

/** Activation location for a session (used by the sessiond / worker shell). */
export interface SessionLocation {
  sessionId: string;
  sessionFile: string;
  exists: boolean;
}

export interface SessionStats {
  messageCount: number;
  pendingMessageCount?: number;
  tokenCount?: number;
  contextUsage?: ContextUsage;
}
