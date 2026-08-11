/**
 * SerialStdoutWriter — ordered, bounded, backpressure-safe stdout writer.
 *
 * stdout carries ONLY protocol NDJSON frames (per R2 freeze); every write is a
 * complete frame appended with "\n". Writes are serialized and drain-aware:
 * when `write()` reports backpressure the writer waits for `drain` before
 * continuing, so frame order is always preserved. The queue is bounded; an
 * overflow or a closed stream rejects every queued frame (fail closed).
 *
 * `flush()` resolves once every enqueued frame has been flushed to the stream,
 * giving the composition root a graceful-exit gate before process.exit.
 */
import type { Writable as NodeWritableStream } from "node:stream";

export interface SerialStdoutWriterOptions {
  /** Max frames waiting in the queue. */
  maxQueuedFrames?: number;
  /** Max queued bytes before overflow. */
  maxQueuedBytes?: number;
}

interface Frame {
  data: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class SerialStdoutWriter {
  private readonly queue: Frame[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;
  private failure: Error | undefined;
  /** Frame currently mid-write (already dequeued; must be rejected on fail). */
  private writing: Frame | undefined;
  private readonly flushWaiters: (() => void)[] = [];
  /** Resolvers waiting on stream 'drain'; woken on drain OR fail so close never hangs. */
  private readonly drainWaiters: (() => void)[] = [];
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;

  constructor(private readonly stream: NodeWritableStream, options: SerialStdoutWriterOptions = {}) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? 256;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024;
    stream.once("close", () => this.fail(new Error("stdout writer closed")));
    stream.once("error", (error) => this.fail(error));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Enqueue a full frame (without trailing newline). Resolves once written. */
  enqueue(data: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.failure ?? new Error("stdout writer is closed"));
    }
    const bytes = Buffer.byteLength(data);
    if (this.queue.length >= this.maxQueuedFrames || this.queuedBytes + bytes > this.maxQueuedBytes) {
      const error = new Error("stdout writer queue overflowed");
      this.fail(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, bytes, resolve, reject });
      this.queuedBytes += bytes;
      if (!this.draining) void this.drain();
    });
  }

  /** Resolve once all currently-queued frames have been written to the stream. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.draining && this.queue.length === 0 && this.writing === undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.flushWaiters.push(resolve);
    });
  }

  /** Reject all pending frames; future enqueues reject. Never hangs on backpressure. */
  close(error = new Error("stdout writer closed")): void {
    this.fail(error);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const frame = this.queue.shift();
        if (!frame) break;
        this.queuedBytes -= frame.bytes;
        this.writing = frame;
        try {
          if (!this.stream.write(`${frame.data}\n`)) await this.waitForDrain();
          // fail() may have rejected this frame while we waited on drain.
          if (this.closed) {
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
      // Only wake flush waiters when nothing remains (or we are closed).
      if (this.closed || (this.queue.length === 0 && this.writing === undefined)) {
        const waiters = this.flushWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.closed) return Promise.resolve();
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
    // Unblock any drain waiters so the drain loop can observe closed and exit.
    for (const wake of this.drainWaiters.splice(0)) wake();
    for (const resolve of this.flushWaiters.splice(0)) resolve();
  }
}
