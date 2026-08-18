import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CorrelatedRuntimeCommandResult,
  CorrelatedRuntimeInterruptResult,
  RuntimeAttachParams,
  RuntimeCommand,
  RuntimeCreateParams,
  RuntimeCreateResult,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeInterrupt,
  RuntimeSnapshot,
  RuntimeActivateResult,
  RuntimeGetSnapshotResult,
  RuntimeListRunningResult,
  SessiondPush,
  SessiondRuntimeAttachResult,
  SnapshotDeliveryReason,
  WorkerStatus,
  WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import { PROTOCOL_VERSION, RuntimeCloseReasonSchema, type ProtocolErrorCode } from "@fffattiger/pix-protocol";
import type { RuntimeCloseReason } from "@fffattiger/pix-protocol";
import { isRuntimeError, type SessionCatalogPort, type SessionDetail, type SessionHeader, type SessionListFilter, type SessionLocation, type SessionLocatorPort, type SessionMutationPort } from "@fffattiger/pix-runtime-core";
import { SessiondError, duplicateInterruptUnavailable, duplicateResultUnavailable, rejectedCommand, rejectedInterrupt, unavailableCommand, unavailableInterrupt } from "./errors.js";
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

interface Subscriber {
  closed: boolean;
  draining: boolean;
  queue: SessiondPush[];
  listener: PushListener;
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

interface PendingSnapshot {
  resolve: (snapshot: RuntimeSnapshot) => void;
  reject: (error: Error) => void;
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
  commandResults: Map<string, CorrelatedRuntimeCommandResult>;
  acceptedCommands: Map<string, RuntimeCommand["type"]>;
  pendingCommands: Map<string, PendingCommand>;
  pendingInterrupts: Map<string, PendingInterrupt>;
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
    if (!Number.isSafeInteger(this.commandResultLimit) || this.commandResultLimit < 1) throw new RangeError("commandResultLimit must be positive");
    if (!Number.isSafeInteger(this.commandResultCacheLimit) || this.commandResultCacheLimit < 1 || this.commandResultCacheLimit > this.commandResultLimit) throw new RangeError("commandResultCacheLimit must be positive and no greater than commandResultLimit");
    if (!Number.isSafeInteger(this.createRequestLimit) || this.createRequestLimit < 1) throw new RangeError("createRequestLimit must be positive");
    if (!Number.isSafeInteger(this.interruptLimit) || this.interruptLimit < 1) throw new RangeError("interruptLimit must be positive");
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
        acceptedCommands: new Map(),
        pendingCommands: new Map(),
        pendingInterrupts: new Map(),
        acceptedInterrupts: new Map(),
        interruptResults: new Map(),
        pendingSnapshots: new Map(),
        authorityFinalizations: new Map(),
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
            cwd: input.cwd,
            projectRoot: input.projectRoot,
            ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
            ...(input.create?.model === undefined ? {} : { model: input.create.model }),
            ...(input.create?.thinkingLevel === undefined ? {} : { thinkingLevel: input.create.thinkingLevel }),
            ...(input.create?.thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned: input.create.thinkingLevelPinned }),
            ...(input.create?.toolNames === undefined ? {} : { toolNames: [...input.create.toolNames] }),
            ...(input.create?.name === undefined ? {} : { name: input.create.name }),
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
        if (message.payload.sessionId !== record.sessionId) {
          void this.rekey(record, message.payload.sessionId)
            .then(() => void settleReady())
            .catch((error) => {
              record.startupReject?.(error instanceof SessiondError ? error : new SessiondError("worker_unavailable", "worker session rekey failed", true));
            });
        } else void settleReady();
        break;
      }
      case "worker.sessionDiscovered":
        void this.rekey(record, message.payload.sessionId, message.payload.sessionFile, message.payload.cwd);
        break;
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
      case "worker.status": record.status = message.payload.status; break;
      case "worker.fatal": this.crash(record, message.payload.error); break;
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
    let conflicted = false;
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
      record.journal = new EventJournal(this.journalOptions);
      record.journalBaseEventId = 0;
      record.commandResults.clear();
      record.acceptedCommands.clear();
      record.acceptedInterrupts.clear();
      record.interruptResults.clear();
      record.authorityFinalizations.clear();
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
    if (conflicted) {
      // Fail closed OUTSIDE the mutex: identity transition is already done, and
      // the Worker close is never awaited under the global lock.
      record.expectedExitReason = "rekey_conflict";
      this.records.delete(record.sessionId);
      record.unsubscribeWorker();
      record.unsubscribeExit();
      record.startupReject?.(new SessiondError("conflict", `session already active: ${realId}`));
      delete record.startupReject;
      await record.worker.close().catch(() => {});
    }
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
        record.epoch = this.makeEpoch();
        record.journal = new EventJournal(this.journalOptions);
        record.journalBaseEventId = 0;
        record.journalBaseSnapshot = record.projection.snapshot();
        const event = record.journal.append(record.epoch, data);
        this.push(record, this.snapshotPush(record, "epoch_changed"));
        this.push(record, { type: "event", event });
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
    for (const pending of record.pendingSnapshots.values()) { clearTimeout(pending.timer); pending.reject(new SessiondError("worker_unavailable", message, true)); }
    record.pendingSnapshots.clear();
  }

  async command(sessionId: string, command: RuntimeCommand): Promise<CorrelatedRuntimeCommandResult> {
    // D4 identity lane: public `runtime.command(set_session_name)` shares the
    // EXACT same per-session FIFO lane as `sessions.rename`, so the Client
    // SessionActions path can never bypass Host/API rename ordering. The private
    // non-reentrant command operation is never re-admitted into the lane.
    if (command.type === "set_session_name") return this.commandRename(sessionId, command);
    // D2 auto_name: public `runtime.command(generate_session_title)` shares the
    // SAME per-session FIFO lane as rename (reusing the "rename" kind, the §51
    // set_session_name semantics) so a user rename and an auto_name on the same
    // session serialize FIFO with a deterministic last-committer-wins title.
    if (command.type === "generate_session_title") return this.commandAutoName(sessionId, command);
    // D2 fork: `runtime.command(fork)` shares the same per-session FIFO lane as
    // activate/rename/stop/delete so a fork races old-id identity mutations
    // deterministically and ends the OLD worker through the identity stop path.
    if (command.type === "fork") return this.commandFork(sessionId, command);
    const record = this.requireActive(sessionId);
    return this.commandOnRecord(record, command);
  }

  /**
   * Private non-reentrant command operation (the former `command` body). One
   * caller holds exactly one lane and never enqueues recursively; this method
   * is invoked by the rename lane operation for live `set_session_name` and by
   * the public `command` for every other command type.
   */
  private async commandOnRecord(record: RecordState, command: RuntimeCommand): Promise<CorrelatedRuntimeCommandResult> {
    const sessionId = record.sessionId;
    let immediate: CorrelatedRuntimeCommandResult | undefined;
    let pending!: PendingCommand;
    let finalization: Promise<CorrelatedRuntimeCommandResult> | undefined;
    await record.lifecycle.runExclusive(async () => {
      if (this.records.get(sessionId) !== record || ["crashed", "stopped", "stopping"].includes(record.status)) {
        immediate = unavailableCommand(command.commandId, command.type, "runtime stopped before command admission");
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
      const cached = record.commandResults.get(command.commandId);
      if (cached) { immediate = cached; return; }
      const wireId = `command:${record.epoch}:${command.commandId}`;
      const existing = record.pendingCommands.get(wireId);
      if (existing) { pending = existing; return; }
      if (acceptedType !== undefined) { immediate = duplicateResultUnavailable(command.commandId, acceptedType); return; }
      if (record.acceptedCommands.size >= this.commandResultLimit) {
        immediate = rejectedCommand(command.commandId, command.type, "command id capacity reached for this epoch");
        return;
      }
      record.acceptedCommands.set(command.commandId, command.type);
      const wait = deferred<CorrelatedRuntimeCommandResult>();
      const timer = setTimeout(() => {
        record.pendingCommands.delete(wireId);
        wait.resolve(unavailableCommand(command.commandId, command.type, "worker command timed out"));
      }, this.commandTimeoutMs);
      pending = { commandId: command.commandId, commandType: command.type, epoch: record.epoch, promise: wait.promise, resolve: wait.resolve, timer };
      record.pendingCommands.set(wireId, pending);
      this.touch(record);
      try {
        await record.worker.send({ type: "worker.command", id: wireId, protocolVersion: PROTOCOL_VERSION, payload: { sessionId, command } });
      } catch {
        clearTimeout(timer);
        record.pendingCommands.delete(wireId);
        const result = unavailableCommand(command.commandId, command.type, "worker command send failed");
        this.cacheCommandResult(record, result);
        immediate = result;
      }
    });
    if (immediate) return immediate;
    if (finalization) return finalization;
    const result = await pending.promise;
    // Terminal results are cached by the worker.commandResult handler (ordinary
    // commands) or by authority finalization (set_thinking_level & co).
    // Cache only when still absent and this record/epoch still owns the admission
    // so timeout paths stay at-most-once without cross-rekey writes.
    if (
      this.records.get(record.sessionId) === record &&
      record.epoch === pending.epoch &&
      !record.commandResults.has(result.commandId)
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
  private commandRename(sessionId: string, command: RuntimeCommand & { type: "set_session_name" }): Promise<CorrelatedRuntimeCommandResult> {
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
      return this.executeLiveRename(record, command.commandId, canonicalName);
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
  private commandFork(sessionId: string, command: RuntimeCommand & { type: "fork" }): Promise<CorrelatedRuntimeCommandResult> {
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
        const result = await this.commandOnRecord(record, command);
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
  private async executeLiveRename(record: RecordState, commandId: string, name: string): Promise<CorrelatedRuntimeCommandResult> {
    const epochAtCapture = record.epoch;
    if (!this.ownsLiveRecord(record, epochAtCapture)) {
      return unavailableCommand(commandId, "set_session_name", "runtime stopped before rename command");
    }
    const result = await this.commandOnRecord(record, { type: "set_session_name", commandId, name });
    const stillOwned = this.ownsLiveRecord(record, epochAtCapture);
    const matchesCapture = result.commandId === commandId && result.result.type === "set_session_name";
    if (result.result.ok && stillOwned && matchesCapture) {
      this.titleOverlay.publish(record.sessionId, name);
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
   * D2 auto_name: the per-session FIFO identity lane for public
   * `runtime.command(generate_session_title)`. Reuses the "rename" kind (the
   * §51 set_session_name semantics): auto_name generates and applies a session
   * title, so it FIFO-serializes with user renames/set_session_name and the
   * deterministic winner is last-committer-wins per lane order. Stale/rekeyed
   * requests are inert; there is NEVER an offline fallback (a title command
   * never starts a worker for an offline session). Delete/stop interplay is
   * preserved by the lane (a delete removes the overlay; a stop retains it).
   */
  private commandAutoName(sessionId: string, command: RuntimeCommand & { type: "generate_session_title" }): Promise<CorrelatedRuntimeCommandResult> {
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
      return this.executeLiveAutoName(record, command.commandId);
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
  private async executeLiveAutoName(record: RecordState, commandId: string): Promise<CorrelatedRuntimeCommandResult> {
    const epochAtCapture = record.epoch;
    if (!this.ownsLiveRecord(record, epochAtCapture)) {
      return unavailableCommand(commandId, "generate_session_title", "runtime stopped before title command");
    }
    const result = await this.commandOnRecord(record, { type: "generate_session_title", commandId });
    const stillOwned = this.ownsLiveRecord(record, epochAtCapture);
    const matchesCapture = result.commandId === commandId && result.result.type === "generate_session_title";
    if (result.result.ok && stillOwned && matchesCapture && result.result.type === "generate_session_title") {
      this.titleOverlay.publish(record.sessionId, result.result.title);
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
  async interrupt(sessionId: string, commandId: string, interrupt: RuntimeInterrupt): Promise<CorrelatedRuntimeInterruptResult> {
    const record = this.requireActive(sessionId);
    let immediate: CorrelatedRuntimeInterruptResult | undefined;
    let pending!: PendingInterrupt;
    await record.lifecycle.runExclusive(async () => {
      if (this.records.get(sessionId) !== record || ["crashed", "stopped", "stopping"].includes(record.status)) {
        immediate = unavailableInterrupt(commandId, interrupt.type, "runtime stopped before interrupt admission");
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
      if (record.acceptedInterrupts.size >= this.interruptLimit) {
        immediate = rejectedInterrupt(commandId, interrupt.type, "interrupt id capacity reached for this epoch");
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
        await record.worker.send({ type: "worker.interrupt", id: wireId, protocolVersion: PROTOCOL_VERSION, payload: { sessionId, commandId, interrupt } });
      } catch {
        clearTimeout(timer);
        record.pendingInterrupts.delete(wireId);
        const result = unavailableInterrupt(commandId, interrupt.type, "worker interrupt send failed");
        this.cacheInterruptResult(record, result);
        immediate = result;
      }
    });
    if (immediate) return immediate;
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

  listRunning(): RuntimeListRunningResult {
    return {
      sessions: [...this.records.values()]
        .filter((record) => !["stopped", "crashed"].includes(record.status))
        .map((record) => ({
          sessionId: record.sessionId,
          cwd: record.cwd,
          projectRoot: record.projectRoot,
          workerStatus: this.isTurnRunning(record) ? "busy" : record.status,
          epoch: record.epoch,
          ...(record.projection.snapshot().state.sessionName === undefined ? {} : { name: record.projection.snapshot().state.sessionName }),
        })),
    };
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
    if (record.commandResults.has(result.commandId)) record.commandResults.delete(result.commandId);
    record.commandResults.set(result.commandId, result);
    while (record.commandResults.size > this.commandResultCacheLimit) {
      const oldest = record.commandResults.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      record.commandResults.delete(oldest);
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

  private requireActive(sessionId: string): RecordState {
    const record = this.records.get(sessionId);
    if (!record || ["crashed", "stopped", "stopping"].includes(record.status)) throw new SessiondError("worker_unavailable", `runtime unavailable: ${sessionId}`, true);
    return record;
  }

  private broadcastRunningChanged(changedSessionId: string): void {
    const items = this.listRunning().sessions;
    const sessionIds = items.map((item) => item.sessionId);
    const busySessionIds = [...this.records.values()]
      .filter((record) => !["crashed", "stopped", "stopping"].includes(record.status) && this.isTurnRunning(record))
      .map((record) => record.sessionId);
    for (const record of this.records.values()) {
      this.acceptEvent(record, {
        type: "running_sessions_changed",
        sessionId: record.sessionId || changedSessionId,
        sessionIds,
        busySessionIds,
      });
    }
  }

  sessionCatalog(): SessionCatalogPort | undefined { return this.deps.sessionCatalog; }
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
  async listSessions(filter?: SessionListFilter): Promise<SessionHeader[]> {
    const catalog = this.sessionCatalog();
    if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable", false);
    const captured = this.titleOverlay.captureAll();
    const sessions = await catalog.listSessions(filter);
    return sessions.map((item) => this.titleOverlay.apply(item, captured.get(item.sessionId)));
  }

  async readSession(sessionId: string): Promise<SessionDetail> {
    const catalog = this.sessionCatalog();
    if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable", false);
    const captured = this.titleOverlay.captureFor(sessionId);
    const detail = await catalog.readSession(sessionId);
    return this.titleOverlay.apply(detail, captured);
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
