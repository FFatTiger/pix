import {
  PROTOCOL_VERSION,
  ProtocolErrorCodeSchema,
  READ_ONLY_RUNTIME_COMMAND_TYPES,
  RUNTIME_EPOCH_ROLLOVER_FEATURE,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_RUNNING_WATCH_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  SESSIOND_BUILD_IDENTITY,
  evaluateSessiondBuild,
  RuntimeActivateResultSchema,
  WsClientMessageSchema,
  WsHandshakeMessageSchema,
  type ProtocolError,
  type ProtocolHandshakeResponse,
  type RuntimeAttachParams,
  type SessiondMethodParams,
  type SessiondMethodResult,
  type SessiondRpcMethod,
  type SessiondPush,
  type SessiondRunningStatePush,
  type SessiondTurnStatusPush,
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
  ResolvedCapabilities,
  RuntimeWsSeam,
  WsSession,
} from "../types.js";
import {
  identitiesMatch,
  type RuntimeWorkspaceAuthorization,
  type RuntimeWorkspaceAuthorizer,
} from "./runtime-workspace-authorizer.js";

/**
 * Narrow sessiond client surface the gateway consumes. The real
 * {@link SessiondRpcClient} satisfies it; tests inject a fake.
 */
export interface SessiondRuntimeClient {
  call<M extends SessiondRpcMethod>(method: M, params: SessiondMethodParams[M], timeoutMs?: number): Promise<SessiondMethodResult[M]>;
  attach(
    params: SessiondMethodParams["runtime.attach"],
    onPush: (push: SessiondPush) => void | Promise<void>,
  ): Promise<SessiondRpcSubscription<SessiondMethodResult["runtime.attach"]>>;
  submitTurn?(
    params: SessiondMethodParams["runtime.submitTurn"],
    onPush: (push: SessiondTurnStatusPush) => void | Promise<void>,
  ): Promise<SessiondRpcSubscription<SessiondMethodResult["runtime.submitTurn"]>>;
  watchRunning?(
    onPush: (push: SessiondRunningStatePush) => void | Promise<void>,
  ): Promise<SessiondRpcSubscription<SessiondMethodResult["runtime.watchRunning"]>>;
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
  /** Phase 2B read lane: max pending read frames (default 16). */
  readonly readMaxSerialFrames?: number;
  /** Phase 2B read lane: max pending read bytes (default 512 KiB). */
  readonly readMaxSerialBytes?: number;
  /** Phase 3 atomic turn admission lane bounds. */
  readonly turnMaxSerialFrames?: number;
  readonly turnMaxSerialBytes?: number;
  /** Independent stop/control lane bound. */
  readonly controlMaxSerialFrames?: number;
  readonly controlMaxSerialBytes?: number;
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
   * valid hello. Returns the SAME seam-normalized {@link ResolvedCapabilities}
   * output the HTTP projection (health/capabilities/bootstrap) consumes, so
   * the WS handshake can never advertise a capability the mounted seams do
   * not back (no raw production list bypasses normalization). Only the
   * `capabilities` field is advertised; the resolver never leaks the error to
   * the client.
   */
  readonly resolveCapabilities?: () => Promise<ResolvedCapabilities>;
  /** Inject a narrow client (or factory) for tests. */
  readonly client?: SessiondRuntimeClient;
  readonly clientFactory?: () => SessiondRuntimeClient;
  readonly limits?: SessiondRuntimeGatewayLimits;
  readonly outbound?: SessiondRuntimeGatewayOutboundLimits;
  readonly inbound?: SessiondRuntimeGatewayInboundLimits;
  /** Per-RPC timeout passed to a created client (default 10_000 ms). */
  readonly timeoutMs?: number;
  /**
   * Longer RPC timeout for ordinary commands only (default 30 min). Commands
   * like prompt / bash legitimately block until their turn completes, which
   * far exceeds the control-plane RPC default; without this the browser sees a
   * spurious "sessiond RPC timed out" for every long turn even though the turn
   * keeps running to completion.
   */
  readonly commandTimeoutMs?: number;
  /**
   * Phase 2B read RPC timeout (default 15 s). Reads must NEVER use the long
   * command timeout — the dedicated read lane has its own bounded timeout so a
   * read never rides a 30-minute prompt-style window.
   */
  readonly readTimeoutMs?: number;
  /** Testable clock for serverTime (default Date.now). */
  readonly now?: () => number;
  readonly logger?: HostLogger;
  /**
   * Narrow Host-owned exact-session authorizer. Browser observe/explicit-activate
   * features are advertised ONLY when this seam is wired together with the
   * corresponding handler and a compatible sessiond attach/activate hello.
   */
  readonly runtimeWorkspaceAuthorizer?: RuntimeWorkspaceAuthorizer;
  /** Bounded budget covering currentCapabilities + authorizer + final gate/cap recheck (default 2_000). */
  readonly lifecycleAuthorizationTimeoutMs?: number;
  /** Testable timer for the lifecycle-authorization deadline. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_MAX_FRAMES = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED = 4 * 1024 * 1024;
const DEFAULT_MAX_OPEN_SESSIONS = 4;
const DEFAULT_MAX_SERIAL_FRAMES = 256;
const DEFAULT_MAX_SERIAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT_INTERRUPTS = 16;
const DEFAULT_READ_MAX_SERIAL_FRAMES = 16;
const DEFAULT_READ_MAX_SERIAL_BYTES = 512 * 1024;
const DEFAULT_TURN_MAX_SERIAL_FRAMES = 16;
const DEFAULT_TURN_MAX_SERIAL_BYTES = 1024 * 1024;
const DEFAULT_CONTROL_MAX_SERIAL_FRAMES = 16;
const DEFAULT_CONTROL_MAX_SERIAL_BYTES = 256 * 1024;
export const DEFAULT_LIFECYCLE_AUTHORIZATION_TIMEOUT_MS = 2_000;

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

const LIFECYCLE_AUTHORIZATION_TIMEOUT: ProtocolError = {
  code: "unavailable",
  message: "workspace lookup failed",
  retryable: false,
};

async function withLifecycleDeadline<T>(
  work: (signal: { readonly timedOut: boolean }) => Promise<T>,
  timeoutMs: number,
  setTimeoutFn: (fn: () => void, ms: number) => unknown,
  clearTimeoutFn: (handle: unknown) => void,
): Promise<{ ok: true; value: T } | { ok: false; error: ProtocolError }> {
  const signal = { timedOut: false };
  let handle: unknown;
  try {
    return await new Promise((resolve, reject) => {
      handle = setTimeoutFn(() => {
        signal.timedOut = true;
        resolve({ ok: false, error: LIFECYCLE_AUTHORIZATION_TIMEOUT });
      }, timeoutMs);
      void work(signal).then(
        (value) => {
          if (signal.timedOut) return;
          resolve({ ok: true, value });
        },
        (error) => {
          if (signal.timedOut) return;
          reject(error);
        },
      );
    });
  } finally {
    if (handle !== undefined) clearTimeoutFn(handle);
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
  readonly commandTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly runningWatchEnabled: boolean;
  readonly readRpcEnabled: boolean;
  readonly submitTurnEnabled: boolean;
  /** Phase 5B: the client negotiated `runtime.epoch-rollover.v1` and sessiond advertises it. */
  readonly epochRolloverEnabled: boolean;
  readonly observeExistingEnabled: boolean;
  readonly explicitActivateEnabled: boolean;
  readonly runtimeWorkspaceAuthorizer: RuntimeWorkspaceAuthorizer | undefined;
  readonly currentCapabilities: () => Promise<readonly HostCapability[]>;
  readonly lifecycleAuthorizationTimeoutMs: number;
  readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn: (handle: unknown) => void;
}

interface ActiveRunningWatch {
  readonly subscription: SessiondRpcSubscription<SessiondMethodResult["runtime.watchRunning"]>;
  intentionalClose: boolean;
}

interface ActiveTurnSubmission {
  readonly sessionId: string;
  readonly operationId: string;
  /** Composite (sessionId, operationId) key this entry is stored under. */
  readonly key: string;
  readonly subscription: SessiondRpcSubscription<SessiondMethodResult["runtime.submitTurn"]>;
  intentionalClose: boolean;
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
  private readonly resolveCapabilitiesField: (() => Promise<ResolvedCapabilities>) | undefined;
  private readonly limits: SessiondRuntimeGatewayLimits;
  private readonly now: () => number;
  private readonly outboundLimits: SessiondRuntimeGatewayOutboundLimits;
  private readonly inboundLimits: Required<SessiondRuntimeGatewayInboundLimits>;
  private readonly logger: HostLogger;
  private readonly commandTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly runtimeWorkspaceAuthorizer: RuntimeWorkspaceAuthorizer | undefined;
  private readonly lifecycleAuthorizationTimeoutMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

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
      readMaxSerialFrames: positiveSafeInteger(options.inbound?.readMaxSerialFrames, DEFAULT_READ_MAX_SERIAL_FRAMES),
      readMaxSerialBytes: positiveSafeInteger(options.inbound?.readMaxSerialBytes, DEFAULT_READ_MAX_SERIAL_BYTES),
      turnMaxSerialFrames: positiveSafeInteger(options.inbound?.turnMaxSerialFrames, DEFAULT_TURN_MAX_SERIAL_FRAMES),
      turnMaxSerialBytes: positiveSafeInteger(options.inbound?.turnMaxSerialBytes, DEFAULT_TURN_MAX_SERIAL_BYTES),
      controlMaxSerialFrames: positiveSafeInteger(options.inbound?.controlMaxSerialFrames, DEFAULT_CONTROL_MAX_SERIAL_FRAMES),
      controlMaxSerialBytes: positiveSafeInteger(options.inbound?.controlMaxSerialBytes, DEFAULT_CONTROL_MAX_SERIAL_BYTES),
    };
    this.logger = options.logger ?? {};
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30 * 60 * 1_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 15_000;
    this.runtimeWorkspaceAuthorizer = options.runtimeWorkspaceAuthorizer;
    this.lifecycleAuthorizationTimeoutMs = positiveSafeInteger(
      options.lifecycleAuthorizationTimeoutMs,
      DEFAULT_LIFECYCLE_AUTHORIZATION_TIMEOUT_MS,
    );
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Build a per-connection handshake response (serverTime is fresh per connection). */
  private buildHandshakeResponse(
    capabilities: readonly HostCapability[],
    acceptedFeatures: readonly string[] = [],
  ): ProtocolHandshakeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      host: { mode: this.mode, capabilities: [...capabilities] },
      limits: {
        maxUpload: this.limits.maxUpload ?? 0,
        maxOpenSessions: this.limits.maxOpenSessions ?? DEFAULT_MAX_OPEN_SESSIONS,
      },
      sessionSnapshotSupport: true,
      serverTime: this.now(),
      ...(acceptedFeatures.length === 0 ? {} : { acceptedFeatures: [...acceptedFeatures] }),
    };
  }

  /**
   * Resolve advertised capabilities for a single connection. Falls back to the
   * static default when no resolver is wired. A resolver that rejects/throws is
   * fail-closed to an empty set with a sanitized warning; the error is never
   * forwarded to the client (it carries no capabilities, no message).
   */
  private async resolveConnectionCapabilities(): Promise<ResolvedCapabilities> {
    if (this.resolveCapabilitiesField === undefined) {
      return { sessiond: "unknown", capabilities: this.defaultCapabilities };
    }
    try {
      return await this.resolveCapabilitiesField();
    } catch {
      this.logger.warn?.("runtime gateway capability resolver failed; advertising no capabilities");
      return { sessiond: "unknown", capabilities: [] };
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
    // The resolver returns the SAME seam-normalized output as the HTTP
    // projection, so WS and HTTP capability surfaces can never disagree.
    const resolved = await this.resolveConnectionCapabilities();
    const requestedRunningWatch = handshake.payload.features.includes(RUNTIME_RUNNING_WATCH_FEATURE);
    const requestedReadRpc = handshake.payload.features.includes(RUNTIME_READ_RPC_FEATURE);
    const requestedSubmitTurn = handshake.payload.features.includes(RUNTIME_SUBMIT_TURN_FEATURE);
    const requestedEpochRollover = handshake.payload.features.includes(RUNTIME_EPOCH_ROLLOVER_FEATURE);
    const requestedObserveExisting = handshake.payload.features.includes(RUNTIME_OBSERVE_EXISTING_FEATURE);
    const requestedExplicitActivate = handshake.payload.features.includes(RUNTIME_EXPLICIT_ACTIVATE_FEATURE);
    let runningWatchEnabled = false;
    let readRpcEnabled = false;
    let submitTurnEnabled = false;
    let epochRolloverEnabled = false;
    let observeExistingEnabled = false;
    let explicitActivateEnabled = false;
    const wantsLifecycle = requestedObserveExisting || requestedExplicitActivate;
    if (requestedRunningWatch || requestedReadRpc || requestedSubmitTurn || requestedEpochRollover || wantsLifecycle) {
      try {
        // Single system.hello for negotiated additive features. A seam that is
        // not wired/verified is never negotiated (fail closed to false).
        const hello = await this.client.call("system.hello", {}, 2_000);
        runningWatchEnabled = requestedRunningWatch && this.client.watchRunning !== undefined && hello.capabilities?.includes(RUNTIME_RUNNING_WATCH_FEATURE) === true;
        readRpcEnabled = requestedReadRpc && hello.capabilities?.includes(RUNTIME_READ_RPC_FEATURE) === true;
        submitTurnEnabled = requestedSubmitTurn && this.client.submitTurn !== undefined && hello.capabilities?.includes(RUNTIME_SUBMIT_TURN_FEATURE) === true;
        epochRolloverEnabled = requestedEpochRollover && hello.capabilities?.includes(RUNTIME_EPOCH_ROLLOVER_FEATURE) === true;
        const hostHasAgent = resolved.capabilities.includes("agent");
        const authorizerWired = this.runtimeWorkspaceAuthorizer !== undefined;
        const gateVerifierWired = session.verifyGate !== undefined;
        const buildCompatible = evaluateSessiondBuild(hello.build, SESSIOND_BUILD_IDENTITY).state === "compatible";
        const attachActivateCompatible = buildCompatible && hello.capabilities?.includes("runtime.authority") === true;
        observeExistingEnabled = requestedObserveExisting && authorizerWired && gateVerifierWired && hostHasAgent && attachActivateCompatible;
        explicitActivateEnabled = requestedExplicitActivate && authorizerWired && gateVerifierWired && hostHasAgent && attachActivateCompatible;
      } catch {
        runningWatchEnabled = false;
        readRpcEnabled = false;
        submitTurnEnabled = false;
        epochRolloverEnabled = false;
        observeExistingEnabled = false;
        explicitActivateEnabled = false;
      }
    }
    const acceptedFeatures = [
      ...(runningWatchEnabled ? [RUNTIME_RUNNING_WATCH_FEATURE] : []),
      ...(readRpcEnabled ? [RUNTIME_READ_RPC_FEATURE] : []),
      ...(submitTurnEnabled ? [RUNTIME_SUBMIT_TURN_FEATURE] : []),
      ...(epochRolloverEnabled ? [RUNTIME_EPOCH_ROLLOVER_FEATURE] : []),
      ...(observeExistingEnabled ? [RUNTIME_OBSERVE_EXISTING_FEATURE] : []),
      ...(explicitActivateEnabled ? [RUNTIME_EXPLICIT_ACTIVATE_FEATURE] : []),
    ];
    const handshakeResponse = this.buildHandshakeResponse(resolved.capabilities, acceptedFeatures);
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
      commandTimeoutMs: this.commandTimeoutMs,
      readTimeoutMs: this.readTimeoutMs,
      runningWatchEnabled,
      readRpcEnabled,
      submitTurnEnabled,
      epochRolloverEnabled,
      observeExistingEnabled,
      explicitActivateEnabled,
      runtimeWorkspaceAuthorizer: this.runtimeWorkspaceAuthorizer,
      currentCapabilities: async () => (await this.resolveConnectionCapabilities()).capabilities,
      lifecycleAuthorizationTimeoutMs: this.lifecycleAuthorizationTimeoutMs,
      setTimeoutFn: this.setTimeoutFn,
      clearTimeoutFn: this.clearTimeoutFn,
    };
    new GatewayConnection(config, session).start();
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
 * True when a command must interleave with a long-running prompt on the
 * serial lane. D2-P4 queued turns (steer / follow_up) and D2-P8 extension UI
 * response/input run on the INDEPENDENT interleaving lane so they are never
 * HOL-blocked behind a prompt command that awaits an extension request (or
 * streams/queues). Read-only runtime commands use a third bounded read lane;
 * lifecycle mutations and the ordinary prompt stay on the serial lane.
 */
function isInterleavingCommand(message: WsClientMessage): boolean {
  if (message.type !== "command") return false;
  const type = message.payload.command.type;
  return type === "steer" || type === "follow_up" || type === "extension_ui_response" || type === "extension_ui_input";
}

const READ_ONLY_COMMAND_TYPES = new Set<string>(READ_ONLY_RUNTIME_COMMAND_TYPES);

/** Read-only worker requests use a bounded lane independent from long mutations. */
function isReadOnlyCommand(message: WsClientMessage): boolean {
  return message.type === "command" && READ_ONLY_COMMAND_TYPES.has(message.payload.command.type);
}

/**
 * Collision-safe composite key for an active turn subscription. Naive
 * concatenation (`sessionId + operationId`) is ambiguous ("ab"+"c" vs
 * "a"+"bc"); length-prefix encoding is deterministic and unambiguous.
 */
function turnSubscriptionKey(sessionId: string, operationId: string): string {
  return `${sessionId.length}:${sessionId}${operationId.length}:${operationId}`;
}

/**
 * Per-browser-connection state machine. Created after a successful handshake;
 * owns inbound serialization, the outbound queue, the active attach
 * subscription and lifecycle cleanup.
 */
class GatewayConnection {
  private readonly outbound: BoundedOutbound;
  private readonly serial: BoundedSerialQueue;
  /**
   * Lifecycle Phase 2 read lane. Metadata/state reads stay bounded and FIFO,
   * but never HOL-block behind a long prompt/bash/compact mutation.
   */
  private readonly readSerial: BoundedSerialQueue;
  /**
   * D2-P4/P2-P8 independent bounded FIFO interleaving lane. Carries queued
   * turns (steer / follow_up) and extension UI response/input so a long-running
   * prompt on the serial lane never HOL-blocks them (a prompt awaiting an
   * extension request would otherwise deadlock the same-socket response).
   */
  private readonly interleavingSerial: BoundedSerialQueue;
  /** Quick atomic turn admission/status setup, independent from legacy prompt. */
  private readonly turnSerial: BoundedSerialQueue;
  /** Stop/control must never sit behind a legacy long prompt. */
  private readonly controlSerial: BoundedSerialQueue;
  private readonly maxInflightInterrupts: number;
  private inflightInterrupts = 0;
  private generation = 0;
  private active: ActiveAttach | undefined;
  private runningWatch: ActiveRunningWatch | undefined;
  /**
   * Active turn status subscriptions keyed by the exact composite
   * (sessionId, operationId) — never by operationId alone, so the same
   * operationId on sessions A and B coexists and closing/removal uses the
   * exact owner.
   */
  private readonly activeTurns = new Map<string, ActiveTurnSubmission>();
  private browserClosed = false;

  constructor(private readonly config: GatewayConfig, private readonly session: WsSession) {
    this.outbound = new BoundedOutbound(session, config.outboundLimits, () => this.onOutboundOverflow());
    this.serial = new BoundedSerialQueue(config.inboundLimits.maxSerialFrames, config.inboundLimits.maxSerialBytes);
    // Phase 2B read lane uses its OWN smaller explicit limits (never the
    // ordinary serial lane's budget) so a read flood cannot starve commands.
    this.readSerial = new BoundedSerialQueue(config.inboundLimits.readMaxSerialFrames, config.inboundLimits.readMaxSerialBytes);
    // D2-P4 (steer/follow_up) + D2-P8 (extension UI response/input) share the
    // same bounded inbound limits but run on an INDEPENDENT FIFO, so a
    // long-running prompt (serial lane) never HOL-blocks an interleaving
    // command. Both lanes may run concurrently; interrupts remain on the
    // fire-and-forget bypass path.
    this.interleavingSerial = new BoundedSerialQueue(config.inboundLimits.maxSerialFrames, config.inboundLimits.maxSerialBytes);
    this.turnSerial = new BoundedSerialQueue(config.inboundLimits.turnMaxSerialFrames, config.inboundLimits.turnMaxSerialBytes);
    this.controlSerial = new BoundedSerialQueue(config.inboundLimits.controlMaxSerialFrames, config.inboundLimits.controlMaxSerialBytes);
    this.maxInflightInterrupts = config.inboundLimits.maxInflightInterrupts;
  }

  start(): void {
    this.session.onMessage((data) => this.onFrame(data));
    this.session.onClose(() => this.onBrowserClose());
    if (this.config.runningWatchEnabled) void this.openRunningWatch();
  }

  private async openRunningWatch(): Promise<void> {
    const watchRunning = this.config.client.watchRunning;
    if (watchRunning === undefined) {
      this.closeBrowser(CLOSE_INTERNAL_ERROR, "running watch unavailable");
      return;
    }
    const onPush = (push: SessiondRunningStatePush): void => {
      if (this.browserClosed || this.runningWatch === undefined) return;
      this.send({ type: "running_state", payload: push.state });
    };
    try {
      const subscription = await watchRunning.call(this.config.client, onPush);
      if (this.browserClosed) {
        subscription.close();
        return;
      }
      const entry: ActiveRunningWatch = { subscription, intentionalClose: false };
      this.runningWatch = entry;
      // Handshake ACK was sent before this connection state machine started;
      // this full authoritative baseline is therefore the first feature frame.
      this.send({ type: "running_state", payload: subscription.response });
      void subscription.closed.then(() => this.onRunningWatchClosed(entry));
    } catch {
      if (!this.browserClosed) this.closeBrowser(CLOSE_INTERNAL_ERROR, "running watch failed");
    }
  }

  private onRunningWatchClosed(entry: ActiveRunningWatch): void {
    if (this.runningWatch !== entry || entry.intentionalClose) return;
    this.runningWatch = undefined;
    this.closeBrowser(CLOSE_INTERNAL_ERROR, "running watch closed");
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
    // Bounded inbound serial queues: reserve raw UTF-8 bytes before enqueuing
    // so a flood of frames (e.g. commands whose RPC never settles) cannot grow
    // memory unbounded. Overflow fails closed without dispatching. The Phase 2B
    // `read` envelope (and legacy read-only commands) use the independent
    // bounded read lane; D2-P4 routes steer/follow_up and D2-P8 routes
    // extension UI response/input to the independent interleaving lane; all
    // other frames stay on the ordinary serial lane. All lanes are bounded.
    const bytes = Buffer.byteLength(raw, "utf8");
    let laneKind: "serial" | "read" | "interleaving" | "turn" | "control";
    if (message.type === "submit_turn") {
      if (!this.config.submitTurnEnabled) {
        this.config.logger.warn?.("runtime gateway submit frame without negotiated feature");
        this.failProtocol("submit frame without negotiated submit feature");
        return;
      }
      laneKind = "turn";
    } else if (message.type === "stop") {
      laneKind = "control";
    } else if (message.type === "read") {
      // Feature-enabled connections only: a read frame without the negotiated
      // read RPC feature is rejected WITHOUT opening an RPC (fail closed).
      if (!this.config.readRpcEnabled) {
        this.config.logger.warn?.("runtime gateway read frame without negotiated read RPC feature");
        this.failProtocol("read frame without negotiated read RPC feature");
        return;
      }
      laneKind = "read";
    } else if (isInterleavingCommand(message)) {
      laneKind = "interleaving";
    } else if (isReadOnlyCommand(message)) {
      laneKind = "read";
    } else {
      laneKind = "serial";
    }
    const lane = laneKind === "interleaving"
      ? this.interleavingSerial
      : laneKind === "read"
        ? this.readSerial
        : laneKind === "turn"
          ? this.turnSerial
          : laneKind === "control"
            ? this.controlSerial
            : this.serial;
    if (!lane.enqueue(() => this.handleParsed(message), bytes)) {
      this.config.logger.warn?.("runtime gateway inbound overflow; closing", {
        lane: laneKind,
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
      case "activate":
        await this.handleActivate(message);
        return;
      case "detach":
        this.handleDetach(message);
        return;
      case "command":
        await this.handleCommand(message);
        return;
      case "read":
        await this.handleRead(message);
        return;
      case "submit_turn":
        await this.handleSubmitTurn(message);
        return;
      case "getSnapshot":
        await this.handleGetSnapshot(message);
        return;
      case "listRunning":
        await this.handleListRunning(message);
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
    const existingOnly = message.payload.attachMode === "existing_only";
    if (existingOnly && !this.config.observeExistingEnabled) {
      this.send({
        type: "response",
        id: message.id,
        payload: { ok: false, error: { code: "unsupported_capability", message: "existing-only attach is unavailable", retryable: false } },
      });
      return;
    }
    let authorizedIdentity: { sessionId: string; cwd: string; projectRoot: string; epoch?: string } | undefined;
    if (existingOnly) {
      const decision = await this.authorizeExactSession(message.payload.sessionId, "observe");
      if (this.browserClosed) return;
      if (!decision.ok) {
        this.send({ type: "response", id: message.id, payload: { ok: false, error: decision.error } });
        return;
      }
      authorizedIdentity = decision.identity;
      if (this.browserClosed) return;
    }
    // Browser attachMode is Host-only. Strip it before the strict sessiond RPC.
    const { attachMode: _attachMode, ...browserParams } = message.payload;
    // Phase 5B: when the connection negotiated `runtime.epoch-rollover.v1`,
    // mark the sessiond attach so it knows this client understands whole-epoch
    // `epoch_changed` snapshots. Additive; a non-negotiated path omits it.
    const params: RuntimeAttachParams = this.config.epochRolloverEnabled
      ? { ...browserParams, supportsEpochRollover: true }
      : browserParams;
    const generation = ++this.generation;
    this.closeActive(true, true);
    const onPush = (push: SessiondPush): void => {
      if (this.active === undefined || this.active.generation !== generation) return;
      if (push.type === "event") {
        // `running_sessions_changed` remains on the cursor-bearing attach
        // stream even when the negotiated global watch owns its STATE. The
        // event has already consumed an eventId in sessiond's journal; hiding
        // it here creates a cursor hole, makes the Client falsely detect a gap,
        // and causes an endless reattach/replay loop that suppresses live AI
        // output. Watch-mode Clients advance the cursor but ignore the legacy
        // event's state payload.
        this.send({ type: "event", payload: push.event });
      }
      // Replay/live snapshots stay id-less: only the initial attach snapshot
      // carries the request id (see handleAttach).
      else this.send({ type: "snapshot", payload: this.snapshotFromPush(push) });
    };
    try {
      const subscription = existingOnly
        ? await this.config.client.attach(params, onPush)
        : await this.coldAttach(params, onPush);
      if (this.browserClosed || generation !== this.generation) {
        // superseded or gone while connecting
        subscription.close();
        return;
      }
      if (authorizedIdentity && !identitiesMatch(authorizedIdentity, subscription.response, { requireEpoch: true })) {
        subscription.close();
        this.send({ type: "response", id: message.id, payload: { ok: false, error: { code: "internal", message: "runtime identity mismatch", retryable: false } } });
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
      if (this.browserClosed) return;
      this.send({ type: "response", id: message.id, payload: { ok: false, error: mapRpcError(error) } });
    }
  }

  /**
   * Legacy missing-attachMode path: finite Protocol-v2 activating attach.
   * Removal condition: Protocol v3 is the minimum supported version AND the
   * build fence rejects daemon/Worker builds without atomic submitTurn AND
   * every activating caller has migrated to the negotiated activate envelope
   * or atomic submitTurn. No unbounded aliases.
   */
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

  private async handleActivate(message: Extract<WsClientMessage, { type: "activate" }>): Promise<void> {
    if (!this.config.explicitActivateEnabled) {
      this.send({
        type: "response",
        id: message.id,
        payload: { ok: false, error: { code: "unsupported_capability", message: "explicit activate is unavailable", retryable: false } },
      });
      return;
    }
    const decision = await this.authorizeExactSession(message.payload.sessionId, "activate");
    if (this.browserClosed) return;
    if (!decision.ok) {
      this.send({ type: "response", id: message.id, payload: { ok: false, sessionId: message.payload.sessionId, error: decision.error } });
      return;
    }
    if (this.browserClosed) return;
    try {
      const result = await this.config.client.call("runtime.activate", { sessionId: message.payload.sessionId });
      if (this.browserClosed) return;
      const parsed = RuntimeActivateResultSchema.safeParse(result);
      if (!parsed.success || !identitiesMatch(decision.identity, parsed.data)) {
        this.send({ type: "response", id: message.id, payload: { ok: false, sessionId: message.payload.sessionId, error: { code: "internal", message: "runtime identity mismatch", retryable: false } } });
        return;
      }
      this.send({ type: "response", id: message.id, payload: { ok: true, sessionId: parsed.data.sessionId, result: parsed.data } });
    } catch (error) {
      if (this.browserClosed) return;
      this.send({ type: "response", id: message.id, payload: { ok: false, sessionId: message.payload.sessionId, error: mapRpcError(error) } });
    }
  }

  private async authorizeExactSession(
    sessionId: string,
    intent: "observe" | "activate",
  ): Promise<RuntimeWorkspaceAuthorization> {
    const authorizer = this.config.runtimeWorkspaceAuthorizer;
    if (authorizer === undefined) {
      return { ok: false, error: { code: "unsupported_capability", message: "workspace authorization is unavailable", retryable: false } };
    }
    const verifyGate = this.session.verifyGate;
    if (verifyGate === undefined) {
      return { ok: false, error: { code: "unsupported_capability", message: "workspace authorization is unavailable", retryable: false } };
    }
    try {
      const raced = await withLifecycleDeadline(async (signal) => {
        const capabilities = await this.config.currentCapabilities();
        if (signal.timedOut || this.browserClosed) return { ok: false as const, error: LIFECYCLE_AUTHORIZATION_TIMEOUT };
        if (!capabilities.includes("agent")) {
          return { ok: false as const, error: { code: "unsupported_capability" as const, message: "agent capability is unavailable", retryable: false as const } };
        }
        const gateBefore = await Promise.resolve(verifyGate());
        if (signal.timedOut || this.browserClosed) return { ok: false as const, error: LIFECYCLE_AUTHORIZATION_TIMEOUT };
        if (!gateBefore.ok) return { ok: false as const, error: gateBefore.error };
        const decision = await authorizer.authorize({ sessionId, intent });
        if (signal.timedOut || this.browserClosed) return { ok: false as const, error: LIFECYCLE_AUTHORIZATION_TIMEOUT };
        if (!decision.ok) return decision;
        const capabilitiesAfter = await this.config.currentCapabilities();
        if (signal.timedOut || this.browserClosed) return { ok: false as const, error: LIFECYCLE_AUTHORIZATION_TIMEOUT };
        if (!capabilitiesAfter.includes("agent")) {
          return { ok: false as const, error: { code: "unsupported_capability" as const, message: "agent capability is unavailable", retryable: false as const } };
        }
        const gateAfter = await Promise.resolve(verifyGate());
        if (signal.timedOut || this.browserClosed) return { ok: false as const, error: LIFECYCLE_AUTHORIZATION_TIMEOUT };
        if (!gateAfter.ok) return { ok: false as const, error: gateAfter.error };
        return decision;
      }, this.config.lifecycleAuthorizationTimeoutMs, this.config.setTimeoutFn, this.config.clearTimeoutFn);
      if (!raced.ok) return { ok: false, error: raced.error };
      return raced.value;
    } catch {
      return { ok: false, error: LIFECYCLE_AUTHORIZATION_TIMEOUT };
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
    // Phase 5B: on a connection that negotiated `runtime.epoch-rollover.v1`,
    // every command frame MUST carry the exact controller epoch — an absent
    // epoch is rejected pre-RPC (never reaches sessiond).
    if (this.config.epochRolloverEnabled && message.payload.epoch === undefined) {
      this.send({ type: "response", id, payload: { ok: false, error: { code: "invalid_input", message: "command requires an epoch on this connection", retryable: false } } });
      return;
    }
    // Phase 2B: on a connection that negotiated the independent read RPC, a
    // legacy read command via type=command is REJECTED fail-closed (the client
    // must use the dedicated read envelope). Old v2 connections without the
    // feature keep the explicit finite legacy command-envelope shim below.
    if (this.config.submitTurnEnabled && message.payload.command.type === "prompt") {
      this.send({ type: "response", id, payload: { ok: false, error: { code: "invalid_command", message: "prompt commands must use submit_turn on this connection", retryable: false } } });
      return;
    }
    if (this.config.readRpcEnabled && isReadOnlyCommand(message)) {
      this.send({
        type: "response",
        id,
        payload: {
          ok: false,
          error: {
            code: "invalid_command",
            message: "read commands must use the read envelope on this connection",
            retryable: false,
          },
        },
      });
      return;
    }
    try {
      // Forward the exact payload (including the optional epoch) to sessiond.
      const result = await this.config.client.call("runtime.command", message.payload, this.config.commandTimeoutMs);
      this.send({ type: "response", id, payload: { ok: true, result } });
    } catch (error) {
      this.send({ type: "response", id, payload: { ok: false, error: mapRpcError(error) } });
    }
  }

  /**
   * Phase 2B independent read RPC: dispatch `runtime.read` through the bounded
   * read lane with the dedicated read timeout (NEVER the long command timeout)
   * and emit a strictly-correlated `read_result` frame carrying the full
   * identity triple. A late RPC result after browser close is dropped; a failed
   * RPC emits a structured read_result with the request identity so the
   * client's pending read settles fail-closed.
   */
  private async handleSubmitTurn(message: Extract<WsClientMessage, { type: "submit_turn" }>): Promise<void> {
    const submitTurn = this.config.client.submitTurn;
    if (!this.config.submitTurnEnabled || submitTurn === undefined) {
      this.send({ type: "submit_turn_result", id: message.id, payload: { status: "rejected", delivery: "not_delivered", sessionId: message.payload.sessionId, operationId: message.payload.operationId, error: { code: "unsupported_capability", message: "atomic turn admission is unavailable", retryable: false } } });
      return;
    }
    const onPush = (push: SessiondTurnStatusPush): void => {
      if (this.browserClosed) return;
      if (push.status.sessionId !== message.payload.sessionId || push.status.operationId !== message.payload.operationId) return;
      this.send({ type: "turn_status", payload: push.status });
    };
    let subscription: SessiondRpcSubscription<SessiondMethodResult["runtime.submitTurn"]>;
    try {
      subscription = await submitTurn.call(this.config.client, message.payload, onPush);
    } catch (error) {
      if (this.browserClosed) return;
      this.send({ type: "submit_turn_result", id: message.id, payload: { status: "rejected", delivery: "uncertain", sessionId: message.payload.sessionId, operationId: message.payload.operationId, error: mapRpcError(error) } });
      return;
    }
    if (this.browserClosed) { subscription.close(); return; }
    const sessionId = message.payload.sessionId;
    const operationId = message.payload.operationId;
    const key = turnSubscriptionKey(sessionId, operationId);
    const active: ActiveTurnSubmission = { sessionId, operationId, key, subscription, intentionalClose: false };
    this.activeTurns.set(key, active);
    this.send({ type: "submit_turn_result", id: message.id, payload: subscription.response });
    void subscription.closed.then(() => {
      // Exact-owner removal: only this entry's composite key is deleted, so a
      // sibling subscription for a DIFFERENT session with the SAME operationId
      // is never touched.
      if (this.activeTurns.get(key) === active) this.activeTurns.delete(key);
    });
  }

  private async handleRead(message: Extract<WsClientMessage, { type: "read" }>): Promise<void> {
    const { sessionId, epoch, read } = message.payload;
    try {
      const result = await this.config.client.call(
        "runtime.read",
        { sessionId, epoch, requestId: message.id, read },
        this.config.readTimeoutMs,
      );
      if (this.browserClosed) return; // late result: drop, never settle
      this.send({ type: "read_result", id: message.id, payload: result });
    } catch (error) {
      if (this.browserClosed) return;
      this.send({
        type: "read_result",
        id: message.id,
        payload: {
          sessionId,
          epoch,
          requestId: message.id,
          result: { ok: false, type: read.type, error: mapRpcError(error) },
        },
      });
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
      const { sessionId, commandId, epoch, interrupt } = message.payload;
      const interruptType = interrupt.type;
      // Phase 5B: on a negotiated connection the interrupt MUST carry the exact
      // controller epoch — an absent epoch is rejected pre-RPC.
      if (this.config.epochRolloverEnabled && epoch === undefined) {
        this.send({ type: "interrupt_result", id: message.id, payload: { sessionId, commandId, interruptType, result: { ok: false, type: interruptType, error: { code: "invalid_input", message: "interrupt requires an epoch on this connection", retryable: false } } } });
        return;
      }
      let rpc;
      try {
        rpc = await this.config.client.call("runtime.interrupt", { sessionId, commandId, ...(epoch === undefined ? {} : { epoch }), interrupt });
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

  private async handleListRunning(message: Extract<WsClientMessage, { type: "listRunning" }>): Promise<void> {
    try {
      const result = await this.config.client.call("runtime.listRunning", {});
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
    this.readSerial.close(); // read lane short-circuits too
    this.interleavingSerial.close(); // interleaving lane short-circuits too
    this.turnSerial.close(); // turn admission lane short-circuits too
    this.controlSerial.close(); // control lane short-circuits too
    // Best-effort detach only; NEVER runtime.stop on a browser disconnect.
    this.closeActive(true, true);
    this.closeRunningWatch();
    // Browser close ends the status-only turn subscriptions; the turn itself
    // (admitted/executing) keeps running on sessiond/Worker — only the status
    // push channel is closed, never stop/abort.
    this.closeActiveTurns();
  }

  private closeActiveTurns(): void {
    for (const active of this.activeTurns.values()) {
      active.intentionalClose = true;
      active.subscription.close();
    }
    this.activeTurns.clear();
  }

  private closeRunningWatch(): void {
    const watch = this.runningWatch;
    if (watch === undefined) return;
    this.runningWatch = undefined;
    watch.intentionalClose = true;
    watch.subscription.close();
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
    this.readSerial.close(); // read lane stops dispatching too
    this.interleavingSerial.close(); // interleaving lane stops dispatching too
    this.turnSerial.close(); // turn admission lane stops dispatching too
    this.controlSerial.close(); // control lane stops dispatching too
    this.closeActiveTurns();
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
