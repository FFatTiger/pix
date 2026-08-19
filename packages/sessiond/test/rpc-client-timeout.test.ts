import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessiondError } from "../src/errors.js";
import { SessiondRpcClient } from "../src/rpc.js";

/**
 * A minimal fake sessiond RPC endpoint (unix socket): AUTH handshake, then a
 * single request line answered after a configurable delay. Enough to prove the
 * RPC client's per-call timeout override — the host gateway uses it so
 * long-running prompt / bash commands do not hit the short control-plane RPC
 * timeout and produce a spurious "sessiond RPC timed out".
 */
function startFakeRpc(secret: string, respondDelayMs: number): Promise<{
  endpoint: string;
  close(): Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\pix-rpc-client-timeout-${process.pid}-${Date.now()}`
      : join(tmpdir(), `pix-rpc-client-timeout-${process.pid}-${Date.now()}.sock`);
    const server: Server = createServer((socket) => {
      let buffer = "";
      let authed = false;
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!authed) {
            if (line !== `AUTH ${secret}`) {
              socket.end();
              return;
            }
            authed = true;
            socket.write("OK\n");
          } else {
            let request: { id: string; method: string };
            try {
              request = JSON.parse(line);
            } catch {
              socket.end();
              return;
            }
            setTimeout(() => {
              if (socket.destroyed) return;
              socket.write(`${JSON.stringify({ id: request.id, ok: true, method: request.method, result: { pong: true } })}\n`);
            }, respondDelayMs);
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve({
        endpoint,
        close: () => new Promise<void>((resolveClose) => server.close(() => {
          if (process.platform === "win32") {
            resolveClose();
            return;
          }
          rm(endpoint, { force: true }).finally(() => resolveClose());
        })),
      });
    });
    server.on("error", reject);
  });
}

test("RPC client per-call timeout override", async () => {
  const secret = "test-secret";
  const fake = await startFakeRpc(secret, 120);
  try {
    const rpc = new SessiondRpcClient({ endpoint: fake.endpoint, secret, timeoutMs: 500 });
    // Per-call timeout SHORTER than the server delay: reject with the canonical
    // sessiond RPC timeout error instead of hanging.
    await assert.rejects(
      () => rpc.call("system.ping", {}, 40),
      (error: unknown) => {
        assert.ok(error instanceof SessiondError);
        assert.equal(error.code, "timeout");
        assert.equal(error.message, "sessiond RPC timed out");
        assert.equal(error.retryable, true);
        return true;
      },
    );
    // Per-call timeout LONGER than the server delay: resolves normally.
    const pong = await rpc.call("system.ping", {}, 600);
    assert.equal(pong.pong, true);
  } finally {
    await fake.close();
  }
});

test("RPC client per-call timeout overrides a shorter client default", async () => {
  const secret = "test-secret";
  const fake = await startFakeRpc(secret, 120);
  try {
    // Client default would fire at 40ms, but the per-call override keeps the
    // call alive until the delayed response lands.
    const rpc = new SessiondRpcClient({ endpoint: fake.endpoint, secret, timeoutMs: 40 });
    const pong = await rpc.call("system.ping", {}, 600);
    assert.equal(pong.pong, true);
  } finally {
    await fake.close();
  }
});

test("RPC client still applies the default when no override is passed", async () => {
  const secret = "test-secret";
  const fake = await startFakeRpc(secret, 120);
  try {
    const rpc = new SessiondRpcClient({ endpoint: fake.endpoint, secret, timeoutMs: 40 });
    await assert.rejects(
      () => rpc.call("system.ping", {}),
      (error: unknown) => error instanceof SessiondError && error.code === "timeout",
    );
  } finally {
    await fake.close();
  }
});
