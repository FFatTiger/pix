/**
 * RuntimeSocket — low-level WebSocket transport for the pix Runtime Protocol.
 *
 * Production ownership invariant: RuntimeConnection is the sole constructor,
 * owner and RuntimeSocketHandler implementation. This module stays narrow and
 * directly testable, but is not a production bypass around RuntimeConnection.
 *
 * Responsibilities (transport ONLY — projection/cursor live in SessionController):
 *  - open one WebSocket to the same-origin `/v1/runtime`, http→ws / https→wss.
 *  - send the strict first-frame handshake; surface ack (host mode/caps/limits)
 *    or fatal reject.
 *  - maintain an explicit {@link ConnectionState}; never claim `attached`.
 *  - generation token: every connect mints a new generation; late frames from a
 *    superseded socket are dropped before reaching the handler.
 *  - fail-closed frame parsing (Protocol safeParse; never `as any`).
 *  - exponential full-jitter backoff reconnect on retryable loss; no reconnect
 *    after manual close / dispose / fatal reject.
 *  - online/visibility recovery → immediate reconnect attempt.
 *  - idempotent dispose: closes the socket once, detaches all hooks/timers.
 *
 * All IO primitives (WebSocket factory, clock, timers, random, location,
 * online/visibility hooks) are injected for deterministic testing.
 */
import {
  FollowUpCommandSchema,
  ImageAttachmentArraySchema,
  isWithinRuntimeFrameBudget,
  PromptCommandSchema,
  RUNTIME_EPOCH_ROLLOVER_FEATURE,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_LIVENESS_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  RUNTIME_QUESTIONNAIRE_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_RUNNING_WATCH_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  SteerCommandSchema,
  SubmitTurnRequestSchema,
  type ClientIdentity,
  type HostLimits,
  type HostMode,
  type ProtocolError,
  type ProtocolHandshakeResponse,
  type WsClientMessage,
  type WsHostMessage,
} from "@fffattiger/pix-protocol";
import {
  buildHandshakeRequest,
  buildRuntimeWsUrl,
  computeBackoffDelay,
  parseHostFrame,
  type BackoffOptions,
  type RuntimeLocation,
} from "./protocol-wire.js";
import { canSend, type ConnectionState } from "./lifecycle.js";
import { createDefaultIdFactory, type IdFactory } from "./correlation.js";

/** Normalized WebSocket surface the socket consumes (native WS is wrapped to it). */
export interface ManagedWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((info: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: (() => void) | null;
}

export type Timer = unknown;

export interface RuntimeSocketDeps {
  readonly createWebSocket: (url: string) => ManagedWebSocket;
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (handle: Timer) => void;
  readonly random: () => number;
  readonly location: RuntimeLocation;
  readonly identity: ClientIdentity;
  /** Subscribe to "network came back online"; return an unsubscribe. */
  readonly onOnline: (cb: () => void) => () => void;
  /** Subscribe to "tab became visible"; return an unsubscribe. */
  readonly onVisible: (cb: () => void) => () => void;
  /**
   * Fine-grained visibility (both directions), used for wake-from-hidden
   * liveness probing. Optional: without it the socket still heartbeats and
   * probes on demand; it just cannot distinguish "briefly blurred" from
   * "hidden long enough for the transport to have died".
   */
  readonly onVisibility?: (cb: (visible: boolean) => void) => () => void;
  readonly features?: readonly string[];
  readonly backoff?: BackoffOptions;
  readonly handshakeTimeoutMs?: number;
  /** Bounded CONNECTING→OPEN budget (a black-holed TCP attempt must not hang the state machine forever). */
  readonly connectTimeoutMs?: number;
  readonly liveness?: Partial<LivenessOptions>;
  readonly id?: IdFactory;
}

/**
 * Transport liveness knobs (negotiated `runtime.liveness.v1`). Defaults keep a
 * visible tab's connection provably alive and detect a dead one well inside a
 * proxy's typical idle window. All timers are injected for deterministic tests.
 */
export interface LivenessOptions {
  /** Heartbeat cadence while ready and idle (recent inbound traffic counts as a beat). */
  readonly heartbeatIntervalMs: number;
  /** A ping unanswered for this long proves the transport dead → forced reconnect. */
  readonly pongTimeoutMs: number;
  /** A sendable connection with inbound traffic newer than this is trusted without probing. */
  readonly freshnessMs: number;
  /** Hiding shorter than this does not warrant a wake probe. */
  readonly hiddenProbeThresholdMs: number;
}

const DEFAULT_LIVENESS: LivenessOptions = {
  heartbeatIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
  freshnessMs: 60_000,
  hiddenProbeThresholdMs: 5_000,
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Host information negotiated at handshake (mode + capabilities + limits). */
export interface NegotiatedHost {
  readonly mode: HostMode;
  readonly capabilities: readonly string[];
  readonly limits: HostLimits;
}

/** Sink for socket events; implemented only by RuntimeConnection in production. */
export interface RuntimeSocketHandler {
  onConnectionState(state: ConnectionState): void;
  onHandshakeAck(host: NegotiatedHost, response: ProtocolHandshakeResponse): void;
  onHandshakeReject(error: ProtocolError): void;
  onMessage(message: WsHostMessage, generation: number): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;

const invalidInput = (message: string): ProtocolError => ({
  code: "invalid_input",
  message,
  retryable: false,
});

function invalidImageBearingClientMessage(message: WsClientMessage): ProtocolError | null {
  if (message.type === "submit_turn") {
    const parsed = SubmitTurnRequestSchema.safeParse(message.payload);
    return parsed.success ? null : invalidInput("invalid submit turn images");
  }
  if (message.type !== "command") return null;
  const command = message.payload.command;
  if (command.type === "prompt") {
    return PromptCommandSchema.safeParse(command).success ? null : invalidInput("invalid prompt images");
  }
  if (command.type === "steer") {
    return SteerCommandSchema.safeParse(command).success ? null : invalidInput("invalid steer images");
  }
  if (command.type === "follow_up") {
    return FollowUpCommandSchema.safeParse(command).success ? null : invalidInput("invalid follow-up images");
  }
  if ("images" in command && command.images !== undefined) {
    return ImageAttachmentArraySchema.safeParse(command.images).success ? null : invalidInput("invalid command images");
  }
  return null;
}

interface ProbeWaiter {
  resolve: (alive: boolean) => void;
  handle: Timer | null;
}

export class RuntimeSocket {
  private readonly deps: RuntimeSocketDeps;
  private readonly handler: RuntimeSocketHandler;
  private readonly id: IdFactory;
  private readonly backoff: BackoffOptions;
  private readonly handshakeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly liveness: LivenessOptions;
  private state: ConnectionState = "idle";
  private generation = 0;
  private ws: ManagedWebSocket | null = null;
  private wantConnection = false;
  private manualClose = false;
  private disposed = false;
  private reconnectTimer: Timer | null = null;
  private handshakeTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  private reconnectAttempt = 0;
  private unsubOnline: (() => void) | null = null;
  private unsubVisible: (() => void) | null = null;
  private unsubVisibility: (() => void) | null = null;
  /** Liveness (negotiated `runtime.liveness.v1`); disabled until acked. */
  private livenessNegotiated = false;
  private lastInboundAt = 0;
  private hiddenAt: number | null = null;
  private heartbeatTimer: Timer | null = null;
  private pingDeadlineTimer: Timer | null = null;
  private pingOutstanding = false;
  private probeWaiters: ProbeWaiter[] = [];

  constructor(deps: RuntimeSocketDeps, handler: RuntimeSocketHandler) {
    this.deps = deps;
    this.handler = handler;
    this.id = deps.id ?? createDefaultIdFactory(deps.random);
    this.backoff = deps.backoff ?? {};
    this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.liveness = { ...DEFAULT_LIVENESS, ...(deps.liveness ?? {}) };
  }

  get connectionState(): ConnectionState { return this.state; }
  get currentGeneration(): number { return this.generation; }

  /**
   * True when a sendable connection has PROVEN inbound freshness (recent
   * frame or no liveness basis to judge). A stale-but-"ready" connection may
   * be half-open (idle proxy kill never delivered a close) and must be probed
   * before anything is submitted through it.
   */
  isFresh(): boolean {
    if (!this.livenessNegotiated) return true;
    return this.deps.now() - this.lastInboundAt <= this.liveness.freshnessMs;
  }

  /**
   * Probe transport liveness: send one ping (single-flight) and resolve true
   * on ANY inbound frame within `timeoutMs`, false otherwise. Without the
   * negotiated feature there is no honest probe — resolve true (the caller
   * keeps pre-liveness behavior).
   */
  probe(timeoutMs: number): Promise<boolean> {
    if (!this.livenessNegotiated) return Promise.resolve(true);
    if (!canSend(this.state)) return Promise.resolve(false);
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return Promise.resolve(false);
    if (this.probeWaiters.length === 0) this.sendPing();
    return new Promise<boolean>((resolve) => {
      const waiter: ProbeWaiter = { resolve, handle: null };
      waiter.handle = this.deps.setTimeout(() => {
        this.probeWaiters = this.probeWaiters.filter((candidate) => candidate !== waiter);
        resolve(false);
      }, timeoutMs);
      this.probeWaiters.push(waiter);
    });
  }

  /**
   * Force a reconnect NOW (proven-dead transport): the old socket is detached
   * and closed without letting its stale events run, old-generation attempts
   * are failed exactly like any unexpected loss (via `unavailable`), and a
   * fresh connection attempt starts immediately (no backoff wait). No-op when
   * a recovery attempt is already in flight.
   */
  forceReconnect(reason: string): void {
    if (this.disposed || !this.wantConnection) return;
    if (this.state === "connecting" || this.state === "handshaking") return; // recovery already in flight
    this.clearPingState();
    this.resolveProbes(false);
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.clearHandshakeTimer();
    this.clearConnectTimer();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(4000, reason); } catch { /* already closed */ }
    }
    // Unexpected-loss semantics first (old-generation attempts fail closed
    // via the `unavailable` transition — identical to any real loss), then
    // reconnect immediately WITHOUT burning a backoff step: this death was
    // PROVEN, not a failed attempt.
    this.setState("unavailable");
    if (!this.disposed && this.wantConnection) this.openConnection();
  }

  /** Open the socket and run the handshake. No-op if already active or disposed. */
  connect(): void {
    if (this.disposed) return;
    if (this.state !== "idle" && this.state !== "stopped") return;
    this.wantConnection = true;
    this.manualClose = false;
    this.reconnectAttempt = 0;
    this.attachEnvironmentHooks();
    this.openConnection();
  }

  /**
   * Send a validated client message. Throws if the socket is not in a sendable
   * state (post-handshake). RuntimeConnection owns correlation ids/attempts.
   */
  send(message: WsClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || !canSend(this.state)) {
      throw new Error(`runtime socket not sendable (state=${this.state})`);
    }
    const invalid = invalidImageBearingClientMessage(message);
    if (invalid) throw invalid;
    const frame = JSON.stringify(message);
    if (!isWithinRuntimeFrameBudget(frame)) {
      throw {
        code: "invalid_input",
        message: "runtime frame exceeds the size limit",
        retryable: false,
      } satisfies ProtocolError;
    }
    ws.send(frame);
  }

  /** Idempotent transport teardown. NEVER triggers runtime.stop (browser unload rule). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wantConnection = false;
    this.manualClose = true;
    this.clearTimers();
    this.detachEnvironmentHooks();
    this.closeSocket(1000, "client dispose");
    this.setState("stopped");
  }

  // --- internal ----------------------------------------------------------

  private openConnection(): void {
    if (this.disposed || !this.wantConnection) return;
    const gen = (this.generation += 1);
    const url = buildRuntimeWsUrl(this.deps.location);
    this.clearPingState();
    this.stopHeartbeat();
    let ws: ManagedWebSocket;
    try {
      ws = this.deps.createWebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.setState(this.state === "idle" || this.state === "stopped" ? "connecting" : "connecting");
    ws.onopen = () => this.onOpen(gen);
    ws.onmessage = (data) => this.onMessage(gen, data);
    ws.onclose = (info) => this.onClose(gen, info);
    ws.onerror = () => { /* surfaced via onclose */ };
    // Bounded CONNECTING→OPEN: a black-holed TCP attempt (network changed
    // while hidden, proxy accepting nothing) must fail as an attempt, not
    // park the state machine in `connecting` forever.
    this.connectTimer = this.deps.setTimeout(() => {
      this.connectTimer = null;
      if (gen !== this.generation || this.disposed) return;
      const stuck = this.ws;
      this.ws = null;
      if (stuck) {
        stuck.onopen = null;
        stuck.onmessage = null;
        stuck.onclose = null;
        stuck.onerror = null;
        try { stuck.close(4000, "connect timeout"); } catch { /* already closed */ }
      }
      this.scheduleReconnect();
    }, this.connectTimeoutMs);
  }

  private onOpen(gen: number): void {
    if (gen !== this.generation || this.disposed) return;
    this.clearConnectTimer();
    // First frame is always the strict handshake; the socket is OPEN here.
    this.sendHandshake(gen);
  }

  private sendHandshake(gen: number): void {
    if (gen !== this.generation || !this.ws || this.ws.readyState !== WS_OPEN) return;
    this.setState("handshaking");
    // Browser-only lifecycle features (LC-02): observation-only attach and the
    // explicit activate envelope. Both are Browser→Host negotiated seams; they
    // never enter the sessiond/Worker fingerprint. A Host that cannot support
    // them simply does not acknowledge them and the Client degrades honestly
    // (no activating fallback).
    const features = [...new Set([RUNTIME_RUNNING_WATCH_FEATURE, RUNTIME_READ_RPC_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE, RUNTIME_EPOCH_ROLLOVER_FEATURE, RUNTIME_OBSERVE_EXISTING_FEATURE, RUNTIME_EXPLICIT_ACTIVATE_FEATURE, RUNTIME_QUESTIONNAIRE_FEATURE, RUNTIME_LIVENESS_FEATURE, ...(this.deps.features ?? [])])];
    const handshake = buildHandshakeRequest(this.deps.identity, features);
    const frame = JSON.stringify({ type: "handshake", id: this.id(), payload: handshake });
    this.ws.send(frame);
    this.handshakeTimer = this.deps.setTimeout(() => this.onHandshakeTimeout(gen), this.handshakeTimeoutMs);
  }

  private onMessage(gen: number, data: string): void {
    if (gen !== this.generation || this.disposed) return;
    const parsed = parseHostFrame(data);
    if (!parsed.ok) {
      // Unknown / invalid frame: fail closed.
      this.failClosed("invalid runtime frame");
      return;
    }
    const message = parsed.message;
    // ANY parsed inbound frame proves the transport is alive.
    this.lastInboundAt = this.deps.now();
    this.clearPingState();
    this.resolveProbes(true);
    if (message.type === "handshake_ack") {
      this.clearHandshakeTimer();
      const host: NegotiatedHost = {
        mode: message.payload.host.mode,
        capabilities: [...message.payload.host.capabilities],
        limits: message.payload.limits,
      };
      this.reconnectAttempt = 0;
      this.livenessNegotiated = (message.payload.acceptedFeatures ?? []).includes(RUNTIME_LIVENESS_FEATURE);
      this.setState("ready");
      this.handler.onHandshakeAck(host, message.payload);
      if (this.livenessNegotiated) this.startHeartbeat();
      return;
    }
    if (message.type === "handshake_reject") {
      this.clearHandshakeTimer();
      this.handler.onHandshakeReject(message.payload.error);
      this.manualClose = true;
      this.wantConnection = false;
      this.closeSocket(1000, "handshake rejected");
      this.setState("stopped");
      return;
    }
    if (message.type === "pong") {
      // Transport-level liveness echo; consumed here, never projected.
      return;
    }
    if (this.state === "handshaking" || this.state === "connecting") {
      // No data frames (including runtime_unavailable) are permitted before the
      // handshake ack — fail closed per the handshake protocol (LOW).
      this.failClosed("data frame before handshake ack");
      return;
    }
    this.handler.onMessage(message, gen);
  }

  private onHandshakeTimeout(gen: number): void {
    if (gen !== this.generation) return;
    this.failClosed("handshake timeout");
  }

  private onClose(gen: number, _info: { code: number; reason: string; wasClean: boolean }): void {
    if (gen !== this.generation) return; // stale socket
    this.ws = null;
    this.clearHandshakeTimer();
    this.clearConnectTimer();
    this.clearPingState();
    this.resolveProbes(false);
    this.stopHeartbeat();
    if (this.manualClose || !this.wantConnection || this.disposed) {
      if (this.state !== "stopped") this.setState("stopped");
      return;
    }
    // Unexpected close → retryable reconnect with backoff.
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.wantConnection) {
      this.setState("stopped");
      return;
    }
    this.reconnectAttempt += 1;
    const delay = computeBackoffDelay(this.reconnectAttempt, this.deps.random, this.backoff);
    this.setState("unavailable");
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnection || this.disposed) return;
      this.setState("reconnecting");
      this.openConnection();
    }, delay);
  }

  /** Try an immediate reconnect (online/visibility recovery), resetting the wait. */
  private tryImmediateReconnect(): void {
    if (this.disposed || !this.wantConnection) return;
    // A sendable connection needs a liveness PROBE, not a blind reconnect
    // (handled by the visibility/wake path); an in-flight connect/handshake
    // attempt is already the fastest recovery — opening a second socket in
    // parallel would leak one of them.
    if (this.state === "attached" || this.state === "ready" || this.state === "attaching"
      || this.state === "connecting" || this.state === "handshaking") return;
    // Cancel a pending backoff and reconnect now.
    if (this.reconnectTimer !== null) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openConnection();
  }

  /**
   * Wake-from-hidden liveness decision: after hiding past the threshold, a
   * sendable-but-stale connection is probed; a failed probe forces a
   * reconnect so the first user action lands on a PROVEN transport.
   */
  private handleVisibilityChange(visible: boolean): void {
    if (!visible) {
      this.hiddenAt = this.deps.now();
      return;
    }
    const hiddenFor = this.hiddenAt === null ? 0 : this.deps.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (hiddenFor < this.liveness.hiddenProbeThresholdMs) return;
    if (!this.livenessNegotiated || !canSend(this.state)) return;
    if (this.isFresh()) return;
    void this.probe(this.liveness.pongTimeoutMs).then((alive) => {
      if (alive || this.disposed || !this.wantConnection) return;
      if (!canSend(this.state)) return; // loss already surfaced; recovery owns it
      this.forceReconnect("liveness probe failed after wake");
    });
  }

  private attachEnvironmentHooks(): void {
    if (this.unsubOnline === null) this.unsubOnline = this.deps.onOnline(() => this.tryImmediateReconnect());
    if (this.unsubVisible === null) this.unsubVisible = this.deps.onVisible(() => this.tryImmediateReconnect());
    if (this.unsubVisibility === null && this.deps.onVisibility !== undefined) {
      this.unsubVisibility = this.deps.onVisibility((visible) => this.handleVisibilityChange(visible));
    }
  }

  private detachEnvironmentHooks(): void {
    this.unsubOnline?.();
    this.unsubVisible?.();
    this.unsubVisibility?.();
    this.unsubOnline = null;
    this.unsubVisible = null;
    this.unsubVisibility = null;
  }

  private failClosed(reason: string): void {
    this.manualClose = true;
    this.wantConnection = false;
    this.clearPingState();
    this.resolveProbes(false);
    this.stopHeartbeat();
    this.closeSocket(1008, reason);
    this.setState("stopped");
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(code, reason); } catch { /* already closed */ }
    }
  }

  // --- liveness internals -------------------------------------------------

  /** Start the heartbeat chain for the CURRENT generation (post-ack only). */
  private startHeartbeat(): void {
    if (!this.livenessNegotiated || this.heartbeatTimer !== null) return;
    this.scheduleHeartbeatTick(this.generation);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.deps.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleHeartbeatTick(gen: number): void {
    this.heartbeatTimer = this.deps.setTimeout(() => {
      this.heartbeatTimer = null;
      if (gen !== this.generation || this.disposed || !this.wantConnection) return;
      this.runHeartbeatTick(gen);
    }, this.liveness.heartbeatIntervalMs);
  }

  private runHeartbeatTick(gen: number): void {
    if (canSend(this.state)) {
      // Recent inbound traffic proves liveness better than a ping would; an
      // outstanding ping is policed by its own pong deadline.
      if (this.deps.now() - this.lastInboundAt >= this.liveness.heartbeatIntervalMs && !this.pingOutstanding) {
        this.sendPing();
      }
      this.scheduleHeartbeatTick(gen);
    }
    // Non-sendable states: the reconnect machinery owns recovery; the chain
    // restarts with the next handshake ack.
  }

  /** Single-flight ping; the pong deadline proves the transport dead. */
  private sendPing(): void {
    if (this.pingOutstanding) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || !canSend(this.state)) return;
    try {
      ws.send(JSON.stringify({ type: "ping", id: this.id() }));
    } catch {
      return; // send failures surface via onclose; a probe still has its own deadline
    }
    this.pingOutstanding = true;
    this.pingDeadlineTimer = this.deps.setTimeout(() => {
      this.pingDeadlineTimer = null;
      if (!this.pingOutstanding) return;
      this.pingOutstanding = false;
      this.forceReconnect("liveness pong timeout");
    }, this.liveness.pongTimeoutMs);
  }

  /** Any inbound frame proves liveness: retire the outstanding ping. */
  private clearPingState(): void {
    this.pingOutstanding = false;
    if (this.pingDeadlineTimer !== null) {
      this.deps.clearTimeout(this.pingDeadlineTimer);
      this.pingDeadlineTimer = null;
    }
  }

  private resolveProbes(alive: boolean): void {
    if (this.probeWaiters.length === 0) return;
    const waiters = this.probeWaiters;
    this.probeWaiters = [];
    for (const waiter of waiters) {
      if (waiter.handle !== null) this.deps.clearTimeout(waiter.handle);
      waiter.resolve(alive);
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      this.deps.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.deps.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    this.clearConnectTimer();
    this.clearPingState();
    this.resolveProbes(false);
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handler.onConnectionState(state);
  }
}

/** Default browser WebSocket factory wrapping the native WebSocket. */
export function createBrowserWebSocket(url: string): ManagedWebSocket {
  const ws = new WebSocket(url);
  const managed: ManagedWebSocket = {
    get readyState() { return ws.readyState; },
    send: (data) => ws.send(data),
    close: (code, reason) => {
      if (code === undefined) ws.close();
      else if (reason === undefined) ws.close(code);
      else ws.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => { managed.onopen?.(); };
  ws.onmessage = (ev) => { managed.onmessage?.(typeof ev.data === "string" ? ev.data : String(ev.data)); };
  ws.onclose = (ev) => { managed.onclose?.({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean }); };
  ws.onerror = () => { managed.onerror?.(); };
  return managed;
}
