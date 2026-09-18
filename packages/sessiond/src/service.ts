import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CorrelatedRuntimeCommandResult,
  CorrelatedRuntimeInterruptResult,
  CorrelatedRuntimeReadResult,
  RuntimeAttachParams,
  RuntimeCommand,
  RuntimeCommandOutcome,
  RuntimeCreateParams,
  RuntimeCreateResult,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeInterrupt,
  RuntimeReadOutcome,
  RuntimeReadRequest,
  RuntimeReadType,
  RuntimeSnapshot,
  RuntimeActivateResult,
  RuntimeSubmitTurnParams,
  SubmitTurnAdmission,
  TurnStatus,
  ProtocolError,
  SessiondTurnStatusPush,
  RuntimeGetSnapshotResult,
  RuntimeListRunningResult,
  RuntimeRunningState,
  SessiondPush,
  SessiondRunningStatePush,
  SessiondRuntimeAttachResult,
  SnapshotDeliveryReason,
  WorkerStatus,
  WorkerToSessiondMessage,
  WorkerSubmitTurnMessage,
} from "@fffattiger/pix-protocol";
import {
  PROTOCOL_VERSION,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  SESSIOND_BUILD_IDENTITY,
  WORKER_BUILD_IDENTITY,
  evaluateWorkerBuild,
  RuntimeCloseReasonSchema,
  type ProtocolErrorCode,
  type WorkerBuild,
} from "@fffattiger/pix-protocol";
import type { RuntimeCloseReason } from "@fffattiger/pix-protocol";
import { READ_ONLY_RUNTIME_COMMAND_TYPES, isRuntimeError, type CatalogPageRequest, type ProjectCatalogPort, type ProjectPage, type SessionCatalogPort, type SessionHeader, type SessionListFilter, type SessionLocation, type SessionLocatorPort, type SessionMutationPort, type SessionPage, type SessionPageRequest } from "@fffattiger/pix-runtime-core";
import { SessiondError, duplicateInterruptUnavailable, duplicateResultUnavailable, epochChangedCommand, epochChangedInterrupt, rejectedCommand, rejectedInterrupt, unavailableCommand, unavailableInterrupt } from "./errors.js";
import { EventJournal, type EventJournalOptions } from "./journal.js";
import { AsyncMutex } from "./internal/mutex.js";
import { SessionOperationCoordinator, SessionTitleOverlay } from "./internal/session-operation-coordinator.js";
import { SnapshotProjection } from "./projection.js";
import type { WorkerConnection, WorkerProcessFactory, WorkerStartInput } from "./worker.js";

export interface ActivationContext {
  cwd: string;
  projectRoot: string;
}

export interface ActivationContextProvider {
  resolve(sessionId: string, location: SessionLocation, requestedCwd?: string): Promise<ActivationContext>;
}

export interface SessiondOptions {
  journal?: EventJournalOptions;
  workerStartTimeoutMs?: number;
  commandTimeoutMs?: number;
  idleTimeoutMs?: number;
  subscriberQueueLimit?: number;
  commandResultLimit?: number;
  commandResultCacheLimit?: number;
  createRequestLimit?: number;
  interruptLimit?: number;
  /** Phase 2B read lane: max pending reads per record (queued + active), default 16. */
  readQueueLimit?: number;
  /** Phase 2B read lane: per-read timeout in ms, default 10_000 (independent of commandTimeoutMs). */
  readTimeoutMs?: number;
  /** Phase 3 quick Worker admission timeout, independent of long prompt execution. */
  turnAdmissionTimeoutMs?: number;
  /** Accepted operation identities retained per epoch; capacity fails closed. */
  turnOperationLimit?: number;
  /**
   * Phase 5B bounded wait for a `worker.rotateEpoch` result (default 10 s).
   * Timeout keeps the OLD epoch and every ledger intact and the triggering
   * request falls back to the original capacity/session_busy failure.
   */
  epochRolloverTimeoutMs?: number;
  /**
   * Expected Worker build identity for the Phase 7A build fence. Defaults to
   * the compiled-in canonical {@link WORKER_BUILD_IDENTITY}; tests use this
   * to simulate a mixed-dist deployment (e.g. a newer sessiond build than the
   * installed Worker dist). A malformed or non-schema value fails every
   * Worker closed — there is no permissive fallback.
   */
  expectedWorkerBuild?: WorkerBuild;
  now?: () => number;
  makeEpoch?: () => string;
}

/**
 * Bounded in-process diagnostics snapshot (PR#3). Counts only — never session
 * ids, names, paths, stderr, error text, or PIDs. `workersByStatus` covers
 * every frozen {@link WorkerStatus} enum key exactly (zero-filled), so the
 * shape is stable even when no worker exists.
 */
export interface SessiondDiagnostics {
  sessions: number;
  creates: number;
  activations: number;
  subscribers: number;
  lanes: number;
  aliases: number;
  overlay: number;
  workersByStatus: Record<WorkerStatus, number>;
}

export interface SessiondDependencies {
  sessionLocator: SessionLocatorPort;
  activationContext: ActivationContextProvider;
  workerFactory: WorkerProcessFactory;
  sessionCatalog?: SessionCatalogPort;
  projectCatalog?: ProjectCatalogPort;
  /**
   * Offline session mutation (rename) from runtime-core. `undefined` lets the
   * production composition wire the shared {@link createPiSdkSessionPorts}
   * mutation; `null` explicitly disables it for fail-closed tests. The service
   * treats a missing/`null` mutation as fixed `unavailable` for offline rename.
   */
  sessionMutation?: SessionMutationPort | null;
  /**
   * Optional persisted settings file (daemon-owned). When present the service
   * reads the idle-reclamation timeout at construction and writes it back on
   * every {@link SessiondService.setIdleTimeoutMs} so the setting survives
   * sessiond restarts. Missing/unreadable/invalid files fail closed to the
   * default (never crash, never a fabricated value).
   */
  settingsFile?: string;
}

export interface PreparedAttachment {
  readonly result: SessiondRuntimeAttachResult;
  /** Replay is frozen at the authoritative boundary and never includes later live events. */
  readonly replay: readonly SessiondPush[];
  /** Flush replay, then boundary-buffered events, then atomically switch to live delivery. */
  flushTo(listener: PushListener): Promise<void>;
  /** Exactly-once detach. Never stops the worker. */
  close(): void;
}

export type PushListener = (push: SessiondPush) => void | Promise<void>;
export type TurnStatusListener = (push: SessiondTurnStatusPush) => void | Promise<void>;
export type RunningStateListener = (push: SessiondRunningStatePush) => void | Promise<void>;

export interface PreparedTurnSubmission {
  readonly result: SubmitTurnAdmission;
  flushTo(listener: TurnStatusListener): Promise<void>;
  close(): void;
}

export interface PreparedRunningWatch {
  readonly result: RuntimeRunningState;
  flushTo(listener: RunningStateListener): Promise<void>;
  close(): void;
}

interface Subscriber {
  closed: boolean;
  draining: boolean;
  queue: SessiondPush[];
  listener: PushListener;
}

interface RunningSubscriber {
  closed: boolean;
  draining: boolean;
  queue: SessiondRunningStatePush[];
  listener: RunningStateListener;
}

interface PendingCommand {
  commandId: string;
  commandType: RuntimeCommand["type"];
  epoch: string;
  promise: Promise<CorrelatedRuntimeCommandResult>;
  resolve: (result: CorrelatedRuntimeCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingInterrupt {
  commandId: string;
  type: RuntimeInterrupt["type"];
  promise: Promise<CorrelatedRuntimeInterruptResult>;
  resolve: (result: CorrelatedRuntimeInterruptResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTurnAdmission {
  dispatchId: string;
  sessionId: string;
  epoch: string;
  operationId: string;
  turnId: string;
  fingerprint: string;
  resolve: (result: SubmitTurnAdmission) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TurnSubscriber {
  closed: boolean;
  draining: boolean;
  queue: SessiondTurnStatusPush[];
  listener: TurnStatusListener;
}

interface TurnOperationRecord {
  operationId: string;
  fingerprint: string;
  epoch: string;
  turnId: string;
  dispatchId: string;
  admission: SubmitTurnAdmission;
  status: TurnStatus;
  dispatched: boolean;
  subscribers: Set<TurnSubscriber>;
}

interface PendingSnapshot {
  resolve: (snapshot: RuntimeSnapshot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Phase 5B single-flight whole-epoch rollover slot. One rotation per capacity
 * boundary trigger: `from` is the old epoch, `to` the freshly generated one,
 * `dispatchId` the correlated `worker.rotateEpoch` id, and `promise` the
 * settled outcome all joiners await. On success the record is atomically
 * committed under the lifecycle mutex; on failure the OLD epoch and every
 * ledger stay intact and the slot is cleared.
 */
interface EpochRollover {
  from: string;
  to: string;
  dispatchId: string;
  promise: Promise<{ rolled: true } | { rolled: false; error: ProtocolError }>;
  resolve: (outcome: { rolled: true } | { rolled: false; error: ProtocolError }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Phase 2B independent read lane: one pending worker-bound read. Correlated by
 * `dispatchId` (unique per dispatch — never the deterministic requestId) and
 * the full identity triple (sessionId + epoch + requestId + result type). Each
 * waiter settles EXACTLY ONCE via `resolve` (stop/crash/rekey/shutdown/
 * timeout/cancel); late results are dropped by the `worker.readResult` handler.
 */
interface PendingRead {
  dispatchId: string;
  sessionId: string;
  epoch: string;
  requestId: string;
  read: RuntimeReadRequest;
  resolve: (result: RuntimeReadOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RecordState {
  sessionId: string;
  cwd: string;
  projectRoot: string;
  sessionFile?: string;
  epoch: string;
  activationId: string;
  worker: WorkerConnection;
  status: WorkerStatus;
  journal: EventJournal;
  projection: SnapshotProjection;
  journalBaseEventId: number;
  journalBaseSnapshot: RuntimeSnapshot;
  subscribers: Set<Subscriber>;
  /** Bounded terminal result cache for mutation commands. */
  commandResults: Map<string, CorrelatedRuntimeCommandResult>;
  /** Independent bounded read-result cache; read floods cannot evict mutation results. */
  readResults: Map<string, CorrelatedRuntimeCommandResult>;
  /** Mutation command ids accepted during this epoch; reads do not consume it. */
  acceptedCommands: Map<string, RuntimeCommand["type"]>;
  pendingCommands: Map<string, PendingCommand>;
  pendingInterrupts: Map<string, PendingInterrupt>;
  /** Phase 3 accepted/uncertain operation ledger; never FIFO-evicted. */
  turnOperations: Map<string, TurnOperationRecord>;
  pendingTurnAdmissions: Map<string, PendingTurnAdmission>;
  /** Phase 2B bounded read lane: pending worker-bound reads keyed by dispatch id. */
  pendingReads: Map<string, PendingRead>;
  /** Phase 2B FIFO of queued (not-yet-dispatched) worker-bound read dispatch ids. */
  readQueue: string[];
  /** Phase 2B dispatch id of the currently Worker-bound read (at most one). */
  activeReadId: string | null;
  /** commandId -> accepted interrupt type; dedups browser commandId per epoch. */
  acceptedInterrupts: Map<string, RuntimeInterrupt["type"]>;
  /** commandId -> cached correlated result so retries return the same result. */
  interruptResults: Map<string, CorrelatedRuntimeInterruptResult>;
  pendingSnapshots: Map<string, PendingSnapshot>;
  /**
   * Per-commandId singleflight for post-success snapshot authority
   * finalization (set_thinking_level / set_model / set_auto_retry / set_tools /
   * reload / compact / navigate_tree). These commands mutate runtime state that is NOT carried
   * on the wire `runtime_state_changed` event (signal-only), so sessiond must
   * refresh via a bounded worker.getSnapshot and only then publish a terminal
   * result.
   * Original callers, same-id dedup waiters, and same-id retries all await
   * the same promise before observing a terminal result. Exact-once / safe
   * join; never issues a second unbounded getSnapshot for the same commandId.
   */
  authorityFinalizations: Map<string, Promise<CorrelatedRuntimeCommandResult>>;
  /**
   * Phase 5B single-flight epoch rollover slot (undefined = none pending).
   * While present, every new command/interrupt/read/snapshot/turn admission is
   * blocked (the joined capacity triggerers await {@link EpochRollover.promise}).
   */
  epochRollover: EpochRollover | undefined;
  /**
   * Phase 5B startup rekey epoch re-sync (undefined = none pending). Distinct
   * from {@link epochRollover}: the rekey already cleared every ledger, so the
   * rotate result settles the waiter directly WITHOUT the capacity-rollover
   * commit (no requiresEpochFence side effect).
   */
  rekeyEpochSync: EpochRollover | undefined;
  /** Startup sessionDiscovered rekey, awaited before worker.ready exposure. */
  rekeyInFlight: Promise<void> | undefined;
  /**
   * Phase 5B fence: set TRUE once a record has rolled. While true, new
   * command/interrupt admissions REQUIRE an exact epoch — missing/old epochs
   * fail closed with `epoch_changed` BEFORE any side effect. Missing is
   * allowed only while this flag is still false (legacy non-negotiated path).
   */
  requiresEpochFence: boolean;
  unsubscribeWorker: () => void;
  unsubscribeExit: () => void;
  expectedExitReason?: string;
  startupReject?: (error: Error) => void;
  lastActivity: number;
  lifecycle: AsyncMutex;
  idleGeneration: number;
  closedEventEmitted: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Commands whose success requires an authoritative snapshot refresh before a
 * terminal result may be published/cached (D2-P2/P3/P4/P6/P7). The projection is
 * the attach/resume authority; the wire `runtime_state_changed` event is
 * signal-only. D2-P6 adds `set_tools` (mutates `state.tools` + systemPrompt,
 * absent from the wire event) and `reload` (the capability event alone is
 * partial — the snapshot must converge tools, systemPrompt, thinking pin/state
 * and the final capability set before success). D2-P7 adds `compact`: the
 * `compaction_end` event only clears activity and does NOT carry the
 * post-compaction messages / messageCount / contextUsage, so a successful
 * compact must refresh via a bounded worker.getSnapshot before a terminal
 * result may be returned/cached (singleflight/triple-match/epoch/rekey/
 * fail-closed identical to set_tools/reload). D2 navigate adds
 * `navigate_tree`: the SDK `navigateTree` moves the session-tree leaf pointer
 * and persists it to the session file, but the wire carries only a
 * `runtime_state_changed` signal (the adapter emits no leaf/messages on the
 * event), so a successful navigate must refresh via a bounded
 * worker.getSnapshot before a terminal result may be returned/cached — the
 * refreshed snapshot carries the new leafId / history / messageCount and is
 * what the sessiond projection serves to getSnapshot / attach / sessions.read
 * / sessions.context afterwards. Extend only for commands that mutate state
 * absent from the wire event.
 */
const READ_ONLY_COMMAND_TYPES = new Set<RuntimeCommand["type"]>(READ_ONLY_RUNTIME_COMMAND_TYPES);

/** Map a legacy command-envelope read command onto the canonical read request. */
function toReadRequest(commandType: RuntimeCommand["type"]): RuntimeReadRequest {
  switch (commandType) {
    case "get_state":
    case "get_session_stats":
    case "get_last_assistant_text":
    case "get_tools":
    case "get_commands":
      return { type: commandType };
    default:
      throw new Error("not a read command");
  }
}

/** Map a Phase 2B read outcome back onto the legacy correlated command outcome shape. */
function toCommandOutcome(outcome: RuntimeReadOutcome): RuntimeCommandOutcome {
  if (!outcome.ok) return { ok: false, type: outcome.type, error: outcome.error };
  switch (outcome.type) {
    case "get_state": return { ok: true, type: "get_state", state: outcome.state };
    case "get_session_stats": return { ok: true, type: "get_session_stats", stats: outcome.stats };
    case "get_last_assistant_text": return { ok: true, type: "get_last_assistant_text", text: outcome.text };
    case "get_tools": return { ok: true, type: "get_tools", tools: [...outcome.tools] };
    case "get_commands": return { ok: true, type: "get_commands", commands: [...outcome.commands] };
  }
}

const AUTHORITY_COMMAND_TYPES = new Set<RuntimeCommand["type"]>([
  "set_thinking_level",
  "set_model",
  "set_auto_retry",
  "set_tools",
  "reload",
  "compact",
  "navigate_tree",
]);

/**
 * Safely normalize an arbitrary stop reason into a Protocol
 * {@link RuntimeCloseReason}. Valid reasons keep their semantics; anything
 * else (unknown/external strings) collapses to the neutral "user" reason so
 * the authoritative `runtime_closed` event always carries a schema-valid value.
 */
const normalizeCloseReason = (reason: string): RuntimeCloseReason =>
  RuntimeCloseReasonSchema.safeParse(reason).success ? (reason as RuntimeCloseReason) : "user";

const defaultSnapshot = (sessionId: string, cwd: string, projectRoot: string): RuntimeSnapshot => ({
  sessionId,
  cwd,
  projectRoot,
  state: {
    sessionId,
    isStreaming: false,
    isPromptRunning: false,
    isBashRunning: false,
    isCompacting: false,
    model: null,
    messageCount: 0,
    queuedMessages: { steering: [], followUp: [] },
    pendingMessageCount: 0,
    writtenFiles: [],
  },
  capabilities: { capabilities: [], version: 0 },
  streaming: { active: false, phase: "idle" },
});

const stripCursor = (event: RuntimeEvent): RuntimeEventData => {
  const { eventId: _eventId, epoch: _epoch, ...data } = event;
  return data as RuntimeEventData;
};

/** Max session-name length in Unicode JS code units (mirrors the adapter/UX cap). */
const MAX_SESSION_NAME_LENGTH = 200;

/**
 * Canonicalize a session display name with the current protocol/domain rule:
 * outer whitespace trimmed, blank rejected, capped at 200 Unicode JS code
 * units, and NUL/C0/DEL control characters rejected. The canonical trimmed
 * name is what the worker/adapter receive and what the RPC returns — a raw
 * user name never crosses the boundary untrimmed. Throws a fixed canonical
 * `invalid_input` SessiondError that never echoes the raw name.
 */
function canonicalizeSessionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new SessiondError("invalid_input", "session name must be a non-empty string", false);
  if (trimmed.length > MAX_SESSION_NAME_LENGTH) throw new SessiondError("invalid_input", "session name exceeds 200 characters", false);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new SessiondError("invalid_input", "session name contains control characters", false);
  return trimmed;
}

/**
 * Fixed sanitized protocol message for each live-rename command failure code.
 * The worker's raw error message (which may reflect transport/worker internals)
 * never crosses the boundary — every code is re-projected onto a fixed message.
 */
const RENAME_FAILURE_MESSAGES: Readonly<Record<ProtocolErrorCode, string>> = {
  protocol_mismatch: "session rename failed",
  invalid_request: "session rename failed",
  invalid_command: "session rename failed",
  invalid_input: "session name is invalid",
  unauthorized: "session rename failed",
  forbidden: "session rename failed",
  not_found: "session not found",
  conflict: "session state conflict during rename",
  epoch_changed: "session state changed during rename",
  gap: "session state changed during rename",
  runtime_unavailable: "runtime unavailable during rename",
  worker_unavailable: "worker unavailable during rename",
  session_busy: "session is busy",
  command_rejected: "session rename was rejected",
  command_duplicate: "session rename was already accepted",
  interrupted: "session rename interrupted",
  unsupported_capability: "session rename is not supported",
  timeout: "session rename timed out",
  external: "session rename failed",
  unavailable: "session rename unavailable",
  internal: "session rename failed",
};

/** Fixed canonical protocol message for offline-mutation failures. */
const OFFLINE_RENAME_FAILURE_MESSAGES: Readonly<Record<ProtocolErrorCode, string>> = {
  ...RENAME_FAILURE_MESSAGES,
  not_found: "session not found",
  invalid_input: "session name is invalid",
  unavailable: "session mutation is unavailable",
};


const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export class SessiondService {
  private readonly records = new Map<string, RecordState>();
  private readonly activations = new Map<string, Promise<RecordState>>();
  private readonly creates = new Map<string, Promise<RuntimeCreateResult>>();
  /**
   * D4 identity fence: the global mutex is held ONLY for short synchronous
   * records/activations transitions, rekey and alias binding. It is NEVER held
   * across adapter/catalog/locator calls, Worker command/start/close, or any
   * other lane — the per-session FIFO identity lanes (see
   * {@link SessionOperationCoordinator}) own all long-running identity work.
   */
  private readonly mutex = new AsyncMutex();
  /** Per-session FIFO identity coordinator (activate / rename / stop / delete). */
  private readonly coordinator = new SessionOperationCoordinator();
  /** Service-owned revisioned rename-title overlay for sessions.list/read. */
  private readonly titleOverlay = new SessionTitleOverlay();
  private readonly now: () => number;
  private readonly makeEpoch: () => string;
  private readonly journalOptions: EventJournalOptions;
  private readonly workerStartTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private idleTimeoutMs: number;
  private readonly subscriberQueueLimit: number;
  private readonly commandResultLimit: number;
  private readonly commandResultCacheLimit: number;
  private readonly createRequestLimit: number;
  private readonly interruptLimit: number;
  private readonly readQueueLimit: number;
  private readonly readTimeoutMs: number;
  private readonly turnAdmissionTimeoutMs: number;
  private readonly turnOperationLimit: number;
  private readonly epochRolloverTimeoutMs: number;
  /** Phase 7A build fence: exact expected Worker build contract. */
  private readonly expectedWorkerBuild: WorkerBuild;
  private readonly runningSubscribers = new Set<RunningSubscriber>();
  private runningState: RuntimeRunningState = { revision: 0, sessionIds: [], busySessionIds: [] };
  private shuttingDown = false;

  constructor(private readonly deps: SessiondDependencies, options: SessiondOptions = {}) {
    this.now = options.now ?? Date.now;
    this.makeEpoch = options.makeEpoch ?? randomUUID;
    this.journalOptions = options.journal ?? {};
    this.workerStartTimeoutMs = options.workerStartTimeoutMs ?? 10_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30 * 60 * 1_000;
    // Explicit option wins (tests use `idleTimeoutMs: 0` to disable); otherwise
    // the persisted daemon setting is honored; otherwise the 1-day default.
    this.idleTimeoutMs = options.idleTimeoutMs ?? this.loadPersistedIdleTimeoutMs() ?? 24 * 60 * 60_000;
    this.subscriberQueueLimit = options.subscriberQueueLimit ?? 256;
    this.commandResultLimit = options.commandResultLimit ?? 10_000;
    this.commandResultCacheLimit = options.commandResultCacheLimit ?? 1_000;
    this.createRequestLimit = options.createRequestLimit ?? 1_000;
    this.interruptLimit = options.interruptLimit ?? 1_000;
    this.readQueueLimit = options.readQueueLimit ?? 16;
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
    this.turnAdmissionTimeoutMs = options.turnAdmissionTimeoutMs ?? 15_000;
    this.turnOperationLimit = options.turnOperationLimit ?? 1_000;
    this.epochRolloverTimeoutMs = options.epochRolloverTimeoutMs ?? 10_000;
    this.expectedWorkerBuild = options.expectedWorkerBuild ?? WORKER_BUILD_IDENTITY;
    if (!Number.isSafeInteger(this.commandResultLimit) || this.commandResultLimit < 1) throw new RangeError("commandResultLimit must be positive");
    if (!Number.isSafeInteger(this.commandResultCacheLimit) || this.commandResultCacheLimit < 1) throw new RangeError("commandResultCacheLimit must be positive");
    if (!Number.isSafeInteger(this.createRequestLimit) || this.createRequestLimit < 1) throw new RangeError("createRequestLimit must be positive");
    if (!Number.isSafeInteger(this.interruptLimit) || this.interruptLimit < 1) throw new RangeError("interruptLimit must be positive");
    if (!Number.isSafeInteger(this.readQueueLimit) || this.readQueueLimit < 1) throw new RangeError("readQueueLimit must be positive");
    if (!Number.isSafeInteger(this.turnOperationLimit) || this.turnOperationLimit < 1) throw new RangeError("turnOperationLimit must be positive");
    if (!Number.isSafeInteger(this.epochRolloverTimeoutMs) || this.epochRolloverTimeoutMs < 1) throw new RangeError("epochRolloverTimeoutMs must be positive");
  }

  async create(input: RuntimeCreateParams): Promise<RuntimeCreateResult> {
    if (this.shuttingDown) throw new SessiondError("unavailable", "sessiond is shutting down", true);
    const existing = this.creates.get(input.createRequestId);
    if (existing) return existing;
    const operation = (async () => {
      const provisional = `creating:${input.createRequestId}`;
      const start: WorkerStartInput = {
        mode: "create",
        activationId: randomUUID(),
        sessionId: provisional,
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        create: {
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
          ...(input.thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned: input.thinkingLevelPinned }),
          ...(input.toolNames === undefined ? {} : { toolNames: input.toolNames }),
          ...(input.name === undefined ? {} : { name: input.name }),
        },
      };
      const record = await this.start(start);
      return {
        sessionId: record.sessionId,
        epoch: record.epoch,
        created: true,
        cwd: record.cwd,
        projectRoot: record.projectRoot,
        workerStatus: record.status,
        // Exact current per-epoch journal cursor after startup/busy-state
        // publication. Client create must never guess this as zero.
        lastEventId: record.journal.lastEventId,
        snapshot: record.projection.snapshot(),
      } satisfies RuntimeCreateResult;
    })();
    this.creates.set(input.createRequestId, operation);
    try {
      const result = await operation;
      while (this.creates.size > this.createRequestLimit) {
        const oldest = this.creates.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === input.createRequestId) break;
        this.creates.delete(oldest);
      }
      return result;
    }
    catch (error) { this.creates.delete(input.createRequestId); throw error; }
  }

  async activate(sessionId: string, requestedCwd?: string): Promise<RuntimeActivateResult> {
    if (this.shuttingDown) throw new SessiondError("unavailable", "sessiond is shutting down", true);
    // Fast path: an already-live record needs no lane and no reservation.
    const active = this.records.get(sessionId);
    if (active && active.status !== "crashed" && active.status !== "stopped") return this.activateResult(active);
    // D4 identity lane: the activation is admitted into the per-session FIFO
    // lane (registering an "activate" reservation SYNCHRONOUSLY so a delete
    // observing it fails closed promptly with session_busy and never waits for
    // the worker). The operation itself — locate / activation-context / worker
    // start — runs INSIDE the lane but OUTSIDE the global mutex, so a worker
    // ready/sessionDiscovered rekey (which itself acquires the mutex) never
    // self-blocks, different-id activations progress independently, and a
    // delete that wins the lane first removes the catalog entry so this
    // admission locates not_found and never starts a worker.
    return this.coordinator.admit(sessionId, "activate", async (ctx) => {
      if (this.shuttingDown) throw new SessiondError("unavailable", "sessiond is shutting down", true);
      const canonicalId = ctx.canonicalId;
      // Re-check inside the lane (FIFO means no same-id race, but a record may
      // already exist from a prior activation or a joined caller).
      const activeNow = this.records.get(canonicalId);
      if (activeNow && activeNow.status !== "crashed" && activeNow.status !== "stopped") return this.activateResult(activeNow);
      const inflightNow = this.activations.get(canonicalId);
      if (inflightNow) return this.activateResult(await inflightNow);
      // A queued request against an id that rekeyed away before it ran is stale.
      if (ctx.isStale()) throw new SessiondError("conflict", "session identity changed during activation", false);
      // Reservation is registered synchronously BEFORE long work (locate /
      // context / worker start).
      const operation = (async () => {
        const location = await this.deps.sessionLocator.locate(canonicalId);
        if (!location.exists) throw new SessiondError("not_found", `session not found: ${canonicalId}`);
        const context = await this.deps.activationContext.resolve(canonicalId, location, requestedCwd);
        return this.start({
          mode: "open",
          activationId: randomUUID(),
          sessionId: canonicalId,
          cwd: context.cwd,
          projectRoot: context.projectRoot,
          sessionFile: location.sessionFile,
        });
      })();
      this.activations.set(canonicalId, operation);
      try {
        return this.activateResult(await operation);
      } finally {
        // Exact-owner cleanup: only the admitted owner deletes its own entry,
        // and only while it still owns it. Joiners never delete another
        // caller's entry. Same-id admissions are lane-serialized, so no other
        // operation can take over the slot while this one is running. The
        // CURRENT canonical id is used (rekey moves the reservation, so a
        // captured pre-rekey id would leak the moved entry).
        const currentCanonical = ctx.canonicalId;
        if (this.activations.get(currentCanonical) === operation) this.activations.delete(currentCanonical);
      }
    });
  }

  private activateResult(record: RecordState): RuntimeActivateResult {
    return {
      sessionId: record.sessionId,
      epoch: record.epoch,
      cwd: record.cwd,
      projectRoot: record.projectRoot,
      workerStatus: record.status,
      snapshot: record.projection.snapshot(),
    };
  }

  private async start(input: WorkerStartInput): Promise<RecordState> {
    const existing = this.records.get(input.sessionId);
    if (existing && existing.status !== "crashed" && existing.status !== "stopped") return existing;
    if (existing) {
      existing.unsubscribeWorker();
      existing.unsubscribeExit();
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      await existing.worker.close().catch(() => {});
      this.records.delete(input.sessionId);
    }
    const worker = await this.deps.workerFactory.start(input);
    const record: RecordState = {
        sessionId: input.sessionId,
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
        epoch: this.makeEpoch(),
        activationId: input.activationId,
        worker,
        status: "starting",
        journal: new EventJournal(this.journalOptions),
        projection: new SnapshotProjection(defaultSnapshot(input.sessionId, input.cwd, input.projectRoot)),
        journalBaseEventId: 0,
        journalBaseSnapshot: defaultSnapshot(input.sessionId, input.cwd, input.projectRoot),
        subscribers: new Set(),
        commandResults: new Map(),
        readResults: new Map(),
        acceptedCommands: new Map(),
        pendingCommands: new Map(),
        pendingInterrupts: new Map(),
        turnOperations: new Map(),
        pendingTurnAdmissions: new Map(),
        pendingReads: new Map(),
        readQueue: [],
        activeReadId: null,
        acceptedInterrupts: new Map(),
        interruptResults: new Map(),
        pendingSnapshots: new Map(),
        authorityFinalizations: new Map(),
        epochRollover: undefined,
        rekeyEpochSync: undefined,
        rekeyInFlight: undefined,
        requiresEpochFence: false,
        unsubscribeWorker: () => {},
        unsubscribeExit: () => {},
        lastActivity: this.now(),
        lifecycle: new AsyncMutex(),
        idleGeneration: 0,
        closedEventEmitted: false,
      };
      this.records.set(input.sessionId, record);
      const ready = deferred<void>();
      record.startupReject = ready.reject;
      record.unsubscribeWorker = worker.subscribe((message) => this.handleWorkerMessage(record, input.activationId, message, ready.resolve));
      record.unsubscribeExit = worker.onExit((exit) => this.handleWorkerExit(record, input.activationId, exit));
      const timer = setTimeout(() => ready.reject(new SessiondError("timeout", "worker start timed out", true)), this.workerStartTimeoutMs);
      try {
        await worker.send({
          type: "worker.init",
          id: `init:${input.activationId}`,
          protocolVersion: PROTOCOL_VERSION,
          payload: {
            mode: input.mode,
            sessionId: input.sessionId,
            // Phase 5B: the worker adopts this as its authorityEpoch; a
            // startup rekey changes the record epoch and re-syncs via
            // worker.rotateEpoch before the record is exposed as ready.
            epoch: record.epoch,
            cwd: input.cwd,
            projectRoot: input.projectRoot,
            ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
            ...(input.create?.model === undefined ? {} : { model: input.create.model }),
            ...(input.create?.thinkingLevel === undefined ? {} : { thinkingLevel: input.create.thinkingLevel }),
            ...(input.create?.thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned: input.create.thinkingLevelPinned }),
            ...(input.create?.toolNames === undefined ? {} : { toolNames: [...input.create.toolNames] }),
            ...(input.create?.name === undefined ? {} : { name: input.create.name }),
            // Phase 7A build fence: the Worker validates this exact build
            // identity before bootstrapping any runtime, so a stale Worker
            // fails its own startup closed instead of running an unverifiable mix.
            build: SESSIOND_BUILD_IDENTITY,
          },
        });
        await ready.promise;
        delete record.startupReject;
        if (this.records.get(record.sessionId) !== record) throw new SessiondError("conflict", "worker identity collided during startup");
        record.status = "ready";
        this.touch(record);
        this.broadcastRunningChanged(record.sessionId);
        return record;
      } catch (error) {
        this.records.delete(record.sessionId);
        this.broadcastRunningChanged(record.sessionId);
        record.expectedExitReason = "startup_failed";
        record.unsubscribeWorker();
        record.unsubscribeExit();
        await worker.close().catch(() => {});
        throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleWorkerMessage(record: RecordState, activationId: string, message: WorkerToSessiondMessage, ready: () => void): void {
    if (record.activationId !== activationId || this.records.get(record.sessionId) !== record) return;
    record.lastActivity = this.now();
    switch (message.type) {
      case "worker.ready": {
        // Phase 7A build fence: validate the exact Worker build contract
        // BEFORE anything is advertised, rekeyed, projected, or dispatched on
        // this Worker. Unknown / older / malformed builds fail the startup
        // closed (the start() catch performs the bounded Worker cleanup); a
        // late ready frame with a bad build is dropped, never projected.
        const buildVerdict = evaluateWorkerBuild(message.payload.build, this.expectedWorkerBuild);
        if (buildVerdict.state === "incompatible") {
          if (record.startupReject !== undefined) {
            record.startupReject(
              new SessiondError(
                "worker_unavailable",
                `worker build contract rejected (${buildVerdict.reason}); the installed Worker dist is not compatible with this sessiond build`,
                false,
              ),
            );
          }
          break;
        }
        // Build-compatibility fence for the additive read RPC. A new sessiond
        // must never advertise/use worker.read against a stale Worker build
        // that only understands worker.command. Missing support fails startup
        // closed before rekey or projection priming.
        if (message.payload.features?.includes(RUNTIME_READ_RPC_FEATURE) !== true) {
          record.startupReject?.(new SessiondError("worker_unavailable", "worker does not support the negotiated read RPC", false));
          break;
        }
        if (message.payload.features?.includes(RUNTIME_SUBMIT_TURN_FEATURE) !== true) {
          record.startupReject?.(new SessiondError("worker_unavailable", "worker does not support atomic turn admission", false));
          break;
        }
        // The authoritative initial projection (state + capabilities together)
        // is fetched via worker.getSnapshot; worker.ready.state is intentionally
        // NOT projected separately so there is a SINGLE authority for the
        // initial snapshot — runtime capabilities can never be inferred from
        // ready state alone. A snapshot failure fails the startup closed.
        const settleReady = async (): Promise<void> => {
          record.status = message.payload.workerStatus;
          try {
            await this.primeProjection(record);
            ready();
          } catch (error) {
            record.startupReject?.(error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker startup snapshot failed", true));
          }
        };
        const settleAfterKnownRekey = async (): Promise<void> => {
          // sessionDiscovered is emitted before ready, but the handlers are
          // async. Await its exact rekey/epoch-sync task before deciding whether
          // ready still needs a fallback rekey; never rotate the same Worker
          // epoch twice concurrently.
          if (record.rekeyInFlight !== undefined) await record.rekeyInFlight;
          if (message.payload.sessionId !== record.sessionId) await this.rekey(record, message.payload.sessionId);
          await settleReady();
        };
        void settleAfterKnownRekey().catch((error) => {
          record.startupReject?.(error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker session rekey failed", true));
        });
        break;
      }
      case "worker.sessionDiscovered": {
        const task = this.rekey(record, message.payload.sessionId, message.payload.sessionFile, message.payload.cwd);
        record.rekeyInFlight = task;
        void task.catch((error) => {
          record.startupReject?.(error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker session rekey failed", true));
        }).finally(() => {
          if (record.rekeyInFlight === task) record.rekeyInFlight = undefined;
        });
        break;
      }
      case "worker.snapshot": {
        if (message.payload.sessionId !== record.sessionId) return;
        const pending = message.id === undefined ? undefined : record.pendingSnapshots.get(message.id);
        if (message.payload.snapshot.sessionId !== record.sessionId) {
          if (pending) {
            clearTimeout(pending.timer);
            record.pendingSnapshots.delete(message.id!);
            pending.reject(new SessiondError("worker_unavailable", "worker snapshot session mismatch", false));
          }
          return;
        }
        try {
          record.projection.replace(message.payload.snapshot);
          if (record.journal.lastEventId === 0) record.journalBaseSnapshot = record.projection.snapshot();
          this.broadcastRunningChanged(record.sessionId);
          if (pending) { clearTimeout(pending.timer); record.pendingSnapshots.delete(message.id!); pending.resolve(record.projection.snapshot()); }
        } catch (error) {
          if (pending) {
            clearTimeout(pending.timer);
            record.pendingSnapshots.delete(message.id!);
            pending.reject(error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker snapshot was rejected", false));
          }
        }
        break;
      }
      case "worker.event":
        if (message.payload.sessionId !== record.sessionId) return;
        this.acceptEvent(record, message.payload.event);
        break;
      case "worker.commandResult": {
        if (message.payload.sessionId !== record.sessionId) return;
        const result = message.payload.result;
        const pending = record.pendingCommands.get(message.id);
        // Accept only when wire id, inner commandId AND result type all match
        // the pending admission (same triple association as interruptResult).
        // A mismatch is dropped without clearing the timer, deleting pending,
        // caching, or starting thinking finalization — the original waiter
        // keeps waiting for a legitimate frame or times out.
        if (
          !pending ||
          pending.resolve === undefined ||
          pending.commandId !== result.commandId ||
          pending.commandType !== result.result.type
        ) {
          return;
        }
        clearTimeout(pending.timer);
        record.pendingCommands.delete(message.id);
        // set_thinking_level / set_model / set_auto_retry / set_tools / reload /
        // compact / navigate_tree success must not be cached or returned
        // until the projection has converged via a bounded worker.getSnapshot
        // refresh. Defer cache + resolve through the per-commandId singleflight
        // so same-id retries cannot observe a pre-authority success.
        if (result.result.ok && AUTHORITY_COMMAND_TYPES.has(result.result.type)) {
          const finalized = this.ensureAuthorityFinalized(record, result);
          void finalized.then((finalResult) => {
            pending.resolve(finalResult);
          });
          break;
        }
        this.cacheCommandResult(record, result);
        pending.resolve(result);
        break;
      }
      case "worker.submitTurnResult": {
        const pending = record.pendingTurnAdmissions.get(message.id);
        if (!pending) return;
        const workerResult = message.payload.result;
        // Strict admission correlation (Phase 3): the result/admission identity
        // must match the pending record EXACTLY — dispatch id, sessionId, epoch,
        // operationId, fingerprint AND the dispatched turnId. A schema-valid
        // frame with the correct dispatchId but a forged turnId (or a nested
        // turnStatus/snapshot carrying a different identity) is dropped WITHOUT
        // projection mutation or settlement, so a later exact frame can still
        // settle the pending admission. The worker also mints only the two
        // terminal worker statuses (accepted/rejected); a `duplicate` admission
        // is sessiond's own re-submit outcome and can never legitimately arrive
        // on the worker→sessiond wire.
        if (
          message.payload.dispatchId !== pending.dispatchId ||
          message.payload.sessionId !== pending.sessionId ||
          message.payload.epoch !== pending.epoch ||
          message.payload.operationId !== pending.operationId ||
          message.payload.fingerprint !== pending.fingerprint ||
          workerResult.sessionId !== pending.sessionId ||
          workerResult.operationId !== pending.operationId ||
          (workerResult.epoch !== undefined && workerResult.epoch !== pending.epoch) ||
          ("turnId" in workerResult && workerResult.turnId !== undefined && workerResult.turnId !== pending.turnId) ||
          (workerResult.status !== "accepted" && workerResult.status !== "rejected") ||
          (workerResult.snapshot !== undefined && workerResult.snapshot.sessionId !== pending.sessionId)
        ) return;
        // Nested turnStatus must carry the exact pending turn identity. (For an
        // accepted admission the wire schema already cross-checks turnId against
        // the outer turnId, but the service boundary stays fail-closed against a
        // forged nested identity even when the outer fields match.)
        if (workerResult.status === "accepted") {
          const turnStatus = workerResult.turnStatus;
          if (
            turnStatus.sessionId !== pending.sessionId ||
            turnStatus.epoch !== pending.epoch ||
            turnStatus.operationId !== pending.operationId ||
            turnStatus.turnId !== pending.turnId
          ) return;
        }
        clearTimeout(pending.timer);
        record.pendingTurnAdmissions.delete(message.id);
        let result: SubmitTurnAdmission;
        if (workerResult.status === "accepted") {
          try {
            record.projection.replace(workerResult.snapshot);
          } catch {
            result = this.rejectedTurn(pending.sessionId, pending.operationId, "not_delivered", { code: "worker_unavailable", message: "worker turn snapshot was rejected", retryable: true }, pending.epoch, record.journal.lastEventId);
            pending.resolve(result);
            return;
          }
          const status: TurnStatus = { ...workerResult.turnStatus, revision: 0 };
          result = { ...workerResult, revision: record.journal.lastEventId, turnStatus: status };
          const operation = record.turnOperations.get(pending.operationId);
          if (operation && operation.dispatchId === pending.dispatchId) {
            operation.admission = result;
            operation.status = status;
            this.pushTurnStatus(operation, { type: "turn_status", status });
          }
          this.broadcastRunningChanged(record.sessionId);
        } else {
          if (workerResult.snapshot !== undefined) {
            try { record.projection.replace(workerResult.snapshot); } catch { /* truthful rejection remains; bad snapshot is omitted below */ }
          }
          result = { ...workerResult, revision: record.journal.lastEventId };
          const operation = record.turnOperations.get(pending.operationId);
          if (operation && operation.dispatchId === pending.dispatchId) operation.admission = result;
        }
        pending.resolve(result);
        break;
      }
      case "worker.turnStatus": {
        const status = message.payload;
        if (status.sessionId !== record.sessionId || status.epoch !== record.epoch) return;
        const operation = record.turnOperations.get(status.operationId);
        if (!operation || operation.turnId !== status.turnId || operation.epoch !== status.epoch) return;
        if (status.revision <= operation.status.revision) return;
        operation.status = status;
        this.pushTurnStatus(operation, { type: "turn_status", status });
        this.broadcastRunningChanged(record.sessionId);
        break;
      }
      case "worker.interruptResult": {
        if (message.payload.sessionId !== record.sessionId) return;
        const result = message.payload.result;
        const pending = record.pendingInterrupts.get(message.id);
        // Accept only when wire id, commandId AND result type all match the
        // pending admission. A mismatch is dropped (never wrongly resolved) so
        // the original waiter times out rather than receiving the wrong result.
        if (!pending || pending.commandId !== result.commandId || pending.type !== result.result.type) return;
        clearTimeout(pending.timer);
        record.pendingInterrupts.delete(message.id);
        this.cacheInterruptResult(record, result);
        pending.resolve(result);
        break;
      }
      case "worker.readResult": {
        // Phase 2B read lane. Accept only when the dispatch id AND the full
        // identity triple (sessionId + epoch + requestId) AND the result type
        // all match the pending read; any mismatch is dropped (never settles
        // another pending read). A late result (no pending entry) is dropped.
        if (message.payload.sessionId !== record.sessionId) return;
        const pending = record.pendingReads.get(message.id);
        if (!pending) return;
        if (
          pending.sessionId !== message.payload.sessionId ||
          pending.epoch !== message.payload.epoch ||
          pending.requestId !== message.payload.requestId ||
          pending.read.type !== message.payload.result.type
        ) {
          return;
        }
        this.settleRead(record, message.id, message.payload.result);
        break;
      }
      case "worker.status":
        record.status = message.payload.status;
        this.broadcastRunningChanged(record.sessionId);
        break;
      case "worker.fatal": this.crash(record, message.payload.error); break;
      case "worker.rotateEpochResult": {
        // Phase 5B: accept ONLY the exact correlated rotation identity
        // (dispatch slot + session + from/to epoch). Any mismatch is dropped so
        // the original waiter keeps waiting for a legitimate frame or times out.
        if (message.payload.sessionId !== record.sessionId) return;
        // Startup rekey epoch re-sync (no capacity-rollover commit side effects).
        const rekeySync = record.rekeyEpochSync;
        if (rekeySync && message.id === rekeySync.dispatchId && message.payload.fromEpoch === rekeySync.from && message.payload.toEpoch === rekeySync.to) {
          clearTimeout(rekeySync.timer);
          if (record.rekeyEpochSync === rekeySync) record.rekeyEpochSync = undefined;
          if (!message.payload.ok) rekeySync.resolve({ rolled: false, error: message.payload.error });
          else rekeySync.resolve({ rolled: true });
          break;
        }
        const pending = record.epochRollover;
        if (!pending) return;
        if (message.id !== pending.dispatchId || message.payload.fromEpoch !== pending.from || message.payload.toEpoch !== pending.to) return;
        clearTimeout(pending.timer);
        if (!message.payload.ok) {
          // Failure keeps the OLD epoch and every ledger intact.
          if (record.epochRollover === pending) record.epochRollover = undefined;
          pending.resolve({ rolled: false, error: message.payload.error });
          break;
        }
        // Success: triple-check record / current old epoch / pending identity
        // under the lifecycle mutex, then atomically commit.
        void record.lifecycle.runExclusive(() => {
          if (this.records.get(record.sessionId) !== record || record.epoch !== pending.from || record.epochRollover !== pending) {
            if (record.epochRollover === pending) record.epochRollover = undefined;
            // Worker already acknowledged the new epoch. If this record still
            // owns the session but cannot commit the exact transition, never
            // continue in a split-brain old epoch.
            if (this.records.get(record.sessionId) === record) {
              this.crash(record, { code: "worker_unavailable", message: "epoch rollover commit lost authority", retryable: true });
              void record.worker.close().catch(() => {});
            }
            pending.resolve({ rolled: false, error: { code: "conflict", message: "session identity changed during epoch rollover", retryable: false } });
            return;
          }
          this.commitEpochRollover(record, pending.to);
          pending.resolve({ rolled: true });
        });
        break;
      }
      default: break;
    }
  }

  /**
   * D4 rekey: requestedId → authoritativeId. The alias is atomically bound to
   * the SAME startup reservation under the short global mutex (synchronous
   * records/alias transition only — the Worker close on the conflict path runs
   * OUTSIDE the mutex). If the target already has an independent lane,
   * reservation or live record, the rekey fails closed with a fixed conflict
   * (never waits/merges/steals). Requests queued against the old id before the
   * rekey observe a bumped lane generation and fail closed stale; requests
   * admitted under the authoritative id after binding queue behind the startup
   * and operate on the ready authoritative record.
   */
  private async rekey(record: RecordState, realId: string, sessionFile?: string, cwd?: string): Promise<void> {
    const oldId = record.sessionId;
    const oldEpoch = record.epoch;
    let conflicted = false;
    let epochChanged = false;
    await this.mutex.runExclusive(() => {
      if (!this.records.has(oldId) || realId === oldId) return;
      const collision = this.records.get(realId);
      if (collision && collision !== record) {
        conflicted = true;
        return;
      }
      if (this.activations.has(realId)) {
        conflicted = true;
        return;
      }
      // An occupied target lane (or a target lane when we have none) is an
      // independent reservation — fail closed rather than wait/merge/steal.
      if (this.coordinator.hasLane(oldId)) {
        if (!this.coordinator.bindRekey(oldId, realId)) {
          conflicted = true;
          return;
        }
      } else if (this.coordinator.hasLane(realId)) {
        conflicted = true;
        return;
      }
      this.records.delete(oldId);
      record.sessionId = realId;
      if (sessionFile !== undefined) record.sessionFile = sessionFile;
      if (cwd !== undefined) record.cwd = cwd;
      record.epoch = this.makeEpoch();
      epochChanged = record.epoch !== oldEpoch;
      record.journal = new EventJournal(this.journalOptions);
      record.journalBaseEventId = 0;
      record.commandResults.clear();
      record.readResults.clear();
      record.acceptedCommands.clear();
      record.acceptedInterrupts.clear();
      record.interruptResults.clear();
      this.settleAllPendingTurns(record, "session epoch changed during rekey");
      record.turnOperations.clear();
      record.authorityFinalizations.clear();
      // Phase 2B read lane: pending reads belong to the OLD epoch — settle each
      // waiter exactly once with a fixed unavailable; late worker.readResult
      // frames (new epoch dispatch ids) are dropped by the handler.
      this.settleAllPendingReads(record, "unavailable", "session epoch changed during rekey");
      record.projection.rekey(realId);
      const snapshot = record.projection.snapshot();
      snapshot.cwd = record.cwd;
      if (sessionFile !== undefined) snapshot.state.sessionFile = sessionFile;
      record.projection.replace(snapshot);
      record.journalBaseSnapshot = record.projection.snapshot();
      this.records.set(realId, record);
      // Move the activation reservation + any rename-title overlay so joiners
      // and reads under the authoritative id see the same identity.
      const reservation = this.activations.get(oldId);
      if (reservation) {
        this.activations.delete(oldId);
        this.activations.set(realId, reservation);
      }
      this.titleOverlay.move(oldId, realId);
    });
    if (!conflicted && oldId !== record.sessionId) this.broadcastRunningChanged(record.sessionId);
    // Phase 5B: a rekey changes the record epoch; re-sync the Worker's
    // authorityEpoch via worker.rotateEpoch BEFORE the record is exposed as
    // ready (startup: idle, zero business handlers). A failed sync fails the
    // startup closed — a ready Worker with a stale authorityEpoch would reject
    // every subsequent command.
    if (!conflicted && epochChanged) {
      const from = oldEpoch;
      const to = record.epoch;
      const wait = deferred<{ rolled: true } | { rolled: false; error: ProtocolError }>();
      const dispatchId = `rotate:${from}:${randomUUID()}`;
      const pending: EpochRollover = { from, to, dispatchId, promise: wait.promise, resolve: wait.resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      pending.timer = setTimeout(() => {
        if (record.rekeyEpochSync !== pending) return;
        record.rekeyEpochSync = undefined;
        wait.resolve({ rolled: false, error: { code: "timeout", message: "worker epoch re-sync timed out", retryable: true } });
      }, this.epochRolloverTimeoutMs);
      record.rekeyEpochSync = pending;
      try {
        await record.worker.send({
          type: "worker.rotateEpoch",
          id: dispatchId,
          protocolVersion: PROTOCOL_VERSION,
          payload: { sessionId: record.sessionId, fromEpoch: from, toEpoch: to },
        });
        const rotated = await wait.promise;
        if (!rotated.rolled) {
          await this.failRekeyEpochSync(record, realId);
          throw new SessiondError("worker_unavailable", "worker epoch re-sync failed during rekey", true);
        }
      } catch (error) {
        clearTimeout(pending.timer);
        if (record.rekeyEpochSync === pending) record.rekeyEpochSync = undefined;
        if (this.records.get(record.sessionId) === record) await this.failRekeyEpochSync(record, realId);
        throw error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker epoch re-sync failed during rekey", true);
      } finally {
        clearTimeout(pending.timer);
      }
    }
    if (conflicted) {
      // Fail closed OUTSIDE the mutex: identity transition is already done, and
      // the Worker close is never awaited under the global lock.
      record.expectedExitReason = "rekey_conflict";
      this.records.delete(record.sessionId);
      this.broadcastRunningChanged(record.sessionId);
      record.unsubscribeWorker();
      record.unsubscribeExit();
      record.startupReject?.(new SessiondError("conflict", `session already active: ${realId}`));
      delete record.startupReject;
      await record.worker.close().catch(() => {});
    }
  }

  /**
   * Fail the startup closed when the post-rekey worker epoch re-sync fails.
   * The record is removed, the startup waiter is rejected and the Worker is
   * closed (bounded) — a ready Worker with a stale authorityEpoch would reject
   * every subsequent command.
   */
  private async failRekeyEpochSync(record: RecordState, realId: string): Promise<void> {
    void realId;
    record.expectedExitReason = "rekey_epoch_sync_failed";
    if (this.records.get(record.sessionId) === record) {
      this.records.delete(record.sessionId);
      this.broadcastRunningChanged(record.sessionId);
    }
    record.unsubscribeWorker();
    record.unsubscribeExit();
    record.startupReject?.(new SessiondError("worker_unavailable", "worker epoch re-sync failed during rekey", true));
    delete record.startupReject;
    await record.worker.close().catch(() => {});
  }

  private acceptEvent(record: RecordState, data: RuntimeEventData): void {
    if (record.status === "crashed" || record.status === "stopped" || record.status === "stopping") return;
    const wasTurnRunning = this.isTurnRunning(record);
    if (data.type === "runtime_closed") {
      if (record.closedEventEmitted) return;
      record.closedEventEmitted = true;
    }
    try {
      record.projection.apply(data);
      const appended = record.journal.appendDetailed(record.epoch, data);
      if (appended.evicted.length > 0) {
        const base = new SnapshotProjection(record.journalBaseSnapshot);
        for (const event of appended.evicted) base.apply(stripCursor(event));
        record.journalBaseSnapshot = base.snapshot();
        record.journalBaseEventId = appended.evicted.at(-1)!.eventId;
      }
      this.push(record, { type: "event", event: appended.event });
      if (data.type !== "running_sessions_changed" && wasTurnRunning !== this.isTurnRunning(record)) {
        this.broadcastRunningChanged(record.sessionId);
      }
    } catch (error) {
      if (error instanceof RangeError && error.message === "event cursor exhausted") {
        const fromEpoch = record.epoch;
        record.epoch = this.makeEpoch();
        record.journal = new EventJournal(this.journalOptions);
        record.journalBaseEventId = 0;
        record.journalBaseSnapshot = record.projection.snapshot();
        const event = record.journal.append(record.epoch, data);
        this.push(record, this.snapshotPush(record, "epoch_changed"));
        this.push(record, { type: "event", event });
        // Phase 5B: re-sync the Worker's authorityEpoch after the cursor-exhaustion
        // epoch change (best-effort, bounded; the existing cursor-exhaustion
        // behavior is retained — no new ledger-clearing claim is made). If the
        // Worker is mid-turn the strict-idle rotate fails and subsequent commands
        // fail closed at the Worker (astronomically rare catastrophic path).
        if (record.rekeyEpochSync === undefined) {
          const to = record.epoch;
          const wait = deferred<{ rolled: true } | { rolled: false; error: ProtocolError }>();
          const dispatchId = `rotate:${fromEpoch}:${randomUUID()}`;
          const pending: EpochRollover = { from: fromEpoch, to, dispatchId, promise: wait.promise, resolve: wait.resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> };
          pending.timer = setTimeout(() => {
            if (record.rekeyEpochSync === pending) record.rekeyEpochSync = undefined;
            wait.resolve({ rolled: false, error: { code: "timeout", message: "worker epoch re-sync timed out", retryable: true } });
          }, this.epochRolloverTimeoutMs);
          record.rekeyEpochSync = pending;
          void record.worker.send({
            type: "worker.rotateEpoch",
            id: dispatchId,
            protocolVersion: PROTOCOL_VERSION,
            payload: { sessionId: record.sessionId, fromEpoch, toEpoch: to },
          }).then(() => wait.promise).catch(() => ({ rolled: false as const, error: { code: "worker_unavailable" as const, message: "worker rotateEpoch send failed", retryable: true } }))
            .then((outcome) => {
              clearTimeout(pending.timer);
              if (record.rekeyEpochSync === pending) record.rekeyEpochSync = undefined;
              void outcome;
            });
        }
      }
      // Other stale/malformed worker events are rejected at the authority boundary.
    }
  }

  private handleWorkerExit(record: RecordState, activationId: string, exit: { error?: import("@fffattiger/pix-protocol").ProtocolError }): void {
    if (record.activationId !== activationId || this.records.get(record.sessionId) !== record || record.expectedExitReason !== undefined) return;
    this.crash(record, exit.error);
  }

  private crash(record: RecordState, error?: import("@fffattiger/pix-protocol").ProtocolError): void {
    if (record.status === "crashed") return;
    const eventData: RuntimeEventData = { type: "worker_crashed", sessionId: record.sessionId, ...(error === undefined ? {} : { error }) };
    this.acceptEvent(record, eventData);
    record.status = "crashed";
    this.rejectPending(record, "worker crashed");
    this.broadcastRunningChanged(record.sessionId);
  }

  private rejectPending(record: RecordState, message: string): void {
    for (const pending of record.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.resolve(unavailableCommand(pending.commandId, pending.commandType, message));
    }
    record.pendingCommands.clear();
    for (const pending of record.pendingInterrupts.values()) { clearTimeout(pending.timer); pending.resolve(unavailableInterrupt(pending.commandId, pending.type, message)); }
    record.pendingInterrupts.clear();
    this.settleAllPendingTurns(record, message);
    for (const pending of record.pendingSnapshots.values()) { clearTimeout(pending.timer); pending.reject(new SessiondError("worker_unavailable", message, true)); }
    record.pendingSnapshots.clear();
    // Phase 2B read lane: settle every pending read EXACTLY ONCE with a fixed
    // structured unavailable outcome (stop/crash/shutdown); late results are
    // dropped by the worker.readResult handler because the pending entry is gone.
    this.settleAllPendingReads(record, "worker_unavailable", message);
  }

  private settleAllPendingTurns(record: RecordState, message: string): void {
    for (const pending of record.pendingTurnAdmissions.values()) {
      clearTimeout(pending.timer);
      pending.resolve(this.rejectedTurn(pending.sessionId, pending.operationId, "uncertain", { code: "worker_unavailable", message, retryable: true }, pending.epoch, record.journal.lastEventId));
    }
    record.pendingTurnAdmissions.clear();
    for (const operation of record.turnOperations.values()) {
      if (operation.status.state === "completed" || operation.status.state === "failed") continue;
      const status: TurnStatus = { ...operation.status, revision: operation.status.revision + 1, state: "failed", error: { code: "worker_unavailable", message, retryable: true } };
      operation.status = status;
      this.pushTurnStatus(operation, { type: "turn_status", status });
    }
  }

  async command(sessionId: string, command: RuntimeCommand, epoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    // Phase 5B outer fence applies BEFORE special identity-lane routing too.
    // Otherwise a stale set_session_name/fork/auto_name request could bypass
    // commandOnRecord and execute after a rollover using the new record epoch.
    const exactRecord = this.records.get(sessionId);
    if (exactRecord && !["crashed", "stopped", "stopping"].includes(exactRecord.status)) {
      if ((epoch !== undefined && epoch !== exactRecord.epoch) || (epoch === undefined && exactRecord.requiresEpochFence)) {
        return epochChangedCommand(command.commandId, command.type);
      }
      if (exactRecord.epochRollover !== undefined) return epochChangedCommand(command.commandId, command.type);
    }
    // D4 identity lane: public `runtime.command(set_session_name)` shares the
    // EXACT same per-session FIFO lane as `sessions.rename`, so the Client
    // SessionActions path can never bypass Host/API rename ordering. The private
    // non-reentrant command operation is never re-admitted into the lane.
    if (command.type === "set_session_name") return this.commandRename(sessionId, command, epoch);
    // D2 auto_name: public `runtime.command(generate_session_title)` shares the
    // SAME per-session FIFO lane as rename (reusing the "rename" kind, the §51
    // set_session_name semantics) so a user rename and an auto_name on the same
    // session serialize FIFO with a deterministic last-committer-wins title.
    if (command.type === "generate_session_title") return this.commandAutoName(sessionId, command, epoch);
    // D2 fork: `runtime.command(fork)` shares the same per-session FIFO lane as
    // activate/rename/stop/delete so a fork races old-id identity mutations
    // deterministically and ends the OLD worker through the identity stop path.
    if (command.type === "fork") return this.commandFork(sessionId, command, epoch);
    const record = this.requireActive(sessionId);
    return this.commandOnRecord(record, command, epoch);
  }

  /**
   * Private non-reentrant command operation (the former `command` body). One
   * caller holds exactly one lane and never enqueues recursively; this method
   * is invoked by the rename lane operation for live `set_session_name` and by
   * the public `command` for every other command type.
   */
  private async commandOnRecord(record: RecordState, command: RuntimeCommand, epoch?: string, allowCoordinatorLane = false): Promise<CorrelatedRuntimeCommandResult> {
    const sessionId = record.sessionId;
    const readOnly = READ_ONLY_COMMAND_TYPES.has(command.type);
    let immediate: CorrelatedRuntimeCommandResult | undefined;
    let pending!: PendingCommand;
    let finalization: Promise<CorrelatedRuntimeCommandResult> | undefined;
    let needsRollover = false;
    await record.lifecycle.runExclusive(async () => {
      if (this.records.get(sessionId) !== record || ["crashed", "stopped", "stopping"].includes(record.status)) {
        immediate = unavailableCommand(command.commandId, command.type, "runtime stopped before command admission");
        return;
      }
      // Phase 5B: while a whole-epoch rollover is pending every new admission is
      // blocked (the joined capacity triggerers await the shared slot promise
      // outside this lock). Fail-closed epoch_changed; retry after the snapshot.
      if (record.epochRollover !== undefined) {
        immediate = epochChangedCommand(command.commandId, command.type);
        return;
      }
      // Phase 5B fence: after a record has rolled, new command admissions
      // REQUIRE the exact current epoch — missing/old fails closed BEFORE any
      // accepted/pending identity or side effect.
      if ((epoch !== undefined && epoch !== record.epoch) || (record.requiresEpochFence && epoch === undefined)) {
        immediate = epochChangedCommand(command.commandId, command.type);
        return;
      }
      const acceptedType = record.acceptedCommands.get(command.commandId);
      if (acceptedType !== undefined && acceptedType !== command.type) {
        immediate = rejectedCommand(command.commandId, command.type, `commandId was already accepted as ${acceptedType}`);
        return;
      }
      // Join in-flight authority finalization before the result cache so
      // same-id retries never observe a pre-refresh success (and never start a
      // second worker.command / getSnapshot for this commandId).
      const finalizing = record.authorityFinalizations.get(command.commandId);
      if (finalizing) { finalization = finalizing; return; }
      const resultCache = readOnly ? record.readResults : record.commandResults;
      const otherResultCache = readOnly ? record.commandResults : record.readResults;
      const cached = resultCache.get(command.commandId);
      if (cached) {
        // A bounded result cache can outlive the accepted-id entry only for
        // read-only requests. Never let a reused commandId obtain a cached
        // result for a different command type.
        if (cached.result.type !== command.type) {
          immediate = rejectedCommand(command.commandId, command.type, `commandId was already completed as ${cached.result.type}`);
        } else {
          immediate = cached;
        }
        return;
      }
      const crossDomainCached = otherResultCache.get(command.commandId);
      if (crossDomainCached) {
        immediate = rejectedCommand(command.commandId, command.type, `commandId was already completed as ${crossDomainCached.result.type}`);
        return;
      }
      const wireId = `command:${record.epoch}:${command.commandId}`;
      const existing = record.pendingCommands.get(wireId);
      if (existing) {
        if (existing.commandType !== command.type) {
          immediate = rejectedCommand(command.commandId, command.type, `commandId was already in progress as ${existing.commandType}`);
        } else {
          pending = existing;
        }
        return;
      }
      if (acceptedType !== undefined) { immediate = duplicateResultUnavailable(command.commandId, acceptedType); return; }
      // Only side-effecting commands consume the epoch's finite admission
      // ledger. Read-only command results remain bounded by the independent
      // readResults cache and may safely be re-issued after eviction; they never
      // mutate the runtime and never make a long-lived session unsendable.
      // Phase 5B: at the capacity boundary BEFORE inserting any accepted/pending
      // identity, an explicitly supplied epoch must equal the current one (a
      // stale/missing-after-rollover epoch fails epoch_changed, never rotates);
      // otherwise a safe whole-epoch rollover is started/joined OUTSIDE the lock.
      if (!readOnly && record.acceptedCommands.size >= this.commandResultLimit) {
        if (epoch !== undefined && epoch !== record.epoch) {
          immediate = epochChangedCommand(command.commandId, command.type);
          return;
        }
        if (epoch === undefined && record.requiresEpochFence) {
          immediate = epochChangedCommand(command.commandId, command.type);
          return;
        }
        needsRollover = true;
        return;
      }
      if (!readOnly) record.acceptedCommands.set(command.commandId, command.type);
      const wait = deferred<CorrelatedRuntimeCommandResult>();
      const timer = setTimeout(() => {
        record.pendingCommands.delete(wireId);
        wait.resolve(unavailableCommand(command.commandId, command.type, "worker command timed out"));
      }, this.commandTimeoutMs);
      pending = { commandId: command.commandId, commandType: command.type, epoch: record.epoch, promise: wait.promise, resolve: wait.resolve, timer };
      record.pendingCommands.set(wireId, pending);
      this.touch(record);
      if (readOnly) {
        // Phase 2B: legacy command-envelope reads route INTERNALLY to the new
        // bounded read service (projection answers + worker.read) — NEVER
        // worker.command — while preserving the old correlated result shape
        // (commandId + RuntimeCommandOutcome) for old v2 clients. requestId =
        // commandId for legacy correlation. The read service settles each
        // waiter exactly once (its own timeout + lifecycle settlement); the
        // legacy timer below is a second, idempotent bound.
        void this.performRead(record, command.commandId, toReadRequest(command.type))
          .then((outcome) => {
            // The legacy command timer or a lifecycle transition may already
            // have settled and removed this waiter. A late read result is then
            // inert: it must not overwrite the cached timeout/unavailable with
            // a later success.
            if (record.pendingCommands.get(wireId) !== pending) return;
            clearTimeout(timer);
            record.pendingCommands.delete(wireId);
            const result: CorrelatedRuntimeCommandResult = { commandId: command.commandId, result: toCommandOutcome(outcome) };
            this.cacheCommandResult(record, result);
            pending.resolve(result);
          })
          .catch(() => {
            // Defensive bound: performRead never rejects; a broken throw still
            // settles the waiter exactly once (never hangs the RPC).
            if (record.pendingCommands.get(wireId) !== pending) return;
            clearTimeout(timer);
            record.pendingCommands.delete(wireId);
            pending.resolve(unavailableCommand(command.commandId, command.type, "read failed"));
          });
      } else {
        try {
          await record.worker.send({ type: "worker.command", id: wireId, protocolVersion: PROTOCOL_VERSION, payload: { sessionId, epoch: record.epoch, command } });
        } catch {
          clearTimeout(timer);
          record.pendingCommands.delete(wireId);
          const result = unavailableCommand(command.commandId, command.type, "worker command send failed");
          this.cacheCommandResult(record, result);
          immediate = result;
        }
      }
    });
    if (immediate) return immediate;
    // Phase 5B: the capacity boundary was hit — start/join the single-flight
    // whole-epoch rollover. On success the triggering request is PROVEN NOT
    // ADMITTED and returns a typed epoch_changed failure (never re-dispatched,
    // never silently retried). On failure the OLD epoch/ledgers stay intact and
    // the original capacity failure is returned.
    if (needsRollover) {
      const roll = await this.rotateEpoch(record, allowCoordinatorLane);
      if (roll.rolled) return epochChangedCommand(command.commandId, command.type);
      if (roll.error.code !== "session_busy") return { commandId: command.commandId, result: { ok: false, type: command.type, error: roll.error } };
      return rejectedCommand(command.commandId, command.type, "command id capacity reached for this epoch");
    }
    if (finalization) return finalization;
    const result = await pending.promise;
    // Terminal results are cached by the worker.commandResult handler (ordinary
    // commands) or by authority finalization (set_thinking_level & co).
    // Cache only when still absent and this record/epoch still owns the admission
    // so timeout paths stay at-most-once without cross-rekey writes.
    if (
      this.records.get(record.sessionId) === record &&
      record.epoch === pending.epoch &&
      !(readOnly ? record.readResults : record.commandResults).has(result.commandId)
    ) {
      this.cacheCommandResult(record, result);
    }
    return result;
  }

  /**
   * D4 identity lane for public `runtime.command(set_session_name)`. Shares the
   * exact same per-session FIFO lane as `sessions.rename` (never bypasses rename
   * ordering) and always returns a structured correlated result. An offline
   * session (no live record) fails with a fixed unavailable result — the Client
   * SessionActions path never silently performs an offline mutation.
   */
  private commandRename(sessionId: string, command: RuntimeCommand & { type: "set_session_name" }, epoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    let canonicalName: string;
    try {
      canonicalName = canonicalizeSessionName(command.name);
    } catch {
      return Promise.resolve({
        commandId: command.commandId,
        result: { ok: false, type: "set_session_name", error: { code: "invalid_input", message: "session name is invalid", retryable: false } },
      });
    }
    return this.coordinator.admit(sessionId, "rename", async (ctx) => {
      if (this.shuttingDown) return unavailableCommand(command.commandId, "set_session_name", "sessiond is shutting down");
      if (ctx.isStale()) return unavailableCommand(command.commandId, "set_session_name", "session identity changed during rename");
      const record = this.records.get(ctx.canonicalId);
      if (!record || record.status === "stopped") {
        return unavailableCommand(command.commandId, "set_session_name", "runtime is not active");
      }
      if (record.status === "crashed" || record.status === "stopping") {
        // A crashed/stopping record remains a reservation: never fall back offline.
        return unavailableCommand(command.commandId, "set_session_name", "runtime is not active");
      }
      return this.executeLiveRename(record, command.commandId, canonicalName, epoch);
    });
  }

  /**
   * D2 fork: the per-session FIFO identity lane for `runtime.command(fork)`.
   * Shares the exact same lane as activate / rename / stop / delete so a fork
   * races identity mutations on the OLD session deterministically:
   *
   * - delete/rename/stop admitted FIRST → the fork's record lookup sees the
   *   removed/stopped record and fails closed with a fixed sanitized
   *   not_found / unavailable (never a partial fork, zero new sessions);
   * - fork admitted FIRST → the lane stays HELD through the old-worker stop, so
   *   a queued rename/delete/stop observes the stopped record (no double-stop,
   *   no stale-lane write).
   *
   * Result-before-stop ordering: the caller's promise is resolved with the fork
   * result as soon as the worker settles it (the fork lane op resolves a
   * private deferred) and ONLY THEN the OLD worker is ended via the existing
   * identity stop path — the client receives the fork result + new session id
   * before the old runtime_closed is observable. The lane op itself continues
   * to hold the lane until the stop completes, so queued identity ops wait for
   * the stopped record.
   *
   * Frozen semantics (never rolled back): a successful fork creates the new
   * session (in the adapter/SDK catalog) BEFORE the old worker stops. If the
   * old-worker stop fails, the fork is NOT rolled back — the new session exists
   * and remains usable; the stop failure is absorbed (never a raw error, never
   * a false fork failure) and the record is still removed. Activation of the
   * forked session id is client-driven (existing activate semantics); there is
   * NO implicit attach switch server-side.
   */
  private commandFork(sessionId: string, command: RuntimeCommand & { type: "fork" }, epoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    const settled = deferred<CorrelatedRuntimeCommandResult>();
    void this.coordinator.admit(sessionId, "fork", async (ctx) => {
      try {
        if (this.shuttingDown) {
          settled.resolve(unavailableCommand(command.commandId, "fork", "sessiond is shutting down"));
          return;
        }
        if (ctx.isStale()) {
          settled.resolve(unavailableCommand(command.commandId, "fork", "session identity changed during fork"));
          return;
        }
        const record = this.records.get(ctx.canonicalId);
        if (!record) {
          // delete-first: the session's record is gone → fixed not_found, never
          // a partial fork and never a raw session id echoed.
          settled.resolve({
            commandId: command.commandId,
            result: { ok: false, type: "fork", error: { code: "not_found", message: "session not found", retryable: false } },
          });
          return;
        }
        if (["crashed", "stopped", "stopping"].includes(record.status)) {
          settled.resolve(unavailableCommand(command.commandId, "fork", "runtime is not active"));
          return;
        }
        const result = await this.commandOnRecord(record, command, epoch);
        // Deliver the fork result to the caller BEFORE the old worker is ended.
        settled.resolve(result);
        if (result.result.ok && result.result.type === "fork") {
          // End the OLD worker via the existing identity-lane stop path. The
          // lane stays held through the stop so queued rename/delete/stop on the
          // old id observe the stopped record (deterministic, no double-stop).
          // stopRecord emits runtime_closed("forked") exactly once (the adapter
          // may already have self-closed; `closedEventEmitted` makes it idempotent)
          // and removes the record — snapshot authority finalization is NOT
          // required because the authoritative record transitions to stopped
          // rather than needing a post-success refresh (fork is deliberately NOT
          // an AUTHORITY_COMMAND_TYPE).
          try {
            await record.lifecycle.runExclusive(() => this.stopRecord(record, "forked"));
          } catch (stopError) {
            // Fork success is never rolled back: the new session already exists.
            // Absorb the stop failure sanitized — no raw text crosses, no false
            // fork failure is reported to the caller (which already received the
            // fork result).
          }
        }
      } catch {
        // Defensive bound: never hang the caller. A second resolve is a no-op
        // (the first — real — result already won), so a late throw cannot
        // replace an already-delivered fork result.
        settled.resolve(unavailableCommand(command.commandId, "fork", "fork failed"));
      }
    });
    return settled.promise;
  }

  /**
   * Live `set_session_name` with D4 ownership guards. The captured record
   * object + epoch are checked immediately before command admission and again
   * before success publication, so an old record/epoch result after
   * stop/reactivate can never publish a title or affect a new Worker. The
   * command result must match the captured ownership; `{ok:false}` is a
   * failure and is never reported as success.
   */
  private async executeLiveRename(record: RecordState, commandId: string, name: string, expectedEpoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    const epochAtCapture = record.epoch;
    if (!this.ownsLiveRecord(record, epochAtCapture)) {
      return unavailableCommand(commandId, "set_session_name", "runtime stopped before rename command");
    }
    const result = await this.commandOnRecord(record, { type: "set_session_name", commandId, name }, expectedEpoch);
    const stillOwned = this.ownsLiveRecord(record, epochAtCapture);
    const matchesCapture = result.commandId === commandId && result.result.type === "set_session_name";
    if (result.result.ok && stillOwned && matchesCapture) {
      this.publishLiveSessionName(record, name);
      return result;
    }
    if (result.result.ok) {
      // The command settled but we no longer own the record/epoch (stop /
      // reactivate / crash during the flight): never publish, never false success.
      return unavailableCommand(commandId, "set_session_name", "runtime changed during rename");
    }
    return result;
  }

  /**
   * Publish a confirmed live title to BOTH the read-side overlay and the
   * authoritative runtime projection. `runtime_state_changed` is signal-only,
   * so projection-local get_state/attach would otherwise remain stale after a
   * rename even though the Worker and JSONL title already committed.
   */
  private publishLiveSessionName(record: RecordState, name: string): void {
    const snapshot = record.projection.snapshot();
    snapshot.state.sessionName = name;
    record.projection.replace(snapshot);
    this.titleOverlay.publish(record.sessionId, name);
  }

  /**
   * D2 auto_name: the per-session FIFO identity lane for public
   * `runtime.command(generate_session_title)`. Reuses the "rename" kind (the
   * §51 set_session_name semantics): auto_name generates and applies a session
   * title, so it FIFO-serializes with user renames/set_session_name and the
   * deterministic winner is last-committer-wins per lane order. Stale/rekeyed
   * requests are inert; there is NEVER an offline fallback (a title command
   * never starts a worker for an offline session). Delete/stop interplay is
   * preserved by the lane (a delete removes the overlay; a stop retains it).
   */
  private commandAutoName(sessionId: string, command: RuntimeCommand & { type: "generate_session_title" }, epoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    return this.coordinator.admit(sessionId, "rename", async (ctx) => {
      if (this.shuttingDown) return unavailableCommand(command.commandId, "generate_session_title", "sessiond is shutting down");
      if (ctx.isStale()) return unavailableCommand(command.commandId, "generate_session_title", "session identity changed during title generation");
      const record = this.records.get(ctx.canonicalId);
      if (!record || record.status === "stopped") {
        return unavailableCommand(command.commandId, "generate_session_title", "runtime is not active");
      }
      if (record.status === "crashed" || record.status === "stopping") {
        // A crashed/stopping record remains a reservation: never fall back offline.
        return unavailableCommand(command.commandId, "generate_session_title", "runtime is not active");
      }
      return this.executeLiveAutoName(record, command, epoch);
    });
  }

  /**
   * Live auto_name with the same D4 ownership guards as executeLiveRename. The
   * captured record object + epoch are checked immediately before command
   * admission and again before success publication, so an old record/epoch
   * result after stop/reactivate/crash can never publish a title or affect a
   * new Worker. The adapter applies the generated title to the worker AND
   * returns it in the RPC result; sessiond publishes the revisioned title
   * overlay from the RPC result — the single source of truth (the §51 overlay
   * publication path), never from a racy wire event. `{ok:false}` is a failure
   * and is never reported as success; a worker crash mid-auto_name surfaces a
   * sanitized failure and publishes no overlay.
   */
  private async executeLiveAutoName(record: RecordState, command: RuntimeCommand & { type: "generate_session_title" }, expectedEpoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    const commandId = command.commandId;
    const epochAtCapture = record.epoch;
    if (!this.ownsLiveRecord(record, epochAtCapture)) {
      return unavailableCommand(commandId, "generate_session_title", "runtime stopped before title command");
    }
    const titleCommand: RuntimeCommand & { type: "generate_session_title" } = {
      type: "generate_session_title",
      commandId,
      ...(command.model === undefined ? {} : { model: command.model }),
    };
    const result = await this.commandOnRecord(record, titleCommand, expectedEpoch);
    const stillOwned = this.ownsLiveRecord(record, epochAtCapture);
    const matchesCapture = result.commandId === commandId && result.result.type === "generate_session_title";
    if (result.result.ok && stillOwned && matchesCapture && result.result.type === "generate_session_title") {
      this.publishLiveSessionName(record, result.result.title);
      return result;
    }
    if (result.result.ok) {
      // The command settled but we no longer own the record/epoch (stop /
      // reactivate / crash during the flight): never publish, never false success.
      return unavailableCommand(commandId, "generate_session_title", "runtime changed during title generation");
    }
    return result;
  }

  private ownsLiveRecord(record: RecordState, epoch: string): boolean {
    return (
      this.records.get(record.sessionId) === record &&
      record.epoch === epoch &&
      !["crashed", "stopped", "stopping"].includes(record.status)
    );
  }

  /**
   * D2-P2/P3/P4/P6/P7 authority + D2 navigate: `set_thinking_level` / `set_model` /
   * `set_auto_retry` / `set_tools` / `reload` / `compact` / `navigate_tree`
   * mutate runtime state
   * that is NOT carried on the wire `runtime_state_changed` event (signal-only;
   * for `compact` the `compaction_end` event only clears activity and does not
   * carry the post-compaction messages/messageCount/contextUsage; for
   * `navigate_tree` the adapter emits only a state signal and the new
   * leafId/history/messageCount must come from the authoritative snapshot
   * refresh). Sessiond
   * projection is the attach/resume authority, so a successful authority
   * command must refresh via worker.getSnapshot and only then publish a
   * terminal success. Refresh failure is fail-closed: every observer receives
   * the same fixed `ok:false` unavailable result (type still the original
   * command type, same commandId, no raw error text from the transport), which
   * is cached so retries do not re-enter the worker or claim a stale-success
   * state. A failed/interrupted authority command never enters this path
   * (only `result.result.ok` frames do).
   */
  private ensureAuthorityFinalized(
    record: RecordState,
    successResult: CorrelatedRuntimeCommandResult,
  ): Promise<CorrelatedRuntimeCommandResult> {
    const commandId = successResult.commandId;
    const commandType = successResult.result.type;
    const existing = record.authorityFinalizations.get(commandId);
    if (existing) return existing;

    const epochAtStart = record.epoch;
    const failClosed = (message: string): CorrelatedRuntimeCommandResult =>
      unavailableCommand(commandId, commandType, message);
    const cacheIfStillOwned = (result: CorrelatedRuntimeCommandResult): void => {
      if (this.records.get(record.sessionId) === record && record.epoch === epochAtStart) {
        this.cacheCommandResult(record, result);
      }
    };

    // Defer execution by one microtask so the singleflight map is installed
    // before any early lifecycle failure can settle. Cleanup is attached only
    // after `operation` exists, preventing a synchronously-completed promise
    // from being inserted into the map after its cleanup already ran.
    const execution = Promise.resolve().then(async (): Promise<CorrelatedRuntimeCommandResult> => {
      if (
        this.records.get(record.sessionId) !== record ||
        record.epoch !== epochAtStart ||
        ["crashed", "stopped", "stopping"].includes(record.status)
      ) {
        const failed = failClosed("runtime stopped before snapshot authority converged");
        cacheIfStillOwned(failed);
        return failed;
      }

      try {
        await this.snapshot(record.sessionId);
      } catch (error) {
        const failed = failClosed(
          error instanceof SessiondError && error.code === "timeout"
            ? "worker snapshot timed out during authority refresh"
            : "snapshot authority refresh failed after successful command",
        );
        cacheIfStillOwned(failed);
        return failed;
      }

      if (
        this.records.get(record.sessionId) !== record ||
        record.epoch !== epochAtStart ||
        ["crashed", "stopped", "stopping"].includes(record.status)
      ) {
        // Identity/lifecycle changed during refresh: never write across records/epochs.
        return failClosed("runtime stopped before snapshot authority converged");
      }

      this.cacheCommandResult(record, successResult);
      return successResult;
    }).catch(() => {
      // Defensive bound: authority finalization must never reject into the RPC
      // or worker-message callback even if an unexpected local operation throws.
      const failed = failClosed("snapshot authority refresh failed after successful command");
      cacheIfStillOwned(failed);
      return failed;
    });

    let operation!: Promise<CorrelatedRuntimeCommandResult>;
    operation = execution.finally(() => {
      if (record.authorityFinalizations.get(commandId) === operation) {
        record.authorityFinalizations.delete(commandId);
      }
    });
    record.authorityFinalizations.set(commandId, operation);
    return operation;
  }

  // ---------------------------------------------------------------------
  // Phase 3 atomic submitTurn authority
  // ---------------------------------------------------------------------

  async submitTurn(input: RuntimeSubmitTurnParams): Promise<SubmitTurnAdmission> {
    if (this.shuttingDown) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "unavailable", message: "sessiond is shutting down", retryable: true });
    const fingerprint = this.turnFingerprint(input);
    return this.coordinator.admit(input.sessionId, "submit", async (ctx) => {
      if (this.shuttingDown) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "unavailable", message: "sessiond is shutting down", retryable: true });
      let record = this.records.get(ctx.canonicalId);
      if (record && !["crashed", "stopped", "stopping"].includes(record.status)) {
        const prior = record.turnOperations.get(input.operationId);
        if (prior) return this.duplicateTurn(record, prior, fingerprint);
        if (input.expectedEpoch === undefined) {
          // Phase 5B: after a rollover a missing epoch is epoch_changed; before
          // the first rollover it keeps the legacy conflict (no epoch fence).
          if (record.requiresEpochFence) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "epoch_changed", message: "session epoch changed", retryable: true }, record.epoch, record.journal.lastEventId);
          return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "conflict", message: "live session submit requires an epoch fence", retryable: false }, record.epoch, record.journal.lastEventId);
        }
        if (input.expectedEpoch !== record.epoch) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "epoch_changed", message: "session epoch changed", retryable: false }, input.expectedEpoch, input.expectedRevision);
        if (input.expectedRevision !== record.journal.lastEventId) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "conflict", message: "session revision changed", retryable: false }, record.epoch, record.journal.lastEventId);
      } else {
        if (input.expectedEpoch !== undefined || input.expectedRevision !== undefined) {
          return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "epoch_changed", message: "session is no longer active at the expected epoch", retryable: false }, input.expectedEpoch, input.expectedRevision);
        }
        if (ctx.isStale()) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "conflict", message: "session identity changed during submit", retryable: false });
        const location = await this.deps.sessionLocator.locate(ctx.canonicalId);
        if (!location.exists) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "not_found", message: "session not found", retryable: false });
        const context = await this.deps.activationContext.resolve(ctx.canonicalId, location);
        record = await this.start({ mode: "open", activationId: randomUUID(), sessionId: ctx.canonicalId, cwd: context.cwd, projectRoot: context.projectRoot, sessionFile: location.sessionFile });
      }

      if (!record || ["crashed", "stopped", "stopping"].includes(record.status)) return this.rejectedTurn(input.sessionId, input.operationId, "not_delivered", { code: "worker_unavailable", message: "runtime is not active", retryable: true });
      const prior = record.turnOperations.get(input.operationId);
      if (prior) return this.duplicateTurn(record, prior, fingerprint);
      // Phase 5B: block every NEW turn admission while a whole-epoch rollover is pending.
      if (record.epochRollover !== undefined) return this.rejectedTurn(record.sessionId, input.operationId, "not_delivered", { code: "epoch_changed", message: "session epoch changed", retryable: true }, record.epoch, record.journal.lastEventId);
      const caps = record.projection.snapshot().capabilities.capabilities;
      if (!caps.includes("runtime.prompt")) return this.rejectedTurn(record.sessionId, input.operationId, "not_delivered", { code: "unsupported_capability", message: "capability not supported: runtime.prompt", retryable: false }, record.epoch, record.journal.lastEventId);
      if (input.activationOverrides?.model !== undefined && !caps.includes("runtime.model.set")) return this.rejectedTurn(record.sessionId, input.operationId, "not_delivered", { code: "unsupported_capability", message: "capability not supported: runtime.model.set", retryable: false }, record.epoch, record.journal.lastEventId);
      if (input.activationOverrides?.thinkingLevel !== undefined && !caps.includes("runtime.thinking.set")) return this.rejectedTurn(record.sessionId, input.operationId, "not_delivered", { code: "unsupported_capability", message: "capability not supported: runtime.thinking.set", retryable: false }, record.epoch, record.journal.lastEventId);
      // Phase 5B: at turnOperation capacity BEFORE inserting any pending/
      // accepted identity, start/join a whole-epoch rollover. On success the
      // triggering submit is proven not-admitted and returns a rejected
      // not_delivered epoch_changed carrying the NEW authority epoch + revision
      // 0; on failure the old epoch/ledgers stay intact and the original
      // session_busy capacity failure is returned. Never dispatched to the worker.
      if (record.turnOperations.size >= this.turnOperationLimit) {
        const roll = await this.rotateEpoch(record, true);
        if (roll.rolled) {
          return this.rejectedTurn(record.sessionId, input.operationId, "not_delivered", { code: "epoch_changed", message: "session epoch changed", retryable: true }, record.epoch, 0);
        }
        return this.rejectedTurn(
          record.sessionId,
          input.operationId,
          "not_delivered",
          roll.error.code === "session_busy"
            ? { code: "session_busy", message: "turn operation capacity reached for this epoch", retryable: true }
            : roll.error,
          record.epoch,
          record.journal.lastEventId,
        );
      }
      if (this.isTurnRunning(record)) return this.rejectedTurn(record.sessionId, input.operationId, "not_delivered", { code: "session_busy", message: "a turn is already running", retryable: true }, record.epoch, record.journal.lastEventId);

      const epoch = record.epoch;
      const turnId = `turn:${randomUUID()}`;
      const dispatchId = `turn-dispatch:${epoch}:${randomUUID()}`;
      const initialStatus: TurnStatus = { sessionId: record.sessionId, epoch, operationId: input.operationId, turnId, revision: 0, state: "admitted" };
      const placeholder = this.rejectedTurn(record.sessionId, input.operationId, "uncertain", { code: "timeout", message: "turn admission is pending", retryable: true }, epoch, record.journal.lastEventId);
      const operation: TurnOperationRecord = { operationId: input.operationId, fingerprint, epoch, turnId, dispatchId, admission: placeholder, status: initialStatus, dispatched: true, subscribers: new Set() };
      record.turnOperations.set(input.operationId, operation);
      const wait = deferred<SubmitTurnAdmission>();
      const timer = setTimeout(() => {
        const pending = record!.pendingTurnAdmissions.get(dispatchId);
        if (!pending) return;
        record!.pendingTurnAdmissions.delete(dispatchId);
        const uncertain = this.rejectedTurn(record!.sessionId, input.operationId, "uncertain", { code: "timeout", message: "worker turn admission timed out", retryable: true }, epoch, record!.journal.lastEventId);
        operation.admission = uncertain;
        operation.status = { ...operation.status, revision: operation.status.revision + 1, state: "failed", error: uncertain.error };
        wait.resolve(uncertain);
      }, this.turnAdmissionTimeoutMs);
      record.pendingTurnAdmissions.set(dispatchId, { dispatchId, sessionId: record.sessionId, epoch, operationId: input.operationId, turnId, fingerprint, resolve: wait.resolve, timer });
      this.touch(record);
      try {
        const workerMessage: WorkerSubmitTurnMessage = { type: "worker.submitTurn", id: dispatchId, protocolVersion: PROTOCOL_VERSION, payload: { sessionId: record.sessionId, epoch, operationId: input.operationId, turnId, fingerprint, request: { ...input, sessionId: record.sessionId } } };
        await record.worker.send(workerMessage);
      } catch {
        clearTimeout(timer);
        record.pendingTurnAdmissions.delete(dispatchId);
        const uncertain = this.rejectedTurn(record.sessionId, input.operationId, "uncertain", { code: "worker_unavailable", message: "worker turn admission send failed", retryable: true }, epoch, record.journal.lastEventId);
        operation.admission = uncertain;
        operation.status = { ...operation.status, revision: operation.status.revision + 1, state: "failed", error: uncertain.error };
        return uncertain;
      }
      return wait.promise;
    });
  }

  async prepareSubmitTurn(input: RuntimeSubmitTurnParams): Promise<PreparedTurnSubmission> {
    const result = await this.submitTurn(input);
    const record = this.records.get(result.sessionId);
    const operation = record?.turnOperations.get(result.operationId);
    if (!record || !operation || (result.status !== "accepted" && result.status !== "duplicate")) {
      return { result, async flushTo() {}, close() {} };
    }
    const buffered: SessiondTurnStatusPush[] = [];
    let liveListener: TurnStatusListener | undefined;
    let overflowed = false;
    const subscriber: TurnSubscriber = { closed: false, draining: false, queue: [], listener: (push) => {
      if (liveListener) return liveListener(push);
      if (buffered.length >= this.subscriberQueueLimit) { overflowed = true; this.closeTurnSubscriber(operation, subscriber); return; }
      buffered.push(push);
    } };
    operation.subscribers.add(subscriber);
    const baselineRevision = result.status === "accepted" || result.status === "duplicate" ? result.turnStatus.revision : -1;
    if (operation.status.revision > baselineRevision) buffered.push({ type: "turn_status", status: operation.status });
    let closed = false;
    return {
      result,
      flushTo: async (listener) => {
        if (closed || overflowed) throw new SessiondError("unavailable", "turn status buffer overflowed", true);
        let terminalDelivered = false;
        while (buffered.length > 0) {
          const push = buffered.shift();
          if (push) {
            await listener(push);
            if (push.status.state === "completed" || push.status.state === "failed") terminalDelivered = true;
          }
        }
        // Phase 5B: once a completed/failed status has been delivered (live or
        // buffered), remove the TurnSubscriber from the operation so terminal
        // turns cannot permanently block strict quiescence. The operation is
        // NOT deleted — the epoch rollover clears it later.
        if (terminalDelivered || subscriber.closed) {
          this.closeTurnSubscriber(operation, subscriber);
          return;
        }
        liveListener = listener;
      },
      close: () => { if (closed) return; closed = true; buffered.length = 0; this.closeTurnSubscriber(operation, subscriber); },
    };
  }

  private duplicateTurn(record: RecordState, operation: TurnOperationRecord, fingerprint: string): SubmitTurnAdmission {
    if (operation.fingerprint !== fingerprint) return this.rejectedTurn(record.sessionId, operation.operationId, "not_delivered", { code: "conflict", message: "operationId payload conflict", retryable: false }, record.epoch, record.journal.lastEventId);
    if (operation.admission.status === "accepted" || operation.admission.status === "duplicate") {
      return { status: "duplicate", delivery: "accepted", sessionId: record.sessionId, epoch: operation.epoch, revision: record.journal.lastEventId, operationId: operation.operationId, turnId: operation.turnId, turnStatus: operation.status, snapshot: record.projection.snapshot() };
    }
    if (operation.admission.delivery === "uncertain") {
      return { status: "duplicate", delivery: "uncertain", sessionId: record.sessionId, epoch: operation.epoch, revision: record.journal.lastEventId, operationId: operation.operationId, turnId: operation.turnId, turnStatus: operation.status, snapshot: record.projection.snapshot() };
    }
    return operation.admission;
  }

  private rejectedTurn(sessionId: string, operationId: string, delivery: "not_delivered" | "uncertain", error: ProtocolError, epoch?: string, revision?: number): Extract<SubmitTurnAdmission, { status: "rejected" }> {
    return { status: "rejected", delivery, sessionId, operationId, ...(epoch === undefined ? {} : { epoch }), ...(revision === undefined ? {} : { revision }), error };
  }

  private turnFingerprint(input: RuntimeSubmitTurnParams): string {
    const canonical = JSON.stringify({ prompt: input.prompt, images: input.images ?? [], activationOverrides: { ...(input.activationOverrides?.model === undefined ? {} : { model: input.activationOverrides.model }), ...(input.activationOverrides?.thinkingLevel === undefined ? {} : { thinkingLevel: input.activationOverrides.thinkingLevel }) } });
    return createHash("sha256").update(canonical).digest("hex");
  }

  private pushTurnStatus(operation: TurnOperationRecord, push: SessiondTurnStatusPush): void {
    for (const subscriber of [...operation.subscribers]) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length >= this.subscriberQueueLimit) { this.closeTurnSubscriber(operation, subscriber); continue; }
      subscriber.queue.push(push);
      if (!subscriber.draining) void this.drainTurnSubscriber(operation, subscriber);
    }
  }

  private async drainTurnSubscriber(operation: TurnOperationRecord, subscriber: TurnSubscriber): Promise<void> {
    subscriber.draining = true;
    try {
      while (!subscriber.closed && subscriber.queue.length > 0) {
        const push = subscriber.queue.shift();
        if (push) {
          await subscriber.listener(push);
          // Phase 5B: after a completed/failed status is delivered, remove the
          // TurnSubscriber from the operation so terminal subscribers cannot
          // permanently block strict quiescence (the operation itself is kept
          // until the epoch rollover clears it).
          if (push.status.state === "completed" || push.status.state === "failed") {
            this.closeTurnSubscriber(operation, subscriber);
            break;
          }
        }
      }
    } catch { this.closeTurnSubscriber(operation, subscriber); }
    finally { subscriber.draining = false; }
  }

  private closeTurnSubscriber(operation: TurnOperationRecord, subscriber: TurnSubscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue.length = 0;
    operation.subscribers.delete(subscriber);
  }

  /**
   * Interrupts are correlated by the browser-issued commandId, mirroring the
   * ordinary command path. The RPC envelope `requestId` is transport-only and
   * is never used for business deduplication.
   *
   * - Same commandId + same type: returns the same promise/result and sends the
   *   worker exactly one interrupt.
   * - Same commandId + different type: fails closed with a non-retryable
   *   `command_rejected` result for the current request.
   * - Capacity reached / stopped / send failure: fails closed with commandId.
   */
  async interrupt(sessionId: string, commandId: string, interrupt: RuntimeInterrupt, epoch?: string): Promise<CorrelatedRuntimeInterruptResult> {
    const record = this.requireActive(sessionId);
    let immediate: CorrelatedRuntimeInterruptResult | undefined;
    let pending!: PendingInterrupt;
    let needsRollover = false;
    await record.lifecycle.runExclusive(async () => {
      if (this.records.get(sessionId) !== record || ["crashed", "stopped", "stopping"].includes(record.status)) {
        immediate = unavailableInterrupt(commandId, interrupt.type, "runtime stopped before interrupt admission");
        return;
      }
      // Phase 5B: block every new interrupt admission while a rollover is pending.
      if (record.epochRollover !== undefined) {
        immediate = epochChangedInterrupt(commandId, interrupt.type);
        return;
      }
      // Phase 5B fence: post-rollover interrupts REQUIRE the exact epoch.
      if ((epoch !== undefined && epoch !== record.epoch) || (record.requiresEpochFence && epoch === undefined)) {
        immediate = epochChangedInterrupt(commandId, interrupt.type);
        return;
      }
      const acceptedType = record.acceptedInterrupts.get(commandId);
      if (acceptedType !== undefined && acceptedType !== interrupt.type) {
        immediate = rejectedInterrupt(commandId, interrupt.type, `commandId was already accepted as ${acceptedType}`);
        return;
      }
      const cached = record.interruptResults.get(commandId);
      if (cached) { immediate = cached; return; }
      const wireId = `interrupt:${record.epoch}:${commandId}`;
      const existing = record.pendingInterrupts.get(wireId);
      if (existing) { pending = existing; return; }
      if (acceptedType !== undefined) { immediate = duplicateInterruptUnavailable(commandId, acceptedType); return; }
      // Phase 5B: capacity boundary — stale/missing-after-rollover epoch fails
      // epoch_changed (never rotates); otherwise start/join the whole-epoch
      // rollover (executed outside the lock below).
      if (record.acceptedInterrupts.size >= this.interruptLimit) {
        if (epoch !== undefined && epoch !== record.epoch) {
          immediate = epochChangedInterrupt(commandId, interrupt.type);
          return;
        }
        if (epoch === undefined && record.requiresEpochFence) {
          immediate = epochChangedInterrupt(commandId, interrupt.type);
          return;
        }
        needsRollover = true;
        return;
      }
      record.acceptedInterrupts.set(commandId, interrupt.type);
      const wait = deferred<CorrelatedRuntimeInterruptResult>();
      const timer = setTimeout(() => {
        record.pendingInterrupts.delete(wireId);
        wait.resolve(unavailableInterrupt(commandId, interrupt.type, "worker interrupt timed out"));
      }, this.commandTimeoutMs);
      pending = { commandId, type: interrupt.type, promise: wait.promise, resolve: wait.resolve, timer };
      record.pendingInterrupts.set(wireId, pending);
      this.touch(record);
      try {
        await record.worker.send({ type: "worker.interrupt", id: wireId, protocolVersion: PROTOCOL_VERSION, payload: { sessionId, epoch: record.epoch, commandId, interrupt } });
      } catch {
        clearTimeout(timer);
        record.pendingInterrupts.delete(wireId);
        const result = unavailableInterrupt(commandId, interrupt.type, "worker interrupt send failed");
        this.cacheInterruptResult(record, result);
        immediate = result;
      }
    });
    if (immediate) return immediate;
    // Phase 5B: capacity boundary — whole-epoch rollover. The triggering
    // interrupt is proven not-admitted: epoch_changed on success, original
    // capacity failure on a failed/busy rotation.
    if (needsRollover) {
      const roll = await this.rotateEpoch(record);
      if (roll.rolled) return epochChangedInterrupt(commandId, interrupt.type);
      if (roll.error.code !== "session_busy") return { commandId, result: { ok: false, type: interrupt.type, error: roll.error } };
      return rejectedInterrupt(commandId, interrupt.type, "interrupt id capacity reached for this epoch");
    }
    return pending.promise;
  }

  /**
   * Authoritative initial projection: after worker.ready/rekey and BEFORE the
   * record is treated as ready / externally attachable, fetch the worker's
   * authoritative snapshot via worker.getSnapshot and use it as the initial
   * projection (capabilities + state together). The existing `worker.snapshot`
   * handler performs the replace and resolves the pending. Any failure
   * (timeout / send error / unmatched session) is propagated so the startup
   * fails closed and the worker is rolled back — the record never becomes
   * attachable with an empty/default capability set.
   */
  private async primeProjection(record: RecordState): Promise<void> {
    const id = `prime:${record.epoch}:${randomUUID()}`;
    const wait = deferred<RuntimeSnapshot>();
    const timer = setTimeout(() => { record.pendingSnapshots.delete(id); wait.reject(new SessiondError("timeout", "worker startup snapshot timed out", true)); }, this.workerStartTimeoutMs);
    record.pendingSnapshots.set(id, { resolve: wait.resolve, reject: wait.reject, timer });
    try {
      await record.worker.send({ type: "worker.getSnapshot", id, protocolVersion: PROTOCOL_VERSION, payload: { sessionId: record.sessionId } });
      await wait.promise;
    } catch (error) {
      record.pendingSnapshots.delete(id);
      throw error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker startup snapshot send failed", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshot(sessionId: string): Promise<RuntimeSnapshot> {
    const record = this.requireActive(sessionId);
    // Phase 5B: block snapshot fetches while a whole-epoch rollover is pending
    // (the projection is about to be rebased by the rotation commit).
    if (record.epochRollover !== undefined) {
      throw new SessiondError("epoch_changed", "session epoch changed", true);
    }
    const id = `snapshot:${record.epoch}:${randomUUID()}`;
    const wait = deferred<RuntimeSnapshot>();
    const timer = setTimeout(() => { record.pendingSnapshots.delete(id); wait.reject(new SessiondError("timeout", "worker snapshot timed out", true)); }, this.commandTimeoutMs);
    record.pendingSnapshots.set(id, { resolve: wait.resolve, reject: wait.reject, timer });
    try {
      await record.worker.send({ type: "worker.getSnapshot", id, protocolVersion: PROTOCOL_VERSION, payload: { sessionId } });
    } catch {
      clearTimeout(timer);
      record.pendingSnapshots.delete(id);
      throw new SessiondError("worker_unavailable", "worker snapshot send failed", true);
    }
    return wait.promise;
  }

  // ---------------------------------------------------------------------
  // Phase 2B independent read lane
  // ---------------------------------------------------------------------

  /**
   * Independent read RPC entry (`runtime.read`). A read requires an ACTIVE
   * record and the EXACT expected epoch; a stale epoch fails closed and never
   * touches the Worker. The response always carries the full identity triple
   * (sessionId + epoch + requestId) + typed outcome, so the Host can forward a
   * strictly correlated `read_result` frame. The identity triple echoes the
   * REQUESTED epoch (not the record's current epoch) so the client's pending
   * read can always be settled by its own identity.
   */
  async runtimeRead(input: {
    sessionId: string;
    epoch: string;
    requestId: string;
    read: RuntimeReadRequest;
  }): Promise<CorrelatedRuntimeReadResult> {
    const record = this.records.get(input.sessionId);
    if (!record || ["crashed", "stopped", "stopping"].includes(record.status)) {
      return {
        sessionId: input.sessionId,
        epoch: input.epoch,
        requestId: input.requestId,
        result: this.failedRead(input.read.type, { code: "worker_unavailable", message: "runtime is not active", retryable: true }),
      };
    }
    if (record.epoch !== input.epoch) {
      return {
        sessionId: input.sessionId,
        epoch: input.epoch,
        requestId: input.requestId,
        result: this.failedRead(input.read.type, { code: "epoch_changed", message: "session epoch changed", retryable: false }),
      };
    }
    // Phase 5B: while a whole-epoch rollover is pending every new read admission
    // is blocked (it must never touch the Worker mid-rotation). The client
    // retries after the authoritative epoch_changed snapshot.
    if (record.epochRollover !== undefined) {
      return {
        sessionId: input.sessionId,
        epoch: input.epoch,
        requestId: input.requestId,
        result: this.failedRead(input.read.type, { code: "epoch_changed", message: "session epoch changed", retryable: true }),
      };
    }
    const outcome = await this.performRead(record, input.requestId, input.read);
    // Always echo the requested identity. Rekey/stop settles the pending read
    // with a failure; returning the new record epoch would make the Client drop
    // its own terminal result and leak the pending slot.
    return { sessionId: input.sessionId, epoch: input.epoch, requestId: input.requestId, result: outcome };
  }

  /**
   * Run one read through the Phase 2B read lane.
   *
   * Snapshot-derived `get_tools` is answered from `record.projection` without
   * touching the Worker; missing data FAILS CLOSED (never a `[]` fallback).
   * `get_state` requires a fresh Worker read because signal-only runtime events
   * do not carry full context/state. It and the remaining reads
   * (`get_session_stats` / `get_commands` / `get_last_assistant_text`) go
   * through the bounded per-record read queue
   * with AT MOST ONE Worker-bound read active and a separate read timeout.
   *
   * The new read lane NEVER uses acceptedCommands, the mutation result cache,
   * authority finalization, or Worker activation for inactive sessions.
   */
  private async performRead(record: RecordState, requestId: string, read: RuntimeReadRequest): Promise<RuntimeReadOutcome> {
    if (read.type === "get_state") {
      // `runtime_state_changed` is intentionally signal-only and does not carry
      // fields such as file-backed context usage, session stats, or the latest
      // adapter state. Read the active Worker rather than returning a stale
      // projection snapshot; this remains on the independent read lane and
      // never consumes mutation admission.
      return this.dispatchWorkerRead(record, requestId, read);
    }
    if (read.type === "get_tools") {
      const tools = record.projection.snapshot().state.tools;
      if (tools === undefined) {
        // Missing data → fail closed, never a `[]` fallback.
        return this.failedRead("get_tools", { code: "unavailable", message: "tools are not available in the session snapshot", retryable: true });
      }
      return { ok: true, type: "get_tools", tools: [...tools] };
    }
    return this.dispatchWorkerRead(record, requestId, read);
  }

  /**
   * Enqueue a Worker-bound read into the bounded per-record read lane. At most
   * {@link readQueueLimit} reads may be pending (queued + active); beyond that
   * a new read fails closed with a fixed unavailable (never unbounded). The
   * dispatch id is `read:<epoch>:<uuid>` — UNIQUE PER DISPATCH and deliberately
   * NOT the deterministic requestId. Each pending read owns a separate timer
   * that settles it exactly once on timeout.
   */
  private dispatchWorkerRead(record: RecordState, requestId: string, read: RuntimeReadRequest): Promise<RuntimeReadOutcome> {
    return new Promise<RuntimeReadOutcome>((resolve) => {
      if (record.pendingReads.size >= this.readQueueLimit) {
        resolve(this.failedRead(read.type, { code: "unavailable", message: "read queue is full", retryable: true }));
        return;
      }
      const dispatchId = `read:${record.epoch}:${randomUUID()}`;
      const timer = setTimeout(() => {
        const pending = record.pendingReads.get(dispatchId);
        if (!pending) return;
        this.settleRead(record, dispatchId, this.failedRead(pending.read.type, { code: "timeout", message: "worker read timed out", retryable: true }));
      }, this.readTimeoutMs);
      record.pendingReads.set(dispatchId, {
        dispatchId,
        sessionId: record.sessionId,
        epoch: record.epoch,
        requestId,
        read,
        resolve,
        timer,
      });
      record.readQueue.push(dispatchId);
      this.dispatchNextRead(record);
    });
  }

  /**
   * Dispatch the head of the read queue when no Worker-bound read is active.
   * Skips already-settled dispatch ids (stale queue entries from a timeout /
   * lifecycle settle) and fail-closes when the record/epoch changed before the
   * dispatch actually fired.
   */
  private dispatchNextRead(record: RecordState): void {
    if (record.activeReadId !== null) return;
    while (record.readQueue.length > 0 && record.activeReadId === null) {
      const dispatchId = record.readQueue.shift()!;
      const pending = record.pendingReads.get(dispatchId);
      if (!pending) continue;
      if (
        this.records.get(record.sessionId) !== record ||
        ["crashed", "stopped", "stopping"].includes(record.status) ||
        record.epoch !== pending.epoch
      ) {
        this.settleRead(record, dispatchId, this.failedRead(pending.read.type, { code: "unavailable", message: "runtime stopped before read dispatch", retryable: true }));
        continue;
      }
      record.activeReadId = dispatchId;
      void record.worker.send({
        type: "worker.read",
        id: dispatchId,
        protocolVersion: PROTOCOL_VERSION,
        payload: { sessionId: record.sessionId, epoch: record.epoch, requestId: pending.requestId, read: pending.read },
      }).catch(() => {
        this.settleRead(record, dispatchId, this.failedRead(pending.read.type, { code: "worker_unavailable", message: "worker read send failed", retryable: true }));
      });
    }
  }

  /**
   * Settle ONE pending read exactly once (result / timeout / lifecycle / send
   * failure) and dispatch the next queued read. A late call for an already-
   * settled dispatch id is a no-op. Clearing `activeReadId` for the settled
   * dispatch id releases the single Worker-bound read slot.
   */
  private settleRead(record: RecordState, dispatchId: string, outcome: RuntimeReadOutcome): void {
    const pending = record.pendingReads.get(dispatchId);
    if (!pending) return;
    clearTimeout(pending.timer);
    record.pendingReads.delete(dispatchId);
    if (record.activeReadId === dispatchId) record.activeReadId = null;
    pending.resolve(outcome);
    this.dispatchNextRead(record);
  }

  /**
   * Settle every pending read of a record exactly once (stop / crash / rekey /
   * shutdown) and clear the read lane. Late `worker.readResult` frames are then
   * dropped by the handler (the pending entry is gone).
   */
  private settleAllPendingReads(record: RecordState, code: ProtocolErrorCode, message: string): void {
    for (const pending of [...record.pendingReads.values()]) {
      this.settleRead(record, pending.dispatchId, this.failedRead(pending.read.type, { code, message, retryable: true }));
    }
    record.readQueue.length = 0;
    record.activeReadId = null;
  }

  /** Structured fixed read failure (never a thrown backend error). */
  private failedRead(type: RuntimeReadType, error: { code: ProtocolErrorCode; message: string; retryable: boolean }): RuntimeReadOutcome {
    return { ok: false, type, error };
  }

  prepareAttach(params: RuntimeAttachParams, onBoundary?: () => void): PreparedAttachment {
    const record = this.requireActive(params.sessionId);
    const liveBuffer: SessiondPush[] = [];
    let overflowed = false;
    let liveListener: PushListener | undefined;
    const subscription = this.createSubscriber(record, (push) => {
      if (liveListener) return liveListener(push);
      if (liveBuffer.length >= this.subscriberQueueLimit) {
        overflowed = true;
        subscription.unsubscribe();
        return;
      }
      liveBuffer.push(push);
    });
    // No await is allowed between subscription establishment and boundary capture.
    const boundary = record.journal.lastEventId;
    const currentAtBoundary = record.projection.snapshot();
    onBoundary?.();
    let reason: SnapshotDeliveryReason = "snapshot";
    let replay: readonly SessiondPush[] = [];
    let boundarySnapshot = currentAtBoundary;
    if ("epoch" in params) {
      if (params.epoch !== record.epoch) reason = "epoch_changed";
      else {
        const journalReplay = record.journal.replayAfter(params.lastEventId);
        if (journalReplay.gap || params.lastEventId < record.journalBaseEventId) reason = "gap";
        else {
          const atCursor = new SnapshotProjection(record.journalBaseSnapshot);
          const beforeCursor = record.journal.snapshot().filter((event) => event.eventId <= params.lastEventId);
          for (const event of beforeCursor) atCursor.apply(stripCursor(event));
          boundarySnapshot = atCursor.snapshot();
          replay = journalReplay.events.filter((event) => event.eventId <= boundary).map((event) => ({ type: "event" as const, event }));
        }
      }
    }
    const result: SessiondRuntimeAttachResult = {
      sessionId: record.sessionId,
      epoch: record.epoch,
      lastEventId: boundary,
      cwd: record.cwd,
      projectRoot: record.projectRoot,
      workerStatus: record.status,
      resumeStatus: reason,
      snapshot: boundarySnapshot,
    };
    let closed = false;
    let flushed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      liveBuffer.length = 0;
      subscription.unsubscribe();
    };
    this.touch(record);
    return {
      result,
      replay,
      async flushTo(listener) {
        if (closed || overflowed) throw new SessiondError("unavailable", "attach buffer overflowed", true);
        if (flushed) throw new SessiondError("conflict", "attach was already flushed");
        flushed = true;
        try {
          for (const push of replay) await listener(push);
          while (liveBuffer.length > 0) {
            const push = liveBuffer.shift();
            if (push) await listener(push);
            if (closed || overflowed) throw new SessiondError("unavailable", "attach closed while flushing", true);
          }
          // Synchronous switch: future subscriber drains enqueue directly after all buffered items.
          liveListener = listener;
        } catch (error) {
          close();
          throw error;
        }
      },
      close,
    };
  }

  attach(params: RuntimeAttachParams, listener?: PushListener): { result: SessiondRuntimeAttachResult; unsubscribe?: () => void } {
    const prepared = this.prepareAttach(params);
    if (listener === undefined) { prepared.close(); return { result: prepared.result }; }
    void prepared.flushTo(listener).catch(() => prepared.close());
    return { result: prepared.result, unsubscribe: prepared.close };
  }

  detach(sessionId: string, listener?: PushListener): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false;
    if (listener !== undefined) {
      for (const subscriber of record.subscribers) if (subscriber.listener === listener) this.closeSubscriber(record, subscriber);
    }
    this.touch(record);
    return true;
  }

  getSnapshot(sessionId: string): RuntimeGetSnapshotResult {
    const record = this.records.get(sessionId);
    if (!record) throw new SessiondError("not_found", `runtime is not active: ${sessionId}`);
    return record.projection.snapshot();
  }

  runningStateSnapshot(): RuntimeRunningState {
    return this.currentRunningState();
  }

  /**
   * Race-free global running watch. Establishes a zero-worker subscriber before
   * capturing the authoritative baseline, buffers later revisions until the
   * RPC response is delivered, then switches atomically to live delivery.
   */
  prepareRunningWatch(): PreparedRunningWatch {
    const liveBuffer: SessiondRunningStatePush[] = [];
    let overflowed = false;
    let liveListener: RunningStateListener | undefined;
    let subscriber: RunningSubscriber;
    subscriber = this.createRunningSubscriber((push) => {
      if (liveListener) return liveListener(push);
      if (liveBuffer.length >= this.subscriberQueueLimit) {
        overflowed = true;
        this.closeRunningSubscriber(subscriber);
        return;
      }
      liveBuffer.push(push);
    });
    const result = this.currentRunningState();
    let closed = false;
    let flushed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      liveBuffer.length = 0;
      this.closeRunningSubscriber(subscriber);
    };
    return {
      result,
      async flushTo(listener) {
        if (closed || overflowed || subscriber.closed) throw new SessiondError("unavailable", "running watch buffer overflowed", true);
        if (flushed) throw new SessiondError("conflict", "running watch was already flushed");
        flushed = true;
        try {
          while (liveBuffer.length > 0) {
            const push = liveBuffer.shift();
            if (push) await listener(push);
            if (closed || overflowed || subscriber.closed) throw new SessiondError("unavailable", "running watch closed while flushing", true);
          }
          liveListener = listener;
        } catch (error) {
          close();
          throw error;
        }
      },
      close,
    };
  }

  listRunning(): RuntimeListRunningResult {
    return { sessions: this.runningItems() };
  }

  hasBusyCwd(cwd: string): { cwd: string; busy: boolean; sessionIds?: string[] } {
    const sessionIds = [...this.records.values()].filter((record) => this.isBusy(record) && this.isBusyCwdFor(record.cwd, cwd)).map((record) => record.sessionId);
    return { cwd, busy: sessionIds.length > 0, ...(sessionIds.length ? { sessionIds } : {}) };
  }

  /**
   * Busy-containment for the SAFETY QUERY only: busy when the normalized
   * absolute runtime cwd equals the target OR is a descendant (path.relative
   * containment; a sibling prefix like `/a/bc` vs `/a/b` is NOT a descendant).
   * `stopByCwd` keeps its exact-match semantics and is unaffected. Non-absolute
   * runtime cwds fall back to exact string equality (preserves legacy behavior;
   * symlink-text paths match textually — a documented caveat, never a realpath).
   */
  private isBusyCwdFor(runtimeCwd: string, target: string): boolean {
    if (!isAbsolute(runtimeCwd) || !isAbsolute(target)) return runtimeCwd === target;
    const rel = relative(resolve(target), resolve(runtimeCwd));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  }

  async stopByCwd(cwd: string, reason = "user"): Promise<string[]> {
    const ids = [...this.records.values()].filter((record) => record.cwd === cwd).map((record) => record.sessionId);
    for (const id of ids) await this.stop(id, reason);
    return ids;
  }

  /**
   * D4 identity lane: an explicit stop shares the session lane with rename /
   * activate / delete, so a rename-first live command settles before the stop
   * and a stop-first removes the record before a later rename uses the offline
   * mutation. The internal {@link stopRecord} is non-reentrant (never acquires
   * the lane); callers that already own/drain (idle timeout, bulk shutdown)
   * must use {@link stopRecord} / {@link stopInternalBypass} directly.
   */
  async stop(sessionId: string, reason = "user"): Promise<boolean> {
    return this.coordinator.admit(sessionId, "stop", async (ctx) => {
      // Stop is an unconditional close intent: even when a rekey moved the lane
      // identity while this stop was queued, it stops the CURRENT canonical
      // record (never leaves a session running because the requested id rekeyed).
      const record = this.records.get(ctx.canonicalId);
      if (!record) return false;
      return record.lifecycle.runExclusive(() => this.stopRecord(record, reason));
    });
  }

  /**
   * Lane-free internal stop bypass for bulk drain (global shutdown). The caller
   * already owns the whole service and must never deadlock by recursively
   * acquiring the per-session lane (a queued lane operation may be blocked on a
   * Worker command this stop would otherwise wait behind).
   */
  private async stopInternalBypass(sessionId: string, reason = "user"): Promise<boolean> {
    const record = this.records.get(sessionId);
    if (!record) return false;
    return record.lifecycle.runExclusive(() => this.stopRecord(record, reason));
  }

  private async stopRecord(record: RecordState, reason: string): Promise<boolean> {
    if (this.records.get(record.sessionId) !== record) return false;
    if (!record.closedEventEmitted) this.acceptEvent(record, { type: "runtime_closed", sessionId: record.sessionId, reason: normalizeCloseReason(reason) });
    record.status = "stopping";
    record.expectedExitReason = reason;
    if (record.idleTimer) clearTimeout(record.idleTimer);
    try {
      await record.worker.send({ type: "worker.shutdown", id: `shutdown:${randomUUID()}`, protocolVersion: PROTOCOL_VERSION, payload: { sessionId: record.sessionId, reason } });
    } catch { /* close below */ }
    await record.worker.close().catch(() => {});
    record.unsubscribeWorker();
    record.unsubscribeExit();
    this.rejectPending(record, "runtime stopped");
    for (const subscriber of [...record.subscribers]) this.closeSubscriber(record, subscriber);
    record.status = "stopped";
    this.records.delete(record.sessionId);
    this.broadcastRunningChanged(record.sessionId);
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const ids = [...this.records.keys()];
    // Bulk drain uses the lane-free internal bypass: it never recursively
    // acquires a per-session lane (a queued lane operation may be blocked on a
    // Worker command), and every still-queued lane operation fails fast on the
    // `shuttingDown` guard when its turn arrives.
    await Promise.allSettled(ids.map((id) => this.stopInternalBypass(id, "shutdown")));
  }

  subscribe(sessionId: string, listener: PushListener): () => void {
    return this.createSubscriber(this.requireActive(sessionId), listener).unsubscribe;
  }

  private createSubscriber(record: RecordState, listener: PushListener): { subscriber: Subscriber; unsubscribe: () => void } {
    const subscriber: Subscriber = { closed: false, draining: false, queue: [], listener };
    record.subscribers.add(subscriber);
    this.touch(record);
    return { subscriber, unsubscribe: () => this.closeSubscriber(record, subscriber) };
  }

  private createRunningSubscriber(listener: RunningStateListener): RunningSubscriber {
    const subscriber: RunningSubscriber = { closed: false, draining: false, queue: [], listener };
    this.runningSubscribers.add(subscriber);
    return subscriber;
  }

  private pushRunningState(push: SessiondRunningStatePush): void {
    for (const subscriber of [...this.runningSubscribers]) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length >= this.subscriberQueueLimit) {
        this.closeRunningSubscriber(subscriber);
        continue;
      }
      subscriber.queue.push(push);
      if (!subscriber.draining) void this.drainRunningSubscriber(subscriber);
    }
  }

  private async drainRunningSubscriber(subscriber: RunningSubscriber): Promise<void> {
    subscriber.draining = true;
    try {
      while (!subscriber.closed && subscriber.queue.length > 0) {
        const push = subscriber.queue.shift();
        if (push) await subscriber.listener(push);
      }
    } catch {
      this.closeRunningSubscriber(subscriber);
    } finally {
      subscriber.draining = false;
    }
  }

  private closeRunningSubscriber(subscriber: RunningSubscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue.length = 0;
    this.runningSubscribers.delete(subscriber);
  }

  private push(record: RecordState, push: SessiondPush): void {
    for (const subscriber of [...record.subscribers]) this.pushToSubscriber(record, subscriber, push);
  }

  private pushToSubscriber(record: RecordState, subscriber: Subscriber | undefined, push: SessiondPush): void {
    if (!subscriber || subscriber.closed) return;
    if (subscriber.queue.length >= this.subscriberQueueLimit) { this.closeSubscriber(record, subscriber); return; }
    subscriber.queue.push(push);
    if (!subscriber.draining) void this.drainSubscriber(record, subscriber);
  }

  private async drainSubscriber(record: RecordState, subscriber: Subscriber): Promise<void> {
    subscriber.draining = true;
    try {
      while (!subscriber.closed && subscriber.queue.length) {
        const item = subscriber.queue.shift();
        if (item) await subscriber.listener(item);
      }
    } catch {
      this.closeSubscriber(record, subscriber);
    } finally {
      subscriber.draining = false;
    }
  }

  private closeSubscriber(record: RecordState, subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue.length = 0;
    record.subscribers.delete(subscriber);
    if (record.status !== "stopping" && record.status !== "stopped" && this.records.get(record.sessionId) === record) this.touch(record);
  }

  private snapshotPush(record: RecordState, reason: SnapshotDeliveryReason): SessiondPush {
    const snapshot = record.projection.snapshot();
    return {
      type: "snapshot",
      sessionId: record.sessionId,
      epoch: record.epoch,
      lastEventId: record.journal.lastEventId,
      cwd: record.cwd,
      projectRoot: record.projectRoot,
      workerStatus: record.status,
      snapshot,
      resumeStatus: reason,
    };
  }

  private cacheCommandResult(record: RecordState, result: CorrelatedRuntimeCommandResult): void {
    const cache = READ_ONLY_COMMAND_TYPES.has(result.result.type) ? record.readResults : record.commandResults;
    if (cache.has(result.commandId)) cache.delete(result.commandId);
    cache.set(result.commandId, result);
    while (cache.size > this.commandResultCacheLimit) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  private cacheInterruptResult(record: RecordState, result: CorrelatedRuntimeInterruptResult): void {
    if (record.interruptResults.has(result.commandId)) record.interruptResults.delete(result.commandId);
    record.interruptResults.set(result.commandId, result);
    while (record.interruptResults.size > this.interruptLimit) {
      const oldest = record.interruptResults.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      record.interruptResults.delete(oldest);
    }
  }

  private touch(record: RecordState): void {
    record.lastActivity = this.now();
    record.idleGeneration += 1;
    this.scheduleIdleCheck(record, record.idleGeneration);
  }

  /**
   * (Re)schedule the idle-reclamation check for one record with the CURRENT
   * `idleTimeoutMs`. Does not touch `lastActivity`, so changing the timeout
   * re-arms existing timers without resetting the idle clock. `0` disables
   * reclamation entirely (no timer armed).
   */
  private scheduleIdleCheck(record: RecordState, generation: number): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    record.idleTimer = setTimeout(() => {
      void record.lifecycle.runExclusive(async () => {
        if (this.records.get(record.sessionId) !== record || generation !== record.idleGeneration) return;
        if (record.subscribers.size === 0 && !this.isBusy(record) && this.now() - record.lastActivity >= this.idleTimeoutMs) await this.stopRecord(record, "idle");
        else this.touch(record);
      });
    }, this.idleTimeoutMs);
    record.idleTimer.unref?.();
  }

  /** Read the persisted idle timeout from the settings file; fail-closed. */
  private loadPersistedIdleTimeoutMs(): number | undefined {
    if (!this.deps.settingsFile) return undefined;
    try {
      if (!existsSync(this.deps.settingsFile)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(this.deps.settingsFile, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const value = (parsed as { idleTimeoutMs?: unknown }).idleTimeoutMs;
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persist the idle timeout to the settings file; throws on write failure. */
  private persistIdleTimeoutMs(ms: number): void {
    if (!this.deps.settingsFile) return;
    const target = this.deps.settingsFile;
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ idleTimeoutMs: ms }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, target);
    } catch {
      try { unlinkSync(tmp); } catch { /* leftover tmp is best-effort */ }
      throw new SessiondError("unavailable", "could not persist idle timeout", true);
    }
  }

  /** Current idle-reclamation timeout in ms (0 = disabled). */
  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  /**
   * Set the idle-reclamation timeout, persist it (when a settings file is
   * wired) and re-arm every live record's timer with the new value. `0`
   * disables reclamation. Fails closed on invalid input.
   */
  setIdleTimeoutMs(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new SessiondError("invalid_input", "idleTimeoutMs must be a non-negative safe integer");
    }
    this.persistIdleTimeoutMs(ms);
    this.idleTimeoutMs = ms;
    for (const record of this.records.values()) {
      record.idleGeneration += 1;
      this.scheduleIdleCheck(record, record.idleGeneration);
    }
  }

  private isTurnRunning(record: RecordState): boolean {
    const state = record.projection.snapshot().state;
    return state.isPromptRunning || state.isStreaming || state.isBashRunning || state.isCompacting;
  }

  private isBusy(record: RecordState): boolean {
    return this.isTurnRunning(record) || record.pendingCommands.size > 0 || record.authorityFinalizations.size > 0;
  }

  // ---------------------------------------------------------------------
  // Phase 5B safe idle whole-epoch rollover
  // ---------------------------------------------------------------------

  /**
   * Strict idle predicate shared with the Worker: no streaming / prompt / bash /
   * compact, streaming inactive, no pending messages, no queued steering/
   * follow-up, no pending extension UI. The projection is the same authority
   * the Worker answers from, so the two predicates agree.
   */
  private isProjectionIdle(record: RecordState): boolean {
    const snapshot = record.projection.snapshot();
    const state = snapshot.state;
    if (state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting) return false;
    if (snapshot.streaming?.active === true) return false;
    if ((state.pendingMessageCount ?? 0) !== 0) return false;
    const queued = state.queuedMessages;
    if (queued !== undefined && (queued.steering.length > 0 || queued.followUp.length > 0)) return false;
    if (state.pendingExtensionUi !== undefined && state.pendingExtensionUi.length > 0) return false;
    return true;
  }

  /**
   * Phase 5B strict quiescence gate for a whole-epoch rollover: the record is
   * the exact current one and `ready`; the projection is idle; every pending
   * business slot (commands / interrupts / reads / turn admissions / snapshots /
   * authority finalizations) is empty; the read lane is empty; every turn
   * operation is terminal AND subscriber-free; no coordinator lane exists for
   * the exact session. Attached snapshot subscribers MAY remain (they receive
   * the `epoch_changed` push).
   */
  private isStrictlyQuiescent(record: RecordState, allowCoordinatorLane: boolean): boolean {
    if (this.records.get(record.sessionId) !== record) return false;
    if (record.status !== "ready") return false;
    if (!this.isProjectionIdle(record)) return false;
    if (record.pendingCommands.size > 0 || record.pendingInterrupts.size > 0 || record.pendingReads.size > 0 || record.pendingTurnAdmissions.size > 0 || record.pendingSnapshots.size > 0 || record.authorityFinalizations.size > 0) return false;
    if (record.readQueue.length > 0 || record.activeReadId !== null) return false;
    for (const operation of record.turnOperations.values()) {
      if (operation.status.state !== "completed" && operation.status.state !== "failed") return false;
      if (operation.subscribers.size > 0) return false;
    }
    if (this.coordinator.hasLane(record.sessionId)) {
      if (!allowCoordinatorLane || !this.coordinator.isExclusivelyPending(record.sessionId, "submit")) return false;
    }
    return true;
  }

  /**
   * Phase 5B single-flight whole-epoch rollover. Joins an already-pending
   * rotation (all capacity triggerers await the SAME promise); otherwise proves
   * strict quiescence, generates the target epoch, sends `worker.rotateEpoch`
   * and awaits the correlated bounded result. A non-quiescent session returns
   * `session_busy` retryable and clears NOTHING.
   */
  private async rotateEpoch(record: RecordState, allowCoordinatorLane = false): Promise<{ rolled: true } | { rolled: false; error: ProtocolError }> {
    let pending: EpochRollover | undefined;
    let created = false;
    let immediate: { rolled: false; error: ProtocolError } | undefined;
    // Quiescence proof + single-flight installation are ONE lifecycle-critical
    // transition. No command/read/interrupt/snapshot admission can slip between
    // the proof and publication of epochRollover.
    await record.lifecycle.runExclusive(() => {
      const existing = record.epochRollover;
      if (existing) { pending = existing; return; }
      if (!this.isStrictlyQuiescent(record, allowCoordinatorLane)) {
        immediate = { rolled: false, error: { code: "session_busy", message: "session is not quiescent", retryable: true } };
        return;
      }
      const from = record.epoch;
      const to = this.makeEpoch();
      const dispatchId = `rotate:${from}:${randomUUID()}`;
      const wait = deferred<{ rolled: true } | { rolled: false; error: ProtocolError }>();
      const slot: EpochRollover = { from, to, dispatchId, promise: wait.promise, resolve: wait.resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      slot.timer = setTimeout(() => {
        if (record.epochRollover !== slot) return;
        record.epochRollover = undefined;
        this.crash(record, { code: "worker_unavailable", message: "worker epoch rollover outcome is uncertain", retryable: true });
        void record.worker.close().catch(() => {});
        slot.resolve({ rolled: false, error: { code: "timeout", message: "worker epoch rollover timed out", retryable: true } });
      }, this.epochRolloverTimeoutMs);
      record.epochRollover = slot;
      pending = slot;
      created = true;
    });
    if (immediate) return immediate;
    if (!pending) return { rolled: false, error: { code: "internal", message: "epoch rollover admission failed", retryable: false } };
    if (!created) return pending.promise;
    try {
      await record.worker.send({
        type: "worker.rotateEpoch",
        id: pending.dispatchId,
        protocolVersion: PROTOCOL_VERSION,
        payload: { sessionId: record.sessionId, fromEpoch: pending.from, toEpoch: pending.to },
      });
    } catch {
      clearTimeout(pending.timer);
      if (record.epochRollover === pending) record.epochRollover = undefined;
      this.crash(record, { code: "worker_unavailable", message: "worker epoch rollover delivery is uncertain", retryable: true });
      void record.worker.close().catch(() => {});
      pending.resolve({ rolled: false, error: { code: "worker_unavailable", message: "worker rotateEpoch send failed", retryable: true } });
    }
    return pending.promise;
  }

  /**
   * Phase 5B atomic rollover commit (under the lifecycle mutex, triple-checked):
   * epoch=to; fresh EventJournal; journalBaseEventId=0; journalBaseSnapshot=
   * current projection; clear command/read/accepted/interrupt result ledgers and
   * terminal turnOperations; set requiresEpochFence=true; clear the pending slot;
   * push `epoch_changed` to existing attach subscribers. No event cursor guess.
   */
  private commitEpochRollover(record: RecordState, toEpoch: string): void {
    record.epoch = toEpoch;
    record.journal = new EventJournal(this.journalOptions);
    record.journalBaseEventId = 0;
    record.journalBaseSnapshot = record.projection.snapshot();
    record.commandResults.clear();
    record.readResults.clear();
    record.acceptedCommands.clear();
    record.acceptedInterrupts.clear();
    record.interruptResults.clear();
    for (const operation of record.turnOperations.values()) {
      for (const subscriber of [...operation.subscribers]) this.closeTurnSubscriber(operation, subscriber);
    }
    record.turnOperations.clear();
    record.requiresEpochFence = true;
    record.epochRollover = undefined;
    this.push(record, this.snapshotPush(record, "epoch_changed"));
  }

  private requireActive(sessionId: string): RecordState {
    const record = this.records.get(sessionId);
    if (!record || ["crashed", "stopped", "stopping"].includes(record.status)) throw new SessiondError("worker_unavailable", `runtime unavailable: ${sessionId}`, true);
    return record;
  }

  private runningItems(): RuntimeListRunningResult["sessions"] {
    return [...this.records.values()]
      .filter((record) => !["stopped", "crashed", "stopping"].includes(record.status))
      .map((record) => {
        const snapshot = record.projection.snapshot();
        return {
          sessionId: record.sessionId,
          cwd: record.cwd,
          projectRoot: record.projectRoot,
          workerStatus: this.isTurnRunning(record) ? "busy" as const : record.status,
          epoch: record.epoch,
          ...(snapshot.state.sessionName === undefined ? {} : { name: snapshot.state.sessionName }),
        };
      })
      .sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0);
  }

  private deriveRunningSets(): { sessionIds: string[]; busySessionIds: string[] } {
    const items = this.runningItems();
    return {
      sessionIds: items.map((item) => item.sessionId),
      busySessionIds: items.filter((item) => item.workerStatus === "busy").map((item) => item.sessionId),
    };
  }

  private currentRunningState(): RuntimeRunningState {
    return {
      revision: this.runningState.revision,
      sessionIds: [...this.runningState.sessionIds],
      busySessionIds: [...this.runningState.busySessionIds],
    };
  }

  private updateRunningState(): RuntimeRunningState | null {
    const derived = this.deriveRunningSets();
    const sameLive = derived.sessionIds.length === this.runningState.sessionIds.length
      && derived.sessionIds.every((id, index) => id === this.runningState.sessionIds[index]);
    const sameBusy = derived.busySessionIds.length === this.runningState.busySessionIds.length
      && derived.busySessionIds.every((id, index) => id === this.runningState.busySessionIds[index]);
    if (sameLive && sameBusy) return null;
    this.runningState = {
      revision: this.runningState.revision + 1,
      sessionIds: derived.sessionIds,
      busySessionIds: derived.busySessionIds,
    };
    return this.currentRunningState();
  }

  private broadcastRunningChanged(changedSessionId: string): void {
    const state = this.updateRunningState();
    if (state === null) return;
    this.pushRunningState({ type: "running_state", state });
    // Protocol v2 compatibility shim. Removal condition: Protocol v3 deletes
    // this per-session event together with browser listRunning legacy mode.
    for (const record of this.records.values()) {
      this.acceptEvent(record, {
        type: "running_sessions_changed",
        sessionId: record.sessionId || changedSessionId,
        sessionIds: state.sessionIds,
        busySessionIds: state.busySessionIds,
      });
    }
  }

  sessionCatalog(): SessionCatalogPort | undefined { return this.deps.sessionCatalog; }
  projectCatalog(): ProjectCatalogPort | undefined { return this.deps.projectCatalog; }
  locate(sessionId: string): Promise<SessionLocation> { return this.deps.sessionLocator.locate(sessionId); }
  activationContext(sessionId: string, location: SessionLocation, requestedCwd?: string): Promise<ActivationContext> {
    return this.deps.activationContext.resolve(sessionId, location, requestedCwd);
  }

  /**
   * D4 identity lane for `sessions.rename`. The name is canonicalized exactly
   * once with the current protocol/domain rule and the canonical name is
   * returned from the RPC. The operation resolves the live/offline choice at
   * lane-run time: a live record gets a live `set_session_name` (never a
   * fallback to offline), a crashed/stopping record remains a reservation with
   * a fixed unavailable, and only an explicitly stopped/absent session uses the
   * offline mutation. No raw name/session/path/worker/adapter error crosses the
   * boundary.
   */
  async renameSession(sessionId: string, name: string): Promise<{ sessionId: string; name: string }> {
    const canonicalName = canonicalizeSessionName(name);
    await this.coordinator.admit(sessionId, "rename", async (ctx) => {
      if (this.shuttingDown) throw new SessiondError("unavailable", "sessiond is shutting down", true);
      if (ctx.isStale()) throw new SessiondError("conflict", "session identity changed during rename", false);
      const record = this.records.get(ctx.canonicalId);
      if (record && record.status !== "stopped") {
        if (record.status === "crashed" || record.status === "stopping") {
          // A crashed/stopping record remains a reservation: rename is fixed
          // unavailable and NEVER falls back to offline until explicitly
          // stopped/removed.
          throw new SessiondError("unavailable", "session rename unavailable while the runtime is stopped or crashed", true);
        }
        const result = await this.executeLiveRename(record, `rename:${randomUUID()}`, canonicalName);
        if (!result.result.ok) throw this.mapRenameCommandFailure(result);
        return;
      }
      if (!this.deps.sessionMutation) throw new SessiondError("unavailable", "session mutation is unavailable", false);
      try {
        await this.deps.sessionMutation.renameSession(ctx.canonicalId, canonicalName);
      } catch (error) {
        throw this.mapOfflineRenameFailure(error);
      }
      this.titleOverlay.publish(ctx.canonicalId, canonicalName);
    });
    return { sessionId, name: canonicalName };
  }

  /** Map a live-command `{ok:false}` result onto a fixed sanitized SessiondError. */
  private mapRenameCommandFailure(result: CorrelatedRuntimeCommandResult): SessiondError {
    const error = result.result.ok ? undefined : result.result.error;
    const code = error?.code ?? "unavailable";
    return new SessiondError(code, RENAME_FAILURE_MESSAGES[code] ?? "session rename failed", error?.retryable ?? false);
  }

  /** Map an offline-mutation failure onto a fixed sanitized SessiondError. */
  private mapOfflineRenameFailure(error: unknown): SessiondError {
    if (error instanceof SessiondError) return error;
    if (isRuntimeError(error)) {
      const code = error.code as ProtocolErrorCode;
      return new SessiondError(code, OFFLINE_RENAME_FAILURE_MESSAGES[code] ?? "session rename failed", error.retryable);
    }
    return new SessiondError("unavailable", "session rename failed", true);
  }

  /**
   * D4 session-history delete (stopped/history only). A live/crashed record (any
   * `records` entry — idle, prompt, bash, compact, crashed or stopping) or an
   * earlier activation reservation (in-flight or queued ahead in the identity
   * lane) fails closed PROMPTLY with a fixed `session_busy` — no wait/stop/
   * delete, no `force`. The catalog I/O runs INSIDE the per-session lane (never
   * under the global mutex), so a delete admitted first lets a later activation
   * queue behind it and fail not_found with zero Workers, and a rename admitted
   * first commits before the delete removes the file. Concurrent delete/delete
   * serialize on the lane; the adapter is ENOENT-idempotent, so the second
   * delete surfaces a fixed `not_found` (or an idempotent success) with no
   * wrong-file risk.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.deps.sessionCatalog) throw new SessiondError("unavailable", "session catalog is unavailable", false);
    const failClosedBusy = (): never => { throw new SessiondError("session_busy", "session is running", false); };
    // Prompt checks BEFORE enqueue (never wait for a worker).
    if (this.records.has(sessionId)) failClosedBusy();
    if (this.activations.has(sessionId)) failClosedBusy();
    if (this.coordinator.hasPendingKind(sessionId, "activate")) failClosedBusy();
    await this.coordinator.admit(sessionId, "delete", async (ctx) => {
      if (this.shuttingDown) throw new SessiondError("unavailable", "sessiond is shutting down", true);
      if (ctx.isStale()) throw new SessiondError("conflict", "session identity changed during delete", false);
      // Defensive record check inside the lane: an activation ahead of a delete
      // would already have made the prompt admission fail closed, and any
      // activation admitted after this delete queues BEHIND it (never runs
      // ahead) — so no live record can exist here; stay fail-closed anyway.
      const canonical = ctx.canonicalId;
      if (this.records.has(canonical)) failClosedBusy();
      await this.deps.sessionCatalog!.deleteSession(canonical);
      this.titleOverlay.remove(canonical);
    });
  }

  /**
   * D4 service wrappers for the read-side catalog that apply the service-owned
   * revisioned title overlay to `sessions.list` / `sessions.read`. A read that
   * begins after a confirmed rename MUST observe the new title; an older
   * catalog response can never clear a newer overlay revision.
   */
  async listSessionPage(request: SessionPageRequest): Promise<SessionPage> {
    const catalog = this.sessionCatalog();
    if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable", false);
    const captured = this.titleOverlay.captureAll();
    const page = catalog.listSessionPage
      ? await catalog.listSessionPage(request)
      : await this.legacySessionPage(catalog, request);
    return {
      ...page,
      sessions: page.sessions.map((item) => this.titleOverlay.apply(item, captured.get(item.sessionId))),
    };
  }

  private async legacySessionPage(catalog: SessionCatalogPort, request: SessionPageRequest): Promise<SessionPage> {
    const sessions = (await catalog.listSessions()).filter((session) =>
      (request.cwd === undefined || session.cwd === request.cwd)
      && (request.projectRoot === undefined || session.projectRoot === request.projectRoot));
    const offset = (request.page - 1) * request.pageSize;
    return {
      sessions: sessions.slice(offset, offset + request.pageSize),
      page: request.page,
      pageSize: request.pageSize,
      total: sessions.length,
      totalPages: sessions.length === 0 ? 0 : Math.ceil(sessions.length / request.pageSize),
      catalogRevision: 0,
    };
  }

  async listProjectPage(request: CatalogPageRequest): Promise<ProjectPage> {
    const catalog = this.projectCatalog();
    if (!catalog) throw new SessiondError("unavailable", "project catalog is unavailable", false);
    return catalog.listProjectPage(request);
  }

  /** Legacy internal list wrapper; production Protocol v4 browsing uses pages. */
  async listSessions(filter?: SessionListFilter): Promise<SessionHeader[]> {
    const catalog = this.sessionCatalog();
    if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable", false);
    const captured = this.titleOverlay.captureAll();
    const sessions = await catalog.listSessions(filter);
    return sessions.map((item) => this.titleOverlay.apply(item, captured.get(item.sessionId)));
  }

  async readSession(sessionId: string): Promise<SessionHeader> {
    const catalog = this.sessionCatalog();
    if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable", false);
    const captured = this.titleOverlay.captureFor(sessionId);
    const { entries: _entries, ...header } = await catalog.readSession(sessionId);
    // `sessions.read` is the exact header/detail authority used by Host
    // workspace authorization. Persisted transcript entries travel only over
    // the bounded `sessions.context` RPC. Never serialize a complete long
    // session into one RPC frame: the writer is intentionally bounded and the
    // Protocol SessionDetail contract makes entries optional.
    return this.titleOverlay.apply(header, captured);
  }

  /**
   * Authoritative in-process Worker lifecycle PIDs (PR#3). Derived ONLY from
   * authoritative records — no process scan. Every record that carries an
   * actual child PID is included (starting / ready / busy / stopping / crashed)
   * until exact record cleanup: `stop` removes the record immediately; a
   * crashed record stays visible until it is stopped or rekeyed/replaced. A
   * record with no real child PID (undefined / non-finite / non-positive /
   * fractional / unsafe) is excluded. Returns unique safe positive integers in
   * ascending order. Never session ids, names, paths, or environment.
   */
  workerPids(): readonly number[] {
    const seen = new Set<number>();
    const pids: number[] = [];
    for (const record of this.records.values()) {
      const pid = record.worker.pid;
      if (typeof pid !== "number") continue;
      // finite is implied by Number.isSafeInteger; exclude NaN/Infinity/fraction/unsafe.
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      pids.push(pid);
    }
    pids.sort((a, b) => a - b);
    return pids;
  }

  /** Test/diagnostic view with no process internals. */
  diagnostics(): SessiondDiagnostics {
    const lanes = this.coordinator.diagnostics();
    // Literal object pinned to the frozen WorkerStatus enum: adding a status to
    // the Protocol enum without adding a key here is a compile-time error.
    const workersByStatus = {
      idle: 0,
      starting: 0,
      ready: 0,
      busy: 0,
      stopping: 0,
      stopped: 0,
      crashed: 0,
      unavailable: 0,
    } satisfies Record<WorkerStatus, number>;
    for (const record of this.records.values()) {
      if (Object.prototype.hasOwnProperty.call(workersByStatus, record.status)) workersByStatus[record.status] += 1;
    }
    return {
      sessions: this.records.size,
      creates: this.creates.size,
      activations: this.activations.size,
      subscribers: [...this.records.values()].reduce((sum, record) => sum + record.subscribers.size, 0),
      lanes: lanes.lanes,
      aliases: lanes.aliases,
      overlay: this.titleOverlay.size(),
      workersByStatus,
    };
  }
}
