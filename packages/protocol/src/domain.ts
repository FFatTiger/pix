import { z } from "zod";
import { ImageAttachmentSchema, NonEmptyStringSchema } from "./common.js";
import { AgentMessageSchema } from "./messages.js";

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
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  lastMessageAt: z.number().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  parentSessionId: NonEmptyStringSchema.optional(),
  forkPointEntryId: NonEmptyStringSchema.optional(),
});
export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

export const SessionDetailSchema = SessionHeaderSchema.extend({
  entries: z.array(SessionEntrySchema).optional(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

export const SessionContextSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  leafId: NonEmptyStringSchema.optional(),
  entries: z.array(SessionEntrySchema),
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

const SESSION_TREE_NODE_LABEL_MAX = 40;

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

export const SessionTreeSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  /** Persisted catalog head leaf; absent when the session has no entries. */
  currentLeafId: NonEmptyStringSchema.optional(),
  roots: z.array(SessionTreeNodeSchema),
  /** Total entries represented (kept + contracted), bounded by the file. */
  entryCount: z.number().int().nonnegative().safe(),
}).superRefine((value, ctx) => {
  // Frozen preview contract: labels are single-line and length-capped.
  const check = (nodes: SessionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.label.length > SESSION_TREE_NODE_LABEL_MAX) {
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
