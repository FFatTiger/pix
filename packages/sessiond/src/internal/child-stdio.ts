/**
 * Child stdio helpers for the R2 Worker process factory.
 *
 * - stdout: line-delimited NDJSON, 2 MiB max frame (UTF-8 bytes), split/coalesced
 *   chunks, CRLF, and EOF partial-line handling.
 * - stdin: ordered, bounded, backpressure-aware writer (one frame per line).
 * - stderr: always drained into a bounded, redacted ring for diagnostics so the
 *   child never blocks on a full pipe and secrets/paths never leak outward.
 */
import type { Readable, Writable } from "node:stream";
import { once } from "node:events";

export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STDERR_RING_BYTES = 64 * 1024;
export const DEFAULT_STDIN_MAX_QUEUED_FRAMES = 256;
export const DEFAULT_STDIN_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// stdout NDJSON reader
// ---------------------------------------------------------------------------

export interface NdjsonStdoutReaderOptions {
  maxFrameBytes?: number;
  onFrame: (line: string) => void;
  /** Called once when framing fails closed (oversize / incomplete oversize). */
  onFatal: (reason: string) => void;
  /** Called once when the stream ends (after any trailing partial is handled). */
  onEnd?: () => void;
}

/**
 * Incremental NDJSON line splitter over a Readable. Does not parse JSON —
 * the caller validates schema. Empty lines are ignored.
 */
export class NdjsonStdoutReader {
  private buffer = "";
  private stopped = false;
  private fatal = false;
  private readonly maxFrameBytes: number;
  private readonly onFrame: (line: string) => void;
  private readonly onFatal: (reason: string) => void;
  private readonly onEnd: (() => void) | undefined;

  constructor(
    private readonly stream: Readable,
    options: NdjsonStdoutReaderOptions,
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.onFrame = options.onFrame;
    this.onFatal = options.onFatal;
    this.onEnd = options.onEnd;
  }

  /** Attach listeners. Safe to call once; subsequent calls are no-ops. */
  start(): void {
    if (this.stopped) return;
    this.stream.setEncoding("utf8");
    this.stream.on("data", (chunk: string) => this.onData(chunk));
    this.stream.on("end", () => this.finish());
    this.stream.on("close", () => this.finish());
    this.stream.on("error", () => this.finish());
  }

  /** Detach and stop consuming. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stream.removeAllListeners("data");
    this.stream.removeAllListeners("end");
    this.stream.removeAllListeners("close");
    this.stream.removeAllListeners("error");
    try {
      this.stream.pause?.();
    } catch {
      // stream may already be destroyed
    }
  }

  private onData(chunk: string): void {
    if (this.stopped || this.fatal) return;
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const raw = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      // CRLF-tolerant: strip a single trailing CR.
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length > 0) {
        if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
          this.fail("frame exceeds the size limit");
          return;
        }
        this.onFrame(line);
        if (this.fatal || this.stopped) return;
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.fail("frame exceeds the size limit");
    }
  }

  private finish(): void {
    if (this.stopped) return;
    // A trailing partial without newline at EOF is a framing error only when
    // non-empty (incomplete frame). Empty buffer is a clean EOF.
    if (!this.fatal && this.buffer.length > 0) {
      const trailing = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      if (trailing.length > 0) {
        if (Buffer.byteLength(trailing, "utf8") > this.maxFrameBytes) {
          this.fail("frame exceeds the size limit");
        } else {
          // Deliver the partial as a frame so schema validation can reject it;
          // an incomplete JSON line will fail closed at the connection layer.
          this.onFrame(trailing);
        }
      }
    }
    this.stop();
    this.onEnd?.();
  }

  private fail(reason: string): void {
    if (this.fatal) return;
    this.fatal = true;
    this.buffer = "";
    this.onFatal(reason);
    this.stop();
  }
}

// ---------------------------------------------------------------------------
// stdin serial writer
// ---------------------------------------------------------------------------

export interface SerialStdinWriterOptions {
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
}

interface StdinFrame {
  data: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Ordered, bounded stdin writer with drain-aware backpressure. */
export class SerialStdinWriter {
  private readonly queue: StdinFrame[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;
  private ended = false;
  private failure: Error | undefined;
  private writing: StdinFrame | undefined;
  private readonly drainWaiters: Array<() => void> = [];
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;

  constructor(
    private readonly stream: Writable,
    options: SerialStdinWriterOptions = {},
  ) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_STDIN_MAX_QUEUED_FRAMES;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_STDIN_MAX_QUEUED_BYTES;
    stream.once("close", () => this.fail(new Error("worker stdin closed")));
    stream.once("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Enqueue one complete frame (no trailing newline). Resolves once written. */
  enqueue(data: string): Promise<void> {
    if (this.closed || this.ended) {
      return Promise.reject(this.failure ?? new Error("worker stdin is closed"));
    }
    const bytes = Buffer.byteLength(data);
    if (this.queue.length >= this.maxQueuedFrames || this.queuedBytes + bytes > this.maxQueuedBytes) {
      const error = new Error("worker stdin queue overflowed");
      this.fail(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, bytes, resolve, reject });
      this.queuedBytes += bytes;
      if (!this.draining) void this.drain();
    });
  }

  /**
   * Gracefully end stdin (EOF to the child). Rejects any still-queued frames.
   * Idempotent.
   */
  end(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    // Reject anything still waiting so callers never hang.
    if (this.writing !== undefined) {
      this.writing.reject(this.failure ?? new Error("worker stdin ended"));
      this.writing = undefined;
    }
    for (const frame of this.queue.splice(0)) {
      frame.reject(this.failure ?? new Error("worker stdin ended"));
    }
    this.queuedBytes = 0;
    for (const wake of this.drainWaiters.splice(0)) wake();
    try {
      this.stream.end();
    } catch {
      // already closed
    }
  }

  /** Fail closed: reject pending frames and refuse further enqueues. */
  close(error = new Error("worker stdin closed")): void {
    this.fail(error);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && !this.ended && this.queue.length > 0) {
        const frame = this.queue.shift();
        if (!frame) break;
        this.queuedBytes -= frame.bytes;
        this.writing = frame;
        try {
          if (!this.stream.write(`${frame.data}\n`)) await this.waitForDrain();
          if (this.closed || this.ended) {
            this.writing = undefined;
            break;
          }
          frame.resolve();
          this.writing = undefined;
        } catch (error) {
          this.writing = undefined;
          frame.reject(error as Error);
          this.fail(error as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.closed || this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onDrain = () => {
        this.stream.off("drain", onDrain);
        const index = this.drainWaiters.indexOf(wake);
        if (index !== -1) this.drainWaiters.splice(index, 1);
        resolve();
      };
      const wake = () => {
        this.stream.off("drain", onDrain);
        resolve();
      };
      this.stream.once("drain", onDrain);
      this.drainWaiters.push(wake);
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    if (this.writing !== undefined) {
      this.writing.reject(error);
      this.writing = undefined;
    }
    for (const frame of this.queue.splice(0)) frame.reject(error);
    this.queuedBytes = 0;
    for (const wake of this.drainWaiters.splice(0)) wake();
  }
}

// ---------------------------------------------------------------------------
// stderr ring (bounded + redacted)
// ---------------------------------------------------------------------------

export interface StderrRingOptions {
  maxBytes?: number;
}

/**
 * Always-on stderr drain. Keeps a bounded, redacted ring buffer for diagnostics
 * without ever applying backpressure to the child or retaining secrets.
 */
export class StderrRing {
  private chunks: string[] = [];
  private bytes = 0;
  private readonly maxBytes: number;
  private stopped = false;

  constructor(
    private readonly stream: Readable,
    options: StderrRingOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_STDERR_RING_BYTES;
  }

  start(): void {
    if (this.stopped) return;
    this.stream.setEncoding("utf8");
    this.stream.on("data", (chunk: string) => this.push(chunk));
    // Swallow errors so a broken stderr pipe never crashes the parent.
    this.stream.on("error", () => {});
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stream.removeAllListeners("data");
    this.stream.removeAllListeners("error");
    try {
      this.stream.resume?.(); // ensure any residual data is discarded
    } catch {
      // ignore
    }
  }

  /** Snapshot of the redacted ring (newest-biased). */
  snapshot(): string {
    return this.chunks.join("");
  }

  /**
   * Test/helper entry: push already-decoded text through the same redaction +
   * eviction path as stream `data` events.
   */
  pushText(raw: string): void {
    this.push(raw);
  }

  private push(raw: string): void {
    if (this.stopped || raw.length === 0) return;
    // Redact first so secrets never enter the ring, even briefly.
    let text = redactStderr(raw);
    if (text.length === 0) return;

    // A single redacted chunk may itself exceed the ring. Keep only its newest
    // UTF-8-safe tail so snapshot() is never emptied by eviction of the only
    // remaining chunk (that race made the flood test flaky under coalesced writes).
    // Re-redact after the cut: a byte-tail can start mid-line and re-expose
    // patterns that only match with a left context on the full line.
    const textBytes = Buffer.byteLength(text, "utf8");
    if (textBytes > this.maxBytes) {
      text = redactStderr(utf8SafeTail(text, this.maxBytes));
      if (text.length === 0) return;
      // Tail + re-redact can only shrink or stay; if still over (marker expansion
      // is not expected to grow past max), trim once more without re-expanding.
      if (Buffer.byteLength(text, "utf8") > this.maxBytes) {
        text = utf8SafeTail(text, this.maxBytes);
      }
    }

    this.chunks.push(text);
    this.bytes += Buffer.byteLength(text, "utf8");

    // Newest-biased multi-chunk eviction: drop oldest whole chunks first.
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped !== undefined) this.bytes -= Buffer.byteLength(dropped, "utf8");
    }

    // If a single retained chunk still overshoots, trim to a UTF-8-safe tail and
    // re-redact so a mid-line cut cannot reintroduce secrets into the snapshot.
    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0]!;
      let trimmed = redactStderr(utf8SafeTail(only, this.maxBytes));
      if (Buffer.byteLength(trimmed, "utf8") > this.maxBytes) {
        trimmed = utf8SafeTail(trimmed, this.maxBytes);
      }
      this.chunks[0] = trimmed;
      this.bytes = Buffer.byteLength(trimmed, "utf8");
    }
  }
}

/**
 * Return the newest portion of `text` whose UTF-8 byte length is ≤ `maxBytes`.
 * Never splits a multi-byte code point: walks backward from the byte budget
 * until `Buffer.from(slice, "utf8").toString("utf8")` round-trips cleanly, which
 * is guaranteed when the start index lands on a code-unit boundary that begins
 * a character (we step by code units via string index after finding a safe byte offset).
 */
export function utf8SafeTail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (text.length === 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;

  // Start at the first byte that may be kept, then advance past any continuation
  // bytes (10xxxxxx) so we never open mid-character.
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  if (start >= buf.length) return "";
  return buf.subarray(start).toString("utf8");
}

/**
 * Redact absolute paths, common API key/token shapes, and Bearer headers from
 * stderr so diagnostic rings never leak secrets or host layout.
 */
export function redactStderr(input: string): string {
  let text = input;
  // Bearer tokens — with or without an Authorization header (chunk splits may
  // drop the header while leaving `Bearer <secret>` intact).
  text = text.replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  text = text.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
  // Explicit key/token assignments and JSON fields
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|secret|password|token)\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    "$1$2[REDACTED]",
  );
  // sk-/rk-/pk- provider tokens (also when a prior chunk cut the leading boundary)
  text = text.replace(/(?:^|[^A-Za-z0-9])(?:sk|rk|pk)[-_][A-Za-z0-9_\-]{8,}/g, (m) => {
    const lead = m[0] !== "s" && m[0] !== "r" && m[0] !== "p" ? m[0]! : "";
    const token = lead ? m.slice(1) : m;
    return `${lead}[REDACTED]`;
  });
  // Long base64-ish blobs that often encode secrets (keep short identifiers)
  text = text.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, "[REDACTED]");
  // Absolute POSIX / Windows paths — also when the chunk starts mid-path after a cut.
  text = text.replace(/(?:^|[\s"'`=(])(\/(?:Users|home|var|tmp|private|opt|etc|root)\/[^\s"'`)]+)/g, (match, path) =>
    match.replace(path, "[PATH]"),
  );
  text = text.replace(/(?:^|\/)((?:Users|home)\/[^\s"'`)]+)/g, (match, path) => match.replace(path, "[PATH]"));
  text = text.replace(/(?:^|[\s"'`=(])([A-Za-z]:\\[^\s"'`)]+)/g, (match, path) => match.replace(path, "[PATH]"));
  return text;
}

/** Convenience: wait for a stream event with a timeout (tests / close races). */
export async function waitForEvent(emitter: NodeJS.EventEmitter, event: string, timeoutMs: number): Promise<unknown[]> {
  return Promise.race([
    once(emitter, event),
    new Promise<unknown[]>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    }),
  ]);
}
