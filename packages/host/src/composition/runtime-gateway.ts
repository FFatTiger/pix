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

export interface SessiondRuntimeGatewayOptions {
  /** sessiond RPC endpoint. Required unless {@link client} is injected. */
  readonly endpoint?: string;
  /** sessiond RPC secret. Required unless {@link client} is injected. */
  readonly secret?: string;
  /** Trusted exposure mode advertised in the handshake. */
  readonly mode: HostMode;
  /** Capabilities advertised in the handshake (M2: agent capability pending R2). */
  readonly capabilities?: readonly HostCapability[];
  /** Inject a narrow client (or factory) for tests. */
  readonly client?: SessiondRuntimeClient;
  readonly clientFactory?: () => SessiondRuntimeClient;
  readonly limits?: SessiondRuntimeGatewayLimits;
  readonly outbound?: SessiondRuntimeGatewayOutboundLimits;
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

const CLOSE_PROTOCOL_ERROR = 1008;
const CLOSE_MESSAGE_TOO_BIG = 1009;
const CLOSE_INTERNAL_ERROR = 1011;

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

/** Minimal FIFO async serializer so attach/command never interleave per socket. */
class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => task());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxBufferedAmount = options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED;
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
  private readonly handshakeResponse: ProtocolHandshakeResponse;
  private readonly outboundLimits: SessiondRuntimeGatewayOutboundLimits;
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
    this.handshakeResponse = {
      protocolVersion: PROTOCOL_VERSION,
      host: { mode: options.mode, capabilities: [...(options.capabilities ?? [])] },
      limits: {
        maxUpload: options.limits?.maxUpload ?? 0,
        maxOpenSessions: options.limits?.maxOpenSessions ?? DEFAULT_MAX_OPEN_SESSIONS,
      },
      sessionSnapshotSupport: true,
      serverTime: (options.now ?? Date.now)(),
    };
    this.outboundLimits = options.outbound ?? {};
    this.logger = options.logger ?? {};
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
    this.write(session, {
      type: "handshake_ack",
      ...(handshake.id !== undefined ? { id: handshake.id } : {}),
      payload: this.handshakeResponse,
    });
    const config: GatewayConfig = {
      client: this.client,
      handshakeResponse: this.handshakeResponse,
      outboundLimits: this.outboundLimits,
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
 * Per-browser-connection state machine. Created after a successful handshake;
 * owns inbound serialization, the outbound queue, the active attach
 * subscription and lifecycle cleanup.
 */
class GatewayConnection {
  private readonly serial = new SerialExecutor();
  private readonly outbound: BoundedOutbound;
  private generation = 0;
  private active: ActiveAttach | undefined;
  private browserClosed = false;

  constructor(private readonly config: GatewayConfig, private readonly session: WsSession) {
    this.outbound = new BoundedOutbound(session, config.outboundLimits, () => this.onOutboundOverflow());
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
    void this.serial.run(() => this.handleParsed(message));
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
    const { sessionId, commandId, interrupt } = message.payload;
    const interruptType = interrupt.type;
    try {
      const rpc = await this.config.client.call("runtime.interrupt", { sessionId, commandId, interrupt });
      this.send({ type: "interrupt_result", id: message.id, payload: { sessionId, commandId, interruptType, result: rpc.result } });
    } catch (error) {
      const mapped = mapRpcError(error);
      this.send({ type: "interrupt_result", id: message.id, payload: { sessionId, commandId, interruptType, result: { ok: false, type: interruptType, error: mapped } } });
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
