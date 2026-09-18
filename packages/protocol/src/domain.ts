import { z } from "zod";
import {
  ImageAttachmentSchema,
  ModelSelectorSchema,
  NonEmptyStringSchema,
  ThinkingLevelSchema,
} from "./common.js";
import { AgentMessageSchema } from "./messages.js";
import { WorkspaceAccessSchema } from "./workspace-access.js";

/** Backend-neutral runtime capability vocabulary mirrored from Runtime Core. */
export const RuntimeCapabilitySchema = z.enum([
  "runtime.prompt",
  "runtime.steer",
  "runtime.follow_up",
  "runtime.abort",
  "runtime.model.set",
  "runtime.thinking.set",
  "runtime.tools.read",
  "runtime.tools.write",
  "runtime.compact",
  "runtime.compact.abort",
  "runtime.fork",
  "runtime.navigate",
  "runtime.bash",
  "runtime.bash.abort",
  "runtime.reload",
  "runtime.extension_ui",
  "runtime.auto_name",
  "runtime.session.rename",
  "runtime.queue",
  "runtime.stats",
]);
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>;

export const RuntimeCapabilitySetSchema = z.strictObject({
  capabilities: z.array(RuntimeCapabilitySchema),
  version: z.number().int().nonnegative().safe(),
});
export type RuntimeCapabilitySet = z.infer<typeof RuntimeCapabilitySetSchema>;

/** Recoverable queued turn; images must survive attach/resume. */
export const QueuedTurnSchema = z.strictObject({
  message: z.string(),
  images: z.array(ImageAttachmentSchema).optional(),
});
export type QueuedTurn = z.infer<typeof QueuedTurnSchema>;

export const QueuedMessagesSchema = z.strictObject({
  steering: z.array(QueuedTurnSchema),
  followUp: z.array(QueuedTurnSchema),
});
export type QueuedMessages = z.infer<typeof QueuedMessagesSchema>;

export const RuntimeCloseReasonSchema = z.enum([
  "user",
  "idle",
  "error",
  "crashed",
  "forked",
  "replaced",
  "shutdown",
  "session_deleted",
]);
export type RuntimeCloseReason = z.infer<typeof RuntimeCloseReasonSchema>;

/* Session read-model DTOs. */
export const SessionEntrySchema = z.strictObject({
  entryId: NonEmptyStringSchema,
  parentEntryId: NonEmptyStringSchema.optional(),
  message: AgentMessageSchema,
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const SessionHeaderSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  sessionFile: z.string().optional(),
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  title: z.string().optional(),
  /** First user message text (sanitized, one line, bounded) — display fallback. */
  firstMessage: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  lastMessageAt: z.number().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  parentSessionId: NonEmptyStringSchema.optional(),
  forkPointEntryId: NonEmptyStringSchema.optional(),
  /**
   * Additive Protocol v2 field (Phase 6A). Current Host always projects it from
   * AllowedRoots; absence means an older same-major producer and MUST render as
   * unknown, never as `authorized`. Protocol v3 makes it required after the
   * daemon/Host build-compatibility fence lands.
   */
  workspaceAccess: WorkspaceAccessSchema.optional(),
});
export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

/** True numbered catalog-page metadata (one-based page; totalPages=0 iff total=0). */
export const CatalogPageMetaSchema = z.strictObject({
  page: z.number().int().positive().safe(),
  pageSize: z.number().int().positive().safe(),
  total: z.number().int().nonnegative().safe(),
  totalPages: z.number().int().nonnegative().safe(),
  catalogRevision: z.number().int().nonnegative().safe(),
});
export type CatalogPageMeta = z.infer<typeof CatalogPageMetaSchema>;

export const SessionPageSchema = CatalogPageMetaSchema.extend({
  sessions: z.array(SessionHeaderSchema),
});
export type SessionPage = z.infer<typeof SessionPageSchema>;

export const ProjectSummarySchema = z.strictObject({
  projectRoot: NonEmptyStringSchema,
  representativeCwd: NonEmptyStringSchema,
  sessionCount: z.number().int().nonnegative().safe(),
  latestActivity: z.number().finite(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectPageSchema = CatalogPageMetaSchema.extend({
  projects: z.array(ProjectSummarySchema),
});
export type ProjectPage = z.infer<typeof ProjectPageSchema>;

export const SessionDetailSchema = SessionHeaderSchema.extend({
  entries: z.array(SessionEntrySchema).optional(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const SessionContextSettingsSchema = z.strictObject({
  /** Persisted model on the selected JSONL branch; null means none recorded. */
  model: ModelSelectorSchema.nullable(),
  /** Persisted thinking level on the selected JSONL branch. */
  thinkingLevel: ThinkingLevelSchema,
});
export type SessionContextSettings = z.infer<typeof SessionContextSettingsSchema>;

export const SessionContextSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  leafId: NonEmptyStringSchema.optional(),
  entries: z.array(SessionEntrySchema),
  /**
   * Additive Protocol v2 compatibility field. Current adapters always project
   * it; absence means an older same-major daemon/read seam and MUST render as
   * unknown, never as catalog default/first-model/auto. Protocol v3 makes it
   * required after daemon build compatibility is enforced.
   */
  settings: SessionContextSettingsSchema.optional(),
  /**
   * Estimated context tokens of the FULL raw selected branch (adapter-owned
   * estimator, computed BEFORE page limit / thinking-media deferral — identical
   * arithmetic to the live runtime's usage). `null` = honestly unknown
   * (post-compaction until a valid assistant usage); `0` = known-empty branch.
   * The denominator is intentionally NOT part of this read: consumers combine
   * this numerator with the exact displayed model's catalog window. Additive
   * Protocol v2 compatibility field with the same Protocol v3 required-field
   * floor as `settings` above.
   */
  contextTokens: z.number().int().nonnegative().nullable().optional(),
  /**
   * Cursor-pagination info (Protocol v2). `hasMore` is true when older entries
   * exist before this page; `nextCursor` is the stable projected entryId cursor
   * to pass as `before` for the next older page (absent when hasMore is false).
   * Entries are ALWAYS chronological within a page.
   */
  pageInfo: z.strictObject({
    hasMore: z.boolean(),
    nextCursor: NonEmptyStringSchema.optional(),
  }),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

/*
 * Normalized read-only session branch tree (BranchNavigator slice).
 *
 * Strict DTO mirrors of the runtime-core canonical model (protocol never
 * imports runtime-core): nodes carry entry ids, structural links, a
 * normalized kind and a safe single-line preview label only — never an SDK
 * tree node, raw path, raw message object, thinking text or tool
 * input/output. Single-child linear chains are contracted into
 * `skippedEntryIds` on the next kept node. `currentLeafId` is the PERSISTED
 * catalog head (exactly the leaf a leaf-less `sessions.context` resolves);
 * a live runtime's in-memory navigated leaf is NOT fabricated here — live
 * consumers take the active leaf from the runtime snapshot.
 *
 * Bounded Tree Wire Contract: the limits below MIRROR the single domain
 * authority in `packages/runtime-core/src/session.ts`
 * (`MAX_SESSION_TREE_*`). Protocol cannot import runtime-core, so these
 * constants are the wire-side copy; the pi-sdk-adapter projection enforces
 * the authority values and the parity tests pin both sides to the same
 * numbers. When a producer hits any budget it MUST return `pageInfo` with
 * explicit truncation counts — never silent omission. `pageInfo` is
 * optional on the wire so a non-truncated tree stays byte-compatible with
 * older clients.
 */
export const SessionTreeNodeKindSchema = z.enum([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "system",
]);
export type SessionTreeNodeKind = z.infer<typeof SessionTreeNodeKindSchema>;

export interface SessionTreeNode {
  entryId: string;
  parentEntryId?: string | undefined;
  kind: SessionTreeNodeKind;
  /** Safe, single-line preview; length-capped (see truncated). */
  label: string;
  /** True when `label` was length-capped (display may add an ellipsis). */
  truncated: boolean;
  children: SessionTreeNode[];
  /** Entry ids contracted into this node from a linear chain above it. */
  skippedEntryIds?: string[] | undefined;
}

// Wire-side mirrors of the runtime-core tree authority (session.ts).
// Keep these EXACTLY equal to the runtime-core constants; the parity tests
// pin them on both sides of the boundary.
export const MAX_SESSION_TREE_LABEL_LENGTH = 40;
export const MAX_SESSION_TREE_DEPTH = 200;
export const MAX_SESSION_TREE_NODES = 1000;
export const MAX_SESSION_TREE_SKIPPED_IDS = 5000;
export const MAX_SESSION_TREE_FRAME = 6000;

export const SessionTreeNodeSchema: z.ZodType<SessionTreeNode> = z.lazy(() =>
  z.strictObject({
    entryId: NonEmptyStringSchema,
    parentEntryId: NonEmptyStringSchema.optional(),
    kind: SessionTreeNodeKindSchema,
    label: z.string().max(512),
    truncated: z.boolean(),
    children: z.array(SessionTreeNodeSchema),
    skippedEntryIds: z.array(NonEmptyStringSchema).optional(),
  }),
);

export const SessionTreePageInfoSchema = z.strictObject({
  /** True when any budget was hit — the returned tree is NOT the complete session. */
  truncated: z.boolean(),
  /** Kept nodes returned (≤ MAX_SESSION_TREE_NODES in a bounded projection). */
  nodeCount: z.number().int().nonnegative(),
  /** Total contracted entry ids returned (≤ MAX_SESSION_TREE_SKIPPED_IDS in a bounded projection). */
  skippedIdCount: z.number().int().nonnegative(),
  /** Total wire elements returned = nodeCount + skippedIdCount (≤ MAX_SESSION_TREE_FRAME in a bounded projection). */
  frameCount: z.number().int().nonnegative(),
});
export type SessionTreePageInfo = z.infer<typeof SessionTreePageInfoSchema>;

export const SessionTreeSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  /** Persisted catalog head leaf; absent when the session has no entries. */
  currentLeafId: NonEmptyStringSchema.optional(),
  roots: z.array(SessionTreeNodeSchema),
  /** Total entries represented (kept + contracted), bounded by the file. */
  entryCount: z.number().int().nonnegative().safe(),
  /** Explicit bounding metadata; present only when the projection was truncated. */
  pageInfo: SessionTreePageInfoSchema.optional(),
}).superRefine((value, ctx) => {
  // Frozen preview contract: labels are single-line and length-capped.
  const check = (nodes: SessionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.label.length > MAX_SESSION_TREE_LABEL_LENGTH) {
        ctx.addIssue({ code: "custom", path: ["roots"], message: "tree node label exceeds the preview cap" });
        return;
      }
      if (node.label.includes("\n")) {
        ctx.addIssue({ code: "custom", path: ["roots"], message: "tree node label must be single-line" });
        return;
      }
      if (depth < 256) check(node.children, depth + 1);
    }
  };
  check(value.roots, 0);
  // Bounded Tree Wire Contract: when pageInfo is present the counts must be
  // self-consistent (frame = nodes + skipped ids) and marked truncated. The
  // numeric caps themselves are enforced by the producer (adapter) against
  // the authority constants; this verifies the explicit truncation contract.
  if (value.pageInfo !== undefined) {
    if (value.pageInfo.frameCount !== value.pageInfo.nodeCount + value.pageInfo.skippedIdCount) {
      ctx.addIssue({ code: "custom", path: ["pageInfo", "frameCount"], message: "tree pageInfo frameCount must equal nodeCount + skippedIdCount" });
    }
    if (value.pageInfo.truncated !== true) {
      ctx.addIssue({ code: "custom", path: ["pageInfo", "truncated"], message: "tree pageInfo must be truncated when present" });
    }
  }
});
export type SessionTree = z.infer<typeof SessionTreeSchema>;

/* Host resource/auth DTOs that are stable product semantics. */
export const AuthProviderKindSchema = z.enum(["oauth", "apiKey", "deviceCode"]);
export type AuthProviderKind = z.infer<typeof AuthProviderKindSchema>;

export const AuthProviderInfoSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: z.string().optional(),
  methods: z.array(AuthProviderKindSchema).min(1),
});
export type AuthProviderInfo = z.infer<typeof AuthProviderInfoSchema>;

export const AuthProviderStatusSchema = z.strictObject({
  providerId: NonEmptyStringSchema,
  authorized: z.boolean(),
  accountName: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type AuthProviderStatus = z.infer<typeof AuthProviderStatusSchema>;

export const SkillInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  enabled: z.boolean(),
  version: z.string().optional(),
  updateAvailable: z.boolean().optional(),
});
export type SkillInfo = z.infer<typeof SkillInfoSchema>;

export const PluginInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  version: z.string().optional(),
  enabled: z.boolean(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const TrustLevelSchema = z.enum(["unknown", "trusted", "denied"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const ProjectTrustStatusSchema = z.strictObject({
  cwd: NonEmptyStringSchema,
  level: TrustLevelSchema,
  source: z.string().optional(),
});
export type ProjectTrustStatus = z.infer<typeof ProjectTrustStatusSchema>;
