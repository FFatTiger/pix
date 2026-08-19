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

test("RPC client per-call timeout override and default", async () => {
  const secret = "test-secret";
  const fake = await startFakeRpc(secret, 120);
  try {
    const longDefault = new SessiondRpcClient({ endpoint: fake.endpoint, secret, timeoutMs: 500 });
    await assert.rejects(
      () => longDefault.call("system.ping", {}, 40),
      (error: unknown) => error instanceof SessiondError && error.code === "timeout" && error.retryable === true,
    );
    const pong = await longDefault.call("system.ping", {}, 600);
    assert.equal(pong.pong, true);

    const shortDefault = new SessiondRpcClient({ endpoint: fake.endpoint, secret, timeoutMs: 40 });
    assert.equal((await shortDefault.call("system.ping", {}, 600)).pong, true);
    await assert.rejects(
      () => shortDefault.call("system.ping", {}),
      (error: unknown) => error instanceof SessiondError && error.code === "timeout",
    );
  } finally {
    await fake.close();
  }
});
