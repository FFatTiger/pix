import { z } from "zod";
import { HostCapabilitiesSchema } from "./capabilities.js";
import {
  EpochSchema,
  LastEventIdSchema,
  ModelSelectorSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  ThinkingLevelSchema,
} from "./common.js";
import { ProtocolVersionSchema } from "./version.js";

export const ClientShellSchema = z.enum(["web", "pwa"]);
export type ClientShell = z.infer<typeof ClientShellSchema>;
export const ClientPlatformSchema = z.enum(["win", "mac", "linux", "ios", "android", "unknown"]);
export type ClientPlatform = z.infer<typeof ClientPlatformSchema>;
export const ClientIdentitySchema = z.strictObject({ shell: ClientShellSchema, platform: ClientPlatformSchema });
export type ClientIdentity = z.infer<typeof ClientIdentitySchema>;
export const HostModeSchema = z.enum(["local", "lan"]);
export type HostMode = z.infer<typeof HostModeSchema>;
export const HostInfoSchema = z.strictObject({ mode: HostModeSchema, capabilities: HostCapabilitiesSchema });
export type HostInfo = z.infer<typeof HostInfoSchema>;
export const HostLimitsSchema = z.strictObject({ maxUpload: z.number().nonnegative(), maxOpenSessions: z.number().nonnegative() });
export type HostLimits = z.infer<typeof HostLimitsSchema>;

export const ProtocolHandshakeRequestSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  client: ClientIdentitySchema,
  features: z.array(z.string()).default([]),
  auth: z.string().optional(),
});
export type ProtocolHandshakeRequest = z.infer<typeof ProtocolHandshakeRequestSchema>;
export const ProtocolHandshakeResponseSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  host: HostInfoSchema,
  limits: HostLimitsSchema,
  sessionSnapshotSupport: z.boolean(),
  serverTime: z.number().int().optional(),
  /**
   * Additive negotiated feature tokens (Protocol v2). Present ONLY when the
   * client advertised the feature AND the Host/sessiond seam is wired; a
   * strict v2 client that did not advertise a feature never receives the
   * matching frames. Unknown/missing tokens are ignored by older clients.
   */
  acceptedFeatures: z.array(z.string()).optional(),
});
export type ProtocolHandshakeResponse = z.infer<typeof ProtocolHandshakeResponseSchema>;
export const ProtocolHandshakeRejectSchema = z.strictObject({ protocolVersion: ProtocolVersionSchema.or(z.number()).optional(), error: ProtocolErrorSchema });
export type ProtocolHandshakeReject = z.infer<typeof ProtocolHandshakeRejectSchema>;

export const ResumeStatusSchema = z.enum(["resumed", "snapshot", "gap", "epoch_changed"]);
export type ResumeStatus = z.infer<typeof ResumeStatusSchema>;
/** Full snapshot delivery cannot represent a cursor-only resumed acknowledgement. */
export const SnapshotDeliveryReasonSchema = z.enum(["snapshot", "gap", "epoch_changed"]);
export type SnapshotDeliveryReason = z.infer<typeof SnapshotDeliveryReasonSchema>;

/** Browser/sessiond create is distinct from attach and always identifies cwd. */
export const RuntimeCreateParamsSchema = z.strictObject({
  createRequestId: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  model: ModelSelectorSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  thinkingLevelPinned: z.boolean().optional(),
  toolNames: z.array(NonEmptyStringSchema).optional(),
  name: z.string().optional(),
});
export type RuntimeCreateParams = z.infer<typeof RuntimeCreateParamsSchema>;

const attachBase = {
  sessionId: NonEmptyStringSchema,
  /**
   * Phase 5B forward-compat marker: the attaching client negotiated
   * `runtime.epoch-rollover.v1` and therefore understands whole-epoch
   * `epoch_changed` snapshots. Additive; a strict v2 client omits it.
   */
  supportsEpochRollover: z.literal(true).optional(),
};
export const RuntimeAttachFreshParamsSchema = z.strictObject(attachBase);
export const RuntimeAttachResumeParamsSchema = z.strictObject({
  ...attachBase,
  epoch: EpochSchema,
  lastEventId: LastEventIdSchema,
});
/** Resume cursor is atomic: epoch and lastEventId appear together or not at all. */
export const RuntimeAttachParamsSchema = z.union([
  RuntimeAttachFreshParamsSchema,
  RuntimeAttachResumeParamsSchema,
]);
export type RuntimeAttachParams = z.infer<typeof RuntimeAttachParamsSchema>;

export const RuntimeAttachResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  lastEventId: LastEventIdSchema,
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  resumeStatus: SnapshotDeliveryReasonSchema,
});
export type RuntimeAttachResult = z.infer<typeof RuntimeAttachResultSchema>;
