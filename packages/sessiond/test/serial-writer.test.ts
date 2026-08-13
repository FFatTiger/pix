import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SessiondError } from "../src/errors.js";
import { SerialSocketWriter } from "../src/internal/serial-writer.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];
  readonly pendingWriteCallbacks: Array<(error?: Error | null) => void> = [];
  block = false;
  deferWriteCallbacks = false;

  constructor() {
    super();
    this.on("drain", () => this.completeWrites());
  }

  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) throw new Error("closed");
    this.writes.push(data);
    if (callback) {
      if (this.block || this.deferWriteCallbacks) this.pendingWriteCallbacks.push(callback);
      else queueMicrotask(() => callback());
    }
    return !this.block;
  }

  completeWrites(error?: Error): void {
    for (const callback of this.pendingWriteCallbacks.splice(0)) callback(error);
  }

  destroy(error?: Error): this { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); return this; }
}

test("serial writer resolves only after the socket write callback", async () => {
  const socket = new FakeSocket();
  socket.deferWriteCallbacks = true;
  const writer = new SerialSocketWriter(socket as never);
  const frame = writer.enqueue("ack\n");
  let settled = false;
  frame.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.deepEqual(socket.writes, ["ack\n"]);
  assert.equal(settled, false, "enqueue must not resolve merely because socket.write returned true");
  socket.completeWrites();
  await frame;
  assert.equal(settled, true);
});

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

test("serial writer enqueue after close rejects with a catchable error", async () => {
  const socket = new FakeSocket();
  const writer = new SerialSocketWriter(socket as never);
  await writer.enqueue("a\n");
  writer.close();
  assert.equal(writer.isClosed, true);
  await assert.rejects(
    writer.enqueue("b\n"),
    (error: unknown) => error instanceof SessiondError && error.retryable === true,
  );
});

test("serial writer close while waiting for drain rejects the in-flight frame and ends the drain", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("a\n");
  const second = writer.enqueue("b\n");
  await Promise.resolve(); // drain() starts, shifts "a", blocks on backpressure; "b" queued
  const settled: string[] = [];
  first.then(() => settled.push("resolve"), () => settled.push("reject"));
  second.then(() => settled.push("resolve"), () => settled.push("reject"));
  await Promise.resolve();
  assert.deepEqual(settled, [], "in-flight frame must not settle before the drain or close");
  socket.emit("close"); // graceful close without a drain event — must not hang
  await assert.rejects(first);
  await assert.rejects(second);
  assert.deepEqual(settled.sort(), ["reject", "reject"], "current + queued frames settle exactly once");
  // drain loop fully terminated and writer closed: further enqueues reject immediately.
  await assert.rejects(writer.enqueue("c\n"));
});

test("serial writer error then close settles exactly once and is idempotent", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("a\n");
  const second = writer.enqueue("b\n");
  await Promise.resolve();
  socket.emit("error", new Error("boom")); // fail via error
  await assert.rejects(first);
  await assert.rejects(second);
  socket.emit("close"); // close after error must be a no-op
  writer.close();
  assert.equal(writer.isClosed, true);
  await assert.rejects(writer.enqueue("c\n"));
});

test("serial writer close then error is a no-op (idempotent order)", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("a\n");
  await Promise.resolve();
  socket.emit("close");
  await assert.rejects(first);
  socket.emit("error", new Error("late"));
  await assert.rejects(writer.enqueue("b\n"));
});

test("serial writer late drain after close is a no-op with no residual wait", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("a\n");
  await Promise.resolve();
  socket.emit("close");
  await assert.rejects(first);
  socket.emit("drain"); // late drain must not resurrect a frame or throw
  await Promise.resolve();
  await assert.rejects(writer.enqueue("b\n"));
});

test("serial writer synchronous write failure on a destroyed socket rejects and closes", async () => {
  const socket = new FakeSocket();
  socket.destroyed = true;
  const writer = new SerialSocketWriter(socket as never);
  await assert.rejects(writer.enqueue("a\n"));
  assert.equal(writer.isClosed, true);
  await assert.rejects(writer.enqueue("b\n"));
});
