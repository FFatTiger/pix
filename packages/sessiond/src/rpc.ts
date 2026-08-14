import { createConnection, createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import {
  PROTOCOL_VERSION,
  SESSIOND_RPC_METHODS,
  SessiondRpcRequestSchema,
  SessiondRpcResponseSchema,
  SessiondPushSchema,
  type ProtocolError,
  type SessiondRpcMethod,
  type SessiondRpcRequest,
  type SessiondRpcResponse,
  type SessiondMethodParams,
  type SessiondMethodResult,
} from "@fffattiger/pix-protocol";
import { SessiondError, toBoundaryProtocolError } from "./errors.js";
import { SerialSocketWriter, type SerialSocketWriterOptions } from "./internal/serial-writer.js";
import type { PreparedAttachment } from "./service.js";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Bounded ACK barrier for the `system.shutdown` response delivery (see {@link SessiondRpcServerOptions.shutdownAckTimeoutMs}). */
const SHUTDOWN_ACK_TIMEOUT_MS = 2_000;

const equalSecret = (actual: string, expected: string): boolean => {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface SessiondRpcContext { requestId: string }

export interface SessiondRpcHandler {
  handle<M extends SessiondRpcMethod>(method: M, params: SessiondMethodParams[M], context?: SessiondRpcContext): Promise<SessiondMethodResult[M]>;
  attach?(params: SessiondMethodParams["runtime.attach"]): PreparedAttachment;
}

export interface SessiondRpcServerOptions {
  endpoint: string;
  secret: string;
  handler: SessiondRpcHandler;
  maxFrameBytes?: number;
  writer?: SerialSocketWriterOptions;
  /**
   * Optional daemon-owned shutdown authority. When present, the server accepts
   * `system.shutdown` requests (after the AUTH secret AND the exact instance-id
   * fence) and delivers a bounded ACK-before-close response; only after that
   * response is actually flushed to the client is {@link SessiondShutdownAuthority.initiate}
   * invoked (at most once per server). When absent, `system.shutdown` is
   * refused fail-closed as unsupported and can never trigger anything.
   */
  shutdownAuthority?: SessiondShutdownAuthority;
  /** Bounded ACK barrier for the `system.shutdown` response (default 2s). */
  shutdownAckTimeoutMs?: number;
  /**
   * Diagnostic line logger (defaults to a never-throwing stderr line writer).
   * Receives pre-formatted `[sessiond] ...` lines that never contain request
   * bodies or secrets.
   */
  logger?: (line: string) => void;
}

/**
 * Daemon-owned shutdown authority wired into the RPC server. `initiate` is
 * invoked exactly once, only after an authenticated + instance-fenced
 * `system.shutdown` response has been ACKed (flushed) to the client. It must
 * never throw. The daemon maps it onto its idempotent shutdown transition.
 */
export interface SessiondShutdownAuthority {
  /** Exact current daemon instance-id; the RPC fence compares strictly against this. */
  readonly instanceId: string;
  /** Begin the (idempotent) daemon shutdown transition. Call-safe multiple times. */
  initiate: () => void;
}

/** Never-throwing default logger: one line to stderr, matching daemon diagnostics. */
const defaultRpcLogger = (line: string): void => {
  try {
    console.error(line);
  } catch {
    // A broken/closed stderr must never take down the RPC path.
  }
};

export class SessiondRpcServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: SessiondRpcServerOptions) {}

  async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.endpoint, () => { server.off("error", reject); resolve(); });
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let authenticated = false;
    let buffered = "";
    let attachment: PreparedAttachment | undefined;
    const writer = new SerialSocketWriter(socket, this.options.writer);
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > (this.options.maxFrameBytes ?? MAX_FRAME_BYTES)) {
        socket.destroy();
        return;
      }
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!authenticated) {
          authenticated = line.startsWith("AUTH ") && equalSecret(line.slice(5), this.options.secret);
          if (!authenticated) { socket.destroy(); return; }
          void writer.enqueue("OK\n").catch(() => socket.destroy());
          continue;
        }
        if (line.length === 0) continue;
        // Fire-and-forget with an explicit terminating catch: a late handler
        // failure must never become an unhandled rejection that kills the daemon.
        void this.process(socket, writer, line, (next) => { attachment?.close(); attachment = next; })
          .catch((error) => this.log(`[sessiond] rpc request process failed: ${describeSafe(error)}`));
      }
    });
    socket.on("close", () => { attachment?.close(); writer.close(); this.sockets.delete(socket); });
    socket.on("error", () => { attachment?.close(); writer.close(); this.sockets.delete(socket); });
  }

  private async process(socket: Socket, writer: SerialSocketWriter, line: string, setAttach: (attachment: PreparedAttachment) => void): Promise<void> {
    let input: unknown;
    try { input = JSON.parse(line); }
    catch {
      await this.writeFailureSafely(writer, "invalid", "system.ping", { code: "invalid_request", message: "invalid JSON", retryable: false });
      return;
    }
    const parsed = SessiondRpcRequestSchema.safeParse(input);
    if (!parsed.success) {
      const candidate = input as { id?: unknown; method?: unknown };
      const method = typeof candidate.method === "string" && isSessiondRpcMethod(candidate.method) ? candidate.method : "system.ping";
      await this.writeFailureSafely(writer, typeof candidate.id === "string" ? candidate.id : "invalid", method, { code: "invalid_request", message: "invalid RPC request", retryable: false });
      return;
    }
    const request = parsed.data;
    if (request.method === "system.shutdown") {
      await this.handleShutdown(writer, request);
      return;
    }
    if (request.method === "runtime.attach" && this.options.handler.attach) {
      let attached: PreparedAttachment;
      try {
        attached = this.options.handler.attach(request.params);
      } catch (error) {
        // attach() may fail synchronously (e.g. unknown session): deliver the
        // sanitized failure response while the connection is alive.
        await this.writeFailureSafely(writer, request.id, request.method, toBoundaryProtocolError(error), error);
        return;
      }
      setAttach(attached);
      try {
        // The response is the first queued frame. Replay/buffer flush cannot overtake it.
        await this.write(writer, { id: request.id, ok: true, method: request.method, result: attached.result });
        await attached.flushTo((push) => this.writePush(writer, push));
      } catch (error) {
        // Connection died mid-attach: tear down locally without letting the write
        // failure escape or double-writing a failure frame.
        attached.close();
        socket.destroy(error as Error);
      }
      return;
    }
    let result: SessiondMethodResult[SessiondRpcMethod];
    try {
      result = await dispatchHandler(this.options.handler, request);
    } catch (error) {
      // Deliver the failure response only if the connection is still alive; a
      // write failure here must never re-fail (peer already gone) or escape.
      await this.writeFailureSafely(writer, request.id, request.method, toBoundaryProtocolError(error), error);
      return;
    }
    try {
      await this.write(writer, { id: request.id, ok: true, method: request.method, result } as SessiondRpcResponse);
    } catch (error) {
      // Distinguish two distinct failure classes here:
      //  - writer closed (peer gone): the late/schema-invalid response is
      //    intentionally discarded and logged — never re-fail, never escape;
      //  - live connection: the schema/validation failure is a programming
      //    error and must surface to the client as a sanitized internal
      //    failure immediately (never silently dropped, never a client timeout).
      if (writer.isClosed) {
        this.logDrop("response", error);
      } else {
        await this.writeFailureSafely(writer, request.id, request.method, toBoundaryProtocolError(error), error);
      }
    }
  }

  private log(line: string): void {
    // Never throws: a throwing custom/default logger must not re-enter the RPC
    // path (e.g. from inside the fire-and-forget `.catch`) and must never turn
    // into an unhandled rejection.
    try {
      (this.options.logger ?? defaultRpcLogger)(line);
    } catch {
      // A broken/closed stderr or a throwing caller-supplied logger is swallowed.
    }
  }

  /** Log a dropped response. Only the SessiondError CODE (never its dynamic message), Error name, or type — so logs stay diagnosable without echoing request bodies or secrets. */
  private logDrop(context: string, cause?: unknown): void {
    const detail = cause === undefined
      ? ""
      : `: ${cause instanceof SessiondError ? `SessiondError(${cause.code})` : cause instanceof Error ? cause.name : typeof cause}`;
    this.log(`[sessiond] rpc ${context} dropped (connection closed)${detail}`);
  }

  /**
   * Write a failure frame without ever escaping. When the writer is already
   * closed the response is discarded (the peer is gone) and the drop is logged.
   * When the mapped response is a sanitized `internal` error (an unexpected
   * thrown value) the original cause is surfaced type-only so programming
   * errors are not silently swallowed.
   */
  private async writeFailureSafely(writer: SerialSocketWriter, id: string, method: SessiondRpcMethod, error: ProtocolError, cause?: unknown): Promise<void> {
    const unexpected = error.code === "internal";
    if (writer.isClosed) {
      this.logDrop("failure response", unexpected ? cause : undefined);
      return;
    }
    try {
      await this.write(writer, { id, ok: false, method, error } as SessiondRpcResponse);
    } catch (writeError) {
      // Writer closed between the check and the enqueue — the peer is gone.
      this.logDrop("failure response", unexpected ? cause : writeError);
    }
  }

  private writePush(writer: SerialSocketWriter, push: import("@fffattiger/pix-protocol").SessiondPush): Promise<void> {
    const parsed = SessiondPushSchema.parse(push);
    return writer.enqueue(`${JSON.stringify(parsed)}\n`);
  }

  private write(writer: SerialSocketWriter, response: SessiondRpcResponse): Promise<void> {
    const parsed = SessiondRpcResponseSchema.parse(response);
    return writer.enqueue(`${JSON.stringify(parsed)}\n`);
  }

  /**
   * Write a response with the bounded ACK barrier (real write callback + drain,
   * exactly-once). Only when this resolves has the client actually received the
   * bytes, so it is the safe point to begin a daemon shutdown transition.
   */
  private writeAcked(writer: SerialSocketWriter, response: SessiondRpcResponse): Promise<void> {
    const parsed = SessiondRpcResponseSchema.parse(response);
    return writer.enqueueFlushed(`${JSON.stringify(parsed)}\n`, this.options.shutdownAckTimeoutMs ?? SHUTDOWN_ACK_TIMEOUT_MS);
  }

  /**
   * Authenticated, instance-fenced `system.shutdown` (AUTH secret was already
   * required by the transport). Strictly fail-closed:
   *  - no authority → unsupported, no shutdown;
   *  - instance-id mismatch → forbidden, no shutdown (never echoes either id);
   *  - malformed params never reach here (schema rejected them earlier);
   *  - response delivery is ACKed (flushed) BEFORE `authority.initiate()` runs;
   *  - if the ACK barrier fails/times out the authority is never invoked — the
   *    daemon is never shut down merely because a request arrived.
   */
  private async handleShutdown(writer: SerialSocketWriter, request: SessiondRpcRequest & { method: "system.shutdown" }): Promise<void> {
    const authority = this.options.shutdownAuthority;
    if (!authority) {
      await this.writeFailureSafely(writer, request.id, "system.shutdown", { code: "unsupported_capability", message: "sessiond shutdown is unsupported", retryable: false });
      return;
    }
    if (request.params.instanceId !== authority.instanceId) {
      // Fail closed on any instance mismatch. The response is a fixed sanitized
      // error that never echoes the received or expected instance id.
      await this.writeFailureSafely(writer, request.id, "system.shutdown", { code: "forbidden", message: "sessiond shutdown refused", retryable: false });
      return;
    }
    let delivered = false;
    try {
      await this.writeAcked(writer, { id: request.id, ok: true, method: "system.shutdown", result: { accepted: true } } as SessiondRpcResponse);
      delivered = true;
    } catch (error) {
      // Delivery failed or timed out: fail closed — never initiate shutdown.
      this.logDrop("shutdown response", error);
    }
    if (delivered) authority.initiate();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Safe, leak-free description of an unexpected failure for logs. */
const describeSafe = (error: unknown): string => {
  if (error instanceof SessiondError) return `SessiondError(${error.code})`;
  if (error instanceof Error) return error.name;
  return typeof error;
};

/**
 * The exact method set the RPC server accepts. Derived from the current
 * Protocol `SESSIOND_RPC_METHODS` constant (never a hand-maintained duplicate
 * that can drift), so it always includes the latest methods such as
 * `sessions.rename` / `sessions.delete`. Contract tests assert this equals the
 * constant and that the constant matches the request schema.
 */
export const isSessiondRpcMethod = (value: string): value is SessiondRpcMethod =>
  (SESSIOND_RPC_METHODS as readonly string[]).includes(value);

async function dispatchHandler(handler: SessiondRpcHandler, request: SessiondRpcRequest): Promise<SessiondMethodResult[SessiondRpcMethod]> {
  return handler.handle(request.method, request.params as never, { requestId: request.id }) as Promise<SessiondMethodResult[SessiondRpcMethod]>;
}

export interface SessiondRpcClientOptions { endpoint: string; secret: string; timeoutMs?: number }
export interface SessiondRpcSubscription<T> { response: T; close(): void; /** Settles exactly once when the attach stream ends (remote close/error or local close()). */ closed: Promise<void> }

export class SessiondRpcClient {
  constructor(private readonly options: SessiondRpcClientOptions) {}

  async attach(params: SessiondMethodParams["runtime.attach"], onPush: (push: import("@fffattiger/pix-protocol").SessiondPush) => void | Promise<void>): Promise<SessiondRpcSubscription<SessiondMethodResult["runtime.attach"]>> {
    const id = crypto.randomUUID();
    const request = SessiondRpcRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, id, method: "runtime.attach", params });
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.endpoint);
      let buffered = "";
      let authenticated = false;
      let attached = false;
      let deliveryReady = false;
      const pendingPushes: import("@fffattiger/pix-protocol").SessiondPush[] = [];
      let settled = false;
      let closedResolve: (() => void) | undefined;
      const closed = new Promise<void>((settle) => { closedResolve = settle; });
      const settleClosed = () => {
        pendingPushes.length = 0;
        const resolve = closedResolve;
        closedResolve = undefined;
        if (resolve) resolve();
      };
      const timer = setTimeout(() => { socket.destroy(); if (!settled) { settled = true; reject(new SessiondError("timeout", "sessiond attach timed out", true)); } }, this.options.timeoutMs ?? 10_000);
      const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); if (!settled) { settled = true; reject(error); } };
      socket.on("connect", () => socket.write(`AUTH ${this.options.secret}\n`));
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!authenticated) {
            if (line !== "OK") return fail(new SessiondError("unauthorized", "sessiond authentication failed"));
            authenticated = true; socket.write(`${JSON.stringify(request)}\n`); continue;
          }
          let value: unknown;
          try { value = JSON.parse(line); } catch { return fail(new SessiondError("invalid_request", "invalid sessiond frame")); }
          if (!attached) {
            const response = SessiondRpcResponseSchema.safeParse(value);
            if (!response.success || response.data.id !== id || response.data.method !== "runtime.attach") return fail(new SessiondError("invalid_request", "mismatched attach response"));
            if (!response.data.ok) return fail(new SessiondError(response.data.error.code, response.data.error.message, response.data.error.retryable, response.data.error.details));
            attached = true; settled = true; clearTimeout(timer);
            resolve({ response: response.data.result, closed, close: () => { settleClosed(); socket.destroy(); } });
            queueMicrotask(() => {
              deliveryReady = true;
              for (const push of pendingPushes.splice(0)) Promise.resolve(onPush(push)).catch(() => socket.destroy());
            });
            continue;
          }
          const push = SessiondPushSchema.safeParse(value);
          if (!push.success) { socket.destroy(); return; }
          if (!deliveryReady) pendingPushes.push(push.data);
          else Promise.resolve(onPush(push.data)).catch(() => socket.destroy());
        }
      });
      socket.on("error", (error) => { if (!settled) fail(error); else settleClosed(); });
      socket.on("close", () => { if (!settled) fail(new SessiondError("unavailable", "sessiond attach closed", true)); else settleClosed(); });
    });
  }

  async call<M extends SessiondRpcMethod>(method: M, params: SessiondMethodParams[M]): Promise<SessiondMethodResult[M]> {
    const id = crypto.randomUUID();
    const request = SessiondRpcRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, id, method, params });
    return new Promise<SessiondMethodResult[M]>((resolve, reject) => {
      const socket = createConnection(this.options.endpoint);
      let buffered = "";
      let authenticated = false;
      const timer = setTimeout(() => { socket.destroy(); reject(new SessiondError("timeout", "sessiond RPC timed out", true)); }, this.options.timeoutMs ?? 10_000);
      const finish = (callback: () => void) => { clearTimeout(timer); socket.destroy(); callback(); };
      socket.on("connect", () => socket.write(`AUTH ${this.options.secret}\n`));
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!authenticated) {
            if (line !== "OK") { finish(() => reject(new SessiondError("unauthorized", "sessiond authentication failed"))); return; }
            authenticated = true;
            socket.write(`${JSON.stringify(request)}\n`);
            continue;
          }
          try {
            const response = SessiondRpcResponseSchema.parse(JSON.parse(line));
            if (response.id !== id || response.method !== method) { finish(() => reject(new SessiondError("invalid_request", "mismatched RPC response"))); return; }
            if (!response.ok) { finish(() => reject(new SessiondError(response.error.code, response.error.message, response.error.retryable, response.error.details))); return; }
            finish(() => resolve(response.result as SessiondMethodResult[M]));
          } catch { finish(() => reject(new SessiondError("invalid_request", "invalid RPC response"))); }
          return;
        }
      });
      socket.on("error", (error) => finish(() => reject(error)));
      socket.on("close", () => { if (!authenticated) { clearTimeout(timer); reject(new SessiondError("unauthorized", "sessiond connection closed")); } });
    });
  }
}
