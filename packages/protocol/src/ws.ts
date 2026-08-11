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
import {
  ProtocolHandshakeRejectSchema,
  ProtocolHandshakeRequestSchema,
  ProtocolHandshakeResponseSchema,
  SnapshotDeliveryReasonSchema,
  RuntimeAttachParamsSchema,
  RuntimeCreateParamsSchema,
} from "./handshake.js";
import {
  CorrelatedRuntimeCommandResultSchema,
  RuntimeInterruptResultSchema,
  RuntimeInterruptSchema,
} from "./results.js";
import { RuntimeSnapshotSchema } from "./snapshot.js";

export const WsHandshakeMessageSchema = z.strictObject({ type: z.literal("handshake"), id: NonEmptyStringSchema.optional(), payload: ProtocolHandshakeRequestSchema });
export const WsHandshakeAckMessageSchema = z.strictObject({ type: z.literal("handshake_ack"), id: NonEmptyStringSchema.optional(), payload: ProtocolHandshakeResponseSchema });
export const WsHandshakeRejectMessageSchema = z.strictObject({ type: z.literal("handshake_reject"), id: NonEmptyStringSchema.optional(), payload: ProtocolHandshakeRejectSchema });

/** Create and attach are distinct; createRequestId cannot enter attach. */
export const WsCreateMessageSchema = z.strictObject({ type: z.literal("create"), id: NonEmptyStringSchema, payload: RuntimeCreateParamsSchema });
export const WsAttachMessageSchema = z.strictObject({ type: z.literal("attach"), id: NonEmptyStringSchema, payload: RuntimeAttachParamsSchema });
export const WsDetachMessageSchema = z.strictObject({ type: z.literal("detach"), id: NonEmptyStringSchema.optional(), payload: z.strictObject({ sessionId: NonEmptyStringSchema }) });
export const WsCommandMessageSchema = z.strictObject({
  type: z.literal("command"),
  id: NonEmptyStringSchema.optional(),
  payload: z.strictObject({ sessionId: NonEmptyStringSchema, command: RuntimeCommandSchema }),
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
    interrupt: RuntimeInterruptSchema,
  }),
});

export const WsResponseMessageSchema = z.strictObject({
  type: z.literal("response"),
  id: NonEmptyStringSchema,
  payload: z.discriminatedUnion("ok", [
    z.strictObject({ sessionId: NonEmptyStringSchema.optional(), ok: z.literal(true), result: CorrelatedRuntimeCommandResultSchema }),
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

export const WsClientMessageSchema = z.discriminatedUnion("type", [WsHandshakeMessageSchema, WsCreateMessageSchema, WsAttachMessageSchema, WsDetachMessageSchema, WsCommandMessageSchema, WsInterruptMessageSchema]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
export const WsHostMessageSchema = z.discriminatedUnion("type", [WsHandshakeAckMessageSchema, WsHandshakeRejectMessageSchema, WsResponseMessageSchema, WsInterruptResultMessageSchema, WsSnapshotMessageSchema, WsEventMessageSchema, WsRuntimeUnavailableMessageSchema]);
export type WsHostMessage = z.infer<typeof WsHostMessageSchema>;
export const WsEnvelopeSchema = z.union([WsClientMessageSchema, WsHostMessageSchema]);
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;
export function parseWsClientMessage(input: unknown): WsClientMessage { return WsClientMessageSchema.parse(input); }
export function parseWsHostMessage(input: unknown): WsHostMessage { return WsHostMessageSchema.parse(input); }
export function safeParseWsClientMessage(input: unknown) { return WsClientMessageSchema.safeParse(input); }
export function safeParseWsHostMessage(input: unknown) { return WsHostMessageSchema.safeParse(input); }
