import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { SessiondRpcServer, type SessiondRpcHandler } from "@fffattiger/pix-sessiond";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import { pingSessiond, createSessiondProbe, identifySessiond, requestSessiondShutdown } from "../src/probe.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-probe-"));

test("pingSessiond returns true against a running daemon", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    assert.equal(await pingSessiond(handle.endpoint, handle.secret), true);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pingSessiond returns false against a dead endpoint", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    assert.equal(await pingSessiond(paths.endpoint, "wrong-or-dead-secret", 500), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identifySessiond authenticates and verifies the hello protocol", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    assert.equal(await identifySessiond(handle.endpoint, handle.secret), true);
    assert.equal(await identifySessiond(handle.endpoint, "wrong-secret", 250), false);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identifySessiond requires the Pix runtime-authority capability", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  const handler = {
    async handle(method: string) {
      if (method === "system.hello") return { protocolVersion: 1 };
      if (method === "system.ping") return { pong: true };
      throw new Error("unsupported");
    },
  } as unknown as SessiondRpcHandler;
  const server = new SessiondRpcServer({
    endpoint: paths.endpoint,
    secret: "s".repeat(43),
    handler,
  });
  try {
    await server.listen();
    assert.equal(await identifySessiond(paths.endpoint, "s".repeat(43)), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("requestSessiondShutdown requires the live instanceId and acknowledges graceful close", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    assert.equal(await requestSessiondShutdown(handle.endpoint, handle.secret, "wrong-instance"), false);
    assert.equal(await pingSessiond(handle.endpoint, handle.secret), true);
    assert.equal(await requestSessiondShutdown(handle.endpoint, handle.secret, handle.instanceId), true);
    await handle.closed;
    assert.equal(await pingSessiond(handle.endpoint, handle.secret, 250), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSessiondProbe reports available while the daemon runs", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const probe = createSessiondProbe(sessiondPaths(dir));
    assert.equal(await probe.isAvailable(), true);
    await handle.shutdown();
    assert.equal(await probe.isAvailable(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
