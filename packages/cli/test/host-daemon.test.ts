import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultHostDaemonDeps,
  hostUrl,
  inspectHost,
  readHostRecord,
  resolveCliDir,
  startHostBackground,
  stopHostBackground,
  tailFile,
  type HostDaemonDeps,
} from "../src/host-daemon.js";
import { resolveCliPackageRoot } from "../src/paths.js";

/**
 * Background Host lifecycle (`pix start` / `stop` / `status`). A fixture
 * process stands in for `pix host`: it holds the Host-dir lock with its own
 * pid and answers /v1/health, so identity verification, readiness, stop and
 * SIGKILL escalation run against a real detached child. Clocks are injected
 * where a bound would otherwise make the test wait.
 */

const FIXTURE = join(resolveCliPackageRoot(), "test", "fixtures", "fake-host.mjs");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixtureDeps(mode: string, overrides: Partial<HostDaemonDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pix-hostd-"));
  const env = { ...process.env, PIX_CLI_DIR: join(root, "cli"), PIX_HOST_DIR: join(root, "host") };
  const deps: HostDaemonDeps = {
    ...defaultHostDaemonDeps(),
    env,
    hostArgv: (options) => [FIXTURE, String(options.port), mode],
    ...overrides,
  };
  return { root, env, deps };
}

/** A clock that jumps 5s per read, so bounded waits expire immediately. */
function jumpingClock(): () => number {
  let t = 0;
  return () => (t += 5_000);
}

test("start → running → already-running → stop → not-running, with a 0600 record", async () => {
  const { root, env, deps } = await fixtureDeps("ok");
  const port = await freePort();
  try {
    const started = await startHostBackground({ hostname: "127.0.0.1", port, open: false }, deps);
    assert.equal(started.action, "started");
    assert.ok(started.action === "started");
    const { record } = started;
    assert.equal(record.url, `http://127.0.0.1:${port}`);
    assert.equal(pidAlive(record.pid), true);
    const recordPath = join(resolveCliDir(env), "host.json");
    if (process.platform !== "win32") assert.equal(statSync(recordPath).mode & 0o777, 0o600);
    assert.match(tailFile(record.logFile, 5), /fake-host: pid \d+ mode ok/);

    assert.equal((await inspectHost(deps)).kind, "running");
    const again = await startHostBackground({ hostname: "127.0.0.1", port, open: false }, deps);
    assert.equal(again.action, "already-running");

    const stopped = await stopHostBackground(deps);
    assert.deepEqual(stopped, { action: "stopped", pid: record.pid, forced: false });
    assert.equal(pidAlive(record.pid), false);
    assert.equal(existsSync(recordPath), false);
    assert.deepEqual(await stopHostBackground(deps), { action: "not-running" });
    assert.equal((await inspectHost(deps)).kind, "not-running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a child that exits before ready fails honestly and leaves no record", async () => {
  const { root, env, deps } = await fixtureDeps("crash");
  try {
    const result = await startHostBackground({ hostname: "127.0.0.1", port: await freePort(), open: false }, deps);
    assert.equal(result.action, "failed");
    assert.ok(result.action === "failed");
    assert.match(result.reason, /exited before becoming ready \(code 3\)/);
    assert.match(tailFile(result.logFile, 5), /EADDRINUSE/);
    assert.equal(readHostRecord(env).kind, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a child that never becomes healthy is terminated at the readiness bound", async () => {
  let killed: { pid: number; signal: string } | undefined;
  const { root, env, deps } = await fixtureDeps("silent", { now: jumpingClock() });
  deps.kill = (pid, signal) => {
    killed = { pid, signal };
    process.kill(pid, signal);
  };
  try {
    const result = await startHostBackground({ hostname: "127.0.0.1", port: await freePort(), open: false }, deps);
    assert.equal(result.action, "failed");
    assert.ok(result.action === "failed");
    assert.match(result.reason, /did not become ready/);
    assert.equal(killed?.signal, "SIGTERM");
    assert.equal(readHostRecord(env).kind, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a host ignoring SIGTERM is SIGKILLed after the bounded wait", async () => {
  const { root, deps } = await fixtureDeps("ignore-term");
  try {
    const started = await startHostBackground({ hostname: "127.0.0.1", port: await freePort(), open: false }, deps);
    assert.ok(started.action === "started");
    const signals: string[] = [];
    // Jump only through the SIGTERM wait; after SIGKILL the real clock bounds
    // the (short) wait for the OS to reap the child.
    const jump = jumpingClock();
    const stopDeps: HostDaemonDeps = {
      ...deps,
      now: () => (signals.includes("SIGKILL") ? Date.now() : jump()),
      kill: (pid, signal) => {
        signals.push(signal);
        process.kill(pid, signal);
      },
    };
    const stopped = await stopHostBackground(stopDeps);
    assert.deepEqual(stopped, { action: "stopped", pid: started.record.pid, forced: true });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(pidAlive(started.record.pid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead recorded pid is stale: stop clears it, start proceeds", async () => {
  const { root, env, deps } = await fixtureDeps("ok");
  const cliDir = resolveCliDir(env);
  mkdirSync(cliDir, { recursive: true });
  const record = { pid: 2 ** 22 + 12345, hostname: "127.0.0.1", port: 1, url: "http://127.0.0.1:1", logFile: join(cliDir, "host.log"), startedAt: 0 };
  writeFileSync(join(cliDir, "host.json"), JSON.stringify(record));
  try {
    assert.equal((await inspectHost({ ...deps, isPidAlive: () => false })).kind, "stale");
    assert.deepEqual(await stopHostBackground({ ...deps, isPidAlive: () => false }), { action: "not-running" });
    assert.equal(readHostRecord(env).kind, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an alive pid that is not the Host-dir lock holder is never signalled", async () => {
  const { root, env, deps } = await fixtureDeps("ok");
  const cliDir = resolveCliDir(env);
  mkdirSync(cliDir, { recursive: true });
  // A recycled pid: alive (this test process) but no Host lock names it.
  const record = { pid: process.pid, hostname: "127.0.0.1", port: 1, url: "http://127.0.0.1:1", logFile: join(cliDir, "host.log"), startedAt: 0 };
  writeFileSync(join(cliDir, "host.json"), JSON.stringify(record));
  const signals: string[] = [];
  try {
    const state = await inspectHost(deps);
    assert.equal(state.kind, "unverified");
    const stopped = await stopHostBackground({ ...deps, kill: (_pid, signal) => { signals.push(signal); } });
    assert.equal(stopped.action, "refused");
    assert.deepEqual(signals, []);
    assert.equal(readHostRecord(env).kind, "missing", "the misleading record is dropped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed record is reported as corrupt, never trusted", async () => {
  const { root, env, deps } = await fixtureDeps("ok");
  const cliDir = resolveCliDir(env);
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "host.json"), JSON.stringify({ pid: "1; rm -rf /", port: 0 }));
  try {
    assert.equal((await inspectHost(deps)).kind, "corrupt");
    assert.deepEqual(await stopHostBackground(deps), { action: "not-running" });
    assert.equal(readHostRecord(env).kind, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hostUrl reaches wildcard binds via loopback; PIX_CLI_DIR must be absolute", () => {
  assert.equal(hostUrl("127.0.0.1", 30141), "http://127.0.0.1:30141");
  assert.equal(hostUrl("0.0.0.0", 30141), "http://127.0.0.1:30141");
  assert.equal(hostUrl("::", 30141), "http://[::1]:30141");
  assert.equal(hostUrl("fe80::1", 8080), "http://[fe80::1]:8080");
  assert.throws(() => resolveCliDir({ PIX_CLI_DIR: "relative/dir" }), /absolute/);
  assert.throws(() => resolveCliDir({ PIX_CLI_DIR: "" }), /absolute/);
});
