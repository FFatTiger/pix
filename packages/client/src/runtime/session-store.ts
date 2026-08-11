/**
 * SessionStore — the client-side Runtime brain.
 *
 * It owns the {@link RuntimeSocket} (transport) and, on top of it:
 *  - the projection {@link RuntimeSnapshot} (reduced through the SHARED Protocol
 *    `reduceRuntimeEventData`, identical semantics to the sessiond authority);
 *  - the resume cursor (sessionId / epoch / lastEventId) and per-generation
 *    attach gating ("no event applies before this generation's first snapshot");
 *  - strict create/open/attach/detach/stop + prompt/abort/getSnapshot with
 *    at-most-once correlation (envelope id vs createRequestId vs commandId vs
 *    interrupt commandId) and bounded reconnect resynchronization;
 *  - the reactive {@link RuntimeView} exposed to React via useSyncExternalStore
 *    (realtime state NEVER goes through TanStack Query).
 *
 * Honesty rules enforced here (M2 C1 spec §C/D/E):
 *  - `attached` is only true after a strictly correlated initial snapshot
 *    (snapshot.id === attach request id, same generation, sessionId match).
 *  - events are applied only when eventId === lastEventId + 1 within the matched
 *    epoch/session; duplicates drop; gaps / epoch / session mismatch → reattach.
 *  - getSnapshot replaces projection state WITHOUT advancing the cursor.
 *  - browser unload / dispose only closes/detaches; NEVER runtime.stop.
 *  - stopping a running prompt first aborts (await interrupt result w/ timeout)
 *    because H1 stop head-of-lines behind a long command.
 */
import {
  reduceRuntimeEventData,
  type AgentMessage,
  type ProtocolError,
  type RuntimeAttachParams,
  type RuntimeCreateParams,
  type RuntimeEventData,
  type RuntimeSnapshot,
  type StreamingAgentMessage,
  type WsClientMessage,
  type WsEventMessage,
  type WsHostMessage,
  type WsInterruptMessage,
  type WsInterruptResultMessage,
  type WsResponseMessage,
  type WsSnapshotMessage,
} from "@fffattiger/pix-protocol";
import {
  RuntimeSocket,
  type NegotiatedHost,
  type RuntimeSocketDeps,
  type RuntimeSocketHandler,
} from "./socket.js";
import { type ConnectionState } from "./lifecycle.js";
import {
  createDefaultIdFactory,
  decideCommandRetry,
  decideEvent,
  type EventApplyDecision,
  type IdFactory,
} from "./correlation.js";

/** Reactive view consumed by React via useSyncExternalStore (immutable per change). */
export interface RuntimeView {
  readonly connection: ConnectionState;
  readonly host: NegotiatedHost | null;
  readonly attached: boolean;
  readonly sessionStopped: boolean;
  readonly sessionId: string | null;
  readonly epoch: string | null;
  readonly snapshot: RuntimeSnapshot | null;
  readonly streaming: boolean;
  readonly streamingPartial: StreamingAgentMessage | null;
  readonly messages: readonly AgentMessage[];
  readonly error: ProtocolError | null;
  readonly fatal: boolean;
  readonly canAgent: boolean;
}

const INITIAL_VIEW: RuntimeView = {
  connection: "idle",
  host: null,
  attached: false,
  sessionStopped: false,
  sessionId: null,
  epoch: null,
  snapshot: null,
  streaming: false,
  streamingPartial: null,
  messages: [],
  error: null,
  fatal: false,
  canAgent: false,
};

export interface SessionStoreOptions {
  readonly id?: IdFactory;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Timeout for awaiting an abort interrupt result before a forced stop (HOL rule). */
  readonly abortTimeoutMs?: number;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface EnvelopePending {
  readonly kind: "getSnapshot" | "detach" | "stop";
  readonly generation: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface CreatePending {
  readonly createRequestId: string;
  envelopeId: string;
  generation: number;
  readonly payload: RuntimeCreateParams;
  resolve(value: { sessionId: string }): void;
  reject(error: unknown): void;
}

interface AttachPending {
  readonly envelopeId: string;
  readonly generation: number;
  readonly sessionId: string;
  resolve(): void;
  reject(error: unknown): void;
}

interface CommandPending {
  readonly commandId: string;
  envelopeId: string;
  generation: number;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface InterruptPending {
  readonly commandId: string;
  envelopeId: string;
  generation: number;
  readonly sessionId: string;
  readonly message: WsInterruptMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

export class SessionStore implements RuntimeSocketHandler {
  private readonly socket: RuntimeSocket;
  private readonly id: IdFactory;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly abortTimeoutMs: number;

  // reactive state
  private connection: ConnectionState = "idle";
  private host: NegotiatedHost | null = null;
  private attached = false;
  private sessionStopped = false;
  private sessionId: string | null = null;
  private epoch: string | null = null;
  private lastEventId = 0;
  private snapshot: RuntimeSnapshot | null = null;
  private error: ProtocolError | null = null;
  private fatal = false;

  // attach / cursor gating
  private intendedSession: { sessionId: string } | null = null;
  private attachGen: number | null = null;
  private awaitingSnapshot = false;
  private resuming = false;

  // pending requests
  private pendingByEnvelope = new Map<string, EnvelopePending>();
  private pendingCreate: CreatePending | null = null;
  private pendingAttach: AttachPending | null = null;
  private pendingCommand: CommandPending | null = null;
  private pendingInterrupt: InterruptPending | null = null;
  /** At most ONE interrupt in flight (well under H1's 16-interrupt cap). */
  private pendingInterruptPromise: Promise<unknown> | null = null;
  private readyWaiters: ReadyWaiter[] = [];

  private readonly listeners = new Set<() => void>();
  private view: RuntimeView = INITIAL_VIEW;

  constructor(socketDeps: RuntimeSocketDeps, options: SessionStoreOptions = {}) {
    this.socket = new RuntimeSocket(socketDeps, this);
    this.id = options.id ?? createDefaultIdFactory();
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  }

  // --- public transport --------------------------------------------------

  connect(): void { this.socket.connect(); }

  /** Idempotent teardown: closes the socket + detaches. NEVER runtime.stop. */
  dispose(): void {
    this.rejectReadyWaiters({ code: "unavailable", message: "runtime disposed", retryable: false });
    this.failAllPending({ code: "unavailable", message: "runtime disposed", retryable: false });
    this.socket.dispose();
  }

  getRuntimeSocket(): RuntimeSocket { return this.socket; }

  // --- public lifecycle --------------------------------------------------

  /** Create a new session, then freshly attach (attach snapshot is authoritative). */
  createSession(params: {
    cwd: string;
    projectRoot: string;
    model?: { provider: string; modelId: string };
    thinkingLevel?: RuntimeCreateParams["thinkingLevel"];
    name?: string;
  }): Promise<{ sessionId: string }> {
    this.sessionStopped = false;
    this.ensureConnecting();
    return new Promise((resolve, reject) => {
      this.whenReady().then(
        () => {
          const createRequestId = this.id();
          const payload: RuntimeCreateParams = {
            createRequestId,
            cwd: params.cwd,
            projectRoot: params.projectRoot,
            ...(params.model === undefined ? {} : { model: params.model }),
            ...(params.thinkingLevel === undefined ? {} : { thinkingLevel: params.thinkingLevel }),
            ...(params.name === undefined ? {} : { name: params.name }),
          };
          const envelopeId = this.id();
          this.pendingCreate = {
            createRequestId,
            envelopeId,
            generation: this.socket.currentGeneration,
            payload,
            resolve,
            reject,
          };
          this.send({ type: "create", id: envelopeId, payload });
        },
        (error) => reject(error),
      );
    });
  }

  /** Open (cold-activate via H1) an existing session with a FRESH attach. */
  openSession(sessionId: string): Promise<void> {
    this.sessionStopped = false;
    this.ensureConnecting();
    return new Promise<void>((resolve, reject) => {
      this.whenReady().then(
        () => {
          this.resuming = false;
          void this.attachSession(sessionId, "fresh").then(resolve, reject);
        },
        (error) => reject(error),
      );
    });
  }

  /** Detach the current attach; the Worker is PRESERVED (no stop). */
  detach(): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    return this.sendEnvelope({ type: "detach", id: this.id(), payload: { sessionId: this.sessionId } }).then(() => {
      this.attached = false;
      this.awaitingSnapshot = false;
      this.intendedSession = null;
      this.setConnection(this.socket.connectionState === "stopped" ? "stopped" : "ready");
      this.notify();
    });
  }

  /**
   * Authoritative stop. If a prompt is currently running, FIRST abort it and
   * await the interrupt result (with a timeout) before stopping — H1 stop
   * head-of-lines behind a long-running command, so we must interrupt first.
   */
  async stop(reason?: string): Promise<void> {
    // HOL rule: H1 stop head-of-lines behind a long-running command, so if a
    // prompt is running we FIRST abort it and await the interrupt result (with a
    // bounded timeout) before issuing the authoritative stop.
    if (this.attached && this.isPromptRunning()) {
      await this.boundedAbort();
    }
    const sessionId = this.sessionId;
    if (!sessionId) return;
    // Authoritative stop frame is fire-and-forget: the host also tears down the
    // attach subscription, and we must not hang on a lost stop response.
    this.send({ type: "stop", id: this.id(), payload: { sessionId, ...(reason === undefined ? {} : { reason }) } });
    this.attached = false;
    this.awaitingSnapshot = false;
    this.sessionStopped = true;
    this.intendedSession = null;
    this.pendingCommand = null;
    this.notify();
  }

  /** Await an abort interrupt result, but never longer than {@link abortTimeoutMs}. */
  private boundedAbort(): Promise<void> {
    return new Promise<void>((continueStop) => {
      let done = false;
      const handle = this.setTimeoutFn(() => {
        if (done) return;
        done = true;
        continueStop();
      }, this.abortTimeoutMs);
      this.abort().then(
        () => {
          if (done) return;
          done = true;
          this.clearTimeoutFn(handle);
          continueStop();
        },
        () => {
          if (done) return;
          done = true;
          this.clearTimeoutFn(handle);
          continueStop();
        },
      );
    });
  }

  /** Read-only snapshot refresh; replaces projection state WITHOUT advancing the cursor. */
  fetchSnapshot(): Promise<RuntimeSnapshot | null> {
    const sessionId = this.sessionId;
    if (!sessionId) return Promise.resolve(this.snapshot);
    return this.sendEnvelope({ type: "getSnapshot", id: this.id(), payload: { sessionId } }).then((result) => {
      const snap = result as RuntimeSnapshot;
      // Replace projection state only; epoch/lastEventId/sessionId cursor unchanged.
      this.snapshot = structuredClone(snap);
      this.notify();
      return this.snapshot;
    });
  }

  /** Send a prompt (ordinary command). commandId is stable across same-epoch retries. */
  sendPrompt(message: string): Promise<unknown> {
    if (!this.attached || !this.sessionId) {
      return Promise.reject(this.notAttachedError());
    }
    const sessionId = this.sessionId;
    const commandId = this.id();
    const envelopeId = this.id();
    const command: WsClientMessage = {
      type: "command",
      id: envelopeId,
      payload: { sessionId, command: { commandId, type: "prompt", message } },
    };
    return new Promise((resolve, reject) => {
      this.pendingCommand = { commandId, envelopeId, generation: this.socket.currentGeneration, sessionId, command, resolve, reject };
      this.send(command);
    });
  }

  /** Abort the running prompt via the INDEPENDENT interrupt path (not queued). */
  abort(): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(this.notAttachedError());
    // Coalesce concurrent aborts: at most one interrupt is ever in flight, so the
    // client can never approach H1's 16-in-flight-interrupt hard cap.
    if (this.pendingInterrupt && this.pendingInterruptPromise) return this.pendingInterruptPromise;
    const sessionId = this.sessionId;
    const commandId = this.id();
    const envelopeId = this.id();
    const wsMessage: WsInterruptMessage = {
      type: "interrupt",
      id: envelopeId,
      payload: { sessionId, commandId, interrupt: { type: "abort" } },
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingInterrupt = { commandId, envelopeId, generation: this.socket.currentGeneration, sessionId, message: wsMessage, resolve, reject };
      this.send(wsMessage);
    });
    this.pendingInterruptPromise = promise;
    return promise;
  }

  // --- external store (useSyncExternalStore) -----------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): RuntimeView => this.view;

  // --- RuntimeSocketHandler ---------------------------------------------

  onConnectionState(state: ConnectionState): void {
    this.connection = state;
    // Socket-driven states never include attached/attaching (those are
    // store-driven), so any socket transition means we are no longer attached.
    // Essential for reconnect: when transport is restored to `ready`, `!attached`
    // triggers the resume re-attach.
    this.attached = false;
    if (state === "ready") {
      this.resolveReadyWaiters();
      // Reconnect resync: a lost create response can be re-sent idempotently.
      if (this.pendingCreate) {
        this.resendCreate();
        return;
      }
      // Reconnect resync: resume the intended session if we were attached.
      if (this.intendedSession && !this.attached && !this.sessionStopped) {
        void this.resumeAttach();
      }
    } else if (state === "stopped") {
      this.rejectReadyWaiters({ code: "unavailable", message: "runtime connection stopped", retryable: false });
    }
    this.notify();
  }

  onHandshakeAck(host: NegotiatedHost): void {
    this.host = host;
    this.notify();
  }

  onHandshakeReject(error: ProtocolError): void {
    this.fatal = true;
    this.error = error;
    this.rejectReadyWaiters(error);
    this.failAllPending(error);
    this.notify();
  }

  onMessage(message: WsHostMessage, generation: number): void {
    switch (message.type) {
      case "snapshot": this.handleSnapshot(message, generation); break;
      case "event": this.handleEvent(message, generation); break;
      case "response": this.handleResponse(message, generation); break;
      case "interrupt_result": this.handleInterruptResult(message, generation); break;
      case "runtime_unavailable": this.handleUnavailable(message, generation); break;
      default: break;
    }
  }

  // --- message handlers --------------------------------------------------

  private handleSnapshot(message: WsSnapshotMessage, generation: number): void {
    const payload = message.payload;
    // Initial attach snapshot: strictly correlated by (generation, request id, sessionId).
    if (
      this.pendingAttach &&
      message.id === this.pendingAttach.envelopeId &&
      generation === this.pendingAttach.generation &&
      payload.sessionId === this.pendingAttach.sessionId
    ) {
      const pending = this.pendingAttach;
      this.pendingAttach = null;
      this.applySnapshot(payload);
      this.attachGen = generation;
      this.awaitingSnapshot = false;
      this.attached = true;
      this.error = null;
      this.setConnection("attached");
      pending.resolve();
      this.resyncAfterAttach(payload.resumeStatus, payload.epoch);
      return;
    }
    // Replay / live snapshot (gap / epoch_changed mid-stream): full replace + cursor.
    if (this.attached && generation === this.attachGen && payload.sessionId === this.sessionId) {
      this.applySnapshot(payload);
      this.notify();
    }
  }

  private handleEvent(message: WsEventMessage, generation: number): void {
    if (!this.attached || generation !== this.attachGen) return;
    const event = message.payload;
    const decision: EventApplyDecision = decideEvent(event, {
      sessionId: this.sessionId,
      epoch: this.epoch,
      lastEventId: this.lastEventId,
      snapshotReceived: !this.awaitingSnapshot,
      generation,
      activeGeneration: this.attachGen ?? -1,
    });
    if (decision.decision === "apply") {
      if (this.snapshot === null) return;
      try {
        this.snapshot = reduceRuntimeEventData(this.snapshot, event as RuntimeEventData);
        this.lastEventId = event.eventId;
      } catch {
        // Projection inconsistency (e.g. a stream event out of order): the
        // authoritative snapshot is stale — re-attach to resynchronize.
        this.reattach("resume");
      }
      this.notify();
    } else if (decision.decision === "reattach") {
      this.reattach("resume");
    }
    // "drop" (duplicate / awaiting-snapshot): ignore.
  }

  private handleResponse(message: WsResponseMessage, generation: number): void {
    const ok = message.payload.ok;
    // attach failure: success arrives as a snapshot, so any `response` matching a
    // pending attach id is a failure (ok:false) → reject.
    if (this.pendingAttach && message.id === this.pendingAttach.envelopeId && generation === this.pendingAttach.generation) {
      const pending = this.pendingAttach;
      this.pendingAttach = null;
      const error: ProtocolError = ok
        ? { code: "internal", message: "attach response without snapshot", retryable: false }
        : message.payload.error;
      pending.reject(error);
      this.setError(error);
      return;
    }
    // create
    if (this.pendingCreate && message.id === this.pendingCreate.envelopeId && generation === this.pendingCreate.generation) {
      const pending = this.pendingCreate;
      this.pendingCreate = null;
      if (!ok) { pending.reject(message.payload.error); this.setError(message.payload.error); return; }
      const result = message.payload.result as { sessionId: string };
      // create optional snapshot is IGNORED; the attach snapshot is authoritative.
      this.intendedSession = { sessionId: result.sessionId };
      void this.attachSession(result.sessionId, "fresh").then(
        () => pending.resolve({ sessionId: result.sessionId }),
        (error) => pending.reject(error),
      );
      return;
    }
    // command
    if (this.pendingCommand && message.id === this.pendingCommand.envelopeId && generation === this.pendingCommand.generation) {
      const pending = this.pendingCommand;
      this.pendingCommand = null;
      if (ok) pending.resolve(message.payload.result);
      else { pending.reject(message.payload.error); this.setError(message.payload.error); }
      return;
    }
    // envelope-keyed one-shots: getSnapshot / detach / stop
    const entry = this.pendingByEnvelope.get(message.id);
    if (entry && entry.generation === generation) {
      this.pendingByEnvelope.delete(message.id);
      if (ok) entry.resolve(message.payload.result);
      else { entry.reject(message.payload.error); this.setError(message.payload.error); }
      return;
    }
    // late / unknown response: drop (generation guard / superseded).
  }

  private handleInterruptResult(message: WsInterruptResultMessage, generation: number): void {
    if (this.pendingInterrupt && message.id === this.pendingInterrupt.envelopeId && generation === this.pendingInterrupt.generation) {
      const pending = this.pendingInterrupt;
      this.pendingInterrupt = null;
      this.pendingInterruptPromise = null;
      const result = message.payload.result;
      if (result.ok) pending.resolve(result);
      else { pending.reject(result.error); this.setError(result.error); }
    }
  }

  private handleUnavailable(message: Extract<WsHostMessage, { type: "runtime_unavailable" }>, _generation: number): void {
    this.setError(message.payload.error);
  }

  // --- attach / resync ---------------------------------------------------

  private attachSession(sessionId: string, mode: "fresh" | "resume"): Promise<void> {
    this.intendedSession = { sessionId };
    this.attached = false;
    this.awaitingSnapshot = true;
    if (mode === "resume") this.resuming = true;
    const envelopeId = this.id();
    const params: RuntimeAttachParams = mode === "resume" && this.epoch !== null
      ? { sessionId, epoch: this.epoch, lastEventId: this.lastEventId }
      : { sessionId };
    this.setConnection("attaching");
    return new Promise<void>((resolve, reject) => {
      this.pendingAttach = { envelopeId, generation: this.socket.currentGeneration, sessionId, resolve, reject };
      this.send({ type: "attach", id: envelopeId, payload: params });
    });
  }

  /** Reconnect resume: re-attach with the atomic epoch + lastEventId cursor. */
  private resumeAttach(): Promise<void> {
    if (!this.intendedSession) return Promise.resolve();
    return this.attachSession(this.intendedSession.sessionId, "resume").catch(() => {
      // Resume failed; the socket backoff will retry and `ready` will re-trigger.
    });
  }

  /** Re-attach after a cursor violation (gap / epoch / session mismatch). */
  private reattach(mode: "fresh" | "resume"): void {
    if (!this.sessionId) return;
    this.attached = false;
    this.awaitingSnapshot = true;
    void this.attachSession(this.sessionId, mode).catch(() => undefined);
  }

  /**
   * After a reconnect delivers its initial snapshot, re-send any pending
   * command/interrupt ONLY when the epoch survived (snapshot/gap). On
   * epoch_changed the prior command's effect is ambiguous → reject, never resend.
   */
  private resyncAfterAttach(resumeStatus: "snapshot" | "gap" | "epoch_changed", snapshotEpoch: string): void {
    if (!this.resuming) return;
    this.resuming = false;
    const epochSurvived = resumeStatus !== "epoch_changed" && (this.epoch === null || this.epoch === snapshotEpoch);
    if (this.pendingCommand) {
      const decision = decideCommandRetry(epochSurvived ? resumeStatus : "epoch_changed");
      if (decision.decision === "resend") {
        this.resendCommand();
      } else {
        this.pendingCommand.reject(decision.error);
        this.pendingCommand = null;
        this.setError(decision.error);
      }
    }
    if (this.pendingInterrupt) {
      if (epochSurvived) {
        this.resendInterrupt();
      } else {
        const err: ProtocolError = { code: "epoch_changed", message: "epoch changed; interrupt not re-sent", retryable: false };
        this.pendingInterrupt.reject(err);
        this.pendingInterrupt = null;
        this.pendingInterruptPromise = null;
      }
    }
  }

  /** Re-send a pending create with the SAME createRequestId (stable across retries). */
  private resendCreate(): void {
    const pending = this.pendingCreate;
    if (!pending) return;
    const envelopeId = this.id();
    pending.envelopeId = envelopeId;
    pending.generation = this.socket.currentGeneration;
    this.send({ type: "create", id: envelopeId, payload: pending.payload });
  }

  /** Re-send a pending command with the SAME commandId (at-most-once per epoch). */
  private resendCommand(): void {
    const pending = this.pendingCommand;
    if (!pending) return;
    const envelopeId = this.id();
    const command: WsClientMessage = { ...pending.command, id: envelopeId };
    this.pendingCommand = { ...pending, envelopeId, generation: this.socket.currentGeneration, command };
    this.send(command);
  }

  /** Re-send a pending interrupt with the SAME commandId (at-most-once per epoch). */
  private resendInterrupt(): void {
    const pending = this.pendingInterrupt;
    if (!pending) return;
    const envelopeId = this.id();
    const message: WsInterruptMessage = { ...pending.message, id: envelopeId };
    this.pendingInterrupt = { ...pending, envelopeId, generation: this.socket.currentGeneration, message };
    this.send(message);
  }

  // --- helpers -----------------------------------------------------------

  private applySnapshot(payload: WsSnapshotMessage["payload"]): void {
    this.sessionId = payload.sessionId;
    this.epoch = payload.epoch;
    this.lastEventId = payload.lastEventId;
    this.snapshot = structuredClone(payload.snapshot);
    this.notify();
  }

  /**
   * Track + send a one-shot envelope request (getSnapshot / detach / stop),
   * resolved/rejected by the matching {@link WsResponseMessage}. Type-safe:
   * the caller constructs the full discriminated-union client message.
   */
  private sendEnvelope(message: WsClientMessage): Promise<unknown> {
    const id = message.id;
    if (id === undefined) return Promise.reject(new Error("envelope request requires an id"));
    return new Promise((resolve, reject) => {
      this.pendingByEnvelope.set(id, {
        kind: message.type === "getSnapshot" ? "getSnapshot" : message.type === "detach" ? "detach" : "stop",
        generation: this.socket.currentGeneration,
        resolve,
        reject,
      });
      this.send(message);
    });
  }

  private send(message: WsClientMessage): void {
    try {
      this.socket.send(message);
    } catch (error) {
      // Not sendable: fail the matching pending promise (if any).
      this.routeSendFailure(message, error);
    }
  }

  private routeSendFailure(message: WsClientMessage, error: unknown): void {
    const id = "id" in message && typeof message.id === "string" ? message.id : null;
    if (id && this.pendingByEnvelope.has(id)) {
      const entry = this.pendingByEnvelope.get(id)!;
      this.pendingByEnvelope.delete(id);
      entry.reject(error);
    } else if (this.pendingCommand?.envelopeId === id) {
      this.pendingCommand.reject(error);
      this.pendingCommand = null;
    } else if (this.pendingInterrupt?.envelopeId === id) {
      this.pendingInterrupt.reject(error);
      this.pendingInterrupt = null;
      this.pendingInterruptPromise = null;
    } else if (this.pendingAttach?.envelopeId === id) {
      this.pendingAttach.reject(error);
      this.pendingAttach = null;
    } else if (this.pendingCreate?.envelopeId === id) {
      this.pendingCreate.reject(error);
      this.pendingCreate = null;
    }
  }

  private ensureConnecting(): void {
    if (this.connection === "idle") this.socket.connect();
  }

  private whenReady(): Promise<void> {
    if (this.connection === "ready") return Promise.resolve();
    if (this.fatal || this.connection === "stopped") {
      return Promise.reject(this.error ?? { code: "unavailable", message: "runtime not ready", retryable: false });
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  private resolveReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private rejectReadyWaiters(error: unknown): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(error);
  }

  private failAllPending(error: ProtocolError): void {
    this.pendingCreate?.reject(error);
    this.pendingCreate = null;
    this.pendingAttach?.reject(error);
    this.pendingAttach = null;
    this.pendingCommand?.reject(error);
    this.pendingCommand = null;
    this.pendingInterrupt?.reject(error);
    this.pendingInterrupt = null;
    this.pendingInterruptPromise = null;
    for (const [, entry] of this.pendingByEnvelope) entry.reject(error);
    this.pendingByEnvelope.clear();
  }

  private isPromptRunning(): boolean {
    return this.snapshot?.state.isPromptRunning === true || this.snapshot?.state.isStreaming === true;
  }

  private notAttachedError(): ProtocolError {
    return { code: "unavailable", message: "not attached to a runtime session", retryable: false };
  }

  private setError(error: ProtocolError): void {
    this.error = error;
    this.notify();
  }

  private setConnection(state: ConnectionState): void {
    this.connection = state;
    this.notify();
  }

  private computeView(): RuntimeView {
    const snapshot = this.snapshot;
    const streaming = snapshot?.streaming?.active === true || snapshot?.state.isStreaming === true;
    return {
      connection: this.connection,
      host: this.host,
      attached: this.attached,
      sessionStopped: this.sessionStopped,
      sessionId: this.sessionId,
      epoch: this.epoch,
      snapshot,
      streaming,
      streamingPartial: snapshot?.streaming?.partialMessage ?? null,
      messages: snapshot?.messages ?? [],
      error: this.error,
      fatal: this.fatal,
      canAgent: this.host?.capabilities.includes("agent") === true,
    };
  }

  private notify(): void {
    this.view = this.computeView();
    for (const listener of this.listeners) listener();
  }
}

