/**
 * Adversarial tests for the bounded exactly-once ACK barrier on
 * {@link SerialSocketWriter.enqueueFlushed} (the `system.shutdown` response
 * delivery gate). Covers force-backpressure (`write=false`) with every
 * callback/drain ordering, timeout, close/error, late events, exactly-once
 * settle, and ordering — the writer-level half of the ACK-before-close
 * contract. "No shutdown on a failed barrier" is exercised at the RPC layer in
 * shutdown-rpc.test.ts.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SessiondError } from "../src/errors.js";
import { SerialSocketWriter } from "../src/internal/serial-writer.js";

/** EventEmitter socket with explicit control over write return value + write callback timing. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  /** When true, write() returns false (backpressure) and drain is required. */
  block = false;
  readonly writes: Array<{ data: string; callback: ((error?: Error | null) => void) | undefined }> = [];
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.destroyed) throw new Error("closed");
    this.writes.push({ data, callback });
    return !this.block;
  }
  fireWriteCallback(index = this.writes.length - 1, error?: Error | null): void {
    this.writes[index]?.callback?.(error);
  }
  fireDrain(): void {
    this.emit("drain");
  }
  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }
}

const settleCounts = (p: Promise<void>): { resolved: () => number; rejected: () => number } => {
  let resolved = 0;
  let rejected = 0;
  p.then(
    () => { resolved += 1; },
    () => { rejected += 1; },
  );
  return { resolved: () => resolved, rejected: () => rejected };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("acked flush settles exactly once after the real write callback (no backpressure)", async () => {
  const socket = new FakeSocket();
  socket.block = false;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  assert.equal(counts.resolved(), 0, "must not settle before the write callback");
  socket.fireWriteCallback();
  await p;
  assert.equal(counts.resolved(), 1, "settles exactly once");
  socket.fireWriteCallback(); // late event is a no-op
  await sleep(10);
  assert.equal(counts.resolved(), 1);
  assert.equal(counts.rejected(), 0);
});

test("acked flush with backpressure: callback-before-drain settles on the drain", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  socket.fireWriteCallback(); // write() returned false → callback alone is not enough
  await sleep(5);
  assert.equal(counts.resolved(), 0, "callback without drain must not settle backpressured write");
  assert.equal(counts.rejected(), 0);
  socket.fireDrain();
  await p;
  assert.equal(counts.resolved(), 1);
  assert.equal(counts.rejected(), 0);
});

test("acked flush with backpressure: drain-before-callback settles on the callback", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  socket.fireDrain(); // drain first — still needs the write callback
  await sleep(5);
  assert.equal(counts.resolved(), 0, "drain without the write callback must not settle");
  assert.equal(counts.rejected(), 0);
  socket.fireWriteCallback();
  await p;
  assert.equal(counts.resolved(), 1);
  assert.equal(counts.rejected(), 0);
});

test("acked flush callback-without-drain never settles; close rejects exactly once (no shutdown)", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  socket.fireWriteCallback();
  await sleep(10);
  assert.equal(counts.resolved(), 0, "callback only (write=false) must stay pending");
  assert.equal(counts.rejected(), 0);
  socket.fireDrain(); // late drain before close → now delivered
  await p;
  assert.equal(counts.resolved(), 1);
});

test("acked flush drain-before-callback + close rejects exactly once (no shutdown)", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  socket.fireDrain();
  await sleep(5);
  assert.equal(counts.resolved(), 0, "drain only (no callback) must stay pending");
  socket.emit("close");
  await assert.rejects(p, (error: unknown) => error instanceof SessiondError && error.retryable === true);
  assert.equal(counts.rejected(), 1, "rejects exactly once");
  socket.fireWriteCallback(); // late callback is a no-op
  await sleep(5);
  assert.equal(counts.rejected(), 1);
});

test("acked flush times out bounded and fails closed exactly once", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const p = writer.enqueueFlushed("response\n", 25);
  await Promise.resolve();
  const counts = settleCounts(p);
  await assert.rejects(p, (error: unknown) => error instanceof SessiondError && error.code === "timeout");
  assert.equal(counts.rejected(), 1, "timeout rejects exactly once");
  assert.equal(writer.isClosed, true, "timeout fails the writer closed");
  socket.fireDrain();
  socket.fireWriteCallback();
  await sleep(10);
  assert.equal(counts.rejected(), 1, "late callback/drain after timeout are no-ops");
  await assert.rejects(writer.enqueue("x\n"));
});

test("acked flush rejects exactly once across error → close → late drain", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  socket.emit("error", new Error("boom"));
  await assert.rejects(p);
  assert.equal(counts.rejected(), 1);
  socket.emit("close");
  socket.fireDrain();
  socket.fireWriteCallback();
  await sleep(5);
  assert.equal(counts.rejected(), 1, "error+close+late events still settle exactly once");
});

test("acked flush close then error is idempotent and rejects exactly once", async () => {
  const socket = new FakeSocket();
  socket.block = true;
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  socket.emit("close");
  await assert.rejects(p);
  socket.emit("error", new Error("late"));
  await assert.rejects(writer.enqueueFlushed("y\n", 500));
});

test("acked flush preserves ordering ahead of and behind ordinary frames", async () => {
  const socket = new FakeSocket(); // no backpressure: write() returns true
  const writer = new SerialSocketWriter(socket as never, { maxQueuedFrames: 8, maxQueuedBytes: 1024 });
  const first = writer.enqueue("ping\n");
  const acked = writer.enqueueFlushed("shutdown\n", 500);
  const third = writer.enqueue("tail\n");
  await Promise.resolve();
  assert.deepEqual(
    socket.writes.map((w) => w.data),
    ["ping\n", "shutdown\n"],
    "the trailing ordinary frame must wait behind the unacknowledged frame",
  );
  assert.equal(socket.writes.length, 2);
  socket.fireWriteCallback(1);
  await Promise.all([first, acked, third]);
  assert.deepEqual(socket.writes.map((w) => w.data), ["ping\n", "shutdown\n", "tail\n"]);
});

test("acked flush enqueue after close rejects with a catchable error", async () => {
  const socket = new FakeSocket();
  const writer = new SerialSocketWriter(socket as never);
  const first = writer.enqueueFlushed("a\n", 500);
  await Promise.resolve();
  socket.fireWriteCallback(0);
  await first;
  writer.close();
  await assert.rejects(
    writer.enqueueFlushed("b\n", 500),
    (error: unknown) => error instanceof SessiondError && error.retryable === true,
  );
});

test("acked flush write callback with an error fails closed (rejects, never settles success, late events no-op)", async () => {
  const socket = new FakeSocket();
  socket.block = false; // write() returns true; delivery hangs on the write callback
  const writer = new SerialSocketWriter(socket as never);
  const p = writer.enqueueFlushed("response\n", 500);
  await Promise.resolve();
  const counts = settleCounts(p);
  const boom = new Error("EPIPE delivered via write callback");
  socket.fireWriteCallback(0, boom);
  // The barrier must reject with exactly the callback error — never success.
  await assert.rejects(p, (error: unknown) => error === boom);
  assert.equal(counts.rejected(), 1, "rejects exactly once");
  assert.equal(counts.resolved(), 0, "a failed write must never settle as success");
  assert.equal(writer.isClosed, true, "writer fails closed");
  // Late events (a subsequent success callback, drain) are no-ops and must not
  // resurrect the frame or produce an unhandled rejection.
  socket.fireWriteCallback(0);
  socket.fireDrain();
  await sleep(10);
  assert.equal(counts.rejected(), 1);
  assert.equal(counts.resolved(), 0);
  await assert.rejects(writer.enqueueFlushed("x\n", 500));
});
