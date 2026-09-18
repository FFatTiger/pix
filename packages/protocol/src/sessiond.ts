import { z } from "zod";
import { SessiondBuildSchema } from "./build.js";
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
  ProjectPageSchema,
  SessionContextSchema,
  SessionDetailSchema,
  SessionPageSchema,
  SessionTreeSchema,
} from "./domain.js";
import { CorrelatedRuntimeReadResultSchema, RuntimeReadRequestSchema } from "./reads.js";
import { RuntimeTurnStatusPushSchema, SubmitTurnAdmissionSchema, SubmitTurnRequestSchema } from "./turns.js";
import { CorrelatedRuntimeCommandResultSchema, CorrelatedRuntimeInterruptResultSchema, RuntimeInterruptSchema } from "./results.js";
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

/**
 * Internal, authenticated control-plane shutdown request (sessiond control RPC
 * only — never a product capability). `instanceId` MUST equal the daemon's
 * exact current instance-lock identity; any other value is refused fail-closed
 * and can never trigger shutdown. The secret is enforced by the RPC transport
 * before this method is ever reached.
 */
export const SystemShutdownParamsSchema = z.strictObject({
  instanceId: NonEmptyStringSchema,
});
export type SystemShutdownParams = z.infer<typeof SystemShutdownParamsSchema>;

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

/**
 * Watch the global running projection. Strict empty params; never activates a
 * worker and never touches records. The response is the full authoritative
 * baseline+revision; subsequent `running_state` pushes carry newer revisions.
 */
export const RuntimeWatchRunningParamsSchema = EmptyObjectSchema;
export type RuntimeWatchRunningParams = z.infer<
  typeof RuntimeWatchRunningParamsSchema
>;

/**
 * Revisioned global running projection. `revision` is a safe non-negative
 * integer that increments ONLY on an actual live/busy set change; `sessionIds`
 * are unique live-worker ids; `busySessionIds` are the live subset whose
 * current turn is authoritatively busy (prompt/bash/compact). Sets are
 * normalized (sorted, deduped) for deterministic comparison.
 */
export const RuntimeRunningStateSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  sessionIds: z.array(NonEmptyStringSchema),
  busySessionIds: z.array(NonEmptyStringSchema),
}).superRefine((value, ctx) => {
  if (new Set(value.sessionIds).size !== value.sessionIds.length) {
    ctx.addIssue({ code: "custom", path: ["sessionIds"], message: "sessionIds must be unique" });
  }
  if (new Set(value.busySessionIds).size !== value.busySessionIds.length) {
    ctx.addIssue({ code: "custom", path: ["busySessionIds"], message: "busySessionIds must be unique" });
  }
  for (const id of value.busySessionIds) {
    if (!value.sessionIds.includes(id)) {
      ctx.addIssue({ code: "custom", path: ["busySessionIds"], message: "busySessionIds must be a subset of sessionIds" });
      break;
    }
  }
});
export type RuntimeRunningState = z.infer<typeof RuntimeRunningStateSchema>;

export const RuntimeWatchRunningResultSchema = RuntimeRunningStateSchema;
export type RuntimeWatchRunningResult = z.infer<
  typeof RuntimeWatchRunningResultSchema
>;

export const RuntimeCommandParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  command: RuntimeCommandSchema,
  /**
   * Exact expected epoch (Phase 5B, optional finite v2 shim). The negotiated
   * Client always includes the exact controller epoch; a stale/missing epoch
   * after a record has rolled fails closed with `epoch_changed` BEFORE any
   * pending/accepted identity is inserted.
   */
  epoch: EpochSchema.optional(),
});
export type RuntimeCommandParams = z.infer<typeof RuntimeCommandParamsSchema>;

/**
 * Independent read RPC (Phase 2B). `requestId` is the browser-issued read
 * correlation id; `epoch` is the exact expected epoch (a stale epoch fails
 * closed and never touches the Worker). The response carries the full
 * identity triple + typed outcome so the Host can forward a strictly
 * correlated `read_result` frame.
 */
export const RuntimeReadParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  requestId: NonEmptyStringSchema,
  read: RuntimeReadRequestSchema,
});
export type RuntimeReadParams = z.infer<typeof RuntimeReadParamsSchema>;

/** Correlated read result (Phase 2B) — identity triple + outcome. */
export const RuntimeReadResultSchema = CorrelatedRuntimeReadResultSchema;
export type RuntimeReadResult = z.infer<typeof RuntimeReadResultSchema>;

export const RuntimeSubmitTurnParamsSchema = SubmitTurnRequestSchema;
export type RuntimeSubmitTurnParams = z.infer<typeof RuntimeSubmitTurnParamsSchema>;
export const RuntimeSubmitTurnResultSchema = SubmitTurnAdmissionSchema;
export type RuntimeSubmitTurnResult = z.infer<typeof RuntimeSubmitTurnResultSchema>;

export const RuntimeInterruptParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  /** Browser-issued business correlation id; the authority deduplicates on it. */
  commandId: NonEmptyStringSchema,
  /** Exact expected epoch (Phase 5B, optional finite v2 shim; see {@link RuntimeCommandParamsSchema.epoch}). */
  epoch: EpochSchema.optional(),
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

/**
 * Optional historical / read-path RPCs (not runtime lifecycle).
 *
 * `sessions.list` and `projects.list` are independent true numbered resources.
 * Filtering/grouping/totals happen before the page slice. `context` carries an
 * optional `leafId` so a branch/view can be selected without activating a
 * worker. All are read-only and start zero Workers.
 */
export const SessionsListParamsSchema = z.strictObject({
  page: z.number().int().positive().safe(),
  pageSize: z.number().int().positive().max(100).safe(),
  cwd: NonEmptyStringSchema.optional(),
  projectRoot: NonEmptyStringSchema.optional(),
});
export type SessionsListParams = z.infer<typeof SessionsListParamsSchema>;

export const ProjectsListParamsSchema = z.strictObject({
  page: z.number().int().positive().safe(),
  pageSize: z.number().int().positive().max(50).safe(),
});
export type ProjectsListParams = z.infer<typeof ProjectsListParamsSchema>;

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
  leafId: NonEmptyStringSchema.optional(),
  /**
   * Exclusive, stable projected entryId cursor. Omitted = the newest page of
   * the selected branch. Clients pin the first page's leafId and use it for all
   * older-page requests so later appends cannot shift pagination.
   */
  before: NonEmptyStringSchema.optional(),
  /**
   * Page size, bounded 1..200. Omitted = the COMPLETE selected projected
   * active branch (direct source-history parity): the producer resolves the
   * branch, maps it canonically and returns every projected entry with
   * `pageInfo.hasMore === false`. An explicit `limit`/`before` keeps the
   * Protocol-v2 paginated compatibility contract (bounded page + `nextCursor`).
   * Removal condition: Protocol v3 minimum client plus migration of the
   * visible-branch exporter off cursor walking; then remove `before`, `limit`
   * and `nextCursor` together with their compatibility tests.
   */
  limit: z.number().int().min(1).max(200).optional(),
  /**
   * Direct-history deferral (source parity). When true, every assistant
   * thinking block with non-empty text is projected as an empty `deferred`
   * placeholder; the deferred text is fetched later via `sessions.thinking`
   * with the exact session/entry/block identity. Default (absent/false) keeps
   * the full inline thinking text.
   */
  deferThinking: z.boolean().optional(),
  /**
   * Direct-history deferral (source parity). When true, base64 image blocks in
   * toolResult messages are OMITTED from the payload and replaced by one
   * truthful text summary per message (count + media types + approx bytes);
   * URL image sources are kept verbatim. Default (absent/false) keeps inline
   * base64 media.
   */
  deferMedia: z.boolean().optional(),
});
export type SessionsContextParams = z.infer<typeof SessionsContextParamsSchema>;

/**
 * Resolve one deferred thinking block by EXACT identity (source parity):
 * `blockIndex` indexes the same canonical projected assistant content array
 * the deferred `sessions.context` page carried, so the placeholder and the
 * resolved text can never drift apart. Fail-closed: unknown session / entry /
 * non-assistant entry / non-thinking block → `not_found`; a malformed
 * (negative or non-integer) block index → `invalid_input`.
 */
export const SessionsThinkingParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  entryId: NonEmptyStringSchema,
  blockIndex: z.number().int().nonnegative().safe(),
});
export type SessionsThinkingParams = z.infer<typeof SessionsThinkingParamsSchema>;

/**
 * Read-only normalized branch tree of one session (BranchNavigator slice).
 * The tree is a pure persisted-JSONL projection (zero workers); leaf selection
 * happens client-side via `sessions.context?leafId`, so this method takes no
 * leaf parameter.
 */
export const SessionsTreeParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type SessionsTreeParams = z.infer<typeof SessionsTreeParamsSchema>;

export const SessionsRenameParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
});
export type SessionsRenameParams = z.infer<typeof SessionsRenameParamsSchema>;

export const SessionsDeleteParamsSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
});
export type SessionsDeleteParams = z.infer<typeof SessionsDeleteParamsSchema>;

/**
 * Idle reclamation configuration. `0` disables idle reclamation entirely.
 */
export const ConfigGetSessionIdleTimeoutMsParamsSchema = EmptyObjectSchema;
export type ConfigGetSessionIdleTimeoutMsParams = z.infer<
  typeof ConfigGetSessionIdleTimeoutMsParamsSchema
>;

export const ConfigSetSessionIdleTimeoutMsParamsSchema = z.strictObject({
  idleTimeoutMs: z.number().int().nonnegative().safe(),
});
export type ConfigSetSessionIdleTimeoutMsParams = z.infer<
  typeof ConfigSetSessionIdleTimeoutMsParamsSchema
>;

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
  /**
   * Strict canonical build identity (Phase 7A build fence). Additive on the
   * wire: a pre-fence daemon omits it and is classified as a stale build by
   * the compatibility matrix (never silently reused); a daemon whose block is
   * present but malformed fails the strict hello schema, so peers preserve it
   * instead of guessing. Owned by `packages/protocol/src/build.ts`.
   */
  build: SessiondBuildSchema.optional(),
});
export type SystemHelloResult = z.infer<typeof SystemHelloResultSchema>;

/** Frozen minimal result: the shutdown transition was accepted. */
export const SystemShutdownResultSchema = z.strictObject({
  accepted: z.literal(true),
});
export type SystemShutdownResult = z.infer<typeof SystemShutdownResultSchema>;

export const RuntimeCreateResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  created: z.boolean(),
  cwd: NonEmptyStringSchema,
  projectRoot: NonEmptyStringSchema,
  workerStatus: WorkerStatusSchema.optional(),
  /** Additive Protocol-v2 create journal cursor. New Clients use this exact
   *  authority fence for the first submitTurn without a Browser attach. */
  lastEventId: LastEventIdSchema.optional(),
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
  workerStatus: WorkerStatusSchema,
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

export const RuntimeInterruptRpcResultSchema = CorrelatedRuntimeInterruptResultSchema;
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

export const SessionsListResultSchema = SessionPageSchema;
export type SessionsListResult = z.infer<typeof SessionsListResultSchema>;

export const ProjectsListResultSchema = ProjectPageSchema;
export type ProjectsListResult = z.infer<typeof ProjectsListResultSchema>;

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

/** Echoes the exact request identity alongside the resolved thinking text. */
export const SessionsThinkingResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  entryId: NonEmptyStringSchema,
  blockIndex: z.number().int().nonnegative(),
  thinking: z.string(),
});
export type SessionsThinkingResult = z.infer<typeof SessionsThinkingResultSchema>;

export const SessionsTreeResultSchema = SessionTreeSchema;
export type SessionsTreeResult = z.infer<typeof SessionsTreeResultSchema>;

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

export const ConfigGetSessionIdleTimeoutMsResultSchema = z.strictObject({
  idleTimeoutMs: z.number().int().nonnegative().safe(),
});
export type ConfigGetSessionIdleTimeoutMsResult = z.infer<
  typeof ConfigGetSessionIdleTimeoutMsResultSchema
>;

export const ConfigSetSessionIdleTimeoutMsResultSchema = z.strictObject({
  idleTimeoutMs: z.number().int().nonnegative().safe(),
});
export type ConfigSetSessionIdleTimeoutMsResult = z.infer<
  typeof ConfigSetSessionIdleTimeoutMsResultSchema
>;

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
    method: z.literal("system.shutdown"),
    params: SystemShutdownParamsSchema,
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
    method: z.literal("runtime.watchRunning"),
    params: RuntimeWatchRunningParamsSchema.default({}),
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.command"),
    params: RuntimeCommandParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.read"),
    params: RuntimeReadParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("runtime.submitTurn"),
    params: RuntimeSubmitTurnParamsSchema,
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
    params: SessionsListParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("projects.list"),
    params: ProjectsListParamsSchema,
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
    method: z.literal("sessions.thinking"),
    params: SessionsThinkingParamsSchema,
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("sessions.tree"),
    params: SessionsTreeParamsSchema,
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
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("config.getSessionIdleTimeoutMs"),
    params: ConfigGetSessionIdleTimeoutMsParamsSchema.default({}),
  }),
  z.strictObject({
    ...rpcEnvelope,
    method: z.literal("config.setSessionIdleTimeoutMs"),
    params: ConfigSetSessionIdleTimeoutMsParamsSchema,
  }),
]);

export type SessiondRpcRequest = z.infer<typeof SessiondRpcRequestSchema>;

export const SESSIOND_RPC_METHODS = [
  "system.ping",
  "system.hello",
  "system.shutdown",
  "runtime.create",
  "runtime.activate",
  "runtime.attach",
  "runtime.detach",
  "runtime.getSnapshot",
  "runtime.listRunning",
  "runtime.watchRunning",
  "runtime.command",
  "runtime.read",
  "runtime.submitTurn",
  "runtime.interrupt",
  "runtime.stop",
  "runtime.hasBusyCwd",
  "runtime.stopByCwd",
  "sessions.list",
  "projects.list",
  "sessions.resolve",
  "sessions.read",
  "sessions.context",
  "sessions.thinking",
  "sessions.tree",
  "sessions.rename",
  "sessions.delete",
  "config.getSessionIdleTimeoutMs",
  "config.setSessionIdleTimeoutMs",
] as const;

export type SessiondRpcMethod = (typeof SESSIOND_RPC_METHODS)[number];

/** Method → params / result mapping for typed handlers. */
export type SessiondMethodParams = {
  "system.ping": SystemPingParams;
  "system.hello": SystemHelloParams;
  "system.shutdown": SystemShutdownParams;
  "runtime.create": SessiondRuntimeCreateParams;
  "runtime.activate": RuntimeActivateParams;
  "runtime.attach": SessiondRuntimeAttachParams;
  "runtime.detach": RuntimeDetachParams;
  "runtime.getSnapshot": RuntimeGetSnapshotParams;
  "runtime.listRunning": RuntimeListRunningParams;
  "runtime.watchRunning": RuntimeWatchRunningParams;
  "runtime.command": RuntimeCommandParams;
  "runtime.read": RuntimeReadParams;
  "runtime.submitTurn": RuntimeSubmitTurnParams;
  "runtime.interrupt": RuntimeInterruptParams;
  "runtime.stop": RuntimeStopParams;
  "runtime.hasBusyCwd": RuntimeHasBusyCwdParams;
  "runtime.stopByCwd": RuntimeStopByCwdParams;
  "sessions.list": SessionsListParams;
  "projects.list": ProjectsListParams;
  "sessions.resolve": SessionsResolveParams;
  "sessions.read": SessionsReadParams;
  "sessions.context": SessionsContextParams;
  "sessions.thinking": SessionsThinkingParams;
  "sessions.tree": SessionsTreeParams;
  "sessions.rename": SessionsRenameParams;
  "sessions.delete": SessionsDeleteParams;
  "config.getSessionIdleTimeoutMs": ConfigGetSessionIdleTimeoutMsParams;
  "config.setSessionIdleTimeoutMs": ConfigSetSessionIdleTimeoutMsParams;
};

export type SessiondMethodResult = {
  "system.ping": SystemPingResult;
  "system.hello": SystemHelloResult;
  "system.shutdown": SystemShutdownResult;
  "runtime.create": RuntimeCreateResult;
  "runtime.activate": RuntimeActivateResult;
  "runtime.attach": SessiondRuntimeAttachResult;
  "runtime.detach": RuntimeDetachResult;
  "runtime.getSnapshot": RuntimeGetSnapshotResult;
  "runtime.listRunning": RuntimeListRunningResult;
  "runtime.watchRunning": RuntimeWatchRunningResult;
  "runtime.command": RuntimeCommandResult;
  "runtime.read": RuntimeReadResult;
  "runtime.submitTurn": RuntimeSubmitTurnResult;
  "runtime.interrupt": RuntimeInterruptRpcResult;
  "runtime.stop": RuntimeStopResult;
  "runtime.hasBusyCwd": RuntimeHasBusyCwdResult;
  "runtime.stopByCwd": RuntimeStopByCwdResult;
  "sessions.list": SessionsListResult;
  "projects.list": ProjectsListResult;
  "sessions.resolve": SessionsResolveResult;
  "sessions.read": SessionsReadResult;
  "sessions.context": SessionsContextResult;
  "sessions.thinking": SessionsThinkingResult;
  "sessions.tree": SessionsTreeResult;
  "sessions.rename": SessionsRenameResult;
  "sessions.delete": SessionsDeleteResult;
  "config.getSessionIdleTimeoutMs": ConfigGetSessionIdleTimeoutMsResult;
  "config.setSessionIdleTimeoutMs": ConfigSetSessionIdleTimeoutMsResult;
};

export const SessiondMethodResultSchemas = {
  "system.ping": SystemPingResultSchema,
  "system.hello": SystemHelloResultSchema,
  "system.shutdown": SystemShutdownResultSchema,
  "runtime.create": RuntimeCreateResultSchema,
  "runtime.activate": RuntimeActivateResultSchema,
  "runtime.attach": SessiondRuntimeAttachResultSchema,
  "runtime.detach": RuntimeDetachResultSchema,
  "runtime.getSnapshot": RuntimeGetSnapshotResultSchema,
  "runtime.listRunning": RuntimeListRunningResultSchema,
  "runtime.watchRunning": RuntimeWatchRunningResultSchema,
  "runtime.command": RuntimeCommandResultSchema,
  "runtime.read": RuntimeReadResultSchema,
  "runtime.submitTurn": RuntimeSubmitTurnResultSchema,
  "runtime.interrupt": RuntimeInterruptRpcResultSchema,
  "runtime.stop": RuntimeStopResultSchema,
  "runtime.hasBusyCwd": RuntimeHasBusyCwdResultSchema,
  "runtime.stopByCwd": RuntimeStopByCwdResultSchema,
  "sessions.list": SessionsListResultSchema,
  "projects.list": ProjectsListResultSchema,
  "sessions.resolve": SessionsResolveResultSchema,
  "sessions.read": SessionsReadResultSchema,
  "sessions.context": SessionsContextResultSchema,
  "sessions.thinking": SessionsThinkingResultSchema,
  "sessions.tree": SessionsTreeResultSchema,
  "sessions.rename": SessionsRenameResultSchema,
  "sessions.delete": SessionsDeleteResultSchema,
  "config.getSessionIdleTimeoutMs": ConfigGetSessionIdleTimeoutMsResultSchema,
  "config.setSessionIdleTimeoutMs": ConfigSetSessionIdleTimeoutMsResultSchema,
} as const;

export const SessiondRpcSuccessSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("system.ping"), result: SystemPingResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("system.hello"), result: SystemHelloResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("system.shutdown"), result: SystemShutdownResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.create"), result: RuntimeCreateResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.activate"), result: RuntimeActivateResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.attach"), result: SessiondRuntimeAttachResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.detach"), result: RuntimeDetachResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.getSnapshot"), result: RuntimeGetSnapshotResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.listRunning"), result: RuntimeListRunningResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.watchRunning"), result: RuntimeWatchRunningResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.command"), result: RuntimeCommandResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.read"), result: RuntimeReadResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.submitTurn"), result: RuntimeSubmitTurnResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.interrupt"), result: RuntimeInterruptRpcResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.stop"), result: RuntimeStopResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.hasBusyCwd"), result: RuntimeHasBusyCwdResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("runtime.stopByCwd"), result: RuntimeStopByCwdResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.list"), result: SessionsListResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("projects.list"), result: ProjectsListResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.resolve"), result: SessionsResolveResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.read"), result: SessionsReadResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.context"), result: SessionsContextResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.thinking"), result: SessionsThinkingResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.tree"), result: SessionsTreeResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.rename"), result: SessionsRenameResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("sessions.delete"), result: SessionsDeleteResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("config.getSessionIdleTimeoutMs"), result: ConfigGetSessionIdleTimeoutMsResultSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(true), method: z.literal("config.setSessionIdleTimeoutMs"), result: ConfigSetSessionIdleTimeoutMsResultSchema }),
]);

export const SessiondRpcFailureSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("system.ping"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("system.hello"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("system.shutdown"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.create"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.activate"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.attach"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.detach"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.getSnapshot"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.listRunning"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.watchRunning"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.command"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.read"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.submitTurn"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.interrupt"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.stop"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.hasBusyCwd"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("runtime.stopByCwd"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.list"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("projects.list"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.resolve"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.read"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.context"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.thinking"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.tree"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.rename"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("sessions.delete"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("config.getSessionIdleTimeoutMs"), error: ProtocolErrorSchema }),
  z.strictObject({ id: NonEmptyStringSchema, ok: z.literal(false), method: z.literal("config.setSessionIdleTimeoutMs"), error: ProtocolErrorSchema }),
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

/** Feature-scoped status push for a `runtime.submitTurn` subscription. */
export const SessiondTurnStatusPushSchema = RuntimeTurnStatusPushSchema;
export type SessiondTurnStatusPush = z.infer<typeof SessiondTurnStatusPushSchema>;

export type SessiondPush = z.infer<typeof SessiondPushSchema>;

/**
 * Global running-watch push, separate from the per-session {@link SessiondPush}
 * stream. Carries the SAME revisioned state shape as the watch baseline.
 */
export const SessiondRunningStatePushSchema = z.strictObject({
  type: z.literal("running_state"),
  state: RuntimeRunningStateSchema,
});
export type SessiondRunningStatePush = z.infer<
  typeof SessiondRunningStatePushSchema
>;

/**
 * Full server-push union on the sessiond channel: per-session event/snapshot
 * pushes AND the global running_state push (used by the running watch RPC).
 */
export const SessiondChannelPushSchema = z.discriminatedUnion("type", [
  SessiondPushEventSchema,
  SessiondPushSnapshotSchema,
  SessiondRunningStatePushSchema,
  SessiondTurnStatusPushSchema,
]);
export type SessiondChannelPush = z.infer<typeof SessiondChannelPushSchema>;

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
