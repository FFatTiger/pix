/**
 * RuntimeConnection — the single stable client runtime transport owner.
 *
 * This is the ONLY production implementation of RuntimeSocketHandler and the
 * ONLY production constructor/owner of RuntimeSocket. It owns connection-global
 * transport state, negotiated features, running-session authority, identity-only
 * create wire exchange and all outbound-attempt correlation. Semantic create
 * admission/registration and attachment ownership live in SessionControllerRegistry.
 */
import {
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_RUNNING_WATCH_FEATURE,
  type CorrelatedRuntimeCommandResult,
  type ProtocolError,
  type ProtocolHandshakeResponse,
  type RuntimeActivateResult,
  type RuntimeCreateParams,
  type RuntimeCreateResult,
  type RuntimeEventData,
  type RuntimeInterruptType,
  type RuntimeListRunningResult,
  type RuntimeCommand,
  type RuntimeReadType,
  type RuntimeSnapshot,
  type SessionStats,
  type SubmitTurnAdmission,
  type WsClientMessage,
  type WsEventMessage,
  type WsHostMessage,
  type WsInterruptResultMessage,
  type WsReadResultMessage,
  type WsResponseMessage,
  type WsSnapshotMessage,
  type WsSubmitTurnResultMessage,
  type WsTurnStatusMessage,
} from "@fffattiger/pix-protocol";
import { createDefaultIdFactory, type IdFactory } from "./correlation.js";
import { canSend, type ConnectionState } from "./lifecycle.js";
import {
  RuntimeSocket,
  type NegotiatedHost,
  type RuntimeSocketDeps,
  type RuntimeSocketHandler,
} from "./socket.js";

const DEFAULT_MAX_OUTBOUND_ATTEMPTS = 256;
const LIVE_STATS_STAGE_TIMEOUT_MS = 5_000;
/** Bounded explicit-activation wait (same budget family as live-stat reads). */
const ACTIVATE_STAGE_TIMEOUT_MS = 5_000;

export type RuntimeTransportState = Exclude<ConnectionState, "attaching" | "attached">;

export interface RuntimeConnectionView {
  readonly state: RuntimeTransportState;
  readonly generation: number;
  readonly host: NegotiatedHost | null;
  readonly acceptedFeatures: readonly string[];
  readonly error: ProtocolError | null;
  readonly fatal: boolean;
  readonly runningSessionIds: readonly string[];
  readonly liveSessionIds: readonly string[];
  readonly liveSessionStateKnown: boolean;
}

export type RuntimeAttemptDisconnectPolicy = "reject_on_disconnect" | "logical_retry";

export type RuntimeAttemptExpectation =
  | { readonly kind: "create"; readonly cwd: string; readonly projectRoot: string }
  | { readonly kind: "attach"; readonly sessionId: string }
  | { readonly kind: "activate"; readonly sessionId: string }
  | { readonly kind: "command"; readonly sessionId: string; readonly commandId: string; readonly resultType: CorrelatedRuntimeCommandResult["result"]["type"] }
  | { readonly kind: "getSnapshot"; readonly sessionId: string }
  | { readonly kind: "detach"; readonly sessionId: string }
  | { readonly kind: "stop"; readonly sessionId: string }
  | { readonly kind: "listRunning" }
  | { readonly kind: "interrupt"; readonly sessionId: string; readonly commandId: string; readonly interruptType: RuntimeInterruptType }
  | { readonly kind: "read"; readonly sessionId: string; readonly epoch: string; readonly requestId: string; readonly readType: RuntimeReadType }
  | { readonly kind: "submit_turn"; readonly sessionId: string; readonly operationId: string; readonly expectedEpoch?: string };

export type RuntimeAttemptFrame =
  | WsResponseMessage
  | WsSnapshotMessage
  | WsInterruptResultMessage
  | WsReadResultMessage
  | WsSubmitTurnResultMessage;

export interface RuntimeAttemptSpec {
  /** Read RPC uses one browser requestId as both envelope and logical id. */
  readonly envelopeId?: string;
  readonly buildMessage: (envelopeId: string) => WsClientMessage;
  readonly expectation: RuntimeAttemptExpectation;
  readonly disconnectPolicy: RuntimeAttemptDisconnectPolicy;
  readonly onFrame: (frame: RuntimeAttemptFrame) => void;
  readonly onSendFailure: (error: unknown) => void;
  readonly onDisconnect: (error: ProtocolError) => void;
}

export interface RuntimeAttemptHandle {
  readonly envelopeId: string;
  readonly generation: number;
  cancel(): void;
}

export interface RuntimeControllerPort {
  onTransportState(state: RuntimeTransportState): void;
  onTransportFatal(error: ProtocolError): void;
  onSnapshot(message: WsSnapshotMessage, generation: number): void;
  onEvent(message: WsEventMessage, generation: number): void;
  onTurnStatus(message: WsTurnStatusMessage, generation: number): void;
  onUnavailable(message: Extract<WsHostMessage, { type: "runtime_unavailable" }>, generation: number): void;
}

export interface RuntimeAttachmentRouteHandle {
  readonly sessionId: string;
  /** Semantic lease generation supplied by SessionControllerRegistry. */
  readonly leaseGeneration: number;
  readonly generation: number;
  isCurrent(): boolean;
  clear(): void;
}

export interface RuntimeControllerBinding {
  readonly sessionId: string;
  sendAttempt(spec: RuntimeAttemptSpec): RuntimeAttemptHandle | null;
  unregisterTurn(operationId: string): void;
  acceptLegacyRunningEvent(event: Extract<RuntimeEventData, { type: "running_sessions_changed" }>): void;
  isCurrent(): boolean;
  unbind(): void;
}

export interface RuntimeConnectionOptions {
  readonly id?: IdFactory;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly maxOutboundAttempts?: number;
}

interface AttemptRecord {
  readonly token: symbol;
  readonly envelopeId: string;
  readonly generation: number;
  readonly bindingToken: symbol;
  readonly expectation: RuntimeAttemptExpectation;
  readonly disconnectPolicy: RuntimeAttemptDisconnectPolicy;
  /** Attach attempts are valid only for the route token current at send time. */
  readonly attachmentRouteToken?: symbol;
  readonly onFrame: (frame: RuntimeAttemptFrame) => void;
  readonly onSendFailure: (error: unknown) => void;
  readonly onDisconnect: (error: ProtocolError) => void;
}

interface BindingRecord {
  readonly token: symbol;
  readonly sessionId: string;
  readonly port: RuntimeControllerPort;
}

interface AttachmentRouteRecord {
  readonly token: symbol;
  readonly bindingToken: symbol;
  readonly sessionId: string;
  readonly leaseGeneration: number;
  generation: number;
}

interface CreatePending {
  readonly createRequestId: string;
  readonly payload: RuntimeCreateParams;
  readonly resolve: (value: RuntimeCreateResult) => void;
  readonly reject: (error: unknown) => void;
  attempt: RuntimeAttemptHandle | null;
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface TimedWaiter extends Waiter {
  readonly handle: unknown;
}

function busyAttemptError(): ProtocolError {
  return {
    code: "session_busy",
    message: "runtime outbound attempt registry is full",
    retryable: true,
  };
}

function connectionLostError(): ProtocolError {
  return { code: "unavailable", message: "runtime connection lost", retryable: true };
}

function responseSessionMatches(message: WsResponseMessage, expected: string): boolean {
  return message.payload.sessionId === undefined || message.payload.sessionId === expected;
}

/** Collision-safe exact composite identity ("ab","c" !== "a","bc"). */
function turnOwnerKey(sessionId: string, operationId: string): string {
  return `${sessionId.length}:${sessionId}${operationId.length}:${operationId}`;
}

function expectationSessionId(expectation: RuntimeAttemptExpectation): string | null {
  switch (expectation.kind) {
    case "attach":
    case "activate":
    case "command":
    case "getSnapshot":
    case "detach":
    case "stop":
    case "interrupt":
    case "read":
    case "submit_turn":
      return expectation.sessionId;
    case "create":
    case "listRunning":
      return null;
  }
}

/** Strict response/result matching. A mismatch never consumes the attempt. */
function matchesAttempt(frame: RuntimeAttemptFrame, expectation: RuntimeAttemptExpectation): boolean {
  switch (expectation.kind) {
    case "create":
      if (frame.type !== "response") return false;
      if (!frame.payload.ok) return true;
      return (frame.payload.result as RuntimeCreateResult).cwd === expectation.cwd
        && (frame.payload.result as RuntimeCreateResult).projectRoot === expectation.projectRoot;
    case "attach":
      if (frame.type === "snapshot") return frame.payload.sessionId === expectation.sessionId;
      return frame.type === "response" && responseSessionMatches(frame, expectation.sessionId);
    case "activate": {
      // Strict result identity: only a response for the EXACT requested session
      // may consume the attempt. A foreign session's activate/result frame,
      // a wrong-kind success result, or a missing sessionId never consumes it.
      if (frame.type !== "response") return false;
      if (!frame.payload.ok) return responseSessionMatches(frame, expectation.sessionId);
      if (frame.payload.sessionId !== undefined && frame.payload.sessionId !== expectation.sessionId) return false;
      const result = frame.payload.result as { sessionId?: unknown; epoch?: unknown; cwd?: unknown; projectRoot?: unknown; workerStatus?: unknown };
      return result.sessionId === expectation.sessionId
        && typeof result.epoch === "string"
        && typeof result.cwd === "string"
        && typeof result.projectRoot === "string"
        && typeof result.workerStatus === "string";
    }
    case "command": {
      if (frame.type !== "response" || !responseSessionMatches(frame, expectation.sessionId)) return false;
      if (!frame.payload.ok) return true;
      const result = frame.payload.result as CorrelatedRuntimeCommandResult;
      return result.commandId === expectation.commandId && result.result.type === expectation.resultType;
    }
    case "getSnapshot":
      return frame.type === "response"
        && responseSessionMatches(frame, expectation.sessionId)
        && (!frame.payload.ok || (frame.payload.result as RuntimeSnapshot).sessionId === expectation.sessionId);
    case "detach":
      return frame.type === "response"
        && responseSessionMatches(frame, expectation.sessionId)
        && (!frame.payload.ok || ((frame.payload.result as { sessionId?: string; detached?: boolean }).sessionId === expectation.sessionId
          && (frame.payload.result as { detached?: boolean }).detached === true));
    case "stop":
      return frame.type === "response"
        && responseSessionMatches(frame, expectation.sessionId)
        && (!frame.payload.ok || ((frame.payload.result as { sessionId?: string; stopped?: boolean }).sessionId === expectation.sessionId
          && (frame.payload.result as { stopped?: boolean }).stopped === true));
    case "listRunning":
      return frame.type === "response"
        && (!frame.payload.ok || Array.isArray((frame.payload.result as RuntimeListRunningResult).sessions));
    case "interrupt":
      return frame.type === "interrupt_result"
        && frame.payload.sessionId === expectation.sessionId
        && frame.payload.commandId === expectation.commandId
        && frame.payload.interruptType === expectation.interruptType
        && frame.payload.result.type === expectation.interruptType;
    case "read":
      return frame.type === "read_result"
        && frame.id === expectation.requestId
        && frame.payload.sessionId === expectation.sessionId
        && frame.payload.epoch === expectation.epoch
        && frame.payload.requestId === expectation.requestId
        && frame.payload.result.type === expectation.readType;
    case "submit_turn": {
      if (frame.type !== "submit_turn_result") return false;
      const admission: SubmitTurnAdmission = frame.payload;
      if (admission.sessionId !== expectation.sessionId || admission.operationId !== expectation.operationId) return false;
      if ((admission.status === "accepted" || admission.status === "duplicate")
        && expectation.expectedEpoch !== undefined
        && admission.epoch !== expectation.expectedEpoch) return false;
      return true;
    }
  }
}

export class RuntimeConnection implements RuntimeSocketHandler {
  private readonly socket: RuntimeSocket;
  private readonly id: IdFactory;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly maxOutboundAttempts: number;
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly bindingsBySessionId = new Map<string, BindingRecord>();
  private readonly turnOwners = new Map<string, symbol>();
  private attachmentRoute: AttachmentRouteRecord | null = null;
  private pendingCreate: CreatePending | null = null;
  private readyWaiters: Waiter[] = [];
  private sendableWaiters: TimedWaiter[] = [];
  private readonly listeners = new Set<() => void>();
  private acceptedFeatureSet: ReadonlySet<string> = new Set();
  private host: NegotiatedHost | null = null;
  private error: ProtocolError | null = null;
  private fatal = false;
  private runningSessionIds: string[] = [];
  private liveSessionIds: string[] = [];
  private liveSessionStateKnown = false;
  private runningProjectionRevision = 0;
  private runningRefreshGeneration = 0;
  private runningAuthorityMode: "pending" | "watch" | "legacy" = "pending";
  private runningWatchGeneration = -1;
  private runningWatchRevision = -1;
  private view: RuntimeConnectionView;

  constructor(deps: RuntimeSocketDeps, options: RuntimeConnectionOptions = {}) {
    this.id = options.id ?? createDefaultIdFactory(deps.random);
    this.setTimeoutFn = options.setTimeout ?? deps.setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? deps.clearTimeout;
    this.maxOutboundAttempts = options.maxOutboundAttempts ?? DEFAULT_MAX_OUTBOUND_ATTEMPTS;
    this.socket = new RuntimeSocket({ ...deps, id: this.id }, this);
    this.view = this.computeView();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): RuntimeConnectionView => this.view;

  get currentGeneration(): number { return this.socket.currentGeneration; }
  get connectionState(): ConnectionState { return this.socket.connectionState; }
  get hasPendingCreate(): boolean { return this.pendingCreate !== null; }

  connect(): void { this.socket.connect(); }

  dispose(): void {
    const error: ProtocolError = { code: "unavailable", message: "runtime disposed", retryable: false };
    this.pendingCreate?.reject(error);
    this.pendingCreate = null;
    this.rejectReadyWaiters(error);
    this.rejectSendableWaiters(error);
    this.removeAllAttempts(error, true);
    for (const binding of [...this.bindingsBySessionId.values()]) this.unbindExact(binding);
    this.socket.dispose();
  }

  registerController(sessionId: string, port: RuntimeControllerPort): RuntimeControllerBinding {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("RuntimeConnection controller sessionId must be non-empty");
    if (this.bindingsBySessionId.has(sessionId)) throw new Error(`RuntimeConnection already has a controller for session ${sessionId}`);
    const record: BindingRecord = { token: Symbol("runtime-controller-binding"), sessionId, port };
    this.bindingsBySessionId.set(sessionId, record);
    const isCurrent = (): boolean => this.bindingsBySessionId.get(sessionId)?.token === record.token;
    return {
      sessionId,
      sendAttempt: (spec) => isCurrent() ? this.registerAndSend(record, spec) : null,
      unregisterTurn: (operationId) => {
        if (!isCurrent()) return;
        const key = turnOwnerKey(sessionId, operationId);
        if (this.turnOwners.get(key) === record.token) this.turnOwners.delete(key);
      },
      acceptLegacyRunningEvent: (event) => {
        if (!isCurrent() || event.sessionId !== sessionId || this.runningAuthorityMode !== "legacy") return;
        this.applyRunningState(event.sessionIds, event.busySessionIds);
      },
      isCurrent,
      unbind: () => {
        if (isCurrent()) this.unbindExact(record);
      },
    };
  }

  replaceAttachmentRoute(sessionId: string, leaseGeneration = 0): RuntimeAttachmentRouteHandle {
    const record = this.bindingsBySessionId.get(sessionId);
    if (record === undefined) throw new Error("cannot route attachment to an unbound controller");
    const route: AttachmentRouteRecord = {
      token: Symbol("runtime-attachment-route"),
      bindingToken: record.token,
      sessionId: record.sessionId,
      leaseGeneration,
      generation: this.currentGeneration,
    };
    this.attachmentRoute = route;
    const isCurrent = (): boolean => this.attachmentRoute?.token === route.token
      && this.bindingsBySessionId.get(route.sessionId)?.token === route.bindingToken;
    return {
      sessionId: route.sessionId,
      leaseGeneration: route.leaseGeneration,
      generation: route.generation,
      isCurrent,
      clear: () => { if (isCurrent()) this.attachmentRoute = null; },
    };
  }

  hasFeature(feature: string): boolean {
    return this.acceptedFeatureSet.has(feature);
  }

  whenReady(): Promise<void> {
    if (this.connectionState === "ready") return Promise.resolve();
    if (this.fatal || this.connectionState === "stopped") {
      return Promise.reject(this.error ?? { code: "unavailable", message: "runtime not ready", retryable: false });
    }
    return new Promise<void>((resolve, reject) => { this.readyWaiters.push({ resolve, reject }); });
  }

  whenSendable(timeoutMs: number): Promise<void> {
    if (canSend(this.connectionState)) return Promise.resolve();
    if (this.fatal || this.connectionState === "stopped") {
      return Promise.reject(this.error ?? { code: "unavailable", message: "runtime not sendable", retryable: false });
    }
    return new Promise<void>((resolve, reject) => {
      const handle = this.setTimeoutFn(() => {
        this.sendableWaiters = this.sendableWaiters.filter((waiter) => waiter.handle !== handle);
        reject({ code: "timeout", message: "runtime not sendable in time", retryable: true } satisfies ProtocolError);
      }, timeoutMs);
      this.sendableWaiters.push({ resolve, reject, handle });
    });
  }

  /** Browser identity-only create. No attach/detach/projection mutation. */
  createSession(params: { cwd: string; projectRoot: string }): Promise<RuntimeCreateResult> {
    if (this.pendingCreate !== null) {
      return Promise.reject({ code: "session_busy", message: "a session create is already in progress", retryable: false } satisfies ProtocolError);
    }
    if (this.connectionState === "idle") this.connect();
    return this.whenReady().then(() => new Promise<RuntimeCreateResult>((resolve, reject) => {
      if (this.pendingCreate !== null) {
        reject({ code: "session_busy", message: "a session create is already in progress", retryable: false } satisfies ProtocolError);
        return;
      }
      const payload: RuntimeCreateParams = {
        createRequestId: this.id(),
        cwd: params.cwd,
        projectRoot: params.projectRoot,
      };
      const pending: CreatePending = { createRequestId: payload.createRequestId, payload, resolve, reject, attempt: null };
      this.pendingCreate = pending;
      this.sendCreateAttempt(pending);
    }));
  }

  /**
   * Explicit bounded activation request (negotiated `runtime.explicit-activate.v1`).
   *
   * Browser→Host only: the Host independently re-verifies gate/origin, the
   * negotiated feature and the exact session's workspace authorization before
   * forwarding `runtime.activate` — this call never bypasses that seam. Strict
   * correlated identity: only a `response` carrying a RuntimeActivateResult for
   * the EXACT requested session settles the attempt; foreign frames never
   * consume it. Fail-closed semantics:
   *  - feature not negotiated → `unsupported_capability` (never a legacy
   *    activating-attach fallback, never an empty success);
   *  - `reject_on_disconnect`: a disconnect settles the attempt — activation is
   *    NEVER auto-resent on reconnect (a later explicit action re-decides);
   *  - bounded wait: the attempt settles with a fixed `timeout` error.
   *
   * The result is returned ONLY to the explicit caller for the explicit target;
   * this method writes no projection, cursor or cross-session state.
   */
  activateSession(sessionId: string): Promise<RuntimeActivateResult> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return Promise.reject({ code: "invalid_input", message: "no session selected", retryable: false } satisfies ProtocolError);
    }
    if (this.connectionState === "idle") this.connect();
    return this.whenSendable(ACTIVATE_STAGE_TIMEOUT_MS).then(() => {
      if (!this.hasFeature(RUNTIME_EXPLICIT_ACTIVATE_FEATURE)) {
        throw { code: "unsupported_capability", message: "explicit runtime activation is unavailable", retryable: false } satisfies ProtocolError;
      }
      return new Promise<RuntimeActivateResult>((resolve, reject) => {
        let settled = false;
        let handle: RuntimeAttemptHandle | null = null;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          this.clearTimeoutFn(timer);
          callback();
        };
        const timer = this.setTimeoutFn(() => {
          handle?.cancel();
          finish(() => reject({ code: "timeout", message: "runtime activation timed out", retryable: true } satisfies ProtocolError));
        }, ACTIVATE_STAGE_TIMEOUT_MS);
        handle = this.registerGlobalAttempt({
          buildMessage: (id) => ({ type: "activate", id, payload: { sessionId } }),
          expectation: { kind: "activate", sessionId },
          disconnectPolicy: "reject_on_disconnect",
          onFrame: (frame) => {
            if (frame.type !== "response") return;
            const payload = frame.payload;
            if (!payload.ok) { finish(() => reject(payload.error)); return; }
            const result = payload.result as RuntimeActivateResult;
            // Defense-in-depth on top of the strict matcher: never resolve a
            // cross-session activation result.
            if (result.sessionId !== sessionId) {
              finish(() => reject({ code: "internal", message: "activation response identity mismatch", retryable: false } satisfies ProtocolError));
              return;
            }
            finish(() => resolve(result));
          },
          onSendFailure: (cause) => finish(() => reject(cause)),
          onDisconnect: (cause) => finish(() => reject(cause)),
        });
      });
    });
  }

  /**
   * Read fresh stats from an ALREADY-live session without taking the Browser's
   * single attachment lease. The listRunning result supplies the exact current
   * epoch; the following independent read RPC carries that fence. A stopped,
   * rekeyed or rolled session fails closed — this method never activates a
   * Worker, guesses an epoch, polls, or retries across an epoch boundary.
   */
  getLiveSessionStats(sessionId: string): Promise<SessionStats> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return Promise.reject({ code: "invalid_input", message: "no session selected", retryable: false } satisfies ProtocolError);
    }
    if (this.connectionState === "idle") this.connect();
    return this.whenSendable(LIVE_STATS_STAGE_TIMEOUT_MS).then(() => {
      if (!this.hasFeature(RUNTIME_READ_RPC_FEATURE)) {
        throw { code: "unsupported_capability", message: "independent runtime reads are unavailable", retryable: false } satisfies ProtocolError;
      }
      return this.lookupLiveSession(sessionId);
    }).then((item) => new Promise<SessionStats>((resolve, reject) => {
      let settled = false;
      const requestId = this.id();
      let handle: RuntimeAttemptHandle | null = null;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        callback();
      };
      const timer = this.setTimeoutFn(() => {
        handle?.cancel();
        finish(() => reject({ code: "timeout", message: "live runtime stats read timed out", retryable: true } satisfies ProtocolError));
      }, LIVE_STATS_STAGE_TIMEOUT_MS);
      handle = this.registerGlobalAttempt({
        envelopeId: requestId,
        buildMessage: (id) => ({ type: "read", id, payload: { sessionId, epoch: item.epoch, read: { type: "get_session_stats" } } }),
        expectation: { kind: "read", sessionId, epoch: item.epoch, requestId, readType: "get_session_stats" },
        disconnectPolicy: "reject_on_disconnect",
        onFrame: (frame) => {
          if (frame.type !== "read_result") return;
          const outcome = frame.payload.result;
          if (!outcome.ok) { finish(() => reject(outcome.error)); return; }
          if (outcome.type !== "get_session_stats") {
            finish(() => reject({ code: "internal", message: "unexpected runtime read result", retryable: false } satisfies ProtocolError));
            return;
          }
          finish(() => resolve(outcome.stats));
        },
        onSendFailure: (cause) => finish(() => reject(cause)),
        onDisconnect: (cause) => finish(() => reject(cause)),
      });
    }));
  }

  /**
   * Send one typed command to an ALREADY-live session without taking the
   * Browser attachment lease. `listRunning` supplies the exact current epoch;
   * sessiond owns the final live-record check and never activates a missing
   * Worker for runtime.command. A stop/rekey between the two frames therefore
   * fails closed instead of creating or selecting another runtime.
   */
  sendLiveSessionCommand(sessionId: string, command: RuntimeCommand): Promise<CorrelatedRuntimeCommandResult> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return Promise.reject({ code: "invalid_input", message: "no session selected", retryable: false } satisfies ProtocolError);
    }
    if (this.connectionState === "idle") this.connect();
    return this.whenSendable(LIVE_STATS_STAGE_TIMEOUT_MS)
      .then(() => this.lookupLiveSession(sessionId))
      .then((item) => new Promise<CorrelatedRuntimeCommandResult>((resolve, reject) => {
        this.registerGlobalAttempt({
          buildMessage: (id) => ({ type: "command", id, payload: { sessionId, epoch: item.epoch, command } }),
          expectation: { kind: "command", sessionId, commandId: command.commandId, resultType: command.type },
          disconnectPolicy: "reject_on_disconnect",
          onFrame: (frame) => {
            if (frame.type !== "response") return;
            if (frame.payload.ok) resolve(frame.payload.result as CorrelatedRuntimeCommandResult);
            else reject(frame.payload.error);
          },
          onSendFailure: reject,
          onDisconnect: reject,
        });
      }));
  }

  refreshRunningSessions(): Promise<readonly string[]> {
    if (this.connectionState === "idle") this.connect();
    const requestGeneration = ++this.runningRefreshGeneration;
    const revisionAtRequest = this.runningProjectionRevision;
    return this.whenReady().then(() => new Promise<readonly string[]>((resolve, reject) => {
      let handle: RuntimeAttemptHandle | null = null;
      handle = this.registerGlobalAttempt({
        buildMessage: (id) => ({ type: "listRunning", id, payload: {} }),
        expectation: { kind: "listRunning" },
        disconnectPolicy: "reject_on_disconnect",
        onFrame: (frame) => {
          if (frame.type !== "response") return;
          if (!frame.payload.ok) {
            this.failRunningRefresh(requestGeneration, revisionAtRequest);
            reject(frame.payload.error);
            return;
          }
          if (requestGeneration !== this.runningRefreshGeneration || revisionAtRequest !== this.runningProjectionRevision) {
            resolve([...this.runningSessionIds]);
            return;
          }
          const running = frame.payload.result as RuntimeListRunningResult;
          this.applyRunningState(
            running.sessions.map((item) => item.sessionId),
            running.sessions.filter((item) => item.workerStatus === "busy").map((item) => item.sessionId),
          );
          resolve([...this.runningSessionIds]);
        },
        onSendFailure: (cause) => { this.failRunningRefresh(requestGeneration, revisionAtRequest); reject(cause); },
        onDisconnect: (cause) => { this.failRunningRefresh(requestGeneration, revisionAtRequest); reject(cause); },
      });
      void handle;
    }));
  }

  // RuntimeSocketHandler -------------------------------------------------

  onConnectionState(state: ConnectionState): void {
    if (this.attachmentRoute !== null) this.attachmentRoute.generation = this.currentGeneration;
    if (state === "ready") {
      this.resolveReadyWaiters();
      this.resolveSendableWaiters();
      if (this.pendingCreate !== null && this.pendingCreate.attempt === null) this.sendCreateAttempt(this.pendingCreate);
    } else if (state === "unavailable" || state === "reconnecting") {
      this.resetRunningAuthority();
      this.removeGenerationAttempts(this.currentGeneration, connectionLostError());
    } else if (state === "stopped") {
      this.resetRunningAuthority();
      const error = this.error ?? { code: "unavailable", message: "runtime connection stopped", retryable: false } satisfies ProtocolError;
      this.error = error;
      this.fatal = true;
      this.rejectReadyWaiters(error);
      this.rejectSendableWaiters(error);
      this.pendingCreate?.reject(error);
      this.pendingCreate = null;
      this.removeAllAttempts(error, true);
      for (const binding of this.bindingsBySessionId.values()) binding.port.onTransportFatal(error);
    }
    if (canSend(state)) this.resolveSendableWaiters();
    this.publish();
  }

  onHandshakeAck(host: NegotiatedHost, response: ProtocolHandshakeResponse): void {
    this.host = host;
    this.error = null;
    this.fatal = false;
    this.acceptedFeatureSet = new Set(response.acceptedFeatures ?? []);
    if (this.hasFeature(RUNTIME_RUNNING_WATCH_FEATURE)) {
      this.runningAuthorityMode = "watch";
      this.liveSessionStateKnown = false;
      this.runningWatchGeneration = this.currentGeneration;
      this.runningWatchRevision = -1;
    } else {
      this.runningAuthorityMode = "legacy";
      void this.refreshRunningSessions().catch(() => undefined);
    }
    this.publish();
  }

  onHandshakeReject(error: ProtocolError): void {
    this.error = error;
    this.fatal = true;
    this.rejectReadyWaiters(error);
    this.rejectSendableWaiters(error);
    this.pendingCreate?.reject(error);
    this.pendingCreate = null;
    this.removeAllAttempts(error, true);
    for (const binding of this.bindingsBySessionId.values()) binding.port.onTransportFatal(error);
    this.publish();
  }

  onMessage(message: WsHostMessage, generation: number): void {
    if (message.type === "running_state") {
      if (this.runningAuthorityMode !== "watch" || generation !== this.runningWatchGeneration) return;
      if (message.payload.revision <= this.runningWatchRevision) return;
      this.runningWatchRevision = message.payload.revision;
      this.applyRunningState(message.payload.sessionIds, message.payload.busySessionIds);
      return;
    }
    if (message.type === "response" || message.type === "snapshot" || message.type === "interrupt_result"
      || message.type === "read_result" || message.type === "submit_turn_result") {
      if (message.id !== undefined && this.routeAttempt(message, generation)) return;
      if (message.type !== "snapshot" || message.id !== undefined) return;
    }
    switch (message.type) {
      case "snapshot":
      case "event": {
        const route = this.attachmentRoute;
        if (route === null || route.generation !== generation || message.payload.sessionId !== route.sessionId) return;
        const binding = this.bindingsBySessionId.get(route.sessionId);
        if (binding?.token !== route.bindingToken) return;
        if (message.type === "snapshot") binding.port.onSnapshot(message, generation);
        else binding.port.onEvent(message, generation);
        break;
      }
      case "turn_status": {
        const key = turnOwnerKey(message.payload.sessionId, message.payload.operationId);
        const ownerToken = this.turnOwners.get(key);
        if (ownerToken === undefined) return;
        const binding = this.bindingsBySessionId.get(message.payload.sessionId);
        if (binding?.token === ownerToken) binding.port.onTurnStatus(message, generation);
        break;
      }
      case "runtime_unavailable":
        if (message.payload.sessionId === undefined) {
          this.error = message.payload.error;
          for (const binding of this.bindingsBySessionId.values()) binding.port.onUnavailable(message, generation);
          this.publish();
        } else {
          this.bindingsBySessionId.get(message.payload.sessionId)?.port.onUnavailable(message, generation);
        }
        break;
      default:
        break;
    }
  }

  // internal -------------------------------------------------------------

  private lookupLiveSession(sessionId: string): Promise<RuntimeListRunningResult["sessions"][number] & { epoch: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handle: RuntimeAttemptHandle | null = null;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        callback();
      };
      const timer = this.setTimeoutFn(() => {
        handle?.cancel();
        finish(() => reject({ code: "timeout", message: "live runtime lookup timed out", retryable: true } satisfies ProtocolError));
      }, LIVE_STATS_STAGE_TIMEOUT_MS);
      handle = this.registerGlobalAttempt({
        buildMessage: (id) => ({ type: "listRunning", id, payload: {} }),
        expectation: { kind: "listRunning" },
        disconnectPolicy: "reject_on_disconnect",
        onFrame: (frame) => {
          if (frame.type !== "response") return;
          if (!frame.payload.ok) {
            const error = (frame.payload as { ok: false; error: ProtocolError }).error;
            finish(() => reject(error));
            return;
          }
          const running = frame.payload.result as RuntimeListRunningResult;
          const item = running.sessions.find((candidate) => candidate.sessionId === sessionId);
          if (item === undefined) {
            finish(() => reject({ code: "not_found", message: "runtime is not active", retryable: false } satisfies ProtocolError));
            return;
          }
          const epoch = item.epoch;
          if (epoch === undefined) {
            finish(() => reject({ code: "unsupported_capability", message: "live runtime epoch is unavailable", retryable: false } satisfies ProtocolError));
            return;
          }
          finish(() => resolve({ ...item, epoch }));
        },
        onSendFailure: (cause) => finish(() => reject(cause)),
        onDisconnect: (cause) => finish(() => reject(cause)),
      });
    });
  }

  private registerAndSend(binding: BindingRecord, spec: RuntimeAttemptSpec): RuntimeAttemptHandle | null {
    const targetSessionId = expectationSessionId(spec.expectation);
    const attachmentRouteValid = spec.expectation.kind !== "attach"
      || (this.attachmentRoute?.bindingToken === binding.token && this.attachmentRoute.sessionId === binding.sessionId);
    if (targetSessionId === null || targetSessionId !== binding.sessionId || !attachmentRouteValid) {
      spec.onSendFailure({
        code: "not_found",
        message: "runtime attempt target does not match controller session",
        retryable: false,
      } satisfies ProtocolError);
      return null;
    }
    return this.registerAttempt(binding.token, spec);
  }

  private registerGlobalAttempt(spec: RuntimeAttemptSpec): RuntimeAttemptHandle | null {
    return this.registerAttempt(Symbol.for("runtime-connection-global"), spec);
  }

  private registerAttempt(bindingToken: symbol, spec: RuntimeAttemptSpec): RuntimeAttemptHandle | null {
    if (this.attempts.size >= this.maxOutboundAttempts) {
      spec.onSendFailure(busyAttemptError());
      return null;
    }
    const envelopeId = spec.envelopeId ?? this.id();
    if (this.attempts.has(envelopeId)) {
      spec.onSendFailure(busyAttemptError());
      return null;
    }
    const generation = this.currentGeneration;
    const token = Symbol("runtime-outbound-attempt");
    const record: AttemptRecord = {
      token,
      envelopeId,
      generation,
      bindingToken,
      expectation: spec.expectation,
      disconnectPolicy: spec.disconnectPolicy,
      ...(spec.expectation.kind === "attach" && this.attachmentRoute !== null
        ? { attachmentRouteToken: this.attachmentRoute.token }
        : {}),
      onFrame: spec.onFrame,
      onSendFailure: spec.onSendFailure,
      onDisconnect: spec.onDisconnect,
    };
    const message = spec.buildMessage(envelopeId);
    if (!("id" in message) || message.id !== envelopeId) {
      spec.onSendFailure(new Error("runtime attempt message must use the provided envelope id"));
      return null;
    }
    if (bindingToken !== Symbol.for("runtime-connection-global")) {
      const expectedSessionId = expectationSessionId(spec.expectation);
      const messageSessionId = "payload" in message && message.payload !== null && typeof message.payload === "object"
        && "sessionId" in message.payload ? message.payload.sessionId : undefined;
      if (expectedSessionId === null || messageSessionId !== expectedSessionId) {
        spec.onSendFailure({ code: "not_found", message: "runtime message target does not match controller session", retryable: false } satisfies ProtocolError);
        return null;
      }
    }
    // Registration MUST happen before send. A synchronous reply/failure cannot
    // race ahead of correlation ownership. Turn push ownership is registered
    // before submit_turn reaches the transport for the same reason.
    this.attempts.set(envelopeId, record);
    if (spec.expectation.kind === "submit_turn") {
      this.turnOwners.set(turnOwnerKey(spec.expectation.sessionId, spec.expectation.operationId), bindingToken);
    }
    try {
      this.socket.send(message);
    } catch (error) {
      if (this.removeExactAttempt(record)) record.onSendFailure(error);
      return null;
    }
    return {
      envelopeId,
      generation,
      cancel: () => { this.removeExactAttempt(record); },
    };
  }

  private routeAttempt(frame: RuntimeAttemptFrame, generation: number): boolean {
    const envelopeId = frame.id;
    if (envelopeId === undefined) return false;
    const record = this.attempts.get(envelopeId);
    if (record === undefined || record.generation !== generation) return false;
    if (record.bindingToken !== Symbol.for("runtime-connection-global")) {
      const sessionId = expectationSessionId(record.expectation);
      if (sessionId === null || this.bindingsBySessionId.get(sessionId)?.token !== record.bindingToken) return false;
    }
    if (record.expectation.kind === "attach" && this.attachmentRoute?.token !== record.attachmentRouteToken) return false;
    if (!matchesAttempt(frame, record.expectation)) return false;
    if (!this.removeExactAttempt(record)) return false;
    if (record.expectation.kind === "attach" && frame.type === "snapshot"
      && this.attachmentRoute?.bindingToken === record.bindingToken
      && this.attachmentRoute.sessionId === record.expectation.sessionId) {
      this.attachmentRoute.generation = generation;
    }
    record.onFrame(frame);
    return true;
  }

  private removeExactAttempt(record: AttemptRecord): boolean {
    if (this.attempts.get(record.envelopeId)?.token !== record.token) return false;
    this.attempts.delete(record.envelopeId);
    return true;
  }

  private removeGenerationAttempts(generation: number, error: ProtocolError): void {
    for (const record of [...this.attempts.values()]) {
      if (record.generation !== generation || !this.removeExactAttempt(record)) continue;
      if (record.disconnectPolicy === "reject_on_disconnect") record.onDisconnect(error);
    }
    if (this.pendingCreate !== null) this.pendingCreate.attempt = null;
  }

  private removeAllAttempts(error: ProtocolError, terminal: boolean): void {
    for (const record of [...this.attempts.values()]) {
      if (!this.removeExactAttempt(record)) continue;
      if (terminal || record.disconnectPolicy === "reject_on_disconnect") record.onDisconnect(error);
    }
  }

  private unbindExact(binding: BindingRecord): void {
    if (this.bindingsBySessionId.get(binding.sessionId)?.token !== binding.token) return;
    this.bindingsBySessionId.delete(binding.sessionId);
    if (this.attachmentRoute?.bindingToken === binding.token) this.attachmentRoute = null;
    for (const record of [...this.attempts.values()]) {
      if (record.bindingToken === binding.token) this.removeExactAttempt(record);
    }
    for (const [key, ownerToken] of this.turnOwners) {
      if (ownerToken === binding.token) this.turnOwners.delete(key);
    }
  }

  private sendCreateAttempt(pending: CreatePending): void {
    pending.attempt?.cancel();
    pending.attempt = this.registerGlobalAttempt({
      buildMessage: (id) => ({ type: "create", id, payload: pending.payload }),
      expectation: { kind: "create", cwd: pending.payload.cwd, projectRoot: pending.payload.projectRoot },
      disconnectPolicy: "logical_retry",
      onFrame: (frame) => {
        if (this.pendingCreate !== pending || frame.type !== "response") return;
        this.pendingCreate = null;
        pending.attempt = null;
        if (!frame.payload.ok) {
          pending.reject(frame.payload.error);
          this.error = frame.payload.error;
          this.publish();
          return;
        }
        const result = frame.payload.result as RuntimeCreateResult;
        // A create success must match its requested identity context where the
        // wire carries it. createRequestId is intentionally request-only.
        if (result.cwd !== pending.payload.cwd || result.projectRoot !== pending.payload.projectRoot) {
          pending.reject({ code: "internal", message: "create response identity mismatch", retryable: false } satisfies ProtocolError);
          return;
        }
        // Settle the create promise before publishing. Promise reactions run in
        // a later microtask, so publish synchronously lets the bound controller
        // re-evaluate ready with hasPendingCreate=false and resume an intended
        // attach immediately, while the create promise is already exactly-once
        // settled. This avoids create+open reconnect starvation without making
        // attach depend on an unrelated running/event publish.
        pending.resolve(result);
        this.publish();
      },
      onSendFailure: (cause) => {
        if (this.pendingCreate !== pending) return;
        this.pendingCreate = null;
        pending.attempt = null;
        pending.reject(cause);
      },
      onDisconnect: () => { /* logical retry remains pending */ },
    });
  }

  private applyRunningState(sessionIds: readonly string[], busySessionIds: readonly string[]): void {
    this.liveSessionIds = [...sessionIds];
    this.runningSessionIds = [...busySessionIds];
    this.liveSessionStateKnown = true;
    this.runningProjectionRevision += 1;
    this.publish();
  }

  private failRunningRefresh(requestGeneration: number, revisionAtRequest: number): void {
    if (requestGeneration !== this.runningRefreshGeneration || revisionAtRequest !== this.runningProjectionRevision) return;
    this.runningSessionIds = [];
    this.liveSessionIds = [];
    this.liveSessionStateKnown = false;
    this.runningProjectionRevision += 1;
    this.publish();
  }

  private resetRunningAuthority(): void {
    this.runningSessionIds = [];
    this.liveSessionIds = [];
    this.liveSessionStateKnown = false;
    this.runningProjectionRevision += 1;
    this.runningAuthorityMode = "pending";
    this.runningWatchGeneration = -1;
    this.runningWatchRevision = -1;
  }

  private resolveReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectReadyWaiters(error: unknown): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private resolveSendableWaiters(): void {
    const waiters = this.sendableWaiters;
    this.sendableWaiters = [];
    for (const waiter of waiters) {
      this.clearTimeoutFn(waiter.handle);
      waiter.resolve();
    }
  }

  private rejectSendableWaiters(error: unknown): void {
    const waiters = this.sendableWaiters;
    this.sendableWaiters = [];
    for (const waiter of waiters) {
      this.clearTimeoutFn(waiter.handle);
      waiter.reject(error);
    }
  }

  private computeView(): RuntimeConnectionView {
    return {
      state: this.connectionState === "attaching" || this.connectionState === "attached" ? "ready" : this.connectionState,
      generation: this.currentGeneration,
      host: this.host,
      acceptedFeatures: [...this.acceptedFeatureSet],
      error: this.error,
      fatal: this.fatal,
      runningSessionIds: [...this.runningSessionIds],
      liveSessionIds: [...this.liveSessionIds],
      liveSessionStateKnown: this.liveSessionStateKnown,
    };
  }

  private publish(): void {
    this.view = this.computeView();
    for (const binding of this.bindingsBySessionId.values()) binding.port.onTransportState(this.view.state);
    for (const listener of this.listeners) listener();
  }
}
