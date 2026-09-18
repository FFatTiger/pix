import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Writable as NodeWritableStream } from "node:stream";
import { SerialStdoutWriter } from "../../src/transport/serial-stdout-writer.js";

class FakeWritable extends EventEmitter {
  readonly writes: string[] = [];
  block = false;
  destroyed = false;

  write(data: string): boolean {
    if (this.destroyed) throw new Error("closed");
    this.writes.push(data);
    return !this.block;
  }
  end(): this { return this; }
  cork(): void {}
  uncork(): void {}
  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }
  setDefaultEncoding(): this { return this; }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SerialStdoutWriter", () => {
  it("preserves order across backpressure", async () => {
    const stream = new FakeWritable();
    stream.block = true;
    const writer = new SerialStdoutWriter(stream as unknown as NodeWritableStream, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
    const first = writer.enqueue("response");
    const second = writer.enqueue("replay");
    const third = writer.enqueue("live");
    await tick();
    assert.deepEqual(stream.writes, ["response\n"]);
    stream.block = false;
    stream.emit("drain");
    await Promise.all([first, second, third]);
    assert.deepEqual(stream.writes, ["response\n", "replay\n", "live\n"]);
  });

  it("overflow fails closed: rejects queued frames and closes", async () => {
    const stream = new FakeWritable();
    stream.block = true;
    const writer = new SerialStdoutWriter(stream as unknown as NodeWritableStream, { maxQueuedFrames: 1, maxQueuedBytes: 32 });
    const outcomesPromise = Promise.allSettled([
      writer.enqueue("a"),
      writer.enqueue("b"),
      writer.enqueue("c"),
    ]);
    stream.block = false;
    stream.emit("drain");
    const outcomes = await outcomesPromise;
    assert.ok(outcomes.some((outcome) => outcome.status === "rejected"));
    assert.equal(writer.isClosed, true);
  });

  it("flush resolves once all queued frames are written", async () => {
    const stream = new FakeWritable();
    stream.block = true;
    const writer = new SerialStdoutWriter(stream as unknown as NodeWritableStream);
    const queued = writer.enqueue("a");
    const flushPromise = writer.flush();
    stream.block = false;
    stream.emit("drain");
    await queued;
    await flushPromise;
    assert.deepEqual(stream.writes, ["a\n"]);
  });

  it("flush resolves immediately when nothing is queued", async () => {
    const stream = new FakeWritable();
    const writer = new SerialStdoutWriter(stream as unknown as NodeWritableStream);
    await writer.flush();
    assert.deepEqual(stream.writes, []);
  });

  it("close rejects pending and future enqueues", async () => {
    const stream = new FakeWritable();
    stream.block = true;
    const writer = new SerialStdoutWriter(stream as unknown as NodeWritableStream);
    const pending = writer.enqueue("a");
    writer.close(new Error("gone"));
    // In-flight + queued frames reject with the close error; future enqueues
    // re-surface the same stored failure (never hang on backpressure).
    await assert.rejects(() => pending, /gone/);
    await assert.rejects(() => writer.enqueue("b"), /gone|closed/);
  });
});
