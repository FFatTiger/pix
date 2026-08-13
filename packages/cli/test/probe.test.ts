import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import { pingSessiond, createSessiondProbe, requestSessiondShutdown } from "../src/probe.js";

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
