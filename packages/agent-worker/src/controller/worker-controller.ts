/**
 * WorkerController — the single-session worker application controller.
 *
 * Owns one {@link AgentRuntimePort} (created or opened via the injected
 * {@link AgentRuntimeFactory}) and projects the Core ↔ Protocol boundary:
 *
 *   - `worker.init` (mode create/open) bootstraps the runtime. On `create`
 *     the adapter returns the real session id; the controller emits
 *     `worker.sessionDiscovered` and carries the real id in `worker.ready`
 *     so the sessiond authority rekeys its record.
 *   - Core events are projected by the {@link StatefulRuntimeMapper} into
 *     Protocol `RuntimeEventData` and pushed as `worker.event` frames. The
 *     mapper never synthesizes epoch/eventId — those are sessiond-owned.
 *   - `worker.command`/`worker.interrupt` execute on the port and produce
 *     EXACTLY ONE correlated result per commandId (wire id echoed, business
 *     commandId preserved). Unknown / duplicate / late / closing paths fail
 *     closed with a correlated error result rather than hanging the sessiond.
 *   - `worker.getSnapshot` maps the Core snapshot via {@link SnapshotMapper}.
 *   - `worker.shutdown` and stdin EOF (`onInputClosed`) perform an ordered
 *     shutdown and request process exit; shutdown is bounded by a timeout that
 *     fails the exit if the runtime does not close in time.
 *
 * The controller is transport-agnostic: it only depends on the outbound
 * message sink and a `requestExit` callback. No epoch/eventId is ever minted.
 */
import {
  READ_ONLY_RUNTIME_COMMAND_TYPES,
  type AgentRuntimeFactory,
  type AgentRuntimePort,
  type RuntimeEvent,
} from "@fffattiger/pix-runtime-core";
import {
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  SESSIOND_BUILD_IDENTITY,
  WORKER_BUILD_IDENTITY,
  evaluateSessiondBuild,
  type CorrelatedRuntimeCommandResult,
  type CorrelatedRuntimeInterruptResult,
  type ProtocolError,
  type RuntimeCommand,
  type RuntimeEventData,
  type RuntimeInterrupt,
  type RuntimeInterruptResult,
  type SessiondToWorkerMessage,
  type WorkerToSessiondMessage,
  type SubmitTurnAdmission,
  type TurnStatus,
} from "@fffattiger/pix-protocol";
import { mapCoreReadToProtocolRead, mapCoreResultToProtocol, mapProtocolCommandToCore, mapProtocolReadToCoreRead } from "../mapper/command-mapper.js";
import { protocolError, runtimeErrorToProtocolError, toProtocolError } from "../mapper/protocol-error.js";
import { SnapshotMapper } from "../mapper/snapshot-mapper.js";
import { StatefulRuntimeMapper } from "../mapper/runtime-mapper.js";

const READ_ONLY_COMMAND_TYPES = new Set<string>(READ_ONLY_RUNTIME_COMMAND_TYPES);

/** Type guard: narrow a Protocol command type onto the read-only vocabulary. */
const isReadOnlyCommandType = (type: RuntimeCommand["type"]): type is (typeof READ_ONLY_RUNTIME_COMMAND_TYPES)[number] =>
  READ_ONLY_COMMAND_TYPES.has(type);

/** Lifecycle phase of the worker application. */
export type WorkerControllerPhase =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

/** Message sink the controller pushes Protocol frames to (implemented by the transport). */
export interface WorkerOutbound {
  send(message: WorkerToSessiondMessage): Promise<void>;
}

export interface WorkerControllerOptions {
  readonly factory: AgentRuntimeFactory;
  readonly outbound: WorkerOutbound;
  /** Called once the process should terminate with the given exit code (idempotent). */
  readonly requestExit: (code: number) => void;
  /** stderr logger (never stdout — stdout carries protocol frames only). */
  readonly logger?: (line: string) => void;
  /** Bounded runtime close during shutdown; exceeds → failure exit. */
  readonly shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export class WorkerController {
  private readonly factory: AgentRuntimeFactory;
  private readonly outbound: WorkerOutbound;
  private readonly requestExit: (code: number) => void;
  private readonly logger: (line: string) => void;
  private readonly shutdownTimeoutMs: number;
  private readonly runtimeMapper: StatefulRuntimeMapper;
  private readonly snapshotMapper: SnapshotMapper;

  private phaseValue: WorkerControllerPhase = "uninitialized";
  private port: AgentRuntimePort | null = null;
  private unsubscribe: (() => void) | null = null;
  private realSessionId: string | null = null;
  private cwdValue = "";
  private projectRootValue = "";
  /** commandIds accepted in this worker lifetime (duplicates fail closed). */
  private readonly seenCommandIds = new Set<string>();
  private readonly seenInterruptIds = new Set<string>();
  private readonly turnLedger = new Map<string, {
    fingerprint: string;
    result?: SubmitTurnAdmission;
    status?: TurnStatus;
    admission: Promise<{ result: SubmitTurnAdmission; completion: import("@fffattiger/pix-runtime-core").RuntimeTurnHandle["completion"] | undefined }>;
  }>();
  private shuttingDown = false;
  /**
   * Phase 5B: authority epoch this worker accepts business frames under.
   * Initialized from the REQUIRED `worker.init.epoch` and advanced ONLY by an
   * exact idle {@code worker.rotateEpoch} (or a sessiond rekey sync at
   * startup). A frame carrying any other epoch is rejected fail-closed with
   * zero port call.
   */
  private authorityEpoch: string | null = null;
  /**
   * Phase 5B: count of in-flight business handlers (command/read/submitTurn/
   * interrupt). worker-main dispatches concurrently, so a rotateEpoch must
   * observe zero before it may mutate any ledger / advance the epoch.
   */
  private activeBusinessHandlers = 0;

  constructor(options: WorkerControllerOptions) {
    this.factory = options.factory;
    this.outbound = options.outbound;
    this.requestExit = options.requestExit;
    this.logger = options.logger ?? (() => {});
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.runtimeMapper = new StatefulRuntimeMapper((line) => this.logger(`[mapper] ${line}`));
    this.snapshotMapper = new SnapshotMapper(this.runtimeMapper);
  }

  get phase(): WorkerControllerPhase {
    return this.phaseValue;
  }

  get sessionId(): string | null {
    return this.realSessionId;
  }

  /** Handle one inbound sessiond→worker message. Fire-and-forget safe. */
  async handleMessage(message: SessiondToWorkerMessage): Promise<void> {
    switch (message.type) {
      case "worker.init":
        await this.handleInit(message);
        return;
      case "worker.command":
        // Phase 5B: business handlers increment the concurrency counter so a
        // concurrent rotateEpoch can never race an in-flight port call.
        await this.withActiveBusiness(() => this.handleCommand(message));
        return;
      case "worker.read":
        await this.withActiveBusiness(() => this.handleRead(message));
        return;
      case "worker.submitTurn":
        await this.withActiveBusiness(() => this.handleSubmitTurn(message));
        return;
      case "worker.interrupt":
        await this.withActiveBusiness(() => this.handleInterrupt(message));
        return;
      case "worker.getSnapshot":
        await this.handleSnapshot(message);
        return;
      case "worker.rotateEpoch":
        // Separate control channel: never counted as a business handler and
        // requires activeBusinessHandlers === 0 before it may rotate.
        await this.handleRotateEpoch(message);
        return;
      case "worker.shutdown":
        await this.shutdown("shutdown");
        return;
      case "worker.ping":
        // No worker→sessiond pong exists in the frozen protocol; a ping is a
        // benign no-op (logged, never answered).
        this.logger("[controller] worker.ping ignored (no pong defined)");
        return;
      case "worker.hostResponse":
        // The worker never issues hostRequests in M2; a stray response is a
        // protocol violation → fail closed.
        await this.failFatal(
          protocolError("invalid_request", "unexpected worker.hostResponse"),
          1,
        );
        return;
    }
  }

  /** Wrap a business handler with the active-handler concurrency counter. */
  private async withActiveBusiness<T>(fn: () => Promise<T>): Promise<T> {
    this.activeBusinessHandlers += 1;
    try {
      return await fn();
    } finally {
      this.activeBusinessHandlers -= 1;
    }
  }

  /** stdin EOF/close: perform an ordered shutdown and request a clean exit. */
  async onInputClosed(): Promise<void> {
    await this.shutdown("input-closed");
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  private async handleInit(message: Extract<SessiondToWorkerMessage, { type: "worker.init" }>): Promise<void> {
    if (this.phaseValue !== "uninitialized") {
      await this.failFatal(
        protocolError("conflict", `worker.init received in phase ${this.phaseValue}`),
        1,
      );
      return;
    }
    // Phase 7A build fence: validate the sessiond build contract BEFORE any
    // runtime is created or any session state is touched. Same protocol major
    // proves nothing; an unknown/older/malformed build fails this Worker
    // closed with a fixed error, so a mixed-dist deployment never runs an
    // unverifiable sessiond↔Worker pair.
    const verdict = evaluateSessiondBuild(message.payload.build, SESSIOND_BUILD_IDENTITY);
    if (verdict.state === "incompatible") {
      this.phaseValue = "failed";
      await this.failFatal(
        protocolError(
          "protocol_mismatch",
          `sessiond build contract rejected (${verdict.reason}); this Worker dist is not compatible with the running sessiond build`,
          false,
        ),
        1,
      );
      return;
    }
    this.phaseValue = "initializing";
    const payload = message.payload;
    // Phase 5B: adopt the authority epoch from the REQUIRED init payload.
    // Every command/read/interrupt/submitTurn frame is validated against it.
    this.authorityEpoch = payload.epoch;
    try {
      const port =
        payload.mode === "create"
          ? await this.factory.create({
              cwd: payload.cwd,
              ...(payload.model === undefined ? {} : { model: payload.model }),
              ...(payload.thinkingLevel === undefined ? {} : { thinkingLevel: payload.thinkingLevel }),
              ...(payload.thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned: payload.thinkingLevelPinned }),
              ...(payload.toolNames === undefined ? {} : { toolNames: [...payload.toolNames] }),
              ...(payload.name === undefined ? {} : { name: payload.name }),
            })
          : await this.factory.open({
              sessionId: payload.sessionId,
              cwd: payload.cwd,
              ...(payload.model === undefined ? {} : { model: payload.model }),
            });
      this.port = port;
      this.realSessionId = port.identity.sessionId;
      this.cwdValue = payload.cwd;
      this.projectRootValue = payload.projectRoot;
      this.unsubscribe = port.subscribe((event) => this.onRuntimeEvent(event));

      const snapshot = await port.getSnapshot();
      const protocolSnapshot = this.snapshotMapper.map(snapshot, {
        cwd: this.cwdValue,
        projectRoot: this.projectRootValue,
      });

      // Create path: the adapter returned the real session id → announce the
      // rekey before ready so the sessiond authority moves its record.
      if (payload.mode === "create" && this.realSessionId !== payload.sessionId) {
        await this.outbound.send({
          type: "worker.sessionDiscovered",
          payload: {
            sessionId: this.realSessionId,
            ...(port.identity.sessionFile === undefined ? {} : { sessionFile: port.identity.sessionFile }),
            cwd: this.cwdValue,
          },
        });
      }

      this.phaseValue = "ready";
      await this.outbound.send({
        type: "worker.ready",
        id: message.id,
        payload: {
          sessionId: this.realSessionId,
          workerStatus: "ready",
          features: [RUNTIME_READ_RPC_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE],
          // Phase 7A build fence: sessiond validates this exact build identity
          // before it advertises or dispatches anything on this Worker.
          build: WORKER_BUILD_IDENTITY,
          state: protocolSnapshot.state,
        },
      });
    } catch (error) {
      this.phaseValue = "failed";
      this.logger(`[controller] init failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.failFatal(toProtocolError(error, "external"), 1);
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private async handleCommand(message: Extract<SessiondToWorkerMessage, { type: "worker.command" }>): Promise<void> {
    const command = message.payload.command;
    const fail = (error: ProtocolError): Promise<void> =>
      this.sendCommandResult(message, { commandId: command.commandId, result: { ok: false, type: command.type, error } });

    if (this.phaseValue !== "ready" || this.port === null) {
      await fail(protocolError("worker_unavailable", "worker is not ready", true));
      return;
    }
    if (message.payload.sessionId !== this.realSessionId) {
      await fail(protocolError("conflict", "command session id does not match the active runtime"));
      return;
    }
    // Phase 5B: a command admitted under a stale authority epoch is rejected
    // fail-closed with ZERO port call (the sessiond rotates whole epochs at
    // capacity; a late pre-rollover frame must never execute post-rotation).
    if (message.payload.epoch !== this.authorityEpoch) {
      await fail(protocolError("epoch_changed", "command epoch does not match the current authority epoch", true));
      return;
    }
    if (this.shuttingDown) {
      await fail(protocolError("worker_unavailable", "worker is shutting down", true));
      return;
    }
    // Mutation command ids are remembered for the entire Worker lifetime to
    // preserve at-most-once execution. Read-only requests are deduplicated by
    // sessiond while in flight / in its bounded result cache, then may be
    // safely re-executed after eviction; retaining them here would recreate an
    // unbounded hidden quota in the Worker.
    if (!READ_ONLY_COMMAND_TYPES.has(command.type)) {
      if (this.seenCommandIds.has(command.commandId)) {
        await fail(protocolError("command_duplicate", `duplicate commandId: ${command.commandId}`));
        return;
      }
      this.seenCommandIds.add(command.commandId);
    }

    try {
      const core = mapProtocolCommandToCore(command);
      // Phase 2B: a legacy worker.command carrying a read-only command is
      // translated to port.read() — reads never travel through port.execute on
      // the new path (they are independent of the mutation command domain).
      const result = isReadOnlyCommandType(command.type)
        ? await this.port.read(mapProtocolReadToCoreRead({ type: command.type }))
        : await this.port.execute(core);
      await this.sendCommandResult(message, { commandId: command.commandId, result: mapCoreResultToProtocol(result) });
    } catch (error) {
      // port.execute / port.read never reject with backend errors, but a broken
      // port / unexpected throw still fails closed with a correlated result.
      await this.sendCommandResult(message, {
        commandId: command.commandId,
        result: { ok: false, type: command.type, error: toProtocolError(error) },
      });
    }
  }

  private async sendCommandResult(
    message: Extract<SessiondToWorkerMessage, { type: "worker.command" }>,
    result: CorrelatedRuntimeCommandResult,
  ): Promise<void> {
    // Prefer the runtime's real id; fall back to the inbound sessionId so a
    // pre-init / failed-init command still gets an exactly-once correlated
    // result (sessiond requires a non-empty sessionId on the wire frame).
    const sessionId = this.realSessionId ?? message.payload.sessionId;
    try {
      await this.outbound.send({
        type: "worker.commandResult",
        id: message.id,
        payload: { sessionId, result },
      });
    } catch (error) {
      this.logger(`[controller] commandResult write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Reads (Phase 2B independent read lane)
  // -------------------------------------------------------------------------

  /**
   * Phase 2B `worker.read`: execute a read through {@link AgentRuntimePort.read}.
   * Reads stay available while a long prompt is pending (they never share the
   * mutation command domain). There is deliberately NO read-id dedup ledger:
   * reads are pure queries that sessiond already bounds (one Worker-bound read
   * active per record) and dedups via its own dispatch-id correlation — the
   * worker echoes the unique per-dispatch `id` back in `worker.readResult`.
   */
  private async handleRead(message: Extract<SessiondToWorkerMessage, { type: "worker.read" }>): Promise<void> {
    if (this.phaseValue !== "ready" || this.port === null) {
      await this.sendReadResult(message, {
        result: { ok: false, type: message.payload.read.type, error: protocolError("worker_unavailable", "worker is not ready", true) },
      });
      return;
    }
    if (message.payload.sessionId !== this.realSessionId) {
      await this.sendReadResult(message, {
        result: { ok: false, type: message.payload.read.type, error: protocolError("conflict", "read session id does not match the active runtime") },
      });
      return;
    }
    // Phase 5B: stale-epoch read → epoch_changed with zero port call.
    if (message.payload.epoch !== this.authorityEpoch) {
      await this.sendReadResult(message, {
        result: { ok: false, type: message.payload.read.type, error: protocolError("epoch_changed", "read epoch does not match the current authority epoch", true) },
      });
      return;
    }
    if (this.shuttingDown) {
      await this.sendReadResult(message, {
        result: { ok: false, type: message.payload.read.type, error: protocolError("worker_unavailable", "worker is shutting down", true) },
      });
      return;
    }
    try {
      const result = await this.port.read(mapProtocolReadToCoreRead(message.payload.read));
      await this.sendReadResult(message, { result: mapCoreReadToProtocolRead(result) });
    } catch (error) {
      await this.sendReadResult(message, {
        result: { ok: false, type: message.payload.read.type, error: toProtocolError(error) },
      });
    }
  }

  private async sendReadResult(
    message: Extract<SessiondToWorkerMessage, { type: "worker.read" }>,
    outcome: { result: import("@fffattiger/pix-protocol").RuntimeReadOutcome },
  ): Promise<void> {
    const sessionId = this.realSessionId ?? message.payload.sessionId;
    try {
      await this.outbound.send({
        type: "worker.readResult",
        id: message.id,
        payload: {
          sessionId,
          epoch: message.payload.epoch,
          requestId: message.payload.requestId,
          result: outcome.result,
        },
      });
    } catch (error) {
      this.logger(`[controller] readResult write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Atomic prompt admission (Phase 3)
  // -------------------------------------------------------------------------

  private async handleSubmitTurn(message: Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }>): Promise<void> {
    const { sessionId, epoch, operationId, turnId, fingerprint, request } = message.payload;
    const key = `${epoch}:${operationId}`;
    const reject = (error: ProtocolError): SubmitTurnAdmission => ({ status: "rejected", delivery: "not_delivered", sessionId, operationId, epoch, error });
    if (this.phaseValue !== "ready" || this.port === null) {
      await this.sendSubmitTurnResult(message, reject(protocolError("worker_unavailable", "worker is not ready", true)));
      return;
    }
    if (sessionId !== this.realSessionId || request.sessionId !== sessionId) {
      await this.sendSubmitTurnResult(message, reject(protocolError("conflict", "submit session id does not match the active runtime")));
      return;
    }
    // Phase 5B: stale-epoch admission → epoch_changed rejection with zero port call.
    if (epoch !== this.authorityEpoch) {
      await this.sendSubmitTurnResult(message, reject(protocolError("epoch_changed", "submit epoch does not match the current authority epoch", true)));
      return;
    }
    if (this.shuttingDown) {
      await this.sendSubmitTurnResult(message, reject(protocolError("worker_unavailable", "worker is shutting down", true)));
      return;
    }
    const existing = this.turnLedger.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        await this.sendSubmitTurnResult(message, reject(protocolError("conflict", "operationId payload conflict")));
        return;
      }
      const admitted = await existing.admission;
      await this.sendSubmitTurnResult(message, admitted.result);
      if (existing.status) await this.sendTurnStatus(existing.status);
      return;
    }

    const activationOverrides = request.activationOverrides === undefined ? undefined : {
      ...(request.activationOverrides.model === undefined ? {} : { model: request.activationOverrides.model }),
      ...(request.activationOverrides.thinkingLevel === undefined ? {} : { thinkingLevel: request.activationOverrides.thinkingLevel }),
    };
    const call = this.port.submitTurn({
      prompt: request.prompt,
      ...(request.images === undefined ? {} : { images: request.images }),
      ...(activationOverrides === undefined ? {} : { activationOverrides }),
    });
    let ledger!: { fingerprint: string; result?: SubmitTurnAdmission; status?: TurnStatus; admission: Promise<{ result: SubmitTurnAdmission; completion: import("@fffattiger/pix-runtime-core").RuntimeTurnHandle["completion"] | undefined }> };
    const admission: Promise<{ result: SubmitTurnAdmission; completion: import("@fffattiger/pix-runtime-core").RuntimeTurnHandle["completion"] | undefined }> = call.then((handle) => {
      const snapshot = this.snapshotMapper.map(handle.admission.snapshot, { cwd: this.cwdValue, projectRoot: this.projectRootValue });
      const result: SubmitTurnAdmission = handle.admission.ok
        ? { status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId, snapshot, turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" } }
        : { status: "rejected", delivery: "not_delivered", sessionId, operationId, epoch, revision: 0, error: runtimeErrorToProtocolError(handle.admission.error), snapshot };
      return { result, completion: handle.admission.ok ? handle.completion : undefined };
    }).catch((error) => ({ result: reject(toProtocolError(error)), completion: undefined }));
    ledger = { fingerprint, admission };
    this.turnLedger.set(key, ledger);
    const admitted = await admission;
    ledger.result = admitted.result;
    await this.sendSubmitTurnResult(message, admitted.result);
    if (admitted.result.status !== "accepted" || admitted.completion === undefined) return;
    ledger.status = admitted.result.turnStatus;
    await this.sendTurnStatus(admitted.result.turnStatus);
    void this.monitorTurn(sessionId, epoch, operationId, turnId, admitted.completion, ledger);
  }

  private async monitorTurn(
    sessionId: string,
    epoch: string,
    operationId: string,
    turnId: string,
    completion: import("@fffattiger/pix-runtime-core").RuntimeTurnHandle["completion"],
    ledger: { result?: SubmitTurnAdmission; status?: TurnStatus },
  ): Promise<void> {
    try {
      const terminal = await completion;
      const snapshot = this.port ? this.snapshotMapper.map(terminal.snapshot, { cwd: this.cwdValue, projectRoot: this.projectRootValue }) : undefined;
      const status: TurnStatus = { sessionId, epoch, operationId, turnId, revision: 1, state: terminal.ok ? "completed" : "failed", ...(terminal.userEntryId === undefined ? {} : { userEntryId: terminal.userEntryId }), ...(snapshot?.state.leafId === undefined ? {} : { finalLeafId: snapshot.state.leafId }), ...(terminal.ok ? {} : { error: runtimeErrorToProtocolError(terminal.error) }) };
      ledger.status = status;
      await this.sendTurnStatus(status);
    } catch (error) {
      const status: TurnStatus = { sessionId, epoch, operationId, turnId, revision: 1, state: "failed", error: toProtocolError(error) };
      ledger.status = status;
      await this.sendTurnStatus(status);
    }
  }

  private async sendSubmitTurnResult(message: Extract<SessiondToWorkerMessage, { type: "worker.submitTurn" }>, result: SubmitTurnAdmission): Promise<void> {
    await this.outbound.send({
      type: "worker.submitTurnResult", id: message.id,
      payload: { sessionId: message.payload.sessionId, epoch: message.payload.epoch, operationId: message.payload.operationId, dispatchId: message.id, fingerprint: message.payload.fingerprint, result },
    }).catch((error) => this.logger(`[controller] submitTurnResult write failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async sendTurnStatus(status: TurnStatus): Promise<void> {
    await this.outbound.send({ type: "worker.turnStatus", payload: status }).catch((error) => this.logger(`[controller] turnStatus write failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  // -------------------------------------------------------------------------
  // Interrupts
  // -------------------------------------------------------------------------

  private async handleInterrupt(message: Extract<SessiondToWorkerMessage, { type: "worker.interrupt" }>): Promise<void> {
    const commandId = message.payload.commandId;
    const interrupt = message.payload.interrupt;
    const fail = (error: ProtocolError): Promise<void> =>
      this.sendInterruptResult(message, { commandId, result: { ok: false, type: interrupt.type, error } });

    if (this.phaseValue !== "ready" || this.port === null) {
      await fail(protocolError("worker_unavailable", "worker is not ready", true));
      return;
    }
    if (message.payload.sessionId !== this.realSessionId) {
      await fail(protocolError("conflict", "interrupt session id does not match the active runtime"));
      return;
    }
    // Phase 5B: a stale-epoch interrupt is rejected BEFORE the seen-dedup ledger
    // is touched (zero port call, zero dedup consumption).
    if (message.payload.epoch !== this.authorityEpoch) {
      await fail(protocolError("epoch_changed", "interrupt epoch does not match the current authority epoch", true));
      return;
    }
    if (this.shuttingDown) {
      await fail(protocolError("worker_unavailable", "worker is shutting down", true));
      return;
    }
    if (this.seenInterruptIds.has(commandId)) {
      await fail(protocolError("command_duplicate", `duplicate interrupt commandId: ${commandId}`));
      return;
    }
    this.seenInterruptIds.add(commandId);

    try {
      const result = await this.port.interrupt({ type: interrupt.type });
      const outcome: RuntimeInterruptResult = result.ok
        ? { ok: true, type: result.type }
        : { ok: false, type: result.type, error: runtimeErrorToProtocolError(result.error) };
      await this.sendInterruptResult(message, { commandId, result: outcome });
    } catch (error) {
      await this.sendInterruptResult(message, {
        commandId,
        result: { ok: false, type: interrupt.type, error: toProtocolError(error) },
      });
    }
  }

  private async sendInterruptResult(
    message: Extract<SessiondToWorkerMessage, { type: "worker.interrupt" }>,
    result: CorrelatedRuntimeInterruptResult,
  ): Promise<void> {
    const sessionId = this.realSessionId ?? message.payload.sessionId;
    try {
      await this.outbound.send({
        type: "worker.interruptResult",
        id: message.id,
        payload: { sessionId, result },
      });
    } catch (error) {
      this.logger(`[controller] interruptResult write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Epoch rollover (Phase 5B)
  // -------------------------------------------------------------------------

  /**
   * Safe idle whole-epoch rollover. The sessiond sends this ONLY after proving
   * strict quiescence; the worker independently re-proves it: exact session /
   * from-epoch, phase ready, ZERO active business handlers, then an
   * authoritative {@code port.getSnapshot()} satisfying the strict idle
   * predicate. On success it atomically clears the seen command/interrupt and
   * terminal turn ledgers and advances {@link authorityEpoch} — no Worker
   * restart, no runtime recreation. A non-idle / busy worker returns
   * {@code session_busy} retryable and clears NOTHING.
   */
  private async handleRotateEpoch(message: Extract<SessiondToWorkerMessage, { type: "worker.rotateEpoch" }>): Promise<void> {
    const { sessionId, fromEpoch, toEpoch } = message.payload;
    const write = (payload: { ok: true } | { ok: false; error: ProtocolError }): Promise<void> =>
      this.outbound.send({ type: "worker.rotateEpochResult", id: message.id, payload: { sessionId, fromEpoch, toEpoch, ...payload } }).catch((error) => {
        this.logger(`[controller] rotateEpochResult write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (this.phaseValue !== "ready" || this.port === null) {
      await write({ ok: false, error: protocolError("worker_unavailable", "worker is not ready", true) });
      return;
    }
    if (sessionId !== this.realSessionId) {
      await write({ ok: false, error: protocolError("conflict", "rotate session id does not match the active runtime") });
      return;
    }
    if (fromEpoch !== this.authorityEpoch) {
      await write({ ok: false, error: protocolError("epoch_changed", "rotate from epoch does not match the current authority epoch", true) });
      return;
    }
    if (this.shuttingDown) {
      await write({ ok: false, error: protocolError("worker_unavailable", "worker is shutting down", true) });
      return;
    }
    if (this.activeBusinessHandlers !== 0) {
      await write({ ok: false, error: protocolError("session_busy", "worker has active business handlers", true) });
      return;
    }
    let snapshot: Awaited<ReturnType<AgentRuntimePort["getSnapshot"]>>;
    try {
      snapshot = await this.port.getSnapshot();
    } catch (error) {
      this.logger(`[controller] rotate snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      await write({ ok: false, error: toProtocolError(error, "external") });
      return;
    }
    if (!this.isIdleForRotate(snapshot)) {
      await write({ ok: false, error: protocolError("session_busy", "session is not idle", true) });
      return;
    }
    // An accepted turn whose terminal monitor has not completed is not
    // quiescent even if a stale snapshot momentarily looks idle. Rejected
    // admissions and terminal completed/failed entries are safe to clear.
    for (const entry of this.turnLedger.values()) {
      if (entry.result?.status === "accepted" && entry.status?.state !== "completed" && entry.status?.state !== "failed") {
        await write({ ok: false, error: protocolError("session_busy", "worker has a non-terminal turn ledger", true) });
        return;
      }
    }
    // Exact idle success: atomically clear whole per-epoch ledgers + advance.
    this.seenCommandIds.clear();
    this.seenInterruptIds.clear();
    this.turnLedger.clear();
    this.authorityEpoch = toEpoch;
    await write({ ok: true });
  }

  /**
   * Strict idle predicate shared by the rotate path: no streaming / prompt /
   * bash / compact, streaming inactive, no pending messages, no queued
   * steering/follow-up, no pending extension UI.
   */
  private isIdleForRotate(snapshot: Awaited<ReturnType<AgentRuntimePort["getSnapshot"]>>): boolean {
    const state = snapshot.state;
    if (state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting) return false;
    if (snapshot.streaming?.active === true) return false;
    if ((state.pendingMessageCount ?? 0) !== 0) return false;
    const queued = state.queuedMessages;
    if (queued !== undefined && (queued.steering.length > 0 || queued.followUp.length > 0)) return false;
    if (state.pendingExtensionUi !== undefined && state.pendingExtensionUi.length > 0) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  private async handleSnapshot(message: Extract<SessiondToWorkerMessage, { type: "worker.getSnapshot" }>): Promise<void> {
    if (this.phaseValue !== "ready" || this.port === null) {
      // No error result shape exists for a snapshot request; fail closed loudly.
      await this.failFatal(protocolError("worker_unavailable", "worker is not ready", true), 1);
      return;
    }
    if (message.payload.sessionId !== this.realSessionId) {
      await this.failFatal(protocolError("conflict", "snapshot session id does not match the active runtime"), 1);
      return;
    }
    try {
      const snapshot = await this.port.getSnapshot();
      const protocolSnapshot = this.snapshotMapper.map(snapshot, {
        cwd: this.cwdValue,
        projectRoot: this.projectRootValue,
      });
      await this.outbound.send({
        type: "worker.snapshot",
        id: message.id,
        payload: { sessionId: this.realSessionId, snapshot: protocolSnapshot },
      });
    } catch (error) {
      this.logger(`[controller] snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.failFatal(toProtocolError(error, "external"), 1);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onRuntimeEvent(event: RuntimeEvent): void {
    let mapped: RuntimeEventData[];
    try {
      mapped = this.runtimeMapper.mapEvent(event);
    } catch (error) {
      this.logger(`[controller] event mapping failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const data of mapped) {
      void this.outbound.send({ type: "worker.event", payload: { sessionId: data.sessionId, event: data } }).catch((error) => {
        this.logger(`[controller] event write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.phaseValue = "stopping";
    this.logger(`[controller] shutdown (${reason})`);

    const port = this.port;
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (port === null) {
      this.phaseValue = "stopped";
      this.requestExit(0);
      return;
    }

    // Race the runtime close against a hard timeout so a stuck port never
    // hangs the process. The first to settle wins; a timeout fails the exit.
    let timedOut = false;
    try {
      await Promise.race([
        port.close(reason === "shutdown" ? "shutdown" : "user"),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, this.shutdownTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.logger(`[controller] runtime close failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.port = null;
    }
    this.phaseValue = "stopped";
    if (timedOut) {
      this.logger("[controller] shutdown timed out; failing exit");
      this.requestExit(1);
      return;
    }
    this.requestExit(0);
  }

  private async failFatal(error: ProtocolError, exitCode: number): Promise<void> {
    this.logger(`[controller] fatal: ${error.code} ${error.message}`);
    try {
      await this.outbound.send({
        type: "worker.fatal",
        payload: {
          ...(this.realSessionId === null ? {} : { sessionId: this.realSessionId }),
          error,
        },
      });
    } catch (writeError) {
      this.logger(`[controller] fatal write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
    }
    this.requestExit(exitCode);
  }
}
