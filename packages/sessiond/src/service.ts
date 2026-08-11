import { randomUUID } from "node:crypto";
import type {
  CorrelatedRuntimeCommandResult,
  RuntimeAttachParams,
  RuntimeCommand,
  RuntimeCreateParams,
  RuntimeCreateResult,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeInterrupt,
  RuntimeInterruptResult,
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
import { PROTOCOL_VERSION, RuntimeCloseReasonSchema } from "@fffattiger/pix-protocol";
import type { RuntimeCloseReason } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocation, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondError, duplicateResultUnavailable, rejectedCommand, unavailableCommand, unavailableInterrupt } from "./errors.js";
import { EventJournal, type EventJournalOptions } from "./journal.js";
import { AsyncMutex } from "./internal/mutex.js";
import { SnapshotProjection } from "./projection.js";
import type { WorkerConnection, WorkerProcessFactory, WorkerStartInput } from "./worker.js";

export interface ActivationContext {
  cwd: string;
  projectRoot: string;
}

export interface ActivationContextProvider {
  resolve(sessionId: string, location: SessionLocation, requestedCwd?: string): Promise<ActivationContext>;
}

export interface SessionMutationPort {
  rename(sessionId: string, name: string): Promise<void>;
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

export interface SessiondDependencies {
  sessionLocator: SessionLocatorPort;
  activationContext: ActivationContextProvider;
  workerFactory: WorkerProcessFactory;
  sessionCatalog?: SessionCatalogPort;
  sessionMutation?: SessionMutationPort;
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
  promise: Promise<CorrelatedRuntimeCommandResult>;
  resolve: (result: CorrelatedRuntimeCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingInterrupt {
  type: RuntimeInterrupt["type"];
  resolve: (result: RuntimeInterruptResult) => void;
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
  acceptedInterrupts: Map<string, Promise<RuntimeInterruptResult>>;
  pendingSnapshots: Map<string, PendingSnapshot>;
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
  messages: [],
});

const stripCursor = (event: RuntimeEvent): RuntimeEventData => {
  const { eventId: _eventId, epoch: _epoch, ...data } = event;
  return data as RuntimeEventData;
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
  private readonly mutex = new AsyncMutex();
  private readonly now: () => number;
  private readonly makeEpoch: () => string;
  private readonly journalOptions: EventJournalOptions;
  private readonly workerStartTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
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
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
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
    const active = this.records.get(sessionId);
    if (active && active.status !== "crashed" && active.status !== "stopped") return this.activateResult(active);
    const inFlight = this.activations.get(sessionId);
    if (inFlight) return this.activateResult(await inFlight);
    const operation = (async () => {
      const location = await this.deps.sessionLocator.locate(sessionId);
      if (!location.exists) throw new SessiondError("not_found", `session not found: ${sessionId}`);
      const context = await this.deps.activationContext.resolve(sessionId, location, requestedCwd);
      return this.start({
        activationId: randomUUID(),
        sessionId,
        cwd: context.cwd,
        projectRoot: context.projectRoot,
        sessionFile: location.sessionFile,
      });
    })();
    this.activations.set(sessionId, operation);
    try { return this.activateResult(await operation); }
    finally { this.activations.delete(sessionId); }
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
        pendingSnapshots: new Map(),
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
        const settleReady = () => {
          record.status = message.payload.workerStatus;
          if (message.payload.state !== undefined) {
            const snapshot = record.projection.snapshot();
            snapshot.state = message.payload.state;
            snapshot.sessionId = record.sessionId;
            snapshot.state.sessionId = record.sessionId;
            record.projection.replace(snapshot);
          }
          ready();
        };
        if (message.payload.sessionId !== record.sessionId) void this.rekey(record, message.payload.sessionId).then(settleReady);
        else settleReady();
        break;
      }
      case "worker.sessionDiscovered":
        void this.rekey(record, message.payload.sessionId, message.payload.sessionFile, message.payload.cwd);
        break;
      case "worker.snapshot": {
        if (message.payload.sessionId !== record.sessionId) return;
        try {
          record.projection.replace(message.payload.snapshot);
          if (record.journal.lastEventId === 0) record.journalBaseSnapshot = record.projection.snapshot();
          const pending = message.id === undefined ? undefined : record.pendingSnapshots.get(message.id);
          if (pending) { clearTimeout(pending.timer); record.pendingSnapshots.delete(message.id!); pending.resolve(record.projection.snapshot()); }
        } catch { /* malformed state is dropped at authority boundary */ }
        break;
      }
      case "worker.event":
        if (message.payload.sessionId !== record.sessionId) return;
        this.acceptEvent(record, message.payload.event);
        break;
      case "worker.commandResult": {
        if (message.payload.sessionId !== record.sessionId) return;
        const pending = record.pendingCommands.get(message.id);
        if (!pending || pending.resolve === undefined) return;
        clearTimeout(pending.timer);
        record.pendingCommands.delete(message.id);
        this.cacheCommandResult(record, message.payload.result);
        pending.resolve(message.payload.result);
        break;
      }
      case "worker.interruptResult": {
        if (message.payload.sessionId !== record.sessionId) return;
        const pending = record.pendingInterrupts.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        record.pendingInterrupts.delete(message.id);
        pending.resolve(message.payload.result);
        break;
      }
      case "worker.status": record.status = message.payload.status; break;
      case "worker.fatal": this.crash(record, message.payload.error); break;
      default: break;
    }
  }

  private async rekey(record: RecordState, realId: string, sessionFile?: string, cwd?: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!this.records.has(record.sessionId) || realId === record.sessionId) return;
      const collision = this.records.get(realId);
      if (collision && collision !== record) {
        record.expectedExitReason = "rekey_conflict";
        this.records.delete(record.sessionId);
        record.unsubscribeWorker();
        record.unsubscribeExit();
        record.startupReject?.(new SessiondError("conflict", `session already active: ${realId}`));
        delete record.startupReject;
        await record.worker.close().catch(() => {});
        return;
      }
      const oldId = record.sessionId;
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
      record.projection.rekey(realId);
      const snapshot = record.projection.snapshot();
      snapshot.cwd = record.cwd;
      if (sessionFile !== undefined) snapshot.state.sessionFile = sessionFile;
      record.projection.replace(snapshot);
      record.journalBaseSnapshot = record.projection.snapshot();
      this.records.set(realId, record);
    });
  }

  private acceptEvent(record: RecordState, data: RuntimeEventData): void {
    if (record.status === "crashed" || record.status === "stopped" || record.status === "stopping") return;
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
    for (const pending of record.pendingInterrupts.values()) { clearTimeout(pending.timer); pending.resolve(unavailableInterrupt(pending.type, message)); }
    record.pendingInterrupts.clear();
    for (const pending of record.pendingSnapshots.values()) { clearTimeout(pending.timer); pending.reject(new SessiondError("worker_unavailable", message, true)); }
    record.pendingSnapshots.clear();
  }

  async command(sessionId: string, command: RuntimeCommand): Promise<CorrelatedRuntimeCommandResult> {
    const record = this.requireActive(sessionId);
    let immediate: CorrelatedRuntimeCommandResult | undefined;
    let pending!: PendingCommand;
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
      pending = { commandId: command.commandId, commandType: command.type, promise: wait.promise, resolve: wait.resolve, timer };
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
    const result = await pending.promise;
    this.cacheCommandResult(record, result);
    return result;
  }

  async interrupt(sessionId: string, interrupt: RuntimeInterrupt, requestId?: string): Promise<RuntimeInterruptResult> {
    const record = this.requireActive(sessionId);
    const dedupeId = requestId ?? randomUUID();
    const accepted = record.acceptedInterrupts.get(dedupeId);
    if (accepted) return accepted;
    if (record.acceptedInterrupts.size >= this.interruptLimit) return unavailableInterrupt(interrupt.type, "interrupt id capacity reached for this epoch");
    let immediate: RuntimeInterruptResult | undefined;
    let promise!: Promise<RuntimeInterruptResult>;
    await record.lifecycle.runExclusive(async () => {
      const known = record.acceptedInterrupts.get(dedupeId);
      if (known) { promise = known; return; }
      if (this.records.get(sessionId) !== record || ["crashed", "stopped", "stopping"].includes(record.status)) {
        immediate = unavailableInterrupt(interrupt.type, "runtime stopped before interrupt admission");
        return;
      }
      const id = `interrupt:${record.epoch}:${dedupeId}`;
      const wait = deferred<RuntimeInterruptResult>();
      promise = wait.promise;
      record.acceptedInterrupts.set(dedupeId, promise);
      const timer = setTimeout(() => { record.pendingInterrupts.delete(id); wait.resolve(unavailableInterrupt(interrupt.type, "worker interrupt timed out")); }, this.commandTimeoutMs);
      record.pendingInterrupts.set(id, { type: interrupt.type, resolve: wait.resolve, timer });
      try {
        await record.worker.send({ type: "worker.interrupt", id, protocolVersion: PROTOCOL_VERSION, payload: { sessionId, interrupt } });
      } catch {
        clearTimeout(timer);
        record.pendingInterrupts.delete(id);
        immediate = unavailableInterrupt(interrupt.type, "worker interrupt send failed");
        record.acceptedInterrupts.set(dedupeId, Promise.resolve(immediate));
      }
    });
    return immediate ?? promise;
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
    return { sessions: [...this.records.values()].filter((record) => !["stopped", "crashed"].includes(record.status)).map((record) => ({ sessionId: record.sessionId, cwd: record.cwd, projectRoot: record.projectRoot, workerStatus: record.status, epoch: record.epoch, ...(record.projection.snapshot().state.sessionName === undefined ? {} : { name: record.projection.snapshot().state.sessionName }) })) };
  }

  hasBusyCwd(cwd: string): { cwd: string; busy: boolean; sessionIds?: string[] } {
    const sessionIds = [...this.records.values()].filter((record) => record.cwd === cwd && this.isBusy(record)).map((record) => record.sessionId);
    return { cwd, busy: sessionIds.length > 0, ...(sessionIds.length ? { sessionIds } : {}) };
  }

  async stopByCwd(cwd: string, reason = "user"): Promise<string[]> {
    const ids = [...this.records.values()].filter((record) => record.cwd === cwd).map((record) => record.sessionId);
    for (const id of ids) await this.stop(id, reason);
    return ids;
  }

  async stop(sessionId: string, reason = "user"): Promise<boolean> {
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
    await Promise.allSettled(ids.map((id) => this.stop(id, "shutdown")));
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

  private touch(record: RecordState): void {
    record.lastActivity = this.now();
    record.idleGeneration += 1;
    const generation = record.idleGeneration;
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

  private isBusy(record: RecordState): boolean {
    const state = record.projection.snapshot().state;
    return state.isPromptRunning || state.isBashRunning || state.isCompacting || record.pendingCommands.size > 0;
  }

  private requireActive(sessionId: string): RecordState {
    const record = this.records.get(sessionId);
    if (!record || ["crashed", "stopped", "stopping"].includes(record.status)) throw new SessiondError("worker_unavailable", `runtime unavailable: ${sessionId}`, true);
    return record;
  }

  private broadcastRunningChanged(changedSessionId: string): void {
    const ids = this.listRunning().sessions.map((item) => item.sessionId);
    for (const record of this.records.values()) this.acceptEvent(record, { type: "running_sessions_changed", sessionId: record.sessionId || changedSessionId, sessionIds: ids });
  }

  sessionCatalog(): SessionCatalogPort | undefined { return this.deps.sessionCatalog; }
  locate(sessionId: string): Promise<SessionLocation> { return this.deps.sessionLocator.locate(sessionId); }
  activationContext(sessionId: string, location: SessionLocation, requestedCwd?: string): Promise<ActivationContext> {
    return this.deps.activationContext.resolve(sessionId, location, requestedCwd);
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (record) {
      await this.command(sessionId, { type: "set_session_name", commandId: `rename:${randomUUID()}`, name });
      return;
    }
    if (!this.deps.sessionMutation) throw new SessiondError("unavailable", "session mutation is unavailable");
    await this.deps.sessionMutation.rename(sessionId, name);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.records.has(sessionId)) await this.stop(sessionId, "session_deleted");
    if (!this.deps.sessionCatalog) throw new SessiondError("unavailable", "session catalog is unavailable");
    await this.deps.sessionCatalog.deleteSession(sessionId);
  }

  /** Test/diagnostic view with no process internals. */
  diagnostics(): { sessions: number; creates: number; activations: number; subscribers: number } {
    return { sessions: this.records.size, creates: this.creates.size, activations: this.activations.size, subscribers: [...this.records.values()].reduce((sum, record) => sum + record.subscribers.size, 0) };
  }
}
