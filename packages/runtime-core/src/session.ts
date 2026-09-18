/**
 * Canonical session DTOs for the read-side catalog and the activation-side
 * locator. No backend session objects ever cross these ports — only
 * serializable headers, contexts and locations.
 */
import type { AgentMessage, ContextUsage, ThinkingLevel } from "./messages.js";
import type { ModelSelector } from "./model.js";
import type { WorkspaceAccess } from "./workspace-access.js";

export const DEFAULT_SESSION_PAGE_SIZE = 50;
export const MAX_SESSION_PAGE_SIZE = 100;
export const DEFAULT_PROJECT_PAGE_SIZE = 10;
export const MAX_PROJECT_PAGE_SIZE = 50;
export const DEFAULT_PROJECT_SESSION_PAGE_SIZE = 20;

export interface CatalogPageRequest {
  /** One-based page number. */
  page: number;
  pageSize: number;
}

export interface SessionPageRequest extends CatalogPageRequest {
  /** Exact cwd filter (legacy catalog scope; applied before totals). */
  cwd?: string;
  /** Canonical project-root filter for a project's nested session page. */
  projectRoot?: string;
}

export interface CatalogPageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Materialized-catalog revision within the current index generation. */
  catalogRevision: number;
}

export interface SessionPage extends CatalogPageMeta {
  sessions: readonly SessionHeader[];
}

export interface ProjectSummary {
  projectRoot: string;
  representativeCwd: string;
  sessionCount: number;
  latestActivity: number;
}

export interface ProjectPage extends CatalogPageMeta {
  projects: readonly ProjectSummary[];
}

/**
 * Legacy in-process full-list filter retained only for adapter contract and
 * activation/read compatibility. Protocol v4 exposes page/pageSize instead;
 * production Host browsing must never call this path. Removal condition:
 * migrate the remaining adapter contract/list cache tests to page queries.
 */
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
  /** Sanitized bounded first user message used only as a display fallback. */
  firstMessage?: string;
  createdAt?: number;
  updatedAt?: number;
  lastMessageAt?: number;
  messageCount?: number;
  /** Session this one was forked from (fork provenance). */
  parentSessionId?: string;
  /** Entry id the fork was created at. */
  forkPointEntryId?: string;
  /**
   * Additive workspace-authorization projection (Phase 6A). Optional only while
   * Protocol v2 accepts producers that predate this field; absence is unknown
   * legacy and MUST NOT be guessed as `authorized`. Host AllowedRoots owns the
   * live classification; catalog adapters never invent this field.
   */
  workspaceAccess?: WorkspaceAccess;
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

export interface SessionContextPageInfo {
  /** True when older entries exist before this page (before the first entry). */
  hasMore: boolean;
  /** Stable projected entryId cursor for the next older page (absent when !hasMore). */
  nextCursor?: string;
}

export interface SessionContextSettings {
  /** Persisted model resolved on the selected branch; null means no model was recorded. */
  model: ModelSelector | null;
  /** Persisted thinking level resolved on the selected branch. */
  thinkingLevel: ThinkingLevel;
}

export interface SessionContext {
  sessionId: string;
  leafId?: string;
  entries: readonly SessionEntry[];
  /**
   * Zero-Worker branch settings resolved from JSONL. Optional only while the
   * additive Protocol v2 compatibility window accepts an older sessiond that
   * predates this projection; current adapters must provide it. Protocol v3
   * makes this field required after the daemon build-compatibility fence lands.
   */
  settings?: SessionContextSettings;
  /**
   * Estimated context tokens of the FULL raw selected branch, computed by the
   * single adapter-owned estimator BEFORE any page limit or thinking/media
   * deferral (identical arithmetic to the live runtime's usage). `null` means
   * honestly UNKNOWN (post-compaction until a valid assistant usage arrives);
   * `0` means a KNOWN-empty branch; omitted means an older same-major producer
   * without the field (render as unknown, never guess). The DENOMINATOR is
   * deliberately NOT part of this read: consumers combine this numerator with
   * the exact displayed model's catalog window. Optional only for the additive
   * Protocol v2 compatibility window; Protocol v3's required-field floor folds
   * it into the same required-settings migration already noted above.
   */
  contextTokens?: number | null;
  /** Cursor-pagination info (Protocol v2). Entries are chronological per page. */
  pageInfo: SessionContextPageInfo;
}

/**
 * One resolved deferred thinking block (direct source-history parity). The
 * identity triple echoes the exact request so a placeholder emitted by a
 * deferred `SessionContext` page and its resolved text can never be
 * correlated by order or guesswork. `thinking` is the verbatim persisted
 * block text (possibly empty).
 */
export interface SessionThinkingBlock {
  sessionId: string;
  entryId: string;
  blockIndex: number;
  thinking: string;
}

/* ------------------------------------------------------------------ */
/* Normalized session branch tree (read-only navigation projection)    */
/* ------------------------------------------------------------------ */

/**
 * Canonical session-tree node-kind vocabulary (BranchNavigator). Message-like
 * entries keep the canonical AgentMessage role vocabulary (user / assistant /
 * toolResult / bashExecution / custom); structural entries (model/thinking/
 * label/session-info changes, plain custom state, compaction and branch
 * summaries) are `system`. This is the pix canonical vocabulary — never a
 * backend SDK role or entry-type string.
 *
 * SINGLE DOMAIN AUTHORITY: this array is the one source of truth for the
 * tree node kinds. `packages/protocol/src/domain.ts` mirrors it as a wire
 * zod enum (protocol must stay runtime-core-free); the pi-sdk-adapter
 * projection classifies against it.
 */
export const SESSION_TREE_NODE_KINDS = [
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "system",
] as const;

/** Canonical session-tree node kind (see {@link SESSION_TREE_NODE_KINDS}). */
export type SessionTreeNodeKind = (typeof SESSION_TREE_NODE_KINDS)[number];

/*
 * Bounded tree wire contract — SINGLE DOMAIN AUTHORITY for every tree limit.
 *
 * `packages/protocol/src/domain.ts` mirrors these exact values in its wire
 * schema (protocol cannot import runtime-core); the adapter projection
 * (`packages/pi-sdk-adapter/src/internal/session-tree.ts`) enforces them and
 * reports truncation explicitly. Keep every constant here, never inline a
 * tree limit elsewhere. See `SessionTreePageInfo` for the truncation
 * semantics (explicit pageInfo, never silent omission).
 */

/** Max preview label length in Unicode JS code units (BranchNavigator parity). */
export const MAX_SESSION_TREE_LABEL_LENGTH = 40;

/**
 * Max kept-node depth in the projected tree. Deeper kept descendants are
 * flattened into the nearest kept ancestor (with their contracted ids), so
 * the response tree stays shallow for recursive renderers.
 */
export const MAX_SESSION_TREE_DEPTH = 200;

/** Max kept nodes returned in one projected tree (node budget). */
export const MAX_SESSION_TREE_NODES = 1000;

/** Max total contracted entry ids returned across all kept nodes (skipped-id budget). */
export const MAX_SESSION_TREE_SKIPPED_IDS = 5000;

/**
 * Max wire elements returned in one projected tree = kept nodes + contracted
 * ids (frame budget). Bounds the serialized size of a bounded tree for very
 * large sessions.
 */
export const MAX_SESSION_TREE_FRAME = 6000;

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
 * Explicit bounding metadata for a {@link SessionTree} (Bounded Tree Wire
 * Contract). Present ONLY when the projection hit a budget — a bounded tree
 * is always flagged, never silently omitted. `currentLeafId` stays coherent
 * under truncation: the leaf's path is reserved (prioritized) so the leaf
 * always remains addressable in the returned tree; the leaf path's contracted
 * chains are tail-truncated so every node's `parentEntryId` still resolves to
 * a kept ancestor or the last element of its own `skippedEntryIds`.
 */
export interface SessionTreePageInfo {
  /** True when any budget was hit — the returned tree is NOT the complete session. */
  truncated: boolean;
  /** Kept nodes returned (roots + branch points + leaves; ≤ MAX_SESSION_TREE_NODES). */
  nodeCount: number;
  /** Total contracted entry ids returned (≤ MAX_SESSION_TREE_SKIPPED_IDS). */
  skippedIdCount: number;
  /** Total wire elements returned = nodeCount + skippedIdCount (≤ MAX_SESSION_TREE_FRAME). */
  frameCount: number;
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
 *
 * Bounded Tree Wire Contract: for very large sessions the projection honors
 * the node / skipped-id / frame budgets in this module. When any budget is
 * hit the tree carries `pageInfo` with explicit truncation counts (never a
 * silent omission); `currentLeafId` and every `parentEntryId` stay coherent
 * (see {@link SessionTreePageInfo}).
 */
export interface SessionTree {
  sessionId: string;
  /** Persisted catalog head leaf; absent when the session has no entries. */
  currentLeafId?: string;
  /** Root nodes (malformed/orphaned entries surface as roots, never dropped). */
  roots: readonly SessionTreeNode[];
  /** Total number of entries represented by the FULL session (incl. contracted). */
  entryCount: number;
  /** Explicit bounding metadata; present only when the projection was truncated. */
  pageInfo?: SessionTreePageInfo;
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
