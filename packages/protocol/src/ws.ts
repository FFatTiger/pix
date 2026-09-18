import { z } from "zod";
import { RuntimeCommandSchema } from "./commands.js";
import {
  EpochSchema,
  LastEventIdSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  WorkerStatusSchema,
} from "./common.js";
import { RuntimeEventSchema } from "./events.js";
import { CorrelatedRuntimeReadResultSchema, RuntimeReadRequestSchema } from "./reads.js";
import { SubmitTurnAdmissionSchema, SubmitTurnRequestSchema, RuntimeTurnStatusPushSchema } from "./turns.js";
import {
  ProtocolHandshakeRejectSchema,
  ProtocolHandshakeRequestSchema,
  ProtocolHandshakeResponseSchema,
  SnapshotDeliveryReasonSchema,
  RuntimeAttachFreshParamsSchema,
  RuntimeAttachResumeParamsSchema,
  RuntimeCreateParamsSchema,
} from "./handshake.js";
import {
  CorrelatedRuntimeCommandResultSchema,
  RuntimeInterruptResultSchema,
  RuntimeInterruptSchema,
} from "./results.js";
import { RuntimeSnapshotSchema } from "./snapshot.js";
import {
  RuntimeActivateResultSchema,
  RuntimeCreateResultSchema,
  RuntimeDetachResultSchema,
  RuntimeGetSnapshotResultSchema,
  RuntimeListRunningResultSchema,
  RuntimeRunningStateSchema,
  RuntimeStopResultSchema,
} from "./sessiond.js";

export const WsHandshakeMessageSchema = z.strictObject({ type: z.literal("handshake"), id: NonEmptyStringSchema.optional(), payload: ProtocolHandshakeRequestSchema });
export const WsHandshakeAckMessageSchema = z.strictObject({ type: z.literal("handshake_ack"), id: NonEmptyStringSchema.optional(), payload: ProtocolHandshakeResponseSchema });
export const WsHandshakeRejectMessageSchema = z.strictObject({ type: z.literal("handshake_reject"), id: NonEmptyStringSchema.optional(), payload: ProtocolHandshakeRejectSchema });

/** Create and attach are distinct; createRequestId cannot enter attach. */
export const WsCreateMessageSchema = z.strictObject({ type: z.literal("create"), id: NonEmptyStringSchema, payload: RuntimeCreateParamsSchema });
/** Browser-only extension; sessiond's RuntimeAttachParamsSchema remains unchanged. */
export const BrowserRuntimeAttachParamsSchema = z.union([
  RuntimeAttachFreshParamsSchema.extend({ attachMode: z.literal("existing_only").optional() }),
  RuntimeAttachResumeParamsSchema.extend({ attachMode: z.literal("existing_only").optional() }),
]);
export type BrowserRuntimeAttachParams = z.infer<typeof BrowserRuntimeAttachParamsSchema>;
export const WsAttachMessageSchema = z.strictObject({ type: z.literal("attach"), id: NonEmptyStringSchema, payload: BrowserRuntimeAttachParamsSchema });
export const WsActivateMessageSchema = z.strictObject({
  type: z.literal("activate"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({ sessionId: NonEmptyStringSchema }),
});
export const WsDetachMessageSchema = z.strictObject({ type: z.literal("detach"), id: NonEmptyStringSchema.optional(), payload: z.strictObject({ sessionId: NonEmptyStringSchema }) });
export const WsCommandMessageSchema = z.strictObject({
  type: z.literal("command"),
  id: NonEmptyStringSchema.optional(),
  payload: z.strictObject({ sessionId: NonEmptyStringSchema, command: RuntimeCommandSchema, epoch: EpochSchema.optional() }),
}).superRefine((value, ctx) => {
  if (["abort", "abort_compaction", "abort_bash", "clear_queue"].includes(value.payload.command.type)) {
    ctx.addIssue({ code: "custom", path: ["payload", "command", "type"], message: "interrupt commands must use the independent interrupt envelope" });
  }
});

/** Independent, non-queued control path. commandId correlates retries/results. */
export const WsInterruptMessageSchema = z.strictObject({
  type: z.literal("interrupt"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    commandId: NonEmptyStringSchema,
    epoch: EpochSchema.optional(),
    interrupt: RuntimeInterruptSchema,
  }),
});

/** Read-only snapshot fetch (no worker activation). */
export const WsGetSnapshotMessageSchema = z.strictObject({
  type: z.literal("getSnapshot"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({ sessionId: NonEmptyStringSchema }),
});

/**
 * Independent bounded read request (negotiated `runtime.read-rpc.v1`).
 * `id` is the browser requestId; the payload carries the expected epoch so a
 * stale-epoch read can never touch the Worker. Readable only on connections
 * that negotiated the feature (the Host rejects the frame otherwise).
 */
export const WsReadMessageSchema = z.strictObject({
  type: z.literal("read"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    epoch: EpochSchema,
    read: RuntimeReadRequestSchema,
  }),
});

/**
 * Correlated read result (negotiated `runtime.read-rpc.v1`). The full
 * identity triple (`sessionId`, `epoch`, `requestId`) + result must match a
 * pending read before it may settle it; a late/wrong-id frame is dropped.
 */
export const WsReadResultMessageSchema = z.strictObject({
  type: z.literal("read_result"),
  id: NonEmptyStringSchema,
  payload: CorrelatedRuntimeReadResultSchema,
});

/** Atomic prompt admission (negotiated `runtime.submit-turn.v1`). */
export const WsSubmitTurnMessageSchema = z.strictObject({
  type: z.literal("submit_turn"),
  id: NonEmptyStringSchema,
  payload: SubmitTurnRequestSchema,
});
export const WsSubmitTurnResultMessageSchema = z.strictObject({
  type: z.literal("submit_turn_result"),
  id: NonEmptyStringSchema,
  payload: SubmitTurnAdmissionSchema,
});
export const WsTurnStatusMessageSchema = z.strictObject({
  type: z.literal("turn_status"),
  id: NonEmptyStringSchema.optional(),
  payload: RuntimeTurnStatusPushSchema.shape.status,
});

/** Read-only list of active runtime records; never activates a worker. */
export const WsListRunningMessageSchema = z.strictObject({
  type: z.literal("listRunning"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({}),
});

/** Authoritative session stop; also closes the matching attach subscription. */
export const WsStopMessageSchema = z.strictObject({
  type: z.literal("stop"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({ sessionId: NonEmptyStringSchema, reason: z.string().optional() }),
});

/**
 * Strict success-result union for a correlated WS response. Each member maps
 * to a host verb: command (CorrelatedRuntimeCommandResult), create, detach,
 * getSnapshot (RuntimeSnapshot) and stop. `unknown` is never accepted — the
 * result is always a known, validated protocol result.
 */
export const WsResponseResultSchema = z.union([
  CorrelatedRuntimeCommandResultSchema,
  RuntimeActivateResultSchema,
  RuntimeCreateResultSchema,
  RuntimeDetachResultSchema,
  RuntimeGetSnapshotResultSchema,
  RuntimeListRunningResultSchema,
  RuntimeStopResultSchema,
]);
export type WsResponseResult = z.infer<typeof WsResponseResultSchema>;

export const WsResponseMessageSchema = z.strictObject({
  type: z.literal("response"),
  id: NonEmptyStringSchema,
  payload: z.discriminatedUnion("ok", [
    z.strictObject({ sessionId: NonEmptyStringSchema.optional(), ok: z.literal(true), result: WsResponseResultSchema }),
    z.strictObject({ sessionId: NonEmptyStringSchema.optional(), ok: z.literal(false), error: ProtocolErrorSchema }),
  ]),
});
export const WsInterruptResultMessageSchema = z.strictObject({
  type: z.literal("interrupt_result"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    commandId: NonEmptyStringSchema,
    interruptType: z.enum(["abort", "abort_compaction", "abort_bash", "clear_queue"]),
    result: RuntimeInterruptResultSchema,
  }).superRefine((value, ctx) => {
    if (value.interruptType !== value.result.type) ctx.addIssue({ code: "custom", path: ["result", "type"], message: "interrupt result type mismatch" });
  }),
});
export const WsSnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  id: NonEmptyStringSchema.optional(),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    cwd: NonEmptyStringSchema,
    projectRoot: NonEmptyStringSchema,
    epoch: EpochSchema,
    lastEventId: LastEventIdSchema,
    workerStatus: WorkerStatusSchema,
    snapshot: RuntimeSnapshotSchema,
    resumeStatus: SnapshotDeliveryReasonSchema,
  }).superRefine((value, ctx) => {
    if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
    if (value.cwd !== value.snapshot.cwd) ctx.addIssue({ code: "custom", path: ["snapshot", "cwd"], message: "snapshot cwd mismatch" });
    if (value.projectRoot !== value.snapshot.projectRoot) ctx.addIssue({ code: "custom", path: ["snapshot", "projectRoot"], message: "snapshot projectRoot mismatch" });
  }),
});
export const WsEventMessageSchema = z.strictObject({ type: z.literal("event"), id: NonEmptyStringSchema.optional(), payload: RuntimeEventSchema });
/**
 * Global running projection push (negotiated `runtime.running-watch.v1`).
 * Same revisioned state shape as the sessiond watch baseline. Additive: only
 * sent to clients that accepted the feature, so strict v2 clients never see it.
 */
export const WsRunningStateMessageSchema = z.strictObject({ type: z.literal("running_state"), id: NonEmptyStringSchema.optional(), payload: RuntimeRunningStateSchema });
export const WsRuntimeUnavailableMessageSchema = z.strictObject({ type: z.literal("runtime_unavailable"), id: NonEmptyStringSchema.optional(), payload: z.strictObject({ sessionId: NonEmptyStringSchema.optional(), error: ProtocolErrorSchema }) });

export const WsInterruptExchangeSchema = z
  .strictObject({ request: WsInterruptMessageSchema, response: WsInterruptResultMessageSchema })
  .superRefine(({ request, response }, ctx) => {
    if (request.id !== response.id) ctx.addIssue({ code: "custom", path: ["response", "id"], message: "interrupt request id mismatch" });
    if (request.payload.sessionId !== response.payload.sessionId) ctx.addIssue({ code: "custom", path: ["response", "payload", "sessionId"], message: "interrupt sessionId mismatch" });
    if (request.payload.commandId !== response.payload.commandId) ctx.addIssue({ code: "custom", path: ["response", "payload", "commandId"], message: "interrupt commandId mismatch" });
    if (request.payload.interrupt.type !== response.payload.interruptType) ctx.addIssue({ code: "custom", path: ["response", "payload", "interruptType"], message: "interrupt type mismatch" });
  });
export type WsInterruptExchange = z.infer<typeof WsInterruptExchangeSchema>;

export const WsClientMessageSchema = z.discriminatedUnion("type", [WsHandshakeMessageSchema, WsCreateMessageSchema, WsAttachMessageSchema, WsActivateMessageSchema, WsDetachMessageSchema, WsCommandMessageSchema, WsInterruptMessageSchema, WsGetSnapshotMessageSchema, WsListRunningMessageSchema, WsStopMessageSchema, WsReadMessageSchema, WsSubmitTurnMessageSchema]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
export const WsHostMessageSchema = z.discriminatedUnion("type", [WsHandshakeAckMessageSchema, WsHandshakeRejectMessageSchema, WsResponseMessageSchema, WsInterruptResultMessageSchema, WsSnapshotMessageSchema, WsEventMessageSchema, WsRunningStateMessageSchema, WsRuntimeUnavailableMessageSchema, WsReadResultMessageSchema, WsSubmitTurnResultMessageSchema, WsTurnStatusMessageSchema]);
export type WsHostMessage = z.infer<typeof WsHostMessageSchema>;
export const WsEnvelopeSchema = z.union([WsClientMessageSchema, WsHostMessageSchema]);
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

// Individual message types (additive; derived from the frozen schemas above).
export type WsHandshakeMessage = z.infer<typeof WsHandshakeMessageSchema>;
export type WsHandshakeAckMessage = z.infer<typeof WsHandshakeAckMessageSchema>;
export type WsHandshakeRejectMessage = z.infer<typeof WsHandshakeRejectMessageSchema>;
export type WsCreateMessage = z.infer<typeof WsCreateMessageSchema>;
export type WsAttachMessage = z.infer<typeof WsAttachMessageSchema>;
export type WsActivateMessage = z.infer<typeof WsActivateMessageSchema>;
export type WsDetachMessage = z.infer<typeof WsDetachMessageSchema>;
export type WsCommandMessage = z.infer<typeof WsCommandMessageSchema>;
export type WsInterruptMessage = z.infer<typeof WsInterruptMessageSchema>;
export type WsGetSnapshotMessage = z.infer<typeof WsGetSnapshotMessageSchema>;
export type WsListRunningMessage = z.infer<typeof WsListRunningMessageSchema>;
export type WsStopMessage = z.infer<typeof WsStopMessageSchema>;
export type WsReadMessage = z.infer<typeof WsReadMessageSchema>;
export type WsReadResultMessage = z.infer<typeof WsReadResultMessageSchema>;
export type WsSubmitTurnMessage = z.infer<typeof WsSubmitTurnMessageSchema>;
export type WsSubmitTurnResultMessage = z.infer<typeof WsSubmitTurnResultMessageSchema>;
export type WsTurnStatusMessage = z.infer<typeof WsTurnStatusMessageSchema>;
export type WsResponseMessage = z.infer<typeof WsResponseMessageSchema>;
export type WsInterruptResultMessage = z.infer<typeof WsInterruptResultMessageSchema>;
export type WsSnapshotMessage = z.infer<typeof WsSnapshotMessageSchema>;
export type WsEventMessage = z.infer<typeof WsEventMessageSchema>;
export type WsRunningStateMessage = z.infer<typeof WsRunningStateMessageSchema>;
export type WsRuntimeUnavailableMessage = z.infer<typeof WsRuntimeUnavailableMessageSchema>;
export function parseWsClientMessage(input: unknown): WsClientMessage { return WsClientMessageSchema.parse(input); }
export function parseWsHostMessage(input: unknown): WsHostMessage { return WsHostMessageSchema.parse(input); }
export function safeParseWsClientMessage(input: unknown) { return WsClientMessageSchema.safeParse(input); }
export function safeParseWsHostMessage(input: unknown) { return WsHostMessageSchema.safeParse(input); }
