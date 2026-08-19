import type { EventEmitter } from "node:events";
import { SessiondError } from "../errors.js";

export interface RpcWriteStream extends EventEmitter {
  write(data: string | Uint8Array, cb?: (error?: Error | null) => void): boolean;
  destroy(error?: Error): void;
}

export interface SerialSocketWriterOptions {
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
}

/**
 * Chunk size for ordinary frames, in UTF-8 **bytes**. A single `write()`
 * larger than the platform pipe buffer (Windows named pipe default 64 KiB)
 * can hang or fail the underlying I/O, so every chunk stays well under that
 * bound. Chunking is performed on an already-encoded byte buffer (never on
 * UTF-16 character counts), so multibyte CJK/emoji never inflate a chunk past
 * the platform limit.
 */
const CHUNK_BYTES = 32 * 1024;
/** Bounded wait for a `drain` after backpressure (fail-closed, never wedge). */
const DRAIN_WAIT_MS = 15_000;

interface Frame {
  /** The original frame text (used for the acknowledged, single-write path). */
  data: string;
  /** UTF-8 byte encoding of {@link Frame.data}; encoded exactly once per frame. */
  encoded: Buffer;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
  /**
   * Bounded acknowledgment barrier (set only by {@link SerialSocketWriter.enqueueFlushed}).
   * While present, the frame settles exactly once — across the real socket write
   * callback, the `drain` event (required only when `write()` returned false), a
   * hard timeout, or a terminal socket error/close — whichever fires first.
   * Present for every frame; `undefined` for ordinary {@link SerialSocketWriter.enqueue}
   * frames (preserves the historical no-barrier behavior byte-for-byte).
   */
  barrier: FrameBarrier | undefined;
}

/** State of an acknowledged-flush barrier (see {@link Frame.barrier}). */
interface FrameBarrier {
  timeoutMs: number;
  /** write() returned false → a drain event is required before delivery. */
  needsDrain: boolean;
  /** The socket write callback fired (data handed to the OS). */
  writeCallbackFired: boolean;
  /** A drain event was observed while this frame was flushing. */
  drainFired: boolean;
  /** Exactly-once guard: true once the barrier (or a terminal failure) settled this frame. */
  settled: boolean;
  timer: NodeJS.Timeout | undefined;
  /** Resolves the drain-loop flush wait once delivered. */
  resolveFlush: (() => void) | undefined;
  /** Rejects the drain-loop flush wait on terminal failure. */
  rejectFlush: ((error: Error) => void) | undefined;
}

/**
 * Ordered, bounded socket writer. One write failure rejects all unsettled
 * frames exactly once.
 *
 * Lifecycle guarantees:
 * - `enqueue` after close rejects (with the terminal failure) and never leaves
 *   a dangling promise.
 * - The frame currently being flushed (shifted off the queue while awaiting
 *   `drain` backpressure) is tracked as `current`. A concurrent socket
 *   `close`/`error` rejects it AND unblocks the pending drain, so it settles
 *   exactly once and never hangs.
 * - `error → close` and `close → error` are both idempotent: `fail` is a
 *   no-op once the writer is closed.
 *
 * Acknowledged delivery (`enqueueFlushed`): the returned promise settles
 * exactly once only after the real socket write callback fires AND — when
 * `write()` returned false (backpressure) — a `drain` event, bounded by a hard
 * timeout. Late events (drain/callback after settle) are no-ops. On
 * error/close/timeout the writer fails closed and the frame rejects exactly
 * once, so callers that gate an authority action (e.g. daemon shutdown) on this
 * barrier can never act on a response that was not actually delivered.
 */
export class SerialSocketWriter {
  private readonly queue: Frame[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;
  private failure: Error | undefined;
  /** Frame currently being flushed (removed from the queue). Settled by {@link fail} on close. */
  private current: Frame | undefined;
  /** Resolves the pending backpressure wait so a concurrent close cannot hang the current frame. */
  private resolveDrainWait: (() => void) | undefined;
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;

  /** True once the writer has terminated (socket error/close, overflow, or explicit close). */
  get isClosed(): boolean {
    return this.closed;
  }

  constructor(private readonly socket: RpcWriteStream, options: SerialSocketWriterOptions = {}) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? 256;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024;
    // Listener lifetime == socket lifetime (the writer is per-connection and the
    // socket is destroyed on close), so these never leak.
    socket.on("close", () => this.fail(new SessiondError("unavailable", "RPC socket closed", true)));
    socket.on("error", (error) => this.fail(error));
    socket.on("drain", () => {
      this.endDrainWait();
      // An acknowledged frame that hit backpressure needs the drain event.
      // `current` is the only frame mid-flush, so no bookkeeping set is needed.
      const current = this.current;
      if (current?.barrier) {
        current.barrier.drainFired = true;
        this.trySettleBarrier(current);
      }
    });
  }

  enqueue(data: string): Promise<void> {
    return this.enqueueInternal(data, undefined);
  }

  /**
   * Enqueue `data` and resolve only after the bytes were handed to the OS
   * (real socket write callback) and, when backpressure applied, a `drain` —
   * bounded by `timeoutMs` and settling exactly once. Preserves ordering and
   * the shared bounded queue. On failure (timeout/close/error/overflow) the
   * writer fails closed and the promise rejects once.
   */
  enqueueFlushed(data: string, timeoutMs: number): Promise<void> {
    return this.enqueueInternal(data, {
      timeoutMs,
      needsDrain: false,
      writeCallbackFired: false,
      drainFired: false,
      settled: false,
      timer: undefined,
      resolveFlush: undefined,
      rejectFlush: undefined,
    });
  }

  close(error = new SessiondError("unavailable", "RPC writer closed", true)): void {
    this.fail(error);
  }

  private endDrainWait(): void {
    const resolveDrainWait = this.resolveDrainWait;
    this.resolveDrainWait = undefined;
    if (resolveDrainWait) resolveDrainWait();
  }

  private enqueueInternal(data: string, barrier: FrameBarrier | undefined): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new SessiondError("unavailable", "RPC writer is closed", true));
    const bytes = Buffer.byteLength(data);
    if (this.queue.length >= this.maxQueuedFrames || this.queuedBytes + bytes > this.maxQueuedBytes) {
      const error = new SessiondError("unavailable", "RPC writer queue overflowed", true);
      this.fail(error);
      this.socket.destroy(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      const frame: Frame = { data, encoded: Buffer.from(data, "utf8"), bytes, resolve, reject, barrier };
      this.queue.push(frame);
      this.queuedBytes += bytes;
      if (barrier) {
        // Bound the whole delivery (queue wait + flush). On expiry the writer
        // fails closed and the frame rejects exactly once.
        barrier.timer = setTimeout(() => {
          barrier.timer = undefined;
          this.fail(new SessiondError("timeout", "RPC write timed out", true));
        }, barrier.timeoutMs);
      }
      if (!this.draining) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const frame = this.queue.shift()!;
        this.queuedBytes -= frame.bytes;
        this.current = frame;
        try {
          await this.flushFrame(frame);
          if (!this.closed && frame.barrier === undefined) frame.resolve();
          // For barrier frames the ack barrier (or `fail`) settled the frame
          // exactly once; for no-barrier frames this is the historical path.
        } catch (error) {
          this.fail(error as Error);
        } finally {
          if (this.current === frame) this.current = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async flushFrame(frame: Frame): Promise<void> {
    const barrier = frame.barrier;
    if (barrier === undefined) {
      // Byte-accurate chunking of the already-encoded frame: split the UTF-8
      // byte buffer into subarray views each well under the platform pipe
      // buffer. Because chunks are byte views of a single Buffer, a multibyte
      // character is never split/re-encoded and a chunk can never exceed
      // CHUNK_BYTES bytes regardless of the character width (unlike the old
      // UTF-16 character slicing, which could balloon a 32K-char frame past
      // 64 KiB on Windows). The protocol only cares about the final newline,
      // so splitting is safe.
      const buf = frame.encoded;
      for (let offset = 0; offset < buf.length; offset += CHUNK_BYTES) {
        const chunk = buf.subarray(offset, Math.min(offset + CHUNK_BYTES, buf.length));
        if (!this.socket.write(chunk)) {
          // Backpressure: wait for a real drain or for the writer to close.
          // A concurrent close rejects `frame` via `fail` and resolves this
          // wait, so the frame settles exactly once and never hangs. The wait
          // is also bounded so a peer that stops reading cannot wedge the
          // writer forever.
          await this.waitForDrainOrClose(DRAIN_WAIT_MS);
        }
      }
      return;
    }
    // Acknowledged flush: hand off with a per-write callback and (when
    // backpressure) wait for a drain too, bounded by the frame timeout. The
    // frame is written as one UTF-8 byte buffer.
    return new Promise<void>((resolveFlush, rejectFlush) => {
      barrier.resolveFlush = resolveFlush;
      barrier.rejectFlush = rejectFlush;
      let wrote = false;
      try {
        wrote = this.socket.write(frame.encoded, (error?: Error | null) => {
          if (error) {
            // The write callback reported a failure (e.g. EPIPE delivered via
            // the callback rather than the socket 'error' event). Fail closed
            // through the existing path: rejects this barrier + any queued
            // frames exactly once (clearing timers) and marks the writer
            // closed. Never settle a genuinely-failed write as success.
            this.fail(error);
            return;
          }
          barrier.writeCallbackFired = true;
          this.trySettleBarrier(frame);
        });
      } catch (error) {
        this.fail(error as Error);
        return;
      }
      if (!wrote) barrier.needsDrain = true;
    });
  }

  /**
   * Exactly-once settle of an acknowledged frame: resolve once the write
   * callback fired and (when write() returned false) the drain fired. Any
   * terminal failure goes through {@link fail} → {@link rejectFrame} instead.
   */
  private trySettleBarrier(frame: Frame): void {
    const barrier = frame.barrier;
    if (barrier === undefined || barrier.settled) return;
    if (!barrier.writeCallbackFired || (barrier.needsDrain && !barrier.drainFired)) return;
    barrier.settled = true;
    if (barrier.timer !== undefined) {
      clearTimeout(barrier.timer);
      barrier.timer = undefined;
    }
    barrier.resolveFlush?.();
    frame.resolve();
  }

  private waitForDrainOrClose(timeoutMs = DRAIN_WAIT_MS): Promise<void> {
    if (this.closed || this.resolveDrainWait) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.resolveDrainWait !== finish) return;
        this.resolveDrainWait = undefined;
        this.fail(new SessiondError("timeout", "RPC write drain timed out", true));
        finish();
      }, timeoutMs);
      this.resolveDrainWait = finish;
    });
  }

  private rejectFrame(frame: Frame, error: Error): void {
    if (frame.barrier) {
      const barrier = frame.barrier;
      if (barrier.timer !== undefined) {
        clearTimeout(barrier.timer);
        barrier.timer = undefined;
      }
      barrier.settled = true;
      barrier.rejectFlush?.(error);
    }
    frame.reject(error);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    // Unblock a pending backpressure wait so the current frame is settled (below)
    // instead of hanging on a `drain` that will never arrive.
    this.endDrainWait();
    const current = this.current;
    this.current = undefined;
    if (current) this.rejectFrame(current, error);
    for (const frame of this.queue.splice(0)) this.rejectFrame(frame, error);
    this.queuedBytes = 0;
  }
}
