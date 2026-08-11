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
import type {
  AgentRuntimeFactory,
  AgentRuntimePort,
  RuntimeEvent,
} from "@fffattiger/pix-runtime-core";
import type {
  CorrelatedRuntimeCommandResult,
  CorrelatedRuntimeInterruptResult,
  ProtocolError,
  RuntimeCommand,
  RuntimeEventData,
  RuntimeInterrupt,
  RuntimeInterruptResult,
  SessiondToWorkerMessage,
  WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import { mapCoreResultToProtocol, mapProtocolCommandToCore } from "../mapper/command-mapper.js";
import { protocolError, runtimeErrorToProtocolError, toProtocolError } from "../mapper/protocol-error.js";
import { SnapshotMapper } from "../mapper/snapshot-mapper.js";
import { StatefulRuntimeMapper } from "../mapper/runtime-mapper.js";

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
  private shuttingDown = false;

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
        await this.handleCommand(message);
        return;
      case "worker.interrupt":
        await this.handleInterrupt(message);
        return;
      case "worker.getSnapshot":
        await this.handleSnapshot(message);
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
    this.phaseValue = "initializing";
    const payload = message.payload;
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
    if (this.shuttingDown) {
      await fail(protocolError("worker_unavailable", "worker is shutting down", true));
      return;
    }
    if (this.seenCommandIds.has(command.commandId)) {
      await fail(protocolError("command_duplicate", `duplicate commandId: ${command.commandId}`));
      return;
    }
    this.seenCommandIds.add(command.commandId);

    try {
      const core = mapProtocolCommandToCore(command);
      const result = await this.port.execute(core);
      await this.sendCommandResult(message, { commandId: command.commandId, result: mapCoreResultToProtocol(result) });
    } catch (error) {
      // port.execute never rejects with backend errors, but a broken port /
      // unexpected throw still fails closed with a correlated result.
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
