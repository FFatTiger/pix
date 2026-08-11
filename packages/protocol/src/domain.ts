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
