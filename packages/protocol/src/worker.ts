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

export const WorkerSessionStatusItemSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  cwd: NonEmptyStringSchema,
  state: z.enum(["busy", "waitingUser", "live"]),
});
export type WorkerSessionStatusItem = z.infer<typeof WorkerSessionStatusItemSchema>;

export const WorkerStatusQueryResultMessageSchema = z.strictObject({
  type: z.literal("worker.statusQueryResult"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    sessions: z.array(WorkerSessionStatusItemSchema).max(64),
  }),
});

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

/**
 * Authoritative per-session status item a worker may query (read-only).
 * `busy` mirrors sessiond's running-watch busy (prompt/stream/bash/compact in
 * flight); `waitingUser` = the session has unanswered extension UI (question
 * cards / extension requests); `live` = worker attached but idle.
 */
/**
 * READ-ONLY worker→sessiond status query. Only the ASSISTANT worker may ask
 * (sessiond guards by the requester record's cwd being the assistant
 * workspace); the reply carries one bounded item per live session. This is
 * the only worker-originated correlated request: it rides the existing
 * supervisor IPC pipe (no secret ever reaches the worker) and never mutates
 * sessiond state.
 */
export const WorkerStatusQueryMessageSchema = z.strictObject({
  type: z.literal("worker.statusQuery"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
  }),
});

// --- Assistant write channel (round 7) ----------------------------------

/**
 * Assistant op kinds the sessiond authority may execute on the worker's
 * behalf. `message` is the RAW task text; the sessiond authority prepends
 * `ASSISTANT_SENT_MESSAGE_PREFIX` (single owner of that convention) before
 * the message enters any authoritative send path, so every producer gets the
 * same persisted marker line for free.
 */
export const WorkerAssistantOpPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("send"),
    targetSessionId: NonEmptyStringSchema,
    message: z.string().min(1),
    /** Same semantics as the UI's two send options. When the target is idle
     * both deliveries start a new turn exactly like the composer does. */
    delivery: z.enum(["steer", "follow_up"]),
    waitMinutes: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    kind: z.literal("create"),
    cwd: NonEmptyStringSchema,
    message: z.string().min(1),
    title: z.string().max(200).optional(),
    model: ModelSelectorSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    waitMinutes: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    kind: z.literal("stop"),
    targetSessionId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal("rename"),
    targetSessionId: NonEmptyStringSchema,
    name: z.string().min(1).max(200),
  }),
]);
export type WorkerAssistantOpPayload = z.infer<typeof WorkerAssistantOpPayloadSchema>;

/**
 * WRITE assistant op request (worker → sessiond, correlated like
 * worker.statusQuery). Only the ASSISTANT worker may ask (sessiond guards by
 * the requester record's cwd being the assistant workspace); every other
 * requester is refused without a reply. Execution rides the SAME
 * authoritative paths as the UI (submitTurn / steer / follow_up command /
 * create / stop / rename) so other attached clients observe the effects
 * live; the worker never receives sessiond internals or secrets.
 */
export const WorkerAssistantOpMessageSchema = z.strictObject({
  type: z.literal("worker.assistantOp"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    op: WorkerAssistantOpPayloadSchema,
  }),
});

/**
 * Worker-side cancellation of a pending `wait` (timeout or the assistant's
 * own turn was aborted). The delegated work itself is NOT affected: the
 * ledger entry flips to notify mode so the completion still reaches the
 * assistant session as a notification later.
 */
export const WorkerAssistantWaitCancelMessageSchema = z.strictObject({
  type: z.literal("worker.assistantWaitCancel"),
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    delegationId: NonEmptyStringSchema,
  }),
});

/** How the send actually entered the authoritative path. */
export const AssistantDeliveryPathSchema = z.enum(["steer", "follow_up", "new_turn"]);
export type AssistantDeliveryPath = z.infer<typeof AssistantDeliveryPathSchema>;

export const WorkerAssistantOpResultMessageSchema = z.strictObject({
  type: z.literal("worker.assistantOpResult"),
  id: NonEmptyStringSchema,
  // A plain union, not a discriminated union: success and failure both
  // carry `kind`, and the four success variants all carry `ok: true`, so
  // neither field is a unique discriminator (zod v4 rejects duplicates).
  payload: z.union([
    z.strictObject({
      ok: z.literal(true),
      sessionId: NonEmptyStringSchema,
      kind: z.literal("send"),
      targetSessionId: NonEmptyStringSchema,
      delivery: AssistantDeliveryPathSchema,
      delegationId: NonEmptyStringSchema.optional(),
      note: z.string(),
    }),
    z.strictObject({
      ok: z.literal(true),
      sessionId: NonEmptyStringSchema,
      kind: z.literal("create"),
      targetSessionId: NonEmptyStringSchema,
      delegationId: NonEmptyStringSchema.optional(),
      note: z.string(),
    }),
    z.strictObject({
      ok: z.literal(true),
      sessionId: NonEmptyStringSchema,
      kind: z.literal("stop"),
      stopped: z.boolean(),
      note: z.string(),
    }),
    z.strictObject({
      ok: z.literal(true),
      sessionId: NonEmptyStringSchema,
      kind: z.literal("rename"),
      targetSessionId: NonEmptyStringSchema,
      note: z.string(),
    }),
    z.strictObject({
      ok: z.literal(false),
      sessionId: NonEmptyStringSchema,
      kind: z.enum(["send", "create", "stop", "rename"]),
      error: ProtocolErrorSchema,
    }),
  ]),
});
export type WorkerAssistantOpResultPayload = z.infer<typeof WorkerAssistantOpResultMessageSchema>["payload"];

/** Result kinds for a delegated piece of work. */
export const AssistantWorkOutcomeSchema = z.enum(["completed", "failed", "stopped", "waiting_user"]);
export type AssistantWorkOutcome = z.infer<typeof AssistantWorkOutcomeSchema>;

/**
 * Completion receipt pushed to the assistant worker when delegated work
 * settles while its `wait` is still pending. `id` equals the delegationId.
 */
export const WorkerAssistantCompletionMessageSchema = z.strictObject({
  type: z.literal("worker.assistantCompletion"),
  id: NonEmptyStringSchema,
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    delegationId: NonEmptyStringSchema,
    targetSessionId: NonEmptyStringSchema,
    targetTitle: z.string().optional(),
    outcome: AssistantWorkOutcomeSchema,
    lastText: z.string().optional(),
    /** Absolute path of the full reply file, present only when the reply
     * exceeded sessiond's inline cap. The assistant reads it with `read`. */
    lastTextPath: z.string().optional(),
    /** Full reply length in characters (the inline `lastText` is a preview). */
    lastTextChars: z.number().int().min(0).optional(),
    writtenFiles: z.array(NonEmptyStringSchema).max(8).optional(),
    error: z.string().optional(),
  }),
});
export type WorkerAssistantCompletionPayload = z.infer<typeof WorkerAssistantCompletionMessageSchema>["payload"];

/** sessiond → worker messages. Declared after the assistant frames it includes. */
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
  WorkerStatusQueryResultMessageSchema,
  WorkerAssistantOpResultMessageSchema,
  WorkerAssistantCompletionMessageSchema,
  WorkerPingMessageSchema,
]);

export type SessiondToWorkerMessage = z.infer<typeof SessiondToWorkerMessageSchema>;

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
  WorkerStatusQueryMessageSchema,
  WorkerAssistantOpMessageSchema,
  WorkerAssistantWaitCancelMessageSchema,
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

// --- Assistant ops channel (worker-internal injection surface) ----------

/**
 * The narrow surface the agent worker exposes to the pi-sdk-adapter's
 * assistant tools (injected exactly like the round-4 read-only status
 * channel: worker-main late-bound holder → factory options → driver
 * composition → `assistantExtensionFactoriesForCwd`). One worker process
 * hosts one session, and the sessiond authority independently re-validates
 * the requester's cwd, so this surface carries no identity of its own.
 */
export interface AssistantOpsChannel {
  send(input: {
    targetSessionId: string;
    message: string;
    delivery: "steer" | "follow_up";
    waitMinutes: number;
  }): Promise<WorkerAssistantOpResultPayload>;
  create(input: {
    cwd: string;
    message: string;
    title?: string;
    model?: { provider: string; id: string };
    thinkingLevel?: string;
    waitMinutes: number;
  }): Promise<WorkerAssistantOpResultPayload>;
  stop(targetSessionId: string): Promise<WorkerAssistantOpResultPayload>;
  rename(targetSessionId: string, name: string): Promise<WorkerAssistantOpResultPayload>;
  /** Resolves with the completion receipt, or null on timeout. */
  waitForCompletion(delegationId: string, timeoutMs: number): Promise<WorkerAssistantCompletionPayload | null>;
  /** Stop waiting (worker-side timeout / assistant turn aborted); the
   * delegated work continues and settles via notification later. */
  cancelWait(delegationId: string): void;
}

/** @deprecated use safeParseWorkerToSessiondMessage / SessiondRpcResponse */
export function safeParseWorkerIpcResponse(input: unknown) {
  return WorkerCommandResultMessageSchema.safeParse(input);
}
