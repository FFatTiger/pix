import type { Socket } from "node:net";
import { once } from "node:events";
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

/** Ordered, bounded socket writer. One write failure rejects all queued frames. */
export class SerialSocketWriter {
  private readonly queue: Frame[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;
  private failure: Error | undefined;
  private readonly maxQueuedFrames: number;
  private readonly maxQueuedBytes: number;

  constructor(private readonly socket: Socket, options: SerialSocketWriterOptions = {}) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? 256;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024;
    socket.once("close", () => this.fail(new SessiondError("unavailable", "RPC socket closed", true)));
    socket.once("error", (error) => this.fail(error));
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

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const frame = this.queue.shift();
        if (!frame) break;
        this.queuedBytes -= frame.bytes;
        try {
          if (!this.socket.write(frame.data)) await once(this.socket, "drain");
          frame.resolve();
        } catch (error) {
          frame.reject(error as Error);
          this.fail(error as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const frame of this.queue.splice(0)) frame.reject(error);
    this.queuedBytes = 0;
  }
}
