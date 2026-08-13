import {
  PROTOCOL_VERSION,
  ProtocolErrorCodeSchema,
  WsClientMessageSchema,
  WsHandshakeMessageSchema,
  type ProtocolError,
  type ProtocolHandshakeResponse,
  type RuntimeAttachParams,
  type SessiondMethodParams,
  type SessiondMethodResult,
  type SessiondRpcMethod,
  type SessiondPush,
  type WsClientMessage,
} from "@fffattiger/pix-protocol";
import {
  SessiondRpcClient,
  type SessiondRpcSubscription,
} from "@fffattiger/pix-sessiond/client";
import type {
  HostCapability,
  HostLogger,
  HostMode,
  RuntimeWsSeam,
  WsSession,
} from "../types.js";

/**
 * Narrow sessiond client surface the gateway consumes. The real
 * {@link SessiondRpcClient} satisfies it; tests inject a fake.
 */
export interface SessiondRuntimeClient {
  call<M extends SessiondRpcMethod>(method: M, params: SessiondMethodParams[M]): Promise<SessiondMethodResult[M]>;
  attach(
    params: SessiondMethodParams["runtime.attach"],
    onPush: (push: SessiondPush) => void | Promise<void>,
  ): Promise<SessiondRpcSubscription<SessiondMethodResult["runtime.attach"]>>;
}

export interface SessiondRuntimeGatewayLimits {
  /** Max upload bytes advertised in the handshake (default 0). */
  readonly maxUpload?: number;
  /** Max concurrent open sessions advertised in the handshake (default 4). */
  readonly maxOpenSessions?: number;
}

export interface SessiondRuntimeGatewayOutboundLimits {
  /** Max queued outbound frames before fail-closed close (default 256). */
  readonly maxFrames?: number;
  /** Max queued outbound bytes before fail-closed close (default 4 MiB). */
  readonly maxBytes?: number;
  /** Max raw socket bufferedAmount before fail-closed close (default 4 MiB). */
  readonly maxBufferedAmount?: number;
}

export interface SessiondRuntimeGatewayInboundLimits {
  /** Max pending non-interrupt frames in the inbound serial queue (default 256). */
  readonly maxSerialFrames?: number;
  /** Max pending non-interrupt bytes in the inbound serial queue (default 4 MiB). */
  readonly maxSerialBytes?: number;
  /** Max concurrently in-flight interrupts per socket (default 16). */
  readonly maxInflightInterrupts?: number;
}

export interface SessiondRuntimeGatewayOptions {
  /** sessiond RPC endpoint. Required unless {@link client} is injected. */
  readonly endpoint?: string;
  /** sessiond RPC secret. Required unless {@link client} is injected. */
  readonly secret?: string;
  /** Trusted exposure mode advertised in the handshake. */
  readonly mode: HostMode;
  /**
   * Static capabilities advertised in the handshake when no {@link resolveCapabilities}
   * resolver is wired (M2: agent capability pending R2). Used as the default so
   * generic tests / injection keep working unchanged.
   */
  readonly capabilities?: readonly HostCapability[];
  /**
   * Optional async capability resolver invoked once per connection after a
   * valid hello. Lets the production composition project capabilities
   * consistently with the HTTP projection (sessiond healthy ⇒ agent; otherwise
   * none) instead of baking a static answer at construction time. When the
   * resolver rejects/throws, the gateway logs a sanitized warning and fails
   * closed to an empty capability set (never leaks the error to the client).
   */
  readonly resolveCapabilities?: () => Promise<readonly HostCapability[]>;
  /** Inject a narrow client (or factory) for tests. */
  readonly client?: SessiondRuntimeClient;
  readonly clientFactory?: () => SessiondRuntimeClient;
  readonly limits?: SessiondRuntimeGatewayLimits;
  readonly outbound?: SessiondRuntimeGatewayOutboundLimits;
  readonly inbound?: SessiondRuntimeGatewayInboundLimits;
  /** Per-RPC timeout passed to a created client (default 10_000 ms). */
  readonly timeoutMs?: number;
  /** Testable clock for serverTime (default Date.now). */
  readonly now?: () => number;
  readonly logger?: HostLogger;
}

const DEFAULT_MAX_FRAMES = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED = 4 * 1024 * 1024;
const DEFAULT_MAX_OPEN_SESSIONS = 4;
const DEFAULT_MAX_SERIAL_FRAMES = 256;
const DEFAULT_MAX_SERIAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT_INTERRUPTS = 16;

const CLOSE_PROTOCOL_ERROR = 1008;
const CLOSE_MESSAGE_TOO_BIG = 1009;
const CLOSE_INTERNAL_ERROR = 1011;

/** Invalid operator/test limits fall back to safe defaults, never disable a bound. */
function positiveSafeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Map a sessiond RPC exception into a structured, sanitized ProtocolError. */
export function mapRpcError(error: unknown): ProtocolError {
  if (error !== null && typeof error === "object" && "code" in error) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
    const parsed = ProtocolErrorCodeSchema.safeParse(candidate.code);
    if (parsed.success) {
      const message = typeof candidate.message === "string" ? candidate.message : "sessiond request failed";
      const retryable = candidate.retryable === true;
      return {
        code: parsed.data,
        message,
        retryable,
        ...(candidate.details === undefined ? {} : { details: candidate.details }),
      };
    }
  }
  // Unknown error: sanitize. Never leak stack, secret or endpoint path.
  return { code: "unavailable", message: "sessiond request failed", retryable: false };
}

function rpcErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Bounded FIFO inbound serial queue. Tasks run one at a time so attach/command
 * never interleave per socket; pending frames + bytes are capped so a flood of
 * frames (e.g. commands whose RPC never settles) cannot grow memory unbounded.
 * Overflow is reported to the caller (fail-closed close). Each task releases
 * its reserved slot/bytes in `finally`, and after {@link close} queued tasks
 * short-circuit without dispatching.
 */
class BoundedSerialQueue {
  private pending = 0;
  private pendingBytes = 0;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxFrames: number,
    private readonly maxBytes: number,
  ) {}

  /** Current pending tasks (queued + running). For diagnostics. */
  get depth(): number {
    return this.pending;
  }

  /** Reserve `bytes` for a task. Returns false on overflow (caller fail-closes); true when accepted or already closed. */
  enqueue(task: () => Promise<void> | void, bytes: number): boolean {
    if (this.closed) return true;
    if (this.pending + 1 > this.maxFrames) return false;
    if (this.pendingBytes + bytes > this.maxBytes) return false;
    this.pending += 1;
    this.pendingBytes += bytes;
    const run = async (): Promise<void> => {
      try {
        if (this.closed) return; // short-circuit queued-after-close: no dispatch
        await task();
      } finally {
        this.pending -= 1;
        this.pendingBytes -= bytes;
      }
    };
    this.tail = this.tail.then(run).catch(() => undefined);
    return true;
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Bounded serial outbound queue. Frames are sent in FIFO order; the snapshot
 * always precedes replay/live events because callers enqueue in order. Overflow
 * (frame count, queued bytes, or raw bufferedAmount) is reported so the caller
 * can fail closed instead of growing unbounded memory.
 */
class BoundedOutbound {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private flushing = false;
  private overflowed = false;
  private closed = false;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private readonly maxBufferedAmount: number;

  constructor(
    private readonly session: WsSession,
    options: SessiondRuntimeGatewayOutboundLimits,
    private readonly onOverflow: () => void,
  ) {
    this.maxFrames = positiveSafeInteger(options.maxFrames, DEFAULT_MAX_FRAMES);
    this.maxBytes = positiveSafeInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxBufferedAmount = positiveSafeInteger(options.maxBufferedAmount, DEFAULT_MAX_BUFFERED);
  }

  /** Returns false on enqueue-time overflow (frame/byte bound); the connection
   * fail-closes via {@link onOverflow} on any overflow path. */
  enqueue(frame: string): boolean {
    if (this.closed || this.overflowed) return true;
    const size = Buffer.byteLength(frame, "utf8");
    if (this.queue.length + 1 > this.maxFrames || this.queuedBytes + size > this.maxBytes) {
      this.markOverflow();
      return false;
    }
    this.queue.push(frame);
    this.queuedBytes += size;
    void this.flush();
    return true;
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  /** True once an overflow has forced the queue to drop further frames. */
  get failed(): boolean {
    return this.overflowed;
  }

  private markOverflow(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.onOverflow();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        if (this.closed || this.overflowed) return;
        if (this.session.bufferedAmount > this.maxBufferedAmount) {
          this.markOverflow();
          return;
        }
        const frame = this.queue.shift();
        if (frame === undefined) break;
        this.queuedBytes -= Buffer.byteLength(frame, "utf8");
        this.session.send(frame);
      }
    } finally {
      this.flushing = false;
    }
  }
}

interface GatewayConfig {
  readonly client: SessiondRuntimeClient;
  readonly handshakeResponse: ProtocolHandshakeResponse;
  readonly outboundLimits: SessiondRuntimeGatewayOutboundLimits;
  readonly inboundLimits: Required<SessiondRuntimeGatewayInboundLimits>;
  readonly logger: HostLogger;
}

interface ActiveAttach {
  readonly generation: number;
  readonly sessionId: string;
  readonly subscription: SessiondRpcSubscription<SessiondMethodResult["runtime.attach"]>;
  intentionalClose: boolean;
}

type SnapshotPayload = {
  sessionId: string;
  cwd: string;
  projectRoot: string;
  epoch: string;
  lastEventId: number;
  workerStatus: string;
  snapshot: unknown;
  resumeStatus: string;
};

/**
 * Host runtime WS gateway backed by the narrow sessiond client. Implements the
 * H1 {@link RuntimeWsSeam}: it speaks the pix Runtime Protocol v1 on the browser
 * socket and proxies create/attach/command/interrupt/getSnapshot/stop/detach to
 * sessiond over local RPC.
 *
 * The gateway owns only its own WS/RPC resources. A Host restart/close releases
 * these and never stops the daemon or a Worker. epoch/eventId are owned by
 * sessiond; the gateway never synthesizes them.
 */
export class SessiondRuntimeGateway implements RuntimeWsSeam {
  private readonly client: SessiondRuntimeClient;
  private readonly mode: HostMode;
  private readonly defaultCapabilities: readonly HostCapability[];
  private readonly resolveCapabilitiesField: (() => Promise<readonly HostCapability[]>) | undefined;
  private readonly limits: SessiondRuntimeGatewayLimits;
  private readonly now: () => number;
  private readonly outboundLimits: SessiondRuntimeGatewayOutboundLimits;
  private readonly inboundLimits: Required<SessiondRuntimeGatewayInboundLimits>;
  private readonly logger: HostLogger;

  constructor(options: SessiondRuntimeGatewayOptions) {
    if (options.client) {
      this.client = options.client;
    } else if (options.clientFactory) {
      this.client = options.clientFactory();
    } else {
      if (options.endpoint === undefined || options.secret === undefined) {
        throw new Error("SessiondRuntimeGateway requires endpoint+secret or an injected client");
      }
      const endpoint = options.endpoint;
      const secret = options.secret;
      this.client = new SessiondRpcClient(
        options.timeoutMs !== undefined ? { endpoint, secret, timeoutMs: options.timeoutMs } : { endpoint, secret },
      );
    }
    // Capabilities are NOT baked into a handshake response here: when a resolver
    // is wired, each connection resolves it once after a valid hello so the WS
    // projection matches the HTTP projection instead of being fixed at boot.
    this.mode = options.mode;
    this.defaultCapabilities = [...(options.capabilities ?? [])];
    this.resolveCapabilitiesField = options.resolveCapabilities;
    this.limits = options.limits ?? {};
    this.now = options.now ?? Date.now;
    this.outboundLimits = options.outbound ?? {};
    this.inboundLimits = {
      maxSerialFrames: positiveSafeInteger(options.inbound?.maxSerialFrames, DEFAULT_MAX_SERIAL_FRAMES),
      maxSerialBytes: positiveSafeInteger(options.inbound?.maxSerialBytes, DEFAULT_MAX_SERIAL_BYTES),
      maxInflightInterrupts: positiveSafeInteger(options.inbound?.maxInflightInterrupts, DEFAULT_MAX_INFLIGHT_INTERRUPTS),
    };
    this.logger = options.logger ?? {};
  }

  /** Build a per-connection handshake response (serverTime is fresh per connection). */
  private buildHandshakeResponse(capabilities: readonly HostCapability[]): ProtocolHandshakeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      host: { mode: this.mode, capabilities: [...capabilities] },
      limits: {
        maxUpload: this.limits.maxUpload ?? 0,
        maxOpenSessions: this.limits.maxOpenSessions ?? DEFAULT_MAX_OPEN_SESSIONS,
      },
      sessionSnapshotSupport: true,
      serverTime: this.now(),
    };
  }

  /**
   * Resolve advertised capabilities for a single connection. Falls back to the
   * static default when no resolver is wired. A resolver that rejects/throws is
   * fail-closed to an empty set with a sanitized warning; the error is never
   * forwarded to the client (it carries no capabilities, no message).
   */
  private async resolveConnectionCapabilities(): Promise<readonly HostCapability[]> {
    if (this.resolveCapabilitiesField === undefined) return this.defaultCapabilities;
    try {
      return [...(await this.resolveCapabilitiesField())];
    } catch {
      this.logger.warn?.("runtime gateway capability resolver failed; advertising no capabilities");
      return [];
    }
  }

  async attach(session: WsSession, hello: string): Promise<void> {
    const parsed = WsHandshakeMessageSchema.safeParse(safeJson(hello));
    if (!parsed.success) {
      this.write(session, {
        type: "handshake_reject",
        payload: { error: { code: "protocol_mismatch", message: "unsupported runtime protocol handshake", retryable: false } },
      });
      session.close(CLOSE_PROTOCOL_ERROR, "handshake rejected");
      return;
    }
    const handshake = parsed.data;
    // Resolve capabilities once for this connection AFTER a valid hello, then
    // bake a connection-specific response that both this initial ack and any
    // subsequent repeated handshake reuse (no static-then-async correction).
    const handshakeResponse = this.buildHandshakeResponse(await this.resolveConnectionCapabilities());
    this.write(session, {
      type: "handshake_ack",
      ...(handshake.id !== undefined ? { id: handshake.id } : {}),
      payload: handshakeResponse,
    });
    const config: GatewayConfig = {
      client: this.client,
      handshakeResponse,
      outboundLimits: this.outboundLimits,
      inboundLimits: this.inboundLimits,
      logger: this.logger,
    };
    void new GatewayConnection(config, session).start();
  }

  private write(session: WsSession, message: unknown): void {
    session.send(JSON.stringify(message));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * True when a command is a D2-P4 queued turn (steer / follow_up). These run on
 * the INDEPENDENT queued-turn lane so they are never HOL-blocked behind a
 * long-running prompt command on the serial lane.
 */
function isQueuedTurnCommand(message: WsClientMessage): boolean {
  return message.type === "command" && (message.payload.command.type === "steer" || message.payload.command.type === "follow_up");
}

/**
 * Per-browser-connection state machine. Created after a successful handshake;
 * owns inbound serialization, the outbound queue, the active attach
 * subscription and lifecycle cleanup.
 */
class GatewayConnection {
  private readonly outbound: BoundedOutbound;
  private readonly serial: BoundedSerialQueue;
  /** D2-P4 independent bounded FIFO lane for steer / follow_up queued turns. */
  private readonly queuedTurnSerial: BoundedSerialQueue;
  private readonly maxInflightInterrupts: number;
  private inflightInterrupts = 0;
  private generation = 0;
  private active: ActiveAttach | undefined;
  private browserClosed = false;

  constructor(private readonly config: GatewayConfig, private readonly session: WsSession) {
    this.outbound = new BoundedOutbound(session, config.outboundLimits, () => this.onOutboundOverflow());
    this.serial = new BoundedSerialQueue(config.inboundLimits.maxSerialFrames, config.inboundLimits.maxSerialBytes);
    // D2-P4: steer/follow_up share the same bounded inbound limits but run on
    // an INDEPENDENT FIFO, so a long-running prompt (serial lane) never
    // HOL-blocks a queued turn. Both lanes may run concurrently; interrupts
    // remain on the fire-and-forget bypass path.
    this.queuedTurnSerial = new BoundedSerialQueue(config.inboundLimits.maxSerialFrames, config.inboundLimits.maxSerialBytes);
    this.maxInflightInterrupts = config.inboundLimits.maxInflightInterrupts;
  }

  start(): void {
    this.session.onMessage((data) => this.onFrame(data));
    this.session.onClose(() => this.onBrowserClose());
  }

  private onFrame(raw: string): void {
    if (this.browserClosed) return;
    const data = safeJson(raw);
    if (data === undefined) {
      this.failProtocol("invalid JSON runtime frame");
      return;
    }
    const parsed = WsClientMessageSchema.safeParse(data);
    if (!parsed.success) {
      this.failProtocol("invalid runtime frame");
      return;
    }
    const message = parsed.data;
    if (message.type === "interrupt") {
      // Independent, non-queued control path: an interrupt must never wait
      // behind a long-running command (protocol guarantee). It uses its own
      // sessiond RPC connection, so it cannot reorder an in-flight command.
      void this.handleInterrupt(message);
      return;
    }
    // Bounded inbound serial queue(s): reserve raw UTF-8 bytes before enqueuing
    // so a flood of frames (e.g. commands whose RPC never settles) cannot grow
    // memory unbounded. Overflow fails closed without dispatching. D2-P4 routes
    // steer/follow_up to the independent queued-turn lane so they are never
    // HOL-blocked behind a long-running prompt; all other frames stay on the
    // ordinary serial lane (create/attach/detach/getSnapshot/stop never run
    // concurrently). Both lanes are bounded by the same inbound limits.
    const bytes = Buffer.byteLength(raw, "utf8");
    const queuedTurn = isQueuedTurnCommand(message);
    const lane = queuedTurn ? this.queuedTurnSerial : this.serial;
    if (!lane.enqueue(() => this.handleParsed(message), bytes)) {
      this.config.logger.warn?.("runtime gateway inbound overflow; closing", {
        lane: queuedTurn ? "queued-turn" : "serial",
        bytes,
        pending: lane.depth,
      });
      this.closeBrowser(CLOSE_MESSAGE_TOO_BIG, "inbound queue overflow");
      return;
    }
  }

  private async handleParsed(message: WsClientMessage): Promise<void> {
    if (this.browserClosed) return;
    try {
      await this.dispatch(message);
    } catch (error) {
      // dispatch() maps its own errors; a throw here is a bug — fail closed.
      this.config.logger.error?.("runtime gateway dispatch failed", { error: error instanceof Error ? error.message : String(error) });
      this.closeBrowser(CLOSE_INTERNAL_ERROR, "runtime gateway error");
    }
  }

  private async dispatch(message: WsClientMessage): Promise<void> {
    switch (message.type) {
      case "handshake":
        this.send({ type: "handshake_ack", ...(message.id !== undefined ? { id: message.id } : {}), payload: this.config.handshakeResponse });
        return;
      case "create":
        await this.handleCreate(message);
        return;
      case "attach":
        await this.handleAttach(message);
        return;
      case "detach":
        this.handleDetach(message);
        return;
      case "command":
        await this.handleCommand(message);
        return;
      case "getSnapshot":
        await this.handleGetSnapshot(message);
        return;
      case "stop":
        await this.handleStop(message);
        return;
      default:
        // interrupt is routed before serialization in onFrame.
        return;
    }
  }

  private async handleCreate(message: Extract<WsClientMessage, { type: "create" }>): Promise<void> {
    try {
      const result = await this.config.client.call("runtime.create", message.payload);
      this.send({ type: "response", id: message.id, payload: { ok: true, result } });
    } catch (error) {
      this.send({ type: "response", id: message.id, payload: { ok: false, error: mapRpcError(error) } });
    }
  }

  private async handleAttach(message: Extract<WsClientMessage, { type: "attach" }>): Promise<void> {
    const params = message.payload;
    const generation = ++this.generation;
    this.closeActive(true, true);
    const onPush = (push: SessiondPush): void => {
      if (this.active === undefined || this.active.generation !== generation) return;
      if (push.type === "event") this.send({ type: "event", payload: push.event });
      // Replay/live snapshots stay id-less: only the initial attach snapshot
      // carries the request id (see handleAttach).
      else this.send({ type: "snapshot", payload: this.snapshotFromPush(push) });
    };
    try {
      const subscription = await this.coldAttach(params, onPush);
      if (this.browserClosed || generation !== this.generation) {
        // superseded or gone while connecting
        subscription.close();
        return;
      }
      const entry: ActiveAttach = { generation, sessionId: params.sessionId, subscription, intentionalClose: false };
      this.active = entry;
      // Initial snapshot BEFORE any replay/live event. It carries the attach
      // request id so the client can strictly correlate success by
      // (generation, request id); later sessiond push snapshots stay id-less.
      this.send({ type: "snapshot", id: message.id, payload: this.snapshotFromAttach(subscription.response) });
      void subscription.closed.then(() => this.onAttachClosed(entry));
    } catch (error) {
      if (generation !== this.generation) return; // superseded
      this.send({ type: "response", id: message.id, payload: { ok: false, error: mapRpcError(error) } });
    }
  }

  /** Cold open → attach: retry once with runtime.activate on worker_unavailable. */
  private async coldAttach(
    params: RuntimeAttachParams,
    onPush: (push: SessiondPush) => void | Promise<void>,
  ): Promise<SessiondRpcSubscription<SessiondMethodResult["runtime.attach"]>> {
    try {
      return await this.config.client.attach(params, onPush);
    } catch (error) {
      if (rpcErrorCode(error) === "worker_unavailable") {
        // Activate the (presumably valid but inactive) session, then retry.
        await this.config.client.call("runtime.activate", { sessionId: params.sessionId }); // throws not_found for invalid
        return await this.config.client.attach(params, onPush);
      }
      throw error;
    }
  }

  private handleDetach(message: Extract<WsClientMessage, { type: "detach" }>): void {
    const sessionId = message.payload.sessionId;
    this.closeActiveForSession(sessionId, true, true);
    if (message.id !== undefined) {
      this.send({ type: "response", id: message.id, payload: { ok: true, result: { sessionId, detached: true } } });
    }
  }

  private async handleCommand(message: Extract<WsClientMessage, { type: "command" }>): Promise<void> {
    const id = message.id ?? message.payload.command.commandId;
    try {
      const result = await this.config.client.call("runtime.command", message.payload);
      this.send({ type: "response", id, payload: { ok: true, result } });
    } catch (error) {
      this.send({ type: "response", id, payload: { ok: false, error: mapRpcError(error) } });
    }
  }

  private async handleInterrupt(message: Extract<WsClientMessage, { type: "interrupt" }>): Promise<void> {
    // Bounded concurrency: a socket may hold at most maxInflightInterrupts
    // interrupts in flight. The (N+1)th fails closed WITHOUT opening an RPC.
    if (this.inflightInterrupts >= this.maxInflightInterrupts) {
      this.config.logger.warn?.("runtime gateway interrupt cap exceeded; closing", { inflight: this.inflightInterrupts });
      this.closeBrowser(CLOSE_PROTOCOL_ERROR, "too many concurrent interrupts");
      return;
    }
    this.inflightInterrupts += 1;
    try {
      if (this.browserClosed) return; // closed while waiting for a slot
      const { sessionId, commandId, interrupt } = message.payload;
      const interruptType = interrupt.type;
      let rpc;
      try {
        rpc = await this.config.client.call("runtime.interrupt", { sessionId, commandId, interrupt });
      } catch (error) {
        // late failure after browser close: drop the result, counter still releases in finally
        if (this.browserClosed) return;
        const mapped = mapRpcError(error);
        this.send({ type: "interrupt_result", id: message.id, payload: { sessionId, commandId, interruptType, result: { ok: false, type: interruptType, error: mapped } } });
        return;
      }
      // late success after browser close: drop, do not send
      if (this.browserClosed) return;
      this.send({ type: "interrupt_result", id: message.id, payload: { sessionId, commandId, interruptType, result: rpc.result } });
    } finally {
      this.inflightInterrupts -= 1;
    }
  }

  private async handleGetSnapshot(message: Extract<WsClientMessage, { type: "getSnapshot" }>): Promise<void> {
    try {
      const result = await this.config.client.call("runtime.getSnapshot", message.payload);
      this.send({ type: "response", id: message.id, payload: { ok: true, result } });
    } catch (error) {
      this.send({ type: "response", id: message.id, payload: { ok: false, error: mapRpcError(error) } });
    }
  }

  private async handleStop(message: Extract<WsClientMessage, { type: "stop" }>): Promise<void> {
    const sessionId = message.payload.sessionId;
    try {
      const result = await this.config.client.call("runtime.stop", { sessionId, ...(message.payload.reason !== undefined ? { reason: message.payload.reason } : {}) });
      this.send({ type: "response", id: message.id, payload: { ok: true, result } });
    } catch (error) {
      this.send({ type: "response", id: message.id, payload: { ok: false, error: mapRpcError(error) } });
    }
    // stop also tears down the matching attach subscription (intentional, no detach).
    this.closeActiveForSession(sessionId, true, false);
  }

  // --- attach stream lifecycle --------------------------------------------

  /** Unexpected attach stream break → runtime_unavailable + reconnect prompt. */
  private onAttachClosed(entry: ActiveAttach): void {
    if (this.active !== entry) return; // superseded
    if (entry.intentionalClose) return; // local detach/switch/stop/browser-close
    this.active = undefined;
    this.send({
      type: "runtime_unavailable",
      payload: { sessionId: entry.sessionId, error: { code: "runtime_unavailable", message: "session attach stream closed", retryable: true } },
    });
    this.closeBrowser(CLOSE_INTERNAL_ERROR, "runtime attach stream closed");
  }

  // --- browser socket lifecycle -------------------------------------------

  private onBrowserClose(): void {
    if (this.browserClosed) return;
    this.browserClosed = true;
    this.outbound.close();
    this.serial.close(); // queued inbound tasks short-circuit without dispatching
    this.queuedTurnSerial.close(); // D2-P4 queued-turn lane short-circuits too
    // Best-effort detach only; NEVER runtime.stop on a browser disconnect.
    this.closeActive(true, true);
  }

  private closeActiveForSession(sessionId: string, intentional: boolean, detachBestEffort: boolean): boolean {
    if (this.active === undefined || this.active.sessionId !== sessionId) return false;
    this.closeActive(intentional, detachBestEffort);
    return true;
  }

  private closeActive(intentional: boolean, detachBestEffort: boolean): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.intentionalClose = intentional;
    active.subscription.close();
    if (detachBestEffort) void this.bestEffortDetach(active.sessionId);
  }

  private bestEffortDetach(sessionId: string): void {
    void this.config.client.call("runtime.detach", { sessionId }).then(
      () => undefined,
      () => undefined,
    );
  }

  // --- helpers ------------------------------------------------------------

  private send(message: unknown): void {
    if (this.outbound.failed) return;
    const frame = JSON.stringify(message);
    this.outbound.enqueue(frame); // overflow closes via onOutboundOverflow
  }

  private onOutboundOverflow(): void {
    this.config.logger.warn?.("runtime gateway outbound overflow; closing");
    this.closeBrowser(CLOSE_MESSAGE_TOO_BIG, "outbound overflow");
  }

  private failProtocol(reason: string): void {
    this.config.logger.warn?.("runtime gateway protocol error", { reason });
    this.closeBrowser(CLOSE_PROTOCOL_ERROR, reason);
  }

  private closeBrowser(code: number, reason: string): void {
    this.outbound.close();
    this.serial.close(); // stop dispatching any queued inbound frames
    this.queuedTurnSerial.close(); // D2-P4 queued-turn lane stops dispatching too
    try {
      this.session.close(code, reason);
    } catch {
      // already closed
    }
  }

  private snapshotFromAttach(result: SessiondMethodResult["runtime.attach"]): SnapshotPayload {
    return {
      sessionId: result.sessionId,
      cwd: result.cwd,
      projectRoot: result.projectRoot,
      epoch: result.epoch,
      lastEventId: result.lastEventId,
      workerStatus: result.workerStatus,
      snapshot: result.snapshot,
      resumeStatus: result.resumeStatus,
    };
  }

  private snapshotFromPush(push: Extract<SessiondPush, { type: "snapshot" }>): SnapshotPayload {
    return {
      sessionId: push.sessionId,
      cwd: push.cwd,
      projectRoot: push.projectRoot,
      epoch: push.epoch,
      lastEventId: push.lastEventId,
      workerStatus: push.workerStatus,
      snapshot: push.snapshot,
      resumeStatus: push.resumeStatus,
    };
  }
}
