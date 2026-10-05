import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { NdjsonStdioTransport } from "../../src/transport/ndjson-transport.js";
import type { NdjsonTransportOptions } from "../../src/transport/ndjson-transport.js";
import {
  MAX_RUNTIME_FRAME_BYTES,
  type SessiondToWorkerMessage,
  type WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";

interface TransportHarness {
  transport: NdjsonStdioTransport;
  stdin: PassThrough;
  stdout: PassThrough;
  exitCodes: number[];
  messages: SessiondToWorkerMessage[];
  /** Live counter (object so mutations are visible to the caller). */
  readonly counters: { inputClosed: number };
  stderrLines: string[];
}

function createHarness(options: Partial<NdjsonTransportOptions> = {}): TransportHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exitCodes: number[] = [];
  const messages: SessiondToWorkerMessage[] = [];
  const counters = { inputClosed: 0 };
  const stderrLines: string[] = [];
  const transport = new NdjsonStdioTransport({
    stdin,
    stdout,
    exit: (code: number) => { exitCodes.push(code); },
    stderr: (line: string) => { stderrLines.push(line); },
    onMessage: (message: SessiondToWorkerMessage) => { messages.push(message); },
    onInputClosed: () => { counters.inputClosed += 1; },
    ...options,
  });
  transport.start();
  return { transport, stdin, stdout, exitCodes, messages, counters, stderrLines };
}

/**
 * Collect currently-buffered stdout NDJSON without waiting for stream end
 * (production process.stdout is never ended by the transport).
 * Reads in paused mode so we never depend on a consumer ending the stream.
 */
async function collect(stdout: PassThrough, settleMs = 30): Promise<string> {
  // Give the serial writer a microtask to flush any pending enqueues.
  await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  let out = "";
  // Force paused-mode drain of everything currently buffered.
  stdout.pause();
  let chunk: Buffer | string | null;
  while ((chunk = stdout.read()) !== null) {
    out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return out;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("NdjsonStdioTransport framing", () => {
  it("parses multiple frames in a single chunk and frames split across chunks", async () => {
    const h = createHarness();
    h.stdin.write('{"type":"worker.ping","id":"p1","protocolVersion":2,"payload":{}}');
    h.stdin.write('\n{"type":"worker.ping","id":"p2","protocolVersion":2,"payload":{}}\n');
    await tick();
    assert.equal(h.messages.length, 2);
    assert.deepEqual(h.messages.map((m) => (m as { id: string }).id), ["p1", "p2"]);
  });

  it("tolerates CRLF line endings", async () => {
    const h = createHarness();
    h.stdin.write('{"type":"worker.ping","id":"p1","protocolVersion":2,"payload":{}}\r\n');
    await tick();
    assert.equal(h.messages.length, 1);
  });

  it("ignores empty lines", async () => {
    const h = createHarness();
    h.stdin.write("\n\n");
    h.stdin.write('{"type":"worker.ping","id":"p1","protocolVersion":2,"payload":{}}\n');
    await tick();
    assert.equal(h.messages.length, 1);
  });

  it("malformed JSON emits worker.fatal and exits 1", async () => {
    const h = createHarness();
    h.stdin.write("not-json\n");
    const out = await collect(h.stdout);
    assert.deepEqual(h.exitCodes, [1]);
    const fatal = JSON.parse(out.trim().split("\n")[0]!);
    assert.equal(fatal.type, "worker.fatal");
    assert.equal(fatal.payload.error.code, "invalid_request");
  });

  it("schema-violating frame emits worker.fatal and exits 1", async () => {
    const h = createHarness();
    h.stdin.write('{"type":"bogus.type","id":"x","protocolVersion":2,"payload":{}}\n');
    const out = await collect(h.stdout);
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(JSON.parse(out.trim().split("\n")[0]!).type, "worker.fatal");
  });

  it("oversized frame emits worker.fatal and exits 1", async () => {
    const h = createHarness({ maxFrameBytes: 16 });
    h.stdin.write(`${JSON.stringify({ type: "worker.ping", id: "x", protocolVersion: 2, payload: {} })}\n`);
    const out = await collect(h.stdout);
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(JSON.parse(out.trim().split("\n")[0]!).payload.error.code, "invalid_request");
  });

  it("a frame without a trailing newline that exceeds the limit fails closed", async () => {
    const h = createHarness({ maxFrameBytes: 16 });
    h.stdin.write(JSON.stringify({ type: "worker.ping", id: "x", protocolVersion: 2, payload: {} }));
    await tick();
    assert.deepEqual(h.exitCodes, [1]);
  });

  it("stdin EOF triggers onInputClosed exactly once", async () => {
    const h = createHarness();
    h.stdin.end();
    // PassThrough 'end' is async relative to the call; poll briefly.
    for (let i = 0; i < 20 && h.counters.inputClosed === 0; i += 1) await tick();
    assert.equal(h.counters.inputClosed, 1);
    // A second end/close must not re-fire (transport is stopped).
    h.stdin.emit("close");
    await tick();
    assert.equal(h.counters.inputClosed, 1);
  });
});

describe("NdjsonStdioTransport outbound", () => {
  it("send writes a schema-valid NDJSON frame to stdout", async () => {
    const h = createHarness();
    await h.transport.send({ type: "worker.status", payload: { sessionId: "s1", status: "ready" } });
    const out = await collect(h.stdout);
    const parsed = JSON.parse(out.trim().split("\n")[0]!);
    assert.equal(parsed.type, "worker.status");
    assert.equal(parsed.payload.status, "ready");
    h.transport.stop();
  });

  it("invalid outbound frame fails closed with worker.fatal + exit(1) and rejects send", async () => {
    const h = createHarness();
    await assert.rejects(
      () => h.transport.send({ type: "worker.status", payload: { sessionId: "", status: "ready" } } as never),
      /invalid outbound protocol frame/,
    );
    const out = await collect(h.stdout);
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(JSON.parse(out.trim().split("\n")[0]!).type, "worker.fatal");
  });

  it("requestExit flushes queued frames before invoking exit", async () => {
    const h = createHarness();
    await h.transport.send({ type: "worker.status", payload: { sessionId: "s1", status: "ready" } });
    h.transport.requestExit(0);
    const out = await collect(h.stdout);
    assert.deepEqual(h.exitCodes, [0]);
    assert.ok(out.includes("worker.status"));
  });

  it("default budget accepts a 2.1MB PNG-equivalent valid image frame with MIME/hash equality", { timeout: 10_000 }, async () => {
    const h = createHarness();
    const chunks: Buffer[] = [];
    h.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    const decodedBytes = 2_108_283;
    const data = Buffer.alloc(decodedBytes, 0x41).toString("base64");
    const digest = createHash("sha256").update(data).digest("hex");
    const message: WorkerToSessiondMessage = {
      type: "worker.event",
      payload: {
        sessionId: "s1",
        event: {
          type: "message_start",
          sessionId: "s1",
          streamId: "st1",
          messageId: "m1",
          message: {
            role: "toolResult",
            toolCallId: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
          },
        },
      },
    };
    await h.transport.send(message);
    const out = Buffer.concat(chunks).toString("utf8");
    assert.deepEqual(h.exitCodes, []);
    const parsed = JSON.parse(out.trim().split("\n")[0]!);
    const image = parsed.payload.event.message.content[0];
    assert.equal(image.source.media_type, "image/png");
    assert.equal(image.source.data, data);
    assert.equal(createHash("sha256").update(image.source.data).digest("hex"), digest);
    assert.ok(Buffer.byteLength(out.trim().split("\n")[0]!, "utf8") > 2 * 1024 * 1024);
    h.transport.stop();
  });

  it("one-over the default runtime frame budget still fails closed", async () => {
    const h = createHarness();
    const data = Buffer.alloc(10_000_000, 0x41).toString("base64");
    const pad = "x".repeat(MAX_RUNTIME_FRAME_BYTES);
    await assert.rejects(
      () => h.transport.send({
        type: "worker.event",
        payload: {
          sessionId: pad,
          event: {
            type: "message_start",
            sessionId: pad,
            streamId: "st1",
            messageId: "m1",
            message: {
              role: "toolResult",
              toolCallId: "t1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
            },
          },
        },
      }),
      /outbound frame exceeds the size limit/,
    );
    const out = await collect(h.stdout);
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(JSON.parse(out.trim().split("\n")[0]!).type, "worker.fatal");
  });

  it("exact UTF-8 byte boundary is accepted and one multibyte-over fails closed", async () => {
    const exactBody = JSON.stringify({ type: "worker.ping", id: "p1", protocolVersion: 2, payload: {} });
    const limit = Buffer.byteLength(exactBody, "utf8");
    const exact = createHarness({ maxFrameBytes: limit });
    exact.stdin.write(`${exactBody}\n`);
    await tick();
    assert.equal(exact.messages.length, 1);
    assert.deepEqual(exact.exitCodes, []);
    exact.transport.stop();

    const over = createHarness({ maxFrameBytes: limit });
    const overBody = JSON.stringify({ type: "worker.ping", id: "p1é", protocolVersion: 2, payload: {} });
    assert.equal(Buffer.byteLength(overBody, "utf8"), limit + 2);
    over.stdin.write(`${overBody}\n`);
    await tick();
    assert.deepEqual(over.exitCodes, [1]);
  });
});
