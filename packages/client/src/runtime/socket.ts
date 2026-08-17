/**
 * RuntimeSocket — single WebSocket transport for the pix Runtime Protocol v2.
 *
 * Responsibilities (transport ONLY — projection/cursor live in SessionStore):
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
  readonly features?: readonly string[];
  readonly backoff?: BackoffOptions;
  readonly handshakeTimeoutMs?: number;
  readonly id?: IdFactory;
}

/** Host information negotiated at handshake (mode + capabilities + limits). */
export interface NegotiatedHost {
  readonly mode: HostMode;
  readonly capabilities: readonly string[];
  readonly limits: HostLimits;
}

/** Sink for socket events; implemented by SessionStore. */
export interface RuntimeSocketHandler {
  onConnectionState(state: ConnectionState): void;
  onHandshakeAck(host: NegotiatedHost, response: ProtocolHandshakeResponse): void;
  onHandshakeReject(error: ProtocolError): void;
  onMessage(message: WsHostMessage, generation: number): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;

export class RuntimeSocket {
  private readonly deps: RuntimeSocketDeps;
  private readonly handler: RuntimeSocketHandler;
  private readonly id: IdFactory;
  private readonly backoff: BackoffOptions;
  private readonly handshakeTimeoutMs: number;
  private state: ConnectionState = "idle";
  private generation = 0;
  private ws: ManagedWebSocket | null = null;
  private wantConnection = false;
  private manualClose = false;
  private disposed = false;
  private reconnectTimer: Timer | null = null;
  private handshakeTimer: Timer | null = null;
  private reconnectAttempt = 0;
  private unsubOnline: (() => void) | null = null;
  private unsubVisible: (() => void) | null = null;

  constructor(deps: RuntimeSocketDeps, handler: RuntimeSocketHandler) {
    this.deps = deps;
    this.handler = handler;
    this.id = deps.id ?? createDefaultIdFactory(deps.random);
    this.backoff = deps.backoff ?? {};
    this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  get connectionState(): ConnectionState { return this.state; }
  get currentGeneration(): number { return this.generation; }

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
   * state (post-handshake). The caller (store) owns correlation ids.
   */
  send(message: WsClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || !canSend(this.state)) {
      throw new Error(`runtime socket not sendable (state=${this.state})`);
    }
    ws.send(JSON.stringify(message));
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
  }

  private onOpen(gen: number): void {
    if (gen !== this.generation || this.disposed) return;
    // First frame is always the strict handshake; the socket is OPEN here.
    this.sendHandshake(gen);
  }

  private sendHandshake(gen: number): void {
    if (gen !== this.generation || !this.ws || this.ws.readyState !== WS_OPEN) return;
    this.setState("handshaking");
    const handshake = buildHandshakeRequest(this.deps.identity, this.deps.features);
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
    if (message.type === "handshake_ack") {
      this.clearHandshakeTimer();
      const host: NegotiatedHost = {
        mode: message.payload.host.mode,
        capabilities: [...message.payload.host.capabilities],
        limits: message.payload.limits,
      };
      this.reconnectAttempt = 0;
      this.setState("ready");
      this.handler.onHandshakeAck(host, message.payload);
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
    if (this.state === "attached" || this.state === "ready" || this.state === "attaching") return;
    // Cancel a pending backoff and reconnect now.
    if (this.reconnectTimer !== null) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.openConnection();
  }

  private attachEnvironmentHooks(): void {
    if (this.unsubOnline === null) this.unsubOnline = this.deps.onOnline(() => this.tryImmediateReconnect());
    if (this.unsubVisible === null) this.unsubVisible = this.deps.onVisible(() => this.tryImmediateReconnect());
  }

  private detachEnvironmentHooks(): void {
    this.unsubOnline?.();
    this.unsubVisible?.();
    this.unsubOnline = null;
    this.unsubVisible = null;
  }

  private failClosed(reason: string): void {
    this.manualClose = true;
    this.wantConnection = false;
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

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.deps.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
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
