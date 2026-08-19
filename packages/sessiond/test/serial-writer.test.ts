import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SessiondError } from "../src/errors.js";
import { SerialSocketWriter } from "../src/internal/serial-writer.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: Uint8Array[] = [];
  block = false;
  write(data: string | Uint8Array): boolean {
    if (this.destroyed) throw new Error("closed");
    this.writes.push(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
    return !this.block;
  }
  destroy(error?: Error): this { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); return this; }
}

const writesAsText = (writes: Uint8Array[]): string => writes.map((w) => Buffer.from(w).toString("utf8")).join("");

test("serial writer preserves order across backpressure", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("response\n");
  const second = writer.enqueue("replay\n");
  const third = writer.enqueue("live\n");
  await Promise.resolve();
  assert.equal(writesAsText(socket.writes), "response\n");
  socket.block = false;
  socket.emit("drain");
  await Promise.all([first, second, third]);
  assert.equal(writesAsText(socket.writes), "response\nreplay\nlive\n");
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

test("serial writer chunks by UTF-8 bytes so multibyte CJK/emoji never exceed the chunk bound", async () => {
  const socket = new FakeSocket();
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 64, maxQueuedBytes: 16 * 1024 * 1024 });
  // 8192 emoji (4 bytes each) == 32768 bytes, exactly CHUNK_BYTES. Under the old
  // UTF-16 (character) slicing this would have been one 8192-char slice that a
  // naive byte comparison would still count as 32768 bytes, but a larger frame
  // of emoji (e.g. 16384 emoji == 65536 bytes) must be split into two <=32K
  // byte chunks — never a single 64 KiB write that exceeds Windows pipe buffers.
  const manyEmoji = "\u{1F600}".repeat(16384); // 65536 UTF-8 bytes
  await writer.enqueue(`${manyEmoji}\n`);
  const joined = Buffer.concat(socket.writes.map((w) => Buffer.from(w)));
  assert.equal(joined.toString("utf8"), `${manyEmoji}\n`, "the reassembled frame must be byte-identical, with no multibyte corruption");
  for (const chunk of socket.writes) {
    assert.ok(chunk.byteLength <= 32 * 1024, `each chunk must be <= 32 KiB bytes, got ${chunk.byteLength}`);
  }
  assert.ok(socket.writes.length >= 2, `a 65536-byte emoji frame must be split into >= 2 chunks (got ${socket.writes.length})`);
});

test("serial writer boundary stays byte-accurate for a CJK frame crossing a chunk edge", async () => {
  const socket = new FakeSocket();
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 64, maxQueuedBytes: 16 * 1024 * 1024 });
  // 32768 CJK chars (3 bytes each) = 98304 bytes, split across three 32K chunks.
  const manyCjk = "好".repeat(32768);
  await writer.enqueue(`${manyCjk}\n`);
  const joined = Buffer.concat(socket.writes.map((w) => Buffer.from(w)));
  assert.equal(joined.toString("utf8"), `${manyCjk}\n`);
  for (const chunk of socket.writes) {
    assert.ok(chunk.byteLength <= 32 * 1024, `each chunk must be <= 32 KiB bytes, got ${chunk.byteLength}`);
  }
});
