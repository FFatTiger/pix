import { z } from "zod";
import {
  EpochSchema,
  ImageAttachmentArraySchema,
  ModelSelectorSchema,
  NonBlankTextSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  ThinkingLevelSchema,
} from "./common.js";
import { RuntimeSnapshotSchema } from "./snapshot.js";

/** Wire projection of runtime-core `PromptDisposition`. */
export const PromptDispositionSchema = z.enum(["started", "handled", "queued"]);
export type PromptDisposition = z.infer<typeof PromptDispositionSchema>;

/** Wire projection of runtime-core `QueuedInputDisposition`. `started` means the
 * runtime found the session idle and ran the message as a new turn. */
export const QueuedInputDispositionSchema = z.enum(["handled", "queued", "started"]);
export type QueuedInputDisposition = z.infer<typeof QueuedInputDispositionSchema>;

/** Protocol-v2 additive atomic prompt admission (runtime.submit-turn.v1). */
export const TurnActivationOverridesSchema = z.strictObject({
  model: ModelSelectorSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type TurnActivationOverrides = z.infer<typeof TurnActivationOverridesSchema>;

/**
 * How a send should be delivered while the Agent is running. The AUTHORITY
 * decides whether the session is busy — the client never guesses it. `steer`
 * injects the message into the running turn; `follow_up` (the default) parks
 * it for the end of the current turn.
 */
export const SubmitTurnWhenBusySchema = z.enum(["steer", "follow_up"]);
export type SubmitTurnWhenBusy = z.infer<typeof SubmitTurnWhenBusySchema>;

/**
 * One unconditional, idempotent "send this user message" request — the ONLY
 * send operation on the wire. The authority always accepts it (or answers a
 * duplicate for a replayed `operationId`) and decides the delivery itself:
 * an idle session starts a new turn, a running session queues the message per
 * {@link SubmitTurnRequestSchema.shape.whenBusy}. Only `invalid_input` (the
 * payload itself is illegal) and `not_found` (the session is gone) are final
 * rejections; every other failure is retryable and the client resends the
 * SAME `operationId`.
 *
 * `expectedEpoch` / `expectedRevision` stay on the wire for cached clients that
 * still send them, and are DELIBERATELY IGNORED: they were client-side guesses
 * about authority state, and every mismatch used to surface as a spurious
 * "message not sent". Idempotency is carried by `operationId` alone.
 */
export const SubmitTurnRequestSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  /** Legacy fence fields — accepted for old clients, ignored by the authority. */
  expectedEpoch: EpochSchema.optional(),
  expectedRevision: z.number().int().nonnegative().safe().optional(),
  /** May be empty when images are attached: an image alone is a message. */
  prompt: z.string(),
  images: ImageAttachmentArraySchema.optional(),
  activationOverrides: TurnActivationOverridesSchema.optional(),
  operationId: NonEmptyStringSchema,
  /** Queue policy the authority applies when the session is already running. */
  whenBusy: SubmitTurnWhenBusySchema.optional(),
}).superRefine((value, ctx) => {
  if (!NonBlankTextSchema.safeParse(value.prompt).success && (value.images?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "prompt must be non-blank unless images are attached" });
  }
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
  /** Pi 1.0 backend input receipt on terminal states: `handled` consumed the
   * input (no assistant/user entry owed), `queued` parked it, `started` ran a
   * turn. Absent when the backend reports no disposition (legacy adapters). */
  disposition: PromptDispositionSchema.optional(),
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

/** Session authority cursor, independent of the per-turn status revision. */
export const TurnAuthoritySnapshotSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  lastEventId: z.number().int().nonnegative().safe(),
  snapshot: RuntimeSnapshotSchema,
}).superRefine((value, ctx) => {
  if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
});
export type TurnAuthoritySnapshot = z.infer<typeof TurnAuthoritySnapshotSchema>;

export const RuntimeTurnStatusPushSchema = z.strictObject({
  type: z.literal("turn_status"),
  status: TurnStatusSchema,
  authority: TurnAuthoritySnapshotSchema.optional(),
}).superRefine((value, ctx) => {
  const terminal = value.status.state === "completed" || value.status.state === "failed";
  if (value.status.state === "completed" && value.authority === undefined) ctx.addIssue({ code: "custom", path: ["authority"], message: "completed status requires authority" });
  if (value.authority !== undefined) {
    if (!terminal) ctx.addIssue({ code: "custom", path: ["authority"], message: "only terminal status may carry authority" });
    if (value.authority.sessionId !== value.status.sessionId) ctx.addIssue({ code: "custom", path: ["authority", "sessionId"], message: "authority sessionId mismatch" });
    if (value.authority.epoch !== value.status.epoch) ctx.addIssue({ code: "custom", path: ["authority", "epoch"], message: "authority epoch mismatch" });
  }
});
export type RuntimeTurnStatusPush = z.infer<typeof RuntimeTurnStatusPushSchema>;

export function parseSubmitTurnRequest(input: unknown): SubmitTurnRequest {
  return SubmitTurnRequestSchema.parse(input);
}
export function safeParseSubmitTurnRequest(input: unknown) {
  return SubmitTurnRequestSchema.safeParse(input);
}
