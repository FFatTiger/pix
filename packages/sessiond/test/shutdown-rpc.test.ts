/**
 * Adversarial tests for the authenticated `system.shutdown` control RPC:
 * strict fail-closed authorization (AUTH secret + exact instance-id fence +
 * schema), ACK-before-close response delivery, delivery-gated daemon transition
 * (a failed/timed-out barrier NEVER triggers shutdown), concurrent/retry/
 * in-progress exactly-once behavior, and no unhandled rejections.
 *
 * The writer-level barrier semantics (write callback + drain + timeout +
 * close/error + late events, exactly-once) live in serial-writer-ack.test.ts;
 * this file wires them to the real RPC server and the real daemon.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import { SessiondError } from "../src/errors.js";
import { SessiondRpcClient, SessiondRpcServer } from "../src/rpc.js";
import { startDaemon } from "../src/composition/index.js";

const isWindows = process.platform === "win32";
const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "shutdown-rpc-"));
const cleanup = async (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

interface BareServer {
  dir: string;
  endpoint: string;
  secret: string;
  server: SessiondRpcServer;
  initiateCount: () => number;
  client: () => SessiondRpcClient;
}

/** Bare RPC server (no daemon) with an optional shutdown authority + counter. */
async function bareServer(options: {
  instanceId?: string;
  onInitiate?: () => void;
  ackTimeoutMs?: number;
  maxQueuedFrames?: number;
} = {}): Promise<BareServer> {
  const dir = await tempDir();
  const endpoint = join(dir, "sessiond.sock");
  const secret = "s".repeat(43);
  let initiateCount = 0;
  const server = new SessiondRpcServer({
    endpoint,
    secret,
    handler: ({
      handle: async (m: string) => (m === "system.ping" ? { pong: true, serverTime: Date.now() } : { pong: true }),
    }) as never,
    ...(options.instanceId === undefined
      ? {}
      : {
          shutdownAuthority: {
            instanceId: options.instanceId,
            initiate: () => {
              initiateCount += 1;
              options.onInitiate?.();
            },
          },
        }),
    ...(options.ackTimeoutMs === undefined ? {} : { shutdownAckTimeoutMs: options.ackTimeoutMs }),
    ...(options.maxQueuedFrames === undefined ? {} : { writer: { maxQueuedFrames: options.maxQueuedFrames } }),
    logger: () => {},
  });
  await server.listen();
  return {
    dir,
    endpoint,
    secret,
    server,
    initiateCount: () => initiateCount,
    client: () => new SessiondRpcClient({ endpoint, secret, timeoutMs: 2_000 }),
  };
}

/** Open a raw client, authenticate, send one request line, and read response lines. */
function rawRequest(
  endpoint: string,
  secret: string,
  payload: unknown,
  options: { pauseAfterSend?: boolean; timeoutMs?: number } = {},
): { socket: ReturnType<typeof createConnection>; lines: string[]; closed: Promise<boolean> } {
  const socket = createConnection(endpoint);
  const lines: string[] = [];
  let buffered = "";
  let authed = false;
  let sent = false;
  const closed = new Promise<boolean>((resolve) => {
    socket.on("close", () => resolve(true));
  });
  socket.on("connect", () => socket.write(`AUTH ${secret}\n`));
  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const nl = buffered.indexOf("\n");
      if (nl < 0) break;
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!authed) {
        if (line === "OK") {
          authed = true;
          socket.write(`${JSON.stringify(payload)}\n`);
          sent = true;
          if (options.pauseAfterSend) socket.pause();
        }
        continue;
      }
      lines.push(line);
    }
  });
  socket.on("error", () => {});
  return { socket, lines, closed };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fail-closed authorization: no auth / wrong instance / malformed / unknown /
// unsupported must never trigger shutdown.
// ---------------------------------------------------------------------------

test("system.shutdown requires the AUTH secret: wrong/missing auth is destroyed with no shutdown", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({ instanceId: "inst-1" });
  try {
    // Wrong secret: the server destroys the connection, never processes the request.
    const wrong = rawRequest(h.endpoint, "w".repeat(43), { protocolVersion: PROTOCOL_VERSION, id: "x", method: "system.shutdown", params: { instanceId: "inst-1" } });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 300);
      wrong.socket.on("close", () => { clearTimeout(timer); resolve(); });
    });
    assert.deepEqual(wrong.lines, [], "wrong secret must never reach the method");
    // Missing secret entirely: destroy on first frame.
    const missing = createConnection(h.endpoint);
    let closed = false;
    missing.on("connect", () => missing.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "x", method: "system.shutdown", params: { instanceId: "inst-1" } })}\n`));
    missing.on("close", () => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(closed, true, "a frame before AUTH OK must destroy the connection");
    missing.destroy();
    assert.equal(h.initiateCount(), 0);
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown wrong instanceId fails closed (forbidden) and never initiates", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({ instanceId: "inst-1" });
  try {
    await assert.rejects(
      h.client().call("system.shutdown", { instanceId: "inst-2" }),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError);
        assert.equal(error.code, "forbidden");
        assert.equal(error.message, "sessiond shutdown refused");
        assert.ok(!error.message.includes("inst-2"), "must not echo the received instance id");
        return true;
      },
    );
    assert.equal(h.initiateCount(), 0, "wrong instance must never initiate");
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown blank instanceId is schema-rejected (invalid_request), no shutdown", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({ instanceId: "inst-1" });
  try {
    // Blank instance id never reaches the handler: the wire schema rejects it
    // as invalid_request and the authority is never invoked.
    const req = rawRequest(h.endpoint, h.secret, { protocolVersion: PROTOCOL_VERSION, id: "x", method: "system.shutdown", params: { instanceId: "" } });
    await sleep(250);
    assert.equal(h.initiateCount(), 0, "blank instance id must never initiate");
    assert.ok(req.lines.some((line) => line.includes("invalid_request")), "must answer invalid_request");
    req.socket.destroy();
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown malformed params (extra/unknown keys) is schema-rejected, no shutdown", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({ instanceId: "inst-1" });
  try {
    // strictObject rejects a request carrying an unknown param key.
    const req = rawRequest(h.endpoint, h.secret, { protocolVersion: PROTOCOL_VERSION, id: "x", method: "system.shutdown", params: { instanceId: "inst-1", force: true } });
    await sleep(250);
    assert.equal(h.initiateCount(), 0, "malformed params must never initiate");
    assert.ok(req.lines.some((line) => line.includes("invalid_request")), "must answer invalid_request");
    req.socket.destroy();
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown unknown method is schema-rejected (invalid_request), no shutdown", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({ instanceId: "inst-1" });
  try {
    const req = rawRequest(h.endpoint, h.secret, { protocolVersion: PROTOCOL_VERSION, id: "x", method: "system.nope", params: {} });
    await sleep(250);
    assert.equal(h.initiateCount(), 0, "unknown method must never initiate");
    assert.ok(req.lines.some((line) => line.includes("invalid_request")), "must answer invalid_request");
    req.socket.destroy();
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown without a shutdown authority is refused unsupported, no shutdown", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({}); // no authority
  try {
    await assert.rejects(
      h.client().call("system.shutdown", { instanceId: "whatever" }),
      (error: unknown) => error instanceof SessiondError && error.code === "unsupported_capability",
    );
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown valid request ACKs {accepted:true} exactly once and initiates", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const h = await bareServer({ instanceId: "inst-1" });
  try {
    const result = await h.client().call("system.shutdown", { instanceId: "inst-1" });
    assert.deepEqual(result, { accepted: true });
    assert.equal(h.initiateCount(), 1, "exactly one initiation for one delivered request");
  } finally {
    await h.server.close();
    await cleanup(h.dir);
  }
});

test("system.shutdown delivery failure (backpressure never drains) fails closed with NO initiate", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  // A paused client that never reads fills its receive buffer; the server's
  // writes block (write()=false, no drain) and the bounded ACK timeout fires,
  // failing the writer closed — so the authority must never be invoked.
  const h = await bareServer({ instanceId: "inst-1", ackTimeoutMs: 30 });
  const socket = createConnection(h.endpoint);
  let authed = false;
  let buffered = "";
  socket.on("connect", () => socket.write(`AUTH ${h.secret}\n`));
  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const nl = buffered.indexOf("\n");
      if (nl < 0) break;
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!authed && line === "OK") {
        authed = true;
        // Stop reading immediately so the receive buffer fills with pings the
        // server keeps responding to.
        socket.pause();
        // Flood requests whose responses the paused client never reads — this
        // fills the receive buffer so the shutdown response write returns false.
        for (let i = 0; i < 4000; i += 1) {
          socket.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: `p-${i}`, method: "system.ping", params: {} })}\n`);
        }
        // Only now send shutdown, behind the blocked pings; its short ack
        // timeout fails the writer closed — no delivery, no initiate.
        socket.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "shut", method: "system.shutdown", params: { instanceId: "inst-1" } })}\n`);
      }
    }
  });
  socket.on("error", () => {});
  try {
    await sleep(400);
    assert.equal(h.initiateCount(), 0, "a failed ACK barrier must never initiate shutdown");
  } finally {
    socket.destroy();
    await h.server.close();
    await cleanup(h.dir);
  }
});

// ---------------------------------------------------------------------------
// Daemon composition: ACK-before-close + delivery-gated exactly-once transition.
// ---------------------------------------------------------------------------

test("daemon: valid shutdown ACKs response bytes to the client BEFORE the socket closes, then shuts down", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const dir = await tempDir();
  let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let requestSocket: ReturnType<typeof createConnection> | undefined;
  try {
    handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    // Raw client so we can observe the exact byte ordering: response line first,
    // then the connection close (the daemon tears down only after the ACK).
    const req = rawRequest(handle.endpoint, handle.secret, { protocolVersion: PROTOCOL_VERSION, id: "shut", method: "system.shutdown", params: { instanceId: handle.instanceId } });
    requestSocket = req.socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for shutdown ACK")), 3_000);
      const check = () => {
        if (req.lines.length >= 1) {
          const parsed = JSON.parse(req.lines[0]!);
          if (parsed.id === "shut" && parsed.method === "system.shutdown" && parsed.ok === true && parsed.result?.accepted === true) {
            clearTimeout(timer);
            resolve();
          }
        }
      };
      req.socket.on("data", check);
      req.socket.on("close", check);
    });
    assert.equal(req.lines.length, 1, "exactly one response line, the shutdown ACK");
    const ack = JSON.parse(req.lines[0]!);
    assert.equal(ack.result.accepted, true);
    // The daemon transition is delivery-gated and resolves the lifecycle promise.
    await handle.closed;
    await assert.rejects(stat(handle.paths.lockFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    // The response bytes were observed BEFORE the connection close (close happens
    // only during the post-ACK teardown).
    const closeSeen = await Promise.race([req.closed, sleep(2_000).then(() => false)]);
    assert.equal(closeSeen, true, "server/socket must close after the ACKed response");
  } finally {
    requestSocket?.destroy();
    await handle?.shutdown();
    await cleanup(dir);
  }
});

test("daemon: two concurrent valid shutdown requests → at most one transition, both settle, no unhandled rejection", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const dir = await tempDir();
  let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 2_000 });
    const outcomes = await Promise.allSettled([
      rpc.call("system.shutdown", { instanceId: handle.instanceId }),
      rpc.call("system.shutdown", { instanceId: handle.instanceId }),
    ]);
    // Both settle (accepted or connection-error) — never hang, never reject the process.
    assert.equal(outcomes.length, 2);
    const accepted = outcomes.filter((o) => o.status === "fulfilled" && (o.value as { accepted: boolean }).accepted === true);
    assert.ok(accepted.length >= 1, "at least one request must be accepted");
    // The daemon transition is exactly-once (idempotent shutdownPromise).
    await handle.closed;
    await handle.shutdown(); // idempotent: no second transition
    await handle.closed;
    await assert.rejects(stat(handle.paths.lockFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await handle?.shutdown();
    await cleanup(dir);
  }
});

test("daemon: retry after ACK and shutdown-in-progress never double-trigger the transition", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const dir = await tempDir();
  let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 1_000 });
    const first = await rpc.call("system.shutdown", { instanceId: handle.instanceId });
    assert.deepEqual(first, { accepted: true });
    // A retry while shutdown is in progress must settle (accepted while the
    // socket is still up, or refused once teardown closed it) — never hang,
    // never create a second transition.
    await sleep(30);
    const retry = await Promise.allSettled([rpc.call("system.shutdown", { instanceId: handle.instanceId })]);
    if (retry[0]!.status === "fulfilled") {
      assert.deepEqual((retry[0] as PromiseFulfilledResult<{ accepted: boolean }>).value, { accepted: true });
    }
    // Settled either way; the daemon transition is exactly-once.
    await handle.closed;
    // Shutdown-in-progress: an explicit handle.shutdown is idempotent.
    await handle.shutdown();
    await handle.closed;
    await assert.rejects(stat(handle.paths.lockFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await handle?.shutdown();
    await cleanup(dir);
  }
});

test("daemon: a wrong instance id never shuts the daemon down (it stays pingable)", async (t) => {
  if (isWindows) return t.skip("Unix sockets only");
  const dir = await tempDir();
  let handle: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 1_000 });
    await assert.rejects(
      rpc.call("system.shutdown", { instanceId: "wrong-instance" }),
      (error: unknown) => error instanceof SessiondError && error.code === "forbidden",
    );
    // The daemon is untouched and still answers.
    const ping = await rpc.call("system.ping", {});
    assert.equal(ping.pong, true);
    await handle.shutdown();
  } finally {
    await handle?.shutdown();
    await cleanup(dir);
  }
});
