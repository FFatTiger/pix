import { z } from "zod";
import { RuntimeCommandSchema } from "./commands.js";
import {
  SESSIOND_BUILD_CAPABILITIES,
  RUNTIME_CAPABILITY_VOCABULARY,
  SessiondBuildSchema,
  WorkerBuildSchema,
  sortedUniqueStrings,
  workerBuildFor,
  sessiondBuildFor,
  type SessiondBuild,
  type WorkerBuild,
} from "./build.js";
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
import { CorrelatedRuntimeReadResultSchema, RuntimeReadRequestSchema } from "./reads.js";
import { SubmitTurnAdmissionSchema, SubmitTurnRequestSchema, RuntimeTurnStatusPushSchema } from "./turns.js";
import { CorrelatedRuntimeCommandResultSchema, CorrelatedRuntimeInterruptResultSchema, RuntimeInterruptSchema } from "./results.js";
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
    /**
     * Worker startup mode. `create` starts a brand-new session (create path);
     * `open` reactivates an existing session (activate path). Mandatory so the
     * worker never has to infer intent from optional fields.
     */
    mode: z.enum(["create", "open"]),
    sessionId: NonEmptyStringSchema,
    /**
     * Authority epoch (Phase 5B). REQUIRED: the worker initializes its
     * authorityEpoch from this value and validates every command/read/
     * interrupt/submitTurn frame against it; sessiond rotates it via
     * {@link WorkerRotateEpochMessageSchema} on a whole-epoch rollover (and
     * re-syncs it after a startup rekey changes the record epoch).
     */
    epoch: EpochSchema,
    cwd: NonEmptyStringSchema,
    projectRoot: NonEmptyStringSchema,
    sessionFile: z.string().optional(),
    model: ModelSelectorSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    thinkingLevelPinned: z.boolean().optional(),
    toolNames: z.array(NonEmptyStringSchema).optional(),
    name: z.string().optional(),
    /**
     * Strict sessiond build identity (Phase 7A build fence). REQUIRED: a
     * stale Worker dist whose strict schema does not know this field rejects
     * the whole `worker.init` frame, failing startup closed deterministically
     * instead of silently running an unverifiable mix. A current Worker
     * validates it against its own compiled contract before bootstrapping any
     * runtime.
     */
    build: SessiondBuildSchema,
  }),
});

export const WorkerCommandMessageSchema = z.strictObject({
  type: z.literal("worker.command"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    /** Authority epoch the command was admitted under (Phase 5B, REQUIRED). */
    epoch: EpochSchema,
    command: RuntimeCommandSchema,
  }),
});

/** Atomic prompt admission. `id` is a unique Worker dispatch id; operationId
 * is the stable business retry identity and is never used as the dispatch id. */
export const WorkerSubmitTurnMessageSchema = z.strictObject({
  type: z.literal("worker.submitTurn"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    epoch: EpochSchema,
    operationId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    fingerprint: NonEmptyStringSchema,
    request: SubmitTurnRequestSchema,
  }),
});
export const WorkerSubmitTurnResultMessageSchema = z.strictObject({
  type: z.literal("worker.submitTurnResult"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    epoch: EpochSchema,
    operationId: NonEmptyStringSchema,
    dispatchId: NonEmptyStringSchema,
    fingerprint: NonEmptyStringSchema,
    result: SubmitTurnAdmissionSchema,
  }),
});

export const WorkerTurnStatusMessageSchema = z.strictObject({
  type: z.literal("worker.turnStatus"),
  payload: RuntimeTurnStatusPushSchema.shape.status,
});

export const WorkerInterruptMessageSchema = z.strictObject({
  type: z.literal("worker.interrupt"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    /** Authority epoch the interrupt was admitted under (Phase 5B, REQUIRED). */
    epoch: EpochSchema,
    /** Browser-issued business correlation id; deduplicated by the authority. */
    commandId: NonEmptyStringSchema,
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

/**
 * Independent bounded read dispatch (Phase 2B). `id` is a sessiond-minted
 * dispatch id that is UNIQUE PER DISPATCH and is deliberately NOT the
 * deterministic browser requestId (the worker never dedups reads by id). The
 * payload carries `epoch` (sessiond-owned, passed through for correlation) and
 * the original `requestId` so the full identity triple returns in the result.
 */
export const WorkerReadMessageSchema = z.strictObject({
  type: z.literal("worker.read"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    epoch: EpochSchema,
    requestId: NonEmptyStringSchema,
    read: RuntimeReadRequestSchema,
  }),
});

/**
 * Safe idle whole-epoch rollover (Phase 5B). sessiond sends this ONLY after
 * proving strict quiescence (no pending business frames, projection idle); the
 * worker validates the exact session + from-epoch, confirms no active business
 * handler, takes an authoritative {@code port.getSnapshot()} and applies the
 * strict idle predicate, then atomically clears its seen/turn ledgers and sets
 * authorityEpoch = toEpoch. No Worker restart / runtime recreation.
 */
export const WorkerRotateEpochMessageSchema = z.strictObject({
  type: z.literal("worker.rotateEpoch"),
  id: NonEmptyStringSchema,
  protocolVersion: ProtocolVersionSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    fromEpoch: EpochSchema,
    toEpoch: EpochSchema,
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
  WorkerSubmitTurnMessageSchema,
  WorkerReadMessageSchema,
  WorkerInterruptMessageSchema,
  WorkerGetSnapshotMessageSchema,
  WorkerRotateEpochMessageSchema,
  WorkerShutdownMessageSchema,
  WorkerHostResponseMessageSchema,
  WorkerPingMessageSchema,
]);

export type SessiondToWorkerMessage = z.infer<
  typeof SessiondToWorkerMessageSchema
>;
export type WorkerSubmitTurnMessage = z.infer<typeof WorkerSubmitTurnMessageSchema>;
export type WorkerSubmitTurnResultMessage = z.infer<typeof WorkerSubmitTurnResultMessageSchema>;
export type WorkerTurnStatusMessage = z.infer<typeof WorkerTurnStatusMessageSchema>;

// --- worker → sessiond ---

export const WorkerReadyMessageSchema = z.strictObject({
  type: z.literal("worker.ready"),
  id: NonEmptyStringSchema.optional(),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    workerStatus: WorkerStatusSchema,
    /** Worker contract features implemented by this exact running build. */
    features: z.array(NonEmptyStringSchema).optional(),
    /**
     * Strict Worker build identity (Phase 7A build fence). REQUIRED: sessiond
     * validates it against its exact compiled Worker contract BEFORE it
     * advertises or dispatches anything on this Worker; unknown/older/
     * malformed builds fail the startup closed with bounded cleanup. A stale
     * sessiond dist whose strict schema does not know this field rejects the
     * frame, so the fence holds in both directions of a mixed deployment.
     */
    build: WorkerBuildSchema,
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

/**
 * Correlated read result (Phase 2B). `id` echoes the sessiond dispatch id;
 * the payload carries the full identity triple + typed outcome.
 */
export const WorkerReadResultMessageSchema = z.strictObject({
  type: z.literal("worker.readResult"),
  id: NonEmptyStringSchema,
  payload: CorrelatedRuntimeReadResultSchema,
});

export const WorkerInterruptResultMessageSchema = z.strictObject({
  type: z.literal("worker.interruptResult"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    /** Correlated result mirroring worker.commandResult shape. */
    result: CorrelatedRuntimeInterruptResultSchema,
  }),
});

export const WorkerEventMessageSchema = z.strictObject({
  type: z.literal("worker.event"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    event: RuntimeEventDataSchema,
  }),
});

/**
 * Correlated rotate result (Phase 5B). Strict union: exact session/from/to
 * identity + either {@code ok:true} (epoch rotated, ledgers cleared) or
 * {@code ok:false} with a fixed ProtocolError. A non-idle / busy worker never
 * clears anything and returns {@code session_busy} retryable.
 */
export const WorkerRotateEpochResultMessageSchema = z.strictObject({
  type: z.literal("worker.rotateEpochResult"),
  id: NonEmptyStringSchema,
  payload: z.discriminatedUnion("ok", [
    z.strictObject({
      sessionId: NonEmptyStringSchema,
      fromEpoch: EpochSchema,
      toEpoch: EpochSchema,
      ok: z.literal(true),
    }),
    z.strictObject({
      sessionId: NonEmptyStringSchema,
      fromEpoch: EpochSchema,
      toEpoch: EpochSchema,
      ok: z.literal(false),
      error: ProtocolErrorSchema,
    }),
  ]),
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
  WorkerSubmitTurnResultMessageSchema,
  WorkerReadResultMessageSchema,
  WorkerInterruptResultMessageSchema,
  WorkerRotateEpochResultMessageSchema,
  WorkerEventMessageSchema,
  WorkerSnapshotMessageSchema,
  WorkerSessionDiscoveredMessageSchema,
  WorkerCacheInvalidatedMessageSchema,
  WorkerHostRequestMessageSchema,
  WorkerFatalMessageSchema,
  WorkerStatusMessageSchema,
  WorkerTurnStatusMessageSchema,
]);

export type WorkerToSessiondMessage = z.infer<typeof WorkerToSessiondPushSchema>;

export const WorkerIpcMessageSchema = z.union([
  SessiondToWorkerMessageSchema,
  WorkerToSessiondPushSchema,
]);

export type WorkerIpcMessage = z.infer<typeof WorkerIpcMessageSchema>;

// --- Build identities (Phase 7A) -----------------------------------------

/**
 * Discriminator literal values of a Protocol discriminated union, derived
 * from the schema itself so the schemas stay the single vocabulary source.
 * Fails loudly (never silently) if a union option lacks a literal `type`.
 */
function discriminatorTypes(
  union: { options: readonly unknown[] },
): string[] {
  const values: string[] = [];
  for (const option of union.options) {
    const shape = (option as { shape?: Record<string, unknown> }).shape;
    const typeField = shape?.["type"] as { value?: unknown } | undefined;
    if (typeField === undefined || typeof typeField.value !== "string") {
      throw new Error("build vocabulary: worker IPC schema option without a literal `type` discriminator");
    }
    values.push(typeField.value);
  }
  return values;
}

/**
 * sessiond ↔ Worker IPC message-type vocabulary of THIS build, derived once
 * from the frozen schema unions above (both directions, sorted + unique).
 */
export const WORKER_IPC_MESSAGE_TYPES: readonly string[] = Object.freeze([
  ...sortedUniqueStrings([
    ...discriminatorTypes(SessiondToWorkerMessageSchema),
    ...discriminatorTypes(WorkerToSessiondPushSchema),
  ]),
]);

/** Canonical sessiond build identity this protocol build compiles with. */
export const SESSIOND_BUILD_IDENTITY: SessiondBuild = sessiondBuildFor({
  sessiondCapabilities: SESSIOND_BUILD_CAPABILITIES,
  workerMessageTypes: WORKER_IPC_MESSAGE_TYPES,
  runtimeCapabilities: RUNTIME_CAPABILITY_VOCABULARY,
});

/** Canonical Worker build identity a `worker.ready` must carry exactly. */
export const WORKER_BUILD_IDENTITY: WorkerBuild = workerBuildFor(SESSIOND_BUILD_IDENTITY.fingerprint);

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
