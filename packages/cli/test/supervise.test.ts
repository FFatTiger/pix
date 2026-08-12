import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import {
  ensureSessiond,
  inspectSessiond,
  shutdownSessiond,
  locateSessiond,
} from "../src/supervise.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-supervise-"));

test("inspectSessiond reports not running when no lock exists", async () => {
  const dir = await tempDir();
  try {
    const status = await inspectSessiond(dir);
    assert.equal(status.alive, false);
    assert.equal(status.pid, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectSessiond reports stale when the lock names a dead pid", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    await writeFile(paths.lockFile, JSON.stringify({ pid: 999999, instanceId: "dead", createdAt: 0 }));
    const status = await inspectSessiond(dir);
    assert.equal(status.alive, false);
    assert.equal(status.pid, 999999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectSessiond reports alive+pingable against a running daemon", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const status = await inspectSessiond(dir);
    assert.equal(status.alive, true);
    assert.equal(status.pingable, true);
    assert.equal(status.pid, handle.instanceId ? status.pid : status.pid); // pid present
    assert.equal(typeof status.pid, "number");
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureSessiond reuses a running, pingable daemon (same pid, not just pid-aliveness)", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const before = await inspectSessiond(dir);
    const ensured = await ensureSessiond(dir);
    assert.equal(ensured.reused, true);
    assert.equal(ensured.pid, before.pid);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureSessiond spawns a detached daemon when none is running", async () => {
  const dir = await tempDir();
  try {
    const ensured = await ensureSessiond(dir);
    assert.equal(ensured.reused, false);
    assert.equal(typeof ensured.pid, "number");
    // The spawned daemon must be genuinely pingable.
    const status = await inspectSessiond(dir);
    assert.equal(status.pingable, true);
    assert.equal(status.pid, ensured.pid);
    await shutdownSessiond(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureSessiond fails fast (without spawning) when the runtime dir is broken", async () => {
  // A regular file where a private directory is required makes the lock
  // unreadable and the bootstrap impossible; the new fail-closed inspection
  // refuses to spawn a doomed child at all (previously it spawned and then
  // reported the early child exit).
  const parent = await tempDir();
  const dir = join(parent, "blocker");
  try {
    await writeFile(dir, "i am a file, not a directory");
    await assert.rejects(() => ensureSessiond(dir), /cannot start sessiond/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("shutdownSessiond is a no-op when nothing is running", async () => {
  const dir = await tempDir();
  try {
    const result = await shutdownSessiond(dir);
    assert.equal(result.action, "already-down");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdownSessiond SIGTERMs a running daemon and clears lock + socket", async () => {
  const dir = await tempDir();
  try {
    // shutdownSessiond stops a *separate* daemon process by pid, so spawn a
    // detached one (never the in-process test daemon, whose pid is this test).
    const ensured = await ensureSessiond(dir);
    const pid = ensured.pid;
    const paths = sessiondPaths(dir);
    const result = await shutdownSessiond(dir);
    assert.equal(result.action, "terminated");
    assert.equal(result.pid, pid);
    // lock and socket cleaned up
    assert.equal(existsSync(paths.lockFile), false);
    if (process.platform !== "win32") {
      assert.equal(existsSync(paths.endpoint), false);
    }
    // idempotent: a second down is a no-op
    const again = await shutdownSessiond(dir);
    assert.equal(again.action, "already-down");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdownSessiond returns failed (timeout) when the daemon ignores SIGTERM", async (t) => {
  if (process.platform === "win32") return t.skip("SIGTERM semantics differ on Windows");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // A stubborn process: publishes a lock naming itself, then ignores SIGTERM.
    const script =
      `const fs=require('node:fs'),p=require('node:path');` +
      `fs.writeFileSync(p.join(${JSON.stringify(dir)},'sessiond.lock'),` +
      `JSON.stringify({pid:process.pid,instanceId:'stubborn',createdAt:Date.now()}));` +
      `process.on('SIGTERM',()=>{});setInterval(()=>{},60000);process.stdout.write('ready');`;
    child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stubborn child did not signal ready")), 2_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const result = await shutdownSessiond(dir, { timeoutMs: 300 });
    assert.equal(result.action, "failed");
    assert.equal(result.reason, "timeout");
  } finally {
    if (child) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("locateSessiond honors an explicit directory", async () => {
  const dir = await tempDir();
  try {
    const loc = locateSessiond(dir);
    assert.equal(loc.directory, dir);
    assert.equal(loc.paths.lockFile, join(dir, "sessiond.lock"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
