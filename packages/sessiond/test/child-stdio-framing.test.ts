import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  MAX_RUNTIME_FRAME_BYTES,
  MAX_RUNTIME_FRAME_COUNT,
  MAX_RUNTIME_QUEUED_BYTES,
} from "@fffattiger/pix-protocol";
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_STDIN_MAX_QUEUED_BYTES,
  DEFAULT_STDIN_MAX_QUEUED_FRAMES,
  NdjsonStdoutReader,
  SerialStdinWriter,
} from "../src/internal/child-stdio.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("child stdio defaults follow the Protocol runtime frame/queue contract", () => {
  assert.equal(DEFAULT_MAX_FRAME_BYTES, MAX_RUNTIME_FRAME_BYTES);
  assert.equal(DEFAULT_STDIN_MAX_QUEUED_BYTES, MAX_RUNTIME_QUEUED_BYTES);
  assert.equal(DEFAULT_STDIN_MAX_QUEUED_FRAMES, MAX_RUNTIME_FRAME_COUNT);
});

test("NdjsonStdoutReader accepts exact UTF-8 boundary and rejects one-over including multibyte", async () => {
  const frames: string[] = [];
  const fatals: string[] = [];
  const stream = new PassThrough();
  const reader = new NdjsonStdoutReader(stream, {
    maxFrameBytes: 8,
    onFrame: (line) => frames.push(line),
    onFatal: (reason) => fatals.push(reason),
  });
  reader.start();
  stream.write("aaaaaaaa\n");
  await tick();
  assert.deepEqual(frames, ["aaaaaaaa"]);
  assert.deepEqual(fatals, []);

  stream.write("éaaaaaaa\n");
  await tick();
  assert.deepEqual(fatals, ["frame exceeds the size limit"]);
  reader.stop();
});

test("NdjsonStdoutReader unfinished oversized line fails closed without a newline", async () => {
  const fatals: string[] = [];
  const stream = new PassThrough();
  const reader = new NdjsonStdoutReader(stream, {
    maxFrameBytes: 4,
    onFrame: () => {
      throw new Error("must not deliver an oversized unfinished line");
    },
    onFatal: (reason) => fatals.push(reason),
  });
  reader.start();
  stream.write("xxxxx");
  await tick();
  assert.deepEqual(fatals, ["frame exceeds the size limit"]);
  reader.stop();
});

test("SerialStdinWriter queue bytes include UTF-8 bodies and NDJSON newlines", async (t) => {
  const writes: string[] = [];
  const stream = new PassThrough();
  stream.write = ((chunk: string) => { writes.push(chunk); return false; }) as typeof stream.write;
  const writer = new SerialStdinWriter(stream, { maxQueuedBytes: 6 });
  t.after(() => { writer.close(); stream.destroy(); });
  const pending = [writer.enqueue("hold"), writer.enqueue("é"), writer.enqueue("é")];
  assert.equal(writer.isClosed, false, "two queued three-byte NDJSON lines fit exactly");
  pending.push(writer.enqueue(""));
  const outcomes = Promise.allSettled(pending);
  assert.equal(writer.isClosed, true, "a newline-only frame exceeds the full queue");
  assert.ok((await outcomes).every((outcome) => outcome.status === "rejected"));
  assert.deepEqual(writes, ["hold\n"]);
});

test("SerialStdinWriter default queue admits two full frames including newlines", async () => {
  const writes: string[] = [];
  const stream = new PassThrough();
  stream.write = ((chunk: string) => {
    writes.push(chunk);
    return false;
  }) as typeof stream.write;
  const writer = new SerialStdinWriter(stream);
  const first = "a".repeat(MAX_RUNTIME_FRAME_BYTES);
  const second = "b".repeat(MAX_RUNTIME_FRAME_BYTES);
  const firstWrite = writer.enqueue(first);
  const secondWrite = writer.enqueue(second);
  await tick();
  stream.emit("drain");
  await firstWrite;
  await tick();
  stream.emit("drain");
  await secondWrite;
  assert.deepEqual(writes, [`${first}\n`, `${second}\n`]);
  writer.close();
});
