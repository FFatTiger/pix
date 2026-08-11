import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SerialSocketWriter } from "../src/internal/serial-writer.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];
  block = false;
  write(data: string): boolean {
    if (this.destroyed) throw new Error("closed");
    this.writes.push(data);
    return !this.block;
  }
  destroy(error?: Error): this { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); return this; }
}

test("serial writer preserves order across backpressure", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("response\n");
  const second = writer.enqueue("replay\n");
  const third = writer.enqueue("live\n");
  await Promise.resolve();
  assert.deepEqual(socket.writes, ["response\n"]);
  socket.block = false;
  socket.emit("drain");
  await Promise.all([first, second, third]);
  assert.deepEqual(socket.writes, ["response\n", "replay\n", "live\n"]);
});

test("serial writer overflow closes and rejects queued frames", async () => {
  const socket = new FakeSocket(); socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 1, maxQueuedBytes: 32 });
  const outcomesPromise = Promise.allSettled([
    writer.enqueue("a\n"),
    writer.enqueue("b\n"),
    writer.enqueue("c\n"),
  ]);
  socket.block = false; socket.emit("drain");
  const outcomes = await outcomesPromise;
  assert.ok(outcomes.some((outcome) => outcome.status === "rejected"));
  assert.equal(socket.destroyed, true);
});
