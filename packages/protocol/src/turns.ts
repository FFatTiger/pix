import { z } from "zod";
import {
  EpochSchema,
  ImageAttachmentSchema,
  ModelSelectorSchema,
  NonBlankTextSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  ThinkingLevelSchema,
} from "./common.js";
import { RuntimeSnapshotSchema } from "./snapshot.js";

/** Protocol-v2 additive atomic prompt admission (runtime.submit-turn.v1). */
export const TurnActivationOverridesSchema = z.strictObject({
  model: ModelSelectorSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type TurnActivationOverrides = z.infer<typeof TurnActivationOverridesSchema>;

export const SubmitTurnRequestSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  expectedEpoch: EpochSchema.optional(),
  expectedRevision: z.number().int().nonnegative().safe().optional(),
  prompt: NonBlankTextSchema,
  images: z.array(ImageAttachmentSchema).max(8).optional(),
  activationOverrides: TurnActivationOverridesSchema.optional(),
  operationId: NonEmptyStringSchema,
}).superRefine((value, ctx) => {
  if (value.expectedRevision !== undefined && value.expectedEpoch === undefined) {
    ctx.addIssue({ code: "custom", path: ["expectedRevision"], message: "expectedRevision requires expectedEpoch" });
  }
});
export type SubmitTurnRequest = z.infer<typeof SubmitTurnRequestSchema>;

export const TurnStatusStateSchema = z.enum([
  "admitted",
  "running",
  "user_committed",
  "completed",
  "failed",
]);
export type TurnStatusState = z.infer<typeof TurnStatusStateSchema>;

export const TurnStatusSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  operationId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema,
  /**
   * Monotonic status revision for this turn, starting at 0. This is a
   * PER-TURN status sequence number scoped to (sessionId, epoch, operationId,
   * turnId) — it is explicitly NOT a session revision
   * (`SessionRevision`, packages/protocol/src/revision.ts) and must never be
   * compared with, converted to, or merged with the session journal cursor
   * (epoch/eventId). Same-epoch order only; never cross-turn comparable.
   */
  revision: z.number().int().nonnegative().safe(),
  state: TurnStatusStateSchema,
  userEntryId: NonEmptyStringSchema.optional(),
  finalLeafId: NonEmptyStringSchema.optional(),
  error: ProtocolErrorSchema.optional(),
});
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const SubmitTurnAcceptedSchema = z.strictObject({
  status: z.literal("accepted"),
  delivery: z.literal("accepted"),
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  revision: z.number().int().nonnegative().safe(),
  operationId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema,
  snapshot: RuntimeSnapshotSchema,
  turnStatus: TurnStatusSchema,
}).superRefine((value, ctx) => {
  if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
  if (value.sessionId !== value.turnStatus.sessionId) ctx.addIssue({ code: "custom", path: ["turnStatus", "sessionId"], message: "turnStatus sessionId mismatch" });
  if (value.epoch !== value.turnStatus.epoch) ctx.addIssue({ code: "custom", path: ["turnStatus", "epoch"], message: "turnStatus epoch mismatch" });
  if (value.operationId !== value.turnStatus.operationId) ctx.addIssue({ code: "custom", path: ["turnStatus", "operationId"], message: "turnStatus operationId mismatch" });
  if (value.turnId !== value.turnStatus.turnId) ctx.addIssue({ code: "custom", path: ["turnStatus", "turnId"], message: "turnStatus turnId mismatch" });
});

export const SubmitTurnDuplicateSchema = z.strictObject({
  status: z.literal("duplicate"),
  delivery: z.enum(["accepted", "uncertain"]),
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  revision: z.number().int().nonnegative().safe(),
  operationId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema.optional(),
  turnStatus: TurnStatusSchema,
  snapshot: RuntimeSnapshotSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.snapshot !== undefined && value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
  if (value.sessionId !== value.turnStatus.sessionId) ctx.addIssue({ code: "custom", path: ["turnStatus", "sessionId"], message: "turnStatus sessionId mismatch" });
  if (value.epoch !== value.turnStatus.epoch) ctx.addIssue({ code: "custom", path: ["turnStatus", "epoch"], message: "turnStatus epoch mismatch" });
  if (value.operationId !== value.turnStatus.operationId) ctx.addIssue({ code: "custom", path: ["turnStatus", "operationId"], message: "turnStatus operationId mismatch" });
  if (value.turnId !== undefined && value.turnId !== value.turnStatus.turnId) ctx.addIssue({ code: "custom", path: ["turnStatus", "turnId"], message: "turnStatus turnId mismatch" });
});

export const SubmitTurnRejectedSchema = z.strictObject({
  status: z.literal("rejected"),
  delivery: z.enum(["not_delivered", "uncertain"]),
  sessionId: NonEmptyStringSchema,
  operationId: NonEmptyStringSchema,
  epoch: EpochSchema.optional(),
  revision: z.number().int().nonnegative().safe().optional(),
  error: ProtocolErrorSchema,
  snapshot: RuntimeSnapshotSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.snapshot !== undefined && value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
});

export const SubmitTurnAdmissionSchema = z.union([
  SubmitTurnAcceptedSchema,
  SubmitTurnDuplicateSchema,
  SubmitTurnRejectedSchema,
]);
export type SubmitTurnAdmission = z.infer<typeof SubmitTurnAdmissionSchema>;

export const RuntimeTurnStatusPushSchema = z.strictObject({
  type: z.literal("turn_status"),
  status: TurnStatusSchema,
});
export type RuntimeTurnStatusPush = z.infer<typeof RuntimeTurnStatusPushSchema>;

export function parseSubmitTurnRequest(input: unknown): SubmitTurnRequest {
  return SubmitTurnRequestSchema.parse(input);
}
export function safeParseSubmitTurnRequest(input: unknown) {
  return SubmitTurnRequestSchema.safeParse(input);
}
