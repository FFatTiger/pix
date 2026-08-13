import type { Socket } from "node:net";
import { SessiondError } from "../errors.js";

export interface SerialSocketWriterOptions {
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
}

interface Frame {
  data: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
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
 */
export class SerialSocketWriter {
  private readonly queue: Frame[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;
  private failure: Error | undefined;
  /** Frame currently being flushed (removed from the queue). Settled by {@link fail} on close. */
  private current: Frame | undefined;
  /** Resolves the pending socket-write callback wait so close cannot hang the current frame. */
  private resolveWriteWait: (() => void) | undefined;
  /** Resolves the pending backpressure wait so a concurrent close cannot hang the current frame. */
  private resolveDrainWait: (() => void) | undefined;
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;

  /** True once the writer has terminated (socket error/close, overflow, or explicit close). */
  get isClosed(): boolean {
    return this.closed;
  }

  constructor(private readonly socket: Socket, options: SerialSocketWriterOptions = {}) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? 256;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024;
    // Listener lifetime == socket lifetime (the writer is per-connection and the
    // socket is destroyed on close), so these never leak.
    socket.on("close", () => this.fail(new SessiondError("unavailable", "RPC socket closed", true)));
    socket.on("error", (error) => this.fail(error));
    socket.on("drain", () => this.endDrainWait());
  }

  enqueue(data: string): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new SessiondError("unavailable", "RPC writer is closed", true));
    const bytes = Buffer.byteLength(data);
    if (this.queue.length >= this.maxQueuedFrames || this.queuedBytes + bytes > this.maxQueuedBytes) {
      const error = new SessiondError("unavailable", "RPC writer queue overflowed", true);
      this.fail(error);
      this.socket.destroy(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, bytes, resolve, reject });
      this.queuedBytes += bytes;
      if (!this.draining) void this.drain();
    });
  }

  close(error = new SessiondError("unavailable", "RPC writer closed", true)): void {
    this.fail(error);
  }

  private endWriteWait(): void {
    const resolveWriteWait = this.resolveWriteWait;
    this.resolveWriteWait = undefined;
    if (resolveWriteWait) resolveWriteWait();
  }

  private endDrainWait(): void {
    const resolveDrainWait = this.resolveDrainWait;
    this.resolveDrainWait = undefined;
    if (resolveDrainWait) resolveDrainWait();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const frame = this.queue.shift()!;
        this.queuedBytes -= frame.bytes;
        this.current = frame;
        try {
          // `socket.write()` returning true only means the chunk was accepted
          // into Node's writable queue. Resolve the frame only after its write
          // callback fires; shutdown relies on this promise before destroying
          // sockets. When backpressured, also wait for `drain` before writing
          // the next frame so queue ordering stays bounded.
          const writeComplete = new Promise<void>((resolve) => {
            this.resolveWriteWait = resolve;
          });
          const accepted = this.socket.write(frame.data, (error?: Error | null) => {
            if (error) this.fail(error);
            this.endWriteWait();
          });
          if (accepted) {
            await writeComplete;
          } else {
            await Promise.all([writeComplete, this.waitForDrainOrClose()]);
          }
          if (!this.closed) frame.resolve();
          // else: `fail` already rejected `frame` (the current frame) exactly once.
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

  private waitForDrainOrClose(): Promise<void> {
    if (this.closed || this.resolveDrainWait) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveDrainWait = resolve;
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    // Unblock pending write-callback and backpressure waits so the current
    // frame is rejected instead of hanging on callbacks/events that will never
    // arrive after socket teardown.
    this.endWriteWait();
    this.endDrainWait();
    const current = this.current;
    this.current = undefined;
    if (current) current.reject(error);
    for (const frame of this.queue.splice(0)) frame.reject(error);
    this.queuedBytes = 0;
  }
}
