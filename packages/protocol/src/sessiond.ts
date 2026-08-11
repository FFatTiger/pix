import { z } from "zod";
import { RuntimeCommandSchema } from "./commands.js";
import {
  EmptyObjectSchema,
  EpochSchema,
  LastEventIdSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  WorkerStatusSchema,
} from "./common.js";
import {
  SessionContextSchema,
  SessionDetailSchema,
  SessionHeaderSchema,
} from "./domain.js";
import { CorrelatedRuntimeCommandResultSchema, RuntimeInterruptResultSchema, RuntimeInterruptSchema } from "./results.js";
import { RuntimeEventSchema } from "./events.js";
import {
  SnapshotDeliveryReasonSchema,
  RuntimeAttachParamsSchema,
  RuntimeCreateParamsSchema,
} from "./handshake.js";
import { RuntimeSnapshotSchema } from "./snapshot.js";
import { ProtocolVersionSchema } from "./version.js";

/**
 * Web host ↔ pi-sessiond RPC.
 * Method-discriminated request union: each method has a strict params schema.
 * No params: unknown at the cross-process boundary.
 */

// --- Params ---

export const SystemPingParamsSchema = EmptyObjectSchema;
export type SystemPingParams = z.infer<typeof SystemPingParamsSchema>;

export const SystemHelloParamsSchema = z.strictObject({
  clientName: NonEmptyStringSchema.optional(),
  features: z.array(z.string()).optional(),
});
export type SystemHelloParams = z.infer<typeof SystemHelloParamsSchema>;

export type SessiondRuntimeCreateParams = z.infer<typeof RuntimeCreateParamsSchema>;

export const RuntimeActivateParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema.optional(),
});
export type RuntimeActivateParams = z.infer<typeof RuntimeActivateParamsSchema>;

export const SessiondRuntimeAttachParamsSchema = RuntimeAttachParamsSchema;
export type SessiondRuntimeAttachParams = z.infer<
  typeof SessiondRuntimeAttachParamsSchema
>;

export const RuntimeDetachParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type RuntimeDetachParams = z.infer<typeof RuntimeDetachParamsSchema>;

/** Read-only snapshot; must not implicitly activate a worker. */
export const RuntimeGetSnapshotParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type RuntimeGetSnapshotParams = z.infer<
  typeof RuntimeGetSnapshotParamsSchema
>;

/** List running workers only; must not activate. */
export const RuntimeListRunningParamsSchema = EmptyObjectSchema;
export type RuntimeListRunningParams = z.infer<
  typeof RuntimeListRunningParamsSchema
>;

export const RuntimeCommandParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  command: RuntimeCommandSchema,
});
export type RuntimeCommandParams = z.infer<typeof RuntimeCommandParamsSchema>;

export const RuntimeInterruptParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  interrupt: RuntimeInterruptSchema,
});
export type RuntimeInterruptParams = z.infer<typeof RuntimeInterruptParamsSchema>;

export const RuntimeStopParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  reason: z.string().optional(),
});
export type RuntimeStopParams = z.infer<typeof RuntimeStopParamsSchema>;

export const RuntimeHasBusyCwdParamsSchema = z.strictObject({
  cwd: NonEmptyStringSchema,
});
export type RuntimeHasBusyCwdParams = z.infer<
  typeof RuntimeHasBusyCwdParamsSchema
>;

export const RuntimeStopByCwdParamsSchema = z.strictObject({
  cwd: NonEmptyStringSchema,
  reason: z.string().optional(),
});
export type RuntimeStopByCwdParams = z.infer<typeof RuntimeStopByCwdParamsSchema>;

/** Optional historical / read-path RPCs (not runtime lifecycle). */
export const SessionsListParamsSchema = z.strictObject({
  cwd: NonEmptyStringSchema.optional(),
  limit: z.number().int().positive().optional(),
});
export type SessionsListParams = z.infer<typeof SessionsListParamsSchema>;

export const SessionsResolveParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema.optional(),
  sessionFile: z.string().optional(),
  cwd: NonEmptyStringSchema.optional(),
});
export type SessionsResolveParams = z.infer<typeof SessionsResolveParamsSchema>;

export const SessionsReadParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type SessionsReadParams = z.infer<typeof SessionsReadParamsSchema>;

export const SessionsContextParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type SessionsContextParams = z.infer<typeof SessionsContextParamsSchema>;

export const SessionsRenameParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
});
export type SessionsRenameParams = z.infer<typeof SessionsRenameParamsSchema>;

export const SessionsDeleteParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type SessionsDeleteParams = z.infer<typeof SessionsDeleteParamsSchema>;

// --- Results ---

export const SystemPingResultSchema = z.strictObject({
  pong: z.literal(true),
  serverTime: z.number().int().optional(),
});
export type SystemPingResult = z.infer<typeof SystemPingResultSchema>;

export const SystemHelloResultSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  sessiondVersion: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
});
export type SystemHelloResult = z.infer<typeof SystemHelloResultSchema>;

export const RuntimeCreateResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  created: z.boolean(),
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  workerStatus: WorkerStatusSchema.optional(),
  snapshot: RuntimeSnapshotSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.snapshot === undefined) return;
  if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
  if (value.cwd !== value.snapshot.cwd) ctx.addIssue({ code: "custom", path: ["snapshot", "cwd"], message: "snapshot cwd mismatch" });
  if (value.projectRoot !== value.snapshot.projectRoot) ctx.addIssue({ code: "custom", path: ["snapshot", "projectRoot"], message: "snapshot projectRoot mismatch" });
});
export type RuntimeCreateResult = z.infer<typeof RuntimeCreateResultSchema>;

export const RuntimeActivateResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  workerStatus: WorkerStatusSchema,
  snapshot: RuntimeSnapshotSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.snapshot === undefined) return;
  if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
  if (value.cwd !== value.snapshot.cwd) ctx.addIssue({ code: "custom", path: ["snapshot", "cwd"], message: "snapshot cwd mismatch" });
  if (value.projectRoot !== value.snapshot.projectRoot) ctx.addIssue({ code: "custom", path: ["snapshot", "projectRoot"], message: "snapshot projectRoot mismatch" });
});
export type RuntimeActivateResult = z.infer<typeof RuntimeActivateResultSchema>;

export const SessiondRuntimeAttachResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  lastEventId: LastEventIdSchema,
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  resumeStatus: SnapshotDeliveryReasonSchema,
  snapshot: RuntimeSnapshotSchema,
}).superRefine((value, ctx) => {
  if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
  if (value.cwd !== value.snapshot.cwd) ctx.addIssue({ code: "custom", path: ["snapshot", "cwd"], message: "snapshot cwd mismatch" });
  if (value.projectRoot !== value.snapshot.projectRoot) ctx.addIssue({ code: "custom", path: ["snapshot", "projectRoot"], message: "snapshot projectRoot mismatch" });
});
export type SessiondRuntimeAttachResult = z.infer<
  typeof SessiondRuntimeAttachResultSchema
>;

export const RuntimeDetachResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  detached: z.literal(true),
});
export type RuntimeDetachResult = z.infer<typeof RuntimeDetachResultSchema>;

export const RuntimeGetSnapshotResultSchema = RuntimeSnapshotSchema;
export type RuntimeGetSnapshotResult = z.infer<
  typeof RuntimeGetSnapshotResultSchema
>;

export const RuntimeRunningItemSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  workerStatus: WorkerStatusSchema,
  epoch: EpochSchema.optional(),
  name: z.string().optional(),
});
export type RuntimeRunningItem = z.infer<typeof RuntimeRunningItemSchema>;

export const RuntimeListRunningResultSchema = z.strictObject({
  sessions: z.array(RuntimeRunningItemSchema),
});
export type RuntimeListRunningResult = z.infer<
  typeof RuntimeListRunningResultSchema
>;

export const RuntimeCommandResultSchema = CorrelatedRuntimeCommandResultSchema;
export type RuntimeCommandResult = z.infer<typeof RuntimeCommandResultSchema>;

export const RuntimeInterruptRpcResultSchema = RuntimeInterruptResultSchema;
export type RuntimeInterruptRpcResult = z.infer<typeof RuntimeInterruptRpcResultSchema>;

export const RuntimeStopResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  stopped: z.boolean(),
});
export type RuntimeStopResult = z.infer<typeof RuntimeStopResultSchema>;

export const RuntimeHasBusyCwdResultSchema = z.strictObject({
  cwd: NonEmptyStringSchema,
  busy: z.boolean(),
  sessionIds: z.array(NonEmptyStringSchema).optional(),
});
export type RuntimeHasBusyCwdResult = z.infer<
  typeof RuntimeHasBusyCwdResultSchema
>;

export const RuntimeStopByCwdResultSchema = z.strictObject({
  cwd: NonEmptyStringSchema,
  stoppedSessionIds: z.array(NonEmptyStringSchema),
});
export type RuntimeStopByCwdResult = z.infer<typeof RuntimeStopByCwdResultSchema>;

export const SessionsListItemSchema = SessionHeaderSchema;
export type SessionsListItem = z.infer<typeof SessionsListItemSchema>;

export const SessionsListResultSchema = z.strictObject({
  sessions: z.array(SessionsListItemSchema),
});
export type SessionsListResult = z.infer<typeof SessionsListResultSchema>;

export const SessionsResolveResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  sessionFile: z.string().optional(),
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
});
export type SessionsResolveResult = z.infer<typeof SessionsResolveResultSchema>;

export const SessionsReadResultSchema = SessionDetailSchema;
export type SessionsReadResult = z.infer<typeof SessionsReadResultSchema>;

export const SessionsContextResultSchema = SessionContextSchema;
export type SessionsContextResult = z.infer<typeof SessionsContextResultSchema>;

export const SessionsRenameResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
});
export type SessionsRenameResult = z.infer<typeof SessionsRenameResultSchema>;

export const SessionsDeleteResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  deleted: z.boolean(),
});
export type SessionsDeleteResult = z.infer<typeof SessionsDeleteResultSchema>;

// --- Request union (method-discriminated) ---

const rpcEnvelope = {
  protocolVersion: ProtocolVersionSchema,
  id: NonEmptyStringSchema,
};

export const SessiondRpcRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("system.ping"),
    params: SystemPingParamsSchema.default({}),
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("system.hello"),
    params: SystemHelloParamsSchema.default({}),
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.create"),
    params: RuntimeCreateParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.activate"),
    params: RuntimeActivateParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.attach"),
    params: SessiondRuntimeAttachParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.detach"),
    params: RuntimeDetachParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.getSnapshot"),
    params: RuntimeGetSnapshotParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.listRunning"),
    params: RuntimeListRunningParamsSchema.default({}),
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.command"),
    params: RuntimeCommandParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.interrupt"),
    params: RuntimeInterruptParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.stop"),
    params: RuntimeStopParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.hasBusyCwd"),
    params: RuntimeHasBusyCwdParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.stopByCwd"),
    params: RuntimeStopByCwdParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.list"),
    params: SessionsListParamsSchema.default({}),
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.resolve"),
    params: SessionsResolveParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.read"),
    params: SessionsReadParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.context"),
    params: SessionsContextParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.rename"),
    params: SessionsRenameParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.delete"),
    params: SessionsDeleteParamsSchema,
  }),
]);

export type SessiondRpcRequest = z.infer<typeof SessiondRpcRequestSchema>;

export const SESSIOND_RPC_METHODS = [
  "system.ping",
  "system.hello",
  "runtime.create",
  "runtime.activate",
  "runtime.attach",
  "runtime.detach",
  "runtime.getSnapshot",
  "runtime.listRunning",
  "runtime.command",
  "runtime.interrupt",
  "runtime.stop",
  "runtime.hasBusyCwd",
  "runtime.stopByCwd",
  "sessions.list",
  "sessions.resolve",
  "sessions.read",
  "sessions.context",
  "sessions.rename",
  "sessions.delete",
] as const;

export type SessiondRpcMethod = (typeof SESSIOND_RPC_METHODS)[number];

/** Method → params / result mapping for typed handlers. */
export type SessiondMethodParams = {
  "system.ping": SystemPingParams;
  "system.hello": SystemHelloParams;
  "runtime.create": SessiondRuntimeCreateParams;
  "runtime.activate": RuntimeActivateParams;
  "runtime.attach": SessiondRuntimeAttachParams;
  "runtime.detach": RuntimeDetachParams;
  "runtime.getSnapshot": RuntimeGetSnapshotParams;
  "runtime.listRunning": RuntimeListRunningParams;
  "runtime.command": RuntimeCommandParams;
  "runtime.interrupt": RuntimeInterruptParams;
  "runtime.stop": RuntimeStopParams;
  "runtime.hasBusyCwd": RuntimeHasBusyCwdParams;
  "runtime.stopByCwd": RuntimeStopByCwdParams;
  "sessions.list": SessionsListParams;
  "sessions.resolve": SessionsResolveParams;
  "sessions.read": SessionsReadParams;
  "sessions.context": SessionsContextParams;
  "sessions.rename": SessionsRenameParams;
  "sessions.delete": SessionsDeleteParams;
};

export type SessiondMethodResult = {
  "system.ping": SystemPingResult;
  "system.hello": SystemHelloResult;
  "runtime.create": RuntimeCreateResult;
  "runtime.activate": RuntimeActivateResult;
  "runtime.attach": SessiondRuntimeAttachResult;
  "runtime.detach": RuntimeDetachResult;
  "runtime.getSnapshot": RuntimeGetSnapshotResult;
  "runtime.listRunning": RuntimeListRunningResult;
  "runtime.command": RuntimeCommandResult;
  "runtime.interrupt": RuntimeInterruptRpcResult;
  "runtime.stop": RuntimeStopResult;
  "runtime.hasBusyCwd": RuntimeHasBusyCwdResult;
  "runtime.stopByCwd": RuntimeStopByCwdResult;
  "sessions.list": SessionsListResult;
  "sessions.resolve": SessionsResolveResult;
  "sessions.read": SessionsReadResult;
  "sessions.context": SessionsContextResult;
  "sessions.rename": SessionsRenameResult;
  "sessions.delete": SessionsDeleteResult;
};

export const SessiondMethodResultSchemas = {
  "system.ping": SystemPingResultSchema,
  "system.hello": SystemHelloResultSchema,
  "runtime.create": RuntimeCreateResultSchema,
  "runtime.activate": RuntimeActivateResultSchema,
  "runtime.attach": SessiondRuntimeAttachResultSchema,
  "runtime.detach": RuntimeDetachResultSchema,
  "runtime.getSnapshot": RuntimeGetSnapshotResultSchema,
  "runtime.listRunning": RuntimeListRunningResultSchema,
  "runtime.command": RuntimeCommandResultSchema,
  "runtime.interrupt": RuntimeInterruptRpcResultSchema,
  "runtime.stop": RuntimeStopResultSchema,
  "runtime.hasBusyCwd": RuntimeHasBusyCwdResultSchema,
  "runtime.stopByCwd": RuntimeStopByCwdResultSchema,
  "sessions.list": SessionsListResultSchema,
  "sessions.resolve": SessionsResolveResultSchema,
  "sessions.read": SessionsReadResultSchema,
  "sessions.context": SessionsContextResultSchema,
  "sessions.rename": SessionsRenameResultSchema,
  "sessions.delete": SessionsDeleteResultSchema,
} as const;

export const SessiondRpcSuccessSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("system.ping"), result: SystemPingResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("system.hello"), result: SystemHelloResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.create"), result: RuntimeCreateResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.activate"), result: RuntimeActivateResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.attach"), result: SessiondRuntimeAttachResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.detach"), result: RuntimeDetachResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.getSnapshot"), result: RuntimeGetSnapshotResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.listRunning"), result: RuntimeListRunningResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.command"), result: RuntimeCommandResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.interrupt"), result: RuntimeInterruptRpcResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.stop"), result: RuntimeStopResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.hasBusyCwd"), result: RuntimeHasBusyCwdResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.stopByCwd"), result: RuntimeStopByCwdResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.list"), result: SessionsListResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.resolve"), result: SessionsResolveResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.read"), result: SessionsReadResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.context"), result: SessionsContextResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.rename"), result: SessionsRenameResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.delete"), result: SessionsDeleteResultSchema }),
]);

export const SessiondRpcFailureSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("system.ping"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("system.hello"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.create"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.activate"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.attach"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.detach"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.getSnapshot"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.listRunning"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.command"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.interrupt"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.stop"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.hasBusyCwd"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.stopByCwd"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.list"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.resolve"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.read"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.context"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.rename"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.delete"), error: ProtocolErrorSchema }),
]);

export const SessiondRpcResponseSchema = z.union([
  SessiondRpcSuccessSchema,
  SessiondRpcFailureSchema,
]);

export type SessiondRpcResponse = z.infer<typeof SessiondRpcResponseSchema>;

/** Server-push frames on the same sessiond channel (events / snapshots). */
export const SessiondPushEventSchema = z.strictObject({
  type: z.literal("event"),
  event: RuntimeEventSchema,
});

export const SessiondPushSnapshotSchema = z.strictObject({
  type: z.literal("snapshot"),
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  lastEventId: LastEventIdSchema,
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  workerStatus: WorkerStatusSchema,
  snapshot: RuntimeSnapshotSchema,
  resumeStatus: SnapshotDeliveryReasonSchema,
}).superRefine((value, ctx) => {
  if (value.sessionId !== value.snapshot.sessionId) ctx.addIssue({ code: "custom", path: ["snapshot", "sessionId"], message: "snapshot sessionId mismatch" });
  if (value.cwd !== value.snapshot.cwd) ctx.addIssue({ code: "custom", path: ["snapshot", "cwd"], message: "snapshot cwd mismatch" });
  if (value.projectRoot !== value.snapshot.projectRoot) ctx.addIssue({ code: "custom", path: ["snapshot", "projectRoot"], message: "snapshot projectRoot mismatch" });
});

export const SessiondPushSchema = z.discriminatedUnion("type", [
  SessiondPushEventSchema,
  SessiondPushSnapshotSchema,
]);

export type SessiondPush = z.infer<typeof SessiondPushSchema>;

// Back-compat aliases used by older drafts of this package.
export const SessionCreateParamsSchema = RuntimeCreateParamsSchema;
export const SessionCreateResultSchema = RuntimeCreateResultSchema;
export const SessionAttachParamsSchema = SessiondRuntimeAttachParamsSchema;
export const SessionAttachResultSchema = SessiondRuntimeAttachResultSchema;
export const SessionCommandParamsSchema = RuntimeCommandParamsSchema;
export const SessionCommandResultSchema = RuntimeCommandResultSchema;
export const SessiondRpcMethodSchema = z.enum(SESSIOND_RPC_METHODS);

export function parseSessiondRpcRequest(input: unknown): SessiondRpcRequest {
  return SessiondRpcRequestSchema.parse(input);
}

export function safeParseSessiondRpcRequest(input: unknown) {
  return SessiondRpcRequestSchema.safeParse(input);
}

export function parseSessiondRpcResponse(input: unknown): SessiondRpcResponse {
  return SessiondRpcResponseSchema.parse(input);
}

export function safeParseSessiondRpcResponse(input: unknown) {
  return SessiondRpcResponseSchema.safeParse(input);
}

export function parseSessiondMethodResult<M extends SessiondRpcMethod>(
  method: M,
  result: unknown,
): SessiondMethodResult[M] {
  return SessiondMethodResultSchemas[method].parse(
    result,
  ) as SessiondMethodResult[M];
}
