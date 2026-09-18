/**
 * NdjsonStdioTransport — strict NDJSON framing over stdin/stdout.
 *
 * R2 frozen process model: one non-detached Node child per session, NDJSON
 * stdio, stdin EOF must trigger an ordered shutdown and process exit.
 *
 * Inbound (stdin):
 *   - each complete line is one frame, parsed with the strict
 *     `SessiondToWorkerMessageSchema` (no params: unknown).
 *   - malformed JSON / schema violation / oversized frame (> 2 MiB) produces a
 *     `worker.fatal` frame and a failing exit — never a hang.
 *   - stdin `end`/`close` triggers the ordered shutdown callback.
 *
 * Outbound (stdout):
 *   - stdout carries ONLY protocol frames. Every frame is validated against
 *     `WorkerToSessiondPushSchema` before being written; logs go to stderr.
 *   - writes are serialized and backpressure-safe (see {@link SerialStdoutWriter});
 *     a frame that fails validation is itself a protocol violation and fails
 *     closed with `worker.fatal` + exit.
 *
 * `requestExit` flushes the writer before exiting so the final `worker.fatal`
 * / `worker.ready` frame is never lost.
 */
import type { Readable, Writable as NodeWritableStream } from "node:stream";
import type {
  ProtocolError,
  SessiondToWorkerMessage,
  WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import { WorkerToSessiondPushSchema, safeParseSessiondToWorkerMessage } from "@fffattiger/pix-protocol";
import { protocolError } from "../mapper/protocol-error.js";
import { SerialStdoutWriter, type SerialStdoutWriterOptions } from "./serial-stdout-writer.js";
import {
  createSafeStderrLogger,
  DEFAULT_EXIT_FLUSH_TIMEOUT_MS,
  installProcessStdioGuards,
} from "./safe-stdio.js";

export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface NdjsonTransportOptions extends SerialStdoutWriterOptions {
  readonly stdin?: Readable;
  readonly stdout?: NodeWritableStream;
  /** stderr logger (defaults to the never-throwing process.stderr writer). */
  readonly stderr?: (line: string) => void;
  /** Max encoded bytes of a single inbound/outbound frame. */
  readonly maxFrameBytes?: number;
  /** Process exit override (tests). Defaults to process.exit. */
  readonly exit?: (code: number) => void;
  /** Cap on stdout flush wait before raw exit (parent death / broken pipe). */
  readonly exitFlushTimeoutMs?: number;
  /** Invoked for each parsed inbound frame, in arrival order. */
  readonly onMessage: (message: SessiondToWorkerMessage) => void;
  /** Invoked when stdin reaches EOF / closes (ordered shutdown). */
  readonly onInputClosed: () => void;
}

export class NdjsonStdioTransport {
  private readonly stdin: Readable;
  private readonly writer: SerialStdoutWriter;
  private readonly stderr: (line: string) => void;
  private readonly maxFrameBytes: number;
  private readonly exit: (code: number) => void;
  private readonly exitFlushTimeoutMs: number;
  private readonly onMessage: (message: SessiondToWorkerMessage) => void;
  private readonly onInputClosed: () => void;

  private buffer = "";
  private started = false;
  private stopped = false;
  private exitRequested = false;
  private exitRequestedCode = 0;
  private fatalSent = false;

  constructor(options: NdjsonTransportOptions) {
    // Guard process pipes early so any default-logger EPIPE is swallowed.
    installProcessStdioGuards();
    this.stdin = options.stdin ?? process.stdin;
    this.stderr = options.stderr ?? createSafeStderrLogger();
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.exitFlushTimeoutMs = options.exitFlushTimeoutMs ?? DEFAULT_EXIT_FLUSH_TIMEOUT_MS;
    this.onMessage = options.onMessage;
    this.onInputClosed = options.onInputClosed;
    this.writer = new SerialStdoutWriter(options.stdout ?? process.stdout, options);
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Install stdin listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.onData(chunk));
    this.stdin.on("end", () => this.onEof());
    this.stdin.on("close", () => this.onEof());
    this.stdin.on("error", (error) => {
      this.stderr(`[transport] stdin error: ${error instanceof Error ? error.message : String(error)}`);
      this.onEof();
    });
    // Late-listener race guard: if stdin already reached EOF / was destroyed /
    // closed during the async composition boot gap (parent died before we
    // attached), the end/close events will not re-fire. Trigger ordered
    // shutdown immediately. Buffered complete frames are still delivered via
    // the `data` event that fires when flowing begins, so nothing is lost.
    if (this.stdin.readableEnded || this.stdin.destroyed || this.stdin.closed) {
      this.onEof();
    }
  }

  /** Detach stdin listeners (tests / cleanup). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stdin.removeAllListeners("data");
    this.stdin.removeAllListeners("end");
    this.stdin.removeAllListeners("close");
    this.stdin.removeAllListeners("error");
    this.stdin.pause?.();
  }

  /**
   * Validate + enqueue one outbound Protocol frame. Resolves once written.
   * A frame that violates the frozen schema fails closed.
   */
  send(message: WorkerToSessiondMessage): Promise<void> {
    const parsed = WorkerToSessiondPushSchema.safeParse(message);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 500);
      this.stderr(`[transport] rejecting invalid outbound frame: ${detail}`);
      void this.sendFatalAndExit(
        protocolError("internal", `worker produced an invalid protocol frame (${detail || "schema violation"})`),
        1,
      );
      return Promise.reject(new Error("invalid outbound protocol frame"));
    }
    const frame = JSON.stringify(parsed.data);
    if (Buffer.byteLength(frame) > this.maxFrameBytes) {
      void this.sendFatalAndExit(protocolError("internal", "outbound frame exceeds the size limit"), 1);
      return Promise.reject(new Error("outbound frame exceeds the size limit"));
    }
    return this.writer.enqueue(frame);
  }

  /**
   * Flush all pending frames, then exit. Idempotent: the first exit code wins.
   * Flush is bounded so a broken stdout (parent death) cannot hang the process.
   */
  requestExit(code: number): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    this.exitRequestedCode = code;
    this.stop();
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      try {
        this.exit(exitCode);
      } catch {
        try {
          process.exit(exitCode);
        } catch {
          // exhausted
        }
      }
    };
    const flushTimer = setTimeout(() => {
      this.stderr(`[transport] exit flush timed out after ${this.exitFlushTimeoutMs}ms; raw exit`);
      // Writer may still be waiting on drain of a dead pipe — force-close it.
      try {
        this.writer.close(new Error("exit flush timed out"));
      } catch {
        // ignore
      }
      finish(code);
    }, this.exitFlushTimeoutMs);
    flushTimer.unref?.();
    void this.writer
      .flush()
      .then(() => finish(code))
      .catch(() => finish(1));
  }

  /** Send worker.fatal (once) then exit with the given code. */
  async fatal(error: ProtocolError, exitCode: number): Promise<void> {
    await this.sendFatalAndExit(error, exitCode);
  }

  private onData(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleLine(line);
      if (this.exitRequested) return; // fatal already requested; stop consuming
      newlineIndex = this.buffer.indexOf("\n");
    }
    // No trailing newline yet — guard against an unbounded single frame.
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      void this.sendFatalAndExit(protocolError("invalid_request", "frame exceeds the size limit"), 1);
    }
  }

  private handleLine(line: string): void {
    // Strip a single trailing CR for CRLF-tolerant framing.
    const frame = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (frame.length === 0) return; // empty lines are ignored, not errors
    if (Buffer.byteLength(frame, "utf8") > this.maxFrameBytes) {
      void this.sendFatalAndExit(protocolError("invalid_request", "frame exceeds the size limit"), 1);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      void this.sendFatalAndExit(protocolError("invalid_request", "malformed frame: not valid JSON"), 1);
      return;
    }
    const result = safeParseSessiondToWorkerMessage(parsed);
    if (!result.success) {
      const detail = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 300);
      void this.sendFatalAndExit(protocolError("invalid_request", `malformed frame: ${detail || "schema violation"}`), 1);
      return;
    }
    this.onMessage(result.data);
  }

  private onEof(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onInputClosed();
  }

  private async sendFatalAndExit(error: ProtocolError, exitCode: number): Promise<void> {
    if (this.fatalSent) {
      this.requestExit(exitCode);
      return;
    }
    this.fatalSent = true;
    try {
      const frame = JSON.stringify({ type: "worker.fatal", payload: { error } });
      await this.writer.enqueue(frame);
    } catch (writeError) {
      this.stderr(`[transport] failed to write worker.fatal: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
    }
    this.requestExit(exitCode);
  }
}
