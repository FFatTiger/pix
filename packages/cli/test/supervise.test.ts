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
import { resolveCliPackageRoot } from "../src/paths.js";

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

test("shutdownSessiond stops a running daemon via authenticated RPC and clears lock + socket", async () => {
  const dir = await tempDir();
  try {
    // shutdownSessiond stops a *separate* daemon process via its authenticated
    // system.shutdown RPC, so spawn a detached one (never the in-process test
    // daemon, whose pid is this test).
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

test("shutdownSessiond refuses (obstructed) a live-but-unreachable pid without signalling it", async (t) => {
  if (process.platform === "win32") return t.skip("SIGTERM semantics differ on Windows");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // A live process that claims the lock but publishes no secret/socket: S1
    // treats it as an authoritative live-but-unreachable pid, so down must
    // refuse instead of SIGTERM-ing a pid it cannot confirm is ours.
    const script =
      `const fs=require('node:fs'),p=require('node:path');` +
      `fs.writeFileSync(p.join(${JSON.stringify(dir)},'sessiond.lock'),` +
      `JSON.stringify({pid:process.pid,instanceId:'ghost',createdAt:Date.now()}));` +
      `process.on('SIGTERM',()=>{process.exit(0);});setInterval(()=>{},60000);process.stdout.write('ready');`;
    child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not signal ready")), 2_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const result = await shutdownSessiond(dir, { timeoutMs: 300 });
    assert.equal(result.action, "obstructed");
    assert.match(result.reason, /alive but not reachable/);
    // Refused: the live pid must NOT have been signalled, and nothing deleted.
    assert.equal(proc.exitCode, null);
    assert.equal(proc.signalCode, null);
    assert.equal(existsSync(sessiondPaths(dir).lockFile), true);
  } finally {
    if (child) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdownSessiond returns failed (unsupported) when a reachable daemon does not support system.shutdown", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets only");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // A controlled fixture: real lock + secret + public socket served by the
    // real SessiondRpcServer (so inspect reports healthy), but WITHOUT the
    // shutdown authority — RPC-only down must refuse as unsupported and never
    // kill the target via a PID/SIGTERM fallback.
    const script =
      `import { mkdirSync, writeFileSync } from 'node:fs';` +
      `import { join } from 'node:path';` +
      `import { SessiondRpcServer } from '@fffattiger/pix-sessiond';` +
      `const dir=${JSON.stringify(dir)};` +
      `mkdirSync(dir,{recursive:true});` +
      `const secret='s'.repeat(43);` +
      `writeFileSync(join(dir,'sessiond.lock'),JSON.stringify({pid:process.pid,instanceId:'legacy',createdAt:Date.now()}));` +
      `writeFileSync(join(dir,'sessiond.secret'),secret);` +
      `const server=new SessiondRpcServer({endpoint:join(dir,'sessiond.sock'),secret,handler:{handle:async(m)=>(m==='system.ping'?{pong:true,serverTime:Date.now()}:{pong:true})}});` +
      `await server.listen();` +
      `process.stdout.write('ready');setInterval(()=>{},60000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy child did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    // The fixture must be genuinely reachable, so the failure is a refusal on a
    // healthy-but-legacy daemon, not an obstructed classification.
    const status = await inspectSessiond(dir);
    assert.equal(status.pingable, true);
    assert.equal(status.obstructed, false);
    const result = await shutdownSessiond(dir, { timeoutMs: 300 });
    assert.equal(result.action, "failed");
    assert.equal(result.reason, "sessiond does not support remote shutdown");
    assert.equal(proc.exitCode, null); // no PID/SIGTERM fallback: process still alive
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

test("ensureSessiond never reuses a pingable protocol-v1 daemon; replaces it and starts a fresh one", async () => {
  const dir = await tempDir();
  const fixturePath = join(resolveCliPackageRoot(), "test", "fixtures", "fake-v1-daemon.mjs");
  let stale: ChildProcess | undefined;
  try {
    // Boot the stale v1 daemon as a separate process (writes its own lock).
    stale = spawn(process.execPath, [fixturePath], {
      env: { ...process.env, PIX_SESSIOND_DIR: dir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("fake v1 daemon did not become ready")), 5_000);
      stale!.stdout?.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes("fake-v1-ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      stale!.on("exit", (code) => { clearTimeout(timer); reject(new Error(`fake v1 daemon exited early (${code})`)); });
    });

    // The stale instance is pingable (but protocol v1).
    const before = await inspectSessiond(dir);
    assert.equal(before.pingable, true, "stale v1 daemon must be pingable");
    assert.equal(before.pid, stale.pid);

    // ensureSessiond must NOT silently reuse it.
    const ensured = await ensureSessiond(dir);
    assert.equal(ensured.reused, false, "a stale v1 daemon must never be reused");
    assert.notEqual(ensured.pid, stale.pid, "a fresh daemon must replace the stale one");
    // The fresh daemon is genuinely protocol-current and pingable.
    const status = await inspectSessiond(dir);
    assert.equal(status.pingable, true);
    assert.equal(status.pid, ensured.pid);
    await shutdownSessiond(dir);
  } finally {
    if (stale && stale.exitCode === null) stale.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
