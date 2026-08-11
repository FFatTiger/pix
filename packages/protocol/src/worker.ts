import { z } from "zod";
import { RuntimeCommandSchema } from "./commands.js";
import {
  EmptyObjectSchema,
  EpochSchema,
  ModelSelectorSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  ThinkingLevelSchema,
  WorkerStatusSchema,
} from "./common.js";
import { RuntimeEventDataSchema } from "./events.js";
import { CorrelatedRuntimeCommandResultSchema, RuntimeInterruptResultSchema, RuntimeInterruptSchema } from "./results.js";
import { RuntimeSnapshotSchema, RuntimeStateSchema } from "./snapshot.js";
import { ProtocolVersionSchema } from "./version.js";

/**
 * sessiond ↔ agent-worker IPC.
 * Strict message types with bound payloads — no params: unknown.
 * Explicit extension points (details/data/options) remain z.unknown().
 */

// --- sessiond → worker ---

export const WorkerInitMessageSchema = z.strictObject({
  type: z.literal("worker.init"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    cwd: NonEmptyStringSchema,
    projectRoot: NonEmptyStringSchema,
    sessionFile: z.string().optional(),
    model: ModelSelectorSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    thinkingLevelPinned: z.boolean().optional(),
    toolNames: z.array(NonEmptyStringSchema).optional(),
    name: z.string().optional(),
  }),
});

export const WorkerCommandMessageSchema = z.strictObject({
  type: z.literal("worker.command"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    command: RuntimeCommandSchema,
  }),
});

export const WorkerInterruptMessageSchema = z.strictObject({
  type: z.literal("worker.interrupt"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    interrupt: RuntimeInterruptSchema,
  }),
});

export const WorkerGetSnapshotMessageSchema = z.strictObject({
  type: z.literal("worker.getSnapshot"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
  }),
});

export const WorkerShutdownMessageSchema = z.strictObject({
  type: z.literal("worker.shutdown"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z
    .strictObject({
      sessionId: NonEmptyStringSchema.optional(),
      reason: z.string().optional(),
    })
    .default({}),
});

export const WorkerHostResponseMessageSchema = z.strictObject({
  type: z.literal("worker.hostResponse"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.discriminatedUnion("ok", [
    z.strictObject({
      requestId: NonEmptyStringSchema,
      ok: z.literal(true),
      data: z.unknown().optional(),
    }),
    z.strictObject({
      requestId: NonEmptyStringSchema,
      ok: z.literal(false),
      error: ProtocolErrorSchema,
    }),
  ]),
});

export const WorkerPingMessageSchema = z.strictObject({
  type: z.literal("worker.ping"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: EmptyObjectSchema.default({}),
});

/** sessiond → worker messages */
export const SessiondToWorkerMessageSchema = z.discriminatedUnion("type", [
  WorkerInitMessageSchema,
  WorkerCommandMessageSchema,
  WorkerInterruptMessageSchema,
  WorkerGetSnapshotMessageSchema,
  WorkerShutdownMessageSchema,
  WorkerHostResponseMessageSchema,
  WorkerPingMessageSchema,
]);

export type SessiondToWorkerMessage = z.infer<
  typeof SessiondToWorkerMessageSchema
>;

// --- worker → sessiond ---

export const WorkerReadyMessageSchema = z.strictObject({
  type: z.literal("worker.ready"),
  id: NonEmptyStringSchema.optional(),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    epoch: EpochSchema,
    workerStatus: WorkerStatusSchema,
    state: RuntimeStateSchema.optional(),
  }),
});

export const WorkerCommandResultMessageSchema = z.strictObject({
  type: z.literal("worker.commandResult"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    result: CorrelatedRuntimeCommandResultSchema,
  }),
});

export const WorkerInterruptResultMessageSchema = z.strictObject({
  type: z.literal("worker.interruptResult"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    result: RuntimeInterruptResultSchema,
  }),
});

export const WorkerEventMessageSchema = z.strictObject({
  type: z.literal("worker.event"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    event: RuntimeEventDataSchema,
  }),
});

export const WorkerSnapshotMessageSchema = z.strictObject({
  type: z.literal("worker.snapshot"),
  id: NonEmptyStringSchema.optional(),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    snapshot: RuntimeSnapshotSchema,
  }),
});

export const WorkerSessionDiscoveredMessageSchema = z.strictObject({
  type: z.literal("worker.sessionDiscovered"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    sessionFile: z.string().optional(),
    cwd: NonEmptyStringSchema.optional(),
    details: z.unknown().optional(),
  }),
});

export const WorkerCacheInvalidatedMessageSchema = z.strictObject({
  type: z.literal("worker.cacheInvalidated"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema.optional(),
    caches: z.array(z.string()),
    details: z.unknown().optional(),
  }),
});

export const WorkerHostRequestMessageSchema = z.strictObject({
  type: z.literal("worker.hostRequest"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    requestId: NonEmptyStringSchema,
    kind: NonEmptyStringSchema,
    data: z.unknown().optional(),
  }),
});

export const WorkerFatalMessageSchema = z.strictObject({
  type: z.literal("worker.fatal"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema.optional(),
    error: ProtocolErrorSchema,
  }),
});

export const WorkerStatusMessageSchema = z.strictObject({
  type: z.literal("worker.status"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    status: WorkerStatusSchema,
    detail: z.string().optional(),
  }),
});

export const WorkerToSessiondPushSchema = z.discriminatedUnion("type", [
  WorkerReadyMessageSchema,
  WorkerCommandResultMessageSchema,
  WorkerInterruptResultMessageSchema,
  WorkerEventMessageSchema,
  WorkerSnapshotMessageSchema,
  WorkerSessionDiscoveredMessageSchema,
  WorkerCacheInvalidatedMessageSchema,
  WorkerHostRequestMessageSchema,
  WorkerFatalMessageSchema,
  WorkerStatusMessageSchema,
]);

export type WorkerToSessiondMessage = z.infer<typeof WorkerToSessiondPushSchema>;

export const WorkerIpcMessageSchema = z.union([
  SessiondToWorkerMessageSchema,
  WorkerToSessiondPushSchema,
]);

export type WorkerIpcMessage = z.infer<typeof WorkerIpcMessageSchema>;

// --- Legacy names kept as thin aliases where still useful ---

export const WorkerInitParamsSchema = WorkerInitMessageSchema.shape.payload;
export type WorkerInitParams = z.infer<typeof WorkerInitParamsSchema>;

export const WorkerCommandParamsSchema =
  WorkerCommandMessageSchema.shape.payload;
export type WorkerCommandParams = z.infer<typeof WorkerCommandParamsSchema>;

export const WorkerCommandResultSchema =
  WorkerCommandResultMessageSchema.shape.payload;
export type WorkerCommandResult = z.infer<typeof WorkerCommandResultSchema>;

export function parseSessiondToWorkerMessage(
  input: unknown,
): SessiondToWorkerMessage {
  return SessiondToWorkerMessageSchema.parse(input);
}

export function safeParseSessiondToWorkerMessage(input: unknown) {
  return SessiondToWorkerMessageSchema.safeParse(input);
}

export function parseWorkerToSessiondMessage(
  input: unknown,
): WorkerToSessiondMessage {
  return WorkerToSessiondPushSchema.parse(input);
}

export function safeParseWorkerToSessiondMessage(input: unknown) {
  return WorkerToSessiondPushSchema.safeParse(input);
}

/** @deprecated use parseSessiondToWorkerMessage */
export function parseWorkerIpcRequest(input: unknown): SessiondToWorkerMessage {
  return parseSessiondToWorkerMessage(input);
}

/** @deprecated use safeParseWorkerToSessiondMessage / SessiondRpcResponse */
export function safeParseWorkerIpcResponse(input: unknown) {
  return WorkerCommandResultMessageSchema.safeParse(input);
}
