import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_HISTORY_RESPONSE_BYTES,
  MAX_RPC_INBOUND_FRAME_BYTES,
  MAX_RUNTIME_FRAME_BYTES,
  MAX_RUNTIME_QUEUED_BYTES,
  type SessiondRpcMethod,
  type SessiondMethodResult,
} from "@fffattiger/pix-protocol";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { enqueueRpcOutboundFrame, rpcOutboundBodyBytes } from "../src/internal/rpc-outbound-frame.js";
import { SerialSocketWriter } from "../src/internal/serial-writer.js";
import { SessiondError } from "../src/errors.js";
import { SessiondRpcClient, SessiondRpcServer, type SessiondRpcHandler } from "../src/rpc.js";

const secret = "a".repeat(40);
const pingHandler: SessiondRpcHandler = {
  async handle<M extends SessiondRpcMethod>(method: M): Promise<SessiondMethodResult[M]> {
    if (method === "system.ping") return { pong: true } as SessiondMethodResult[M];
    throw new SessiondError("unsupported_capability", method, false);
  },
};

async function listen(handler: SessiondRpcHandler = pingHandler, options: { maxFrameBytes?: number; maxOutboundBodyBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-frame-"));
  const endpoint = join(directory, "rpc.sock");
  const server = new SessiondRpcServer({ endpoint, secret, handler, ...options });
  await server.listen();
  return {
    endpoint,
    server,
    close: async () => {
      await server.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function rawCall(endpoint: string, payload: string): Promise<{ lines: string[]; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const lines: string[] = [];
    let buffered = "";
    let closed = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw RPC timed out"));
    }, 2_000);
    socket.on("connect", () => socket.write(`AUTH ${secret}\n${payload}`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        lines.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (lines.filter((line) => line !== "OK").length === payload.trimEnd().split("\n").length) socket.end();
      }
    });
    socket.on("close", () => {
      closed = true;
      clearTimeout(timer);
      resolve({ lines, closed });
    });
    socket.on("error", () => {});
  });
}

test("RPC inbound control budget stays 2 MiB and is independent of runtime capacity", () => {
  assert.equal(MAX_RPC_INBOUND_FRAME_BYTES, 2 * 1024 * 1024);
  assert.ok(MAX_RPC_INBOUND_FRAME_BYTES < MAX_RUNTIME_FRAME_BYTES);
  assert.equal(MAX_HISTORY_RESPONSE_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_RUNTIME_QUEUED_BYTES, 2 * (MAX_RUNTIME_FRAME_BYTES + 1));
});

test("coalesced individually legal RPC frames are accepted even when the chunk exceeds one frame", async () => {
  const h = await listen(pingHandler, { maxFrameBytes: 100 });
  try {
    const ping = JSON.stringify({ protocolVersion: 2, id: "p1", method: "system.ping", params: {} });
    const second = JSON.stringify({ protocolVersion: 2, id: "p2", method: "system.ping", params: {} });
    const { lines } = await rawCall(h.endpoint, `${ping}\n${second}\n`);
    const bodies = lines.filter((line) => line !== "OK").map((line) => JSON.parse(line));
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map((body) => body.id), ["p1", "p2"]);
    assert.ok(bodies.every((body) => body.ok === true && body.result.pong === true));
  } finally {
    await h.close();
  }
});

test("split UTF-8 inbound bytes across chunks still decode one legal frame", async () => {
  const h = await listen();
  try {
    const ping = `${JSON.stringify({ protocolVersion: 2, id: "utf8-é", method: "system.ping", params: {} })}\n`;
    const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const socket = createConnection(h.endpoint);
      let buffered = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("split utf8 timed out"));
      }, 2_000);
      socket.on("connect", () => {
        const bytes = Buffer.from(`AUTH ${secret}\n${ping}`, "utf8");
        const split = bytes.indexOf(0xc3) + 1;
        assert.ok(split > 0, "split inside the multibyte code point");
        socket.write(bytes.subarray(0, split));
        socket.write(bytes.subarray(split));
      });
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n").filter(Boolean);
        const response = lines.find((line) => line.startsWith("{"));
        if (response) {
          clearTimeout(timer);
          socket.destroy();
          resolve(JSON.parse(response));
        }
      });
      socket.on("error", reject);
    });
    assert.equal(result.ok, true);
  } finally {
    await h.close();
  }
});

test("client readers honor the response frame budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-oversize-"));
  const endpoint = join(directory, "rpc.sock");
  const { createServer } = await import("node:net");
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let authed = false;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!authed) {
          if (line !== `AUTH ${secret}`) { socket.destroy(); return; }
          authed = true;
          socket.write("OK\n");
        } else {
          let request: { id: string; method: string };
          try { request = JSON.parse(line); } catch { socket.destroy(); return; }
          socket.write(`${JSON.stringify({ id: request.id, ok: true, method: request.method, result: { pong: true, pad: "x".repeat(MAX_RUNTIME_FRAME_BYTES + 8) } })}\n`);
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
  try {
    // The oversized body is one full runtime frame (~30 MiB). The bound is
    // what must reject it, but the rejection only happens once the whole
    // frame has been read; 10s times out on a loaded machine before the read
    // finishes, so the assertion saw a timeout instead of the size error.
    const client = new SessiondRpcClient({ endpoint, secret, timeoutMs: 60_000 });
    await assert.rejects(
      () => client.call("system.ping", {}),
      (error: unknown) => error instanceof SessiondError && /size limit/.test(error.message),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});


test("RPC outbound body limit is inclusive, excludes LF, and counts UTF-8 bytes", async () => {
  const written: string[] = [];
  const socket = Object.assign(new EventEmitter(), { write(frame: string) { written.push(frame); return true; } });
  const writer = new SerialSocketWriter(socket as Socket);
  const exact = `${JSON.stringify({ text: "é" })}\n`;
  const limit = Buffer.byteLength(exact) - 1;
  assert.equal(rpcOutboundBodyBytes(exact), limit);
  await enqueueRpcOutboundFrame(writer, exact, limit);
  assert.deepEqual(written, [exact]);
  await assert.rejects(enqueueRpcOutboundFrame(writer, `${exact.slice(0, -1)} \n`, limit), { code: "unavailable" });
  assert.equal(writer.isClosed, true);
  assert.deepEqual(written, [exact], "one byte over must never reach the socket");
});

function pngImage(decodedBytes: number) {
  return { type: "image" as const, data: Buffer.alloc(decodedBytes, 0).toString("base64"), mimeType: "image/png" as const };
}

test("AUTH and non-image control still reject above 2 MiB", async () => {
  const h = await listen();
  try {
    const oversizedAuth = await new Promise<{ closed: boolean }>((resolve) => {
      const socket = createConnection(h.endpoint);
      socket.on("connect", () => socket.write(`AUTH ${"x".repeat(MAX_RPC_INBOUND_FRAME_BYTES)}\n`));
      socket.on("close", () => resolve({ closed: true }));
      socket.on("error", () => {});
    });
    assert.equal(oversizedAuth.closed, true);
    const ping = JSON.stringify({ protocolVersion: 2, id: "big-ping", method: "system.ping", params: { pad: "x".repeat(MAX_RPC_INBOUND_FRAME_BYTES) } });
    const { lines, closed } = await rawCall(h.endpoint, `${ping}\n`);
    assert.equal(closed, true);
    assert.equal(lines.some((line) => line.startsWith("{") && JSON.parse(line).ok === true), false);
  } finally {
    await h.close();
  }
});

test("coalesced AUTH + image-bearing submitTurn above 2 MiB is admitted unchanged", async () => {
  const seen: unknown[] = [];
  const h = await listen({
    async handle(method) {
      if (method === "system.ping") return { pong: true } as never;
      throw new SessiondError("unsupported_capability", method, false);
    },
    async submitTurn(params) {
      seen.push(params);
      return {
        result: {
          status: "rejected",
          delivery: "not_delivered",
          sessionId: params.sessionId,
          operationId: params.operationId,
          error: { code: "not_found", message: "missing", retryable: false },
        },
        closed: Promise.resolve(null),
        close() {},
        async flushTo() {},
      };
    },
  });
  try {
    const params = {
      sessionId: "s1",
      prompt: "hi",
      operationId: "op-1",
      images: [pngImage(2.1 * 1024 * 1024)],
    };
    const request = JSON.stringify({ protocolVersion: 2, id: "st-big", method: "runtime.submitTurn", params });
    assert.ok(Buffer.byteLength(request, "utf8") > MAX_RPC_INBOUND_FRAME_BYTES);
    const { lines } = await rawCall(h.endpoint, `${request}\n`);
    const body = JSON.parse(lines.find((line) => line !== "OK")!);
    assert.equal(body.ok, true);
    assert.equal(body.method, "runtime.submitTurn");
    const admitted = seen[0] as { images: { data: string }[] };
    assert.equal(admitted.images[0]!.data, params.images[0]!.data);
  } finally {
    await h.close();
  }
});

test("small maxFrameBytes override still rejects image-bearing requests", async () => {
  const h = await listen(pingHandler, { maxFrameBytes: 64 });
  try {
    const request = JSON.stringify({
      protocolVersion: 2,
      id: "st-over",
      method: "runtime.submitTurn",
      params: { sessionId: "s1", prompt: "hi", operationId: "op-1", images: [pngImage(128)] },
    });
    const { lines, closed } = await rawCall(h.endpoint, `${request}\n`);
    assert.equal(closed, true);
    assert.equal(lines.some((line) => line.startsWith("{") && JSON.parse(line).ok === true), false);
  } finally {
    await h.close();
  }
});

test("client refuses to write an image-bearing envelope one UTF-8 byte over the runtime bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-client-oversize-"));
  const endpoint = join(directory, "rpc.sock");
  const { createServer } = await import("node:net");
  const written: string[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      written.push(chunk.toString("utf8"));
      buffer += chunk.toString("utf8");
      if (buffer.includes("AUTH ")) socket.write("OK\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
  try {
    const client = new SessiondRpcClient({ endpoint, secret, timeoutMs: 2_000 });
    const pad = "é".repeat(Math.ceil((MAX_RUNTIME_FRAME_BYTES + 8) / 2));
    await assert.rejects(
      () => client.call("runtime.command", {
        sessionId: "s1",
        command: { commandId: "c1", type: "prompt", message: pad, images: [pngImage(4)] },
      }),
      (error: unknown) => error instanceof SessiondError && error.code === "invalid_input" && error.retryable === false,
    );
    assert.equal(written.join("").includes('"method":"runtime.command"'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC outbound override rejects invalid budgets without changing inbound capacity", async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, MAX_RUNTIME_FRAME_BYTES + 1]) {
    assert.throws(() => new SessiondRpcServer({ endpoint: "unused", secret, handler: pingHandler, maxOutboundBodyBytes: limit }), { code: "invalid_input" });
  }
  const h = await listen(pingHandler, { maxOutboundBodyBytes: 256 });
  try {
    const { lines } = await rawCall(h.endpoint, `${" ".repeat(1024)}${JSON.stringify({ protocolVersion: 2, id: "small", method: "system.ping", params: {} })}\n`);
    assert.equal(JSON.parse(lines.find((line) => line !== "OK")!).ok, true);
  } finally { await h.close(); }
});
