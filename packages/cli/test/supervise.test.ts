import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import {
  legacyWindowsSessiondEndpoint,
  sessiondPaths,
} from "@fffattiger/pix-sessiond/control";
import {
  ensureSessiond,
  inspectSessiond,
  shutdownSessiond,
  locateSessiond,
} from "../src/supervise.js";
import { resolveCliPackageRoot } from "../src/paths.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-supervise-"));

test("inspectSessiond detects an authenticated legacy Windows daemon", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    const script = [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { SessiondRpcServer } from "@fffattiger/pix-sessiond";`,
      `const dir=${JSON.stringify(dir)};mkdirSync(dir,{recursive:true});`,
      `const secret="s".repeat(43),instanceId="legacy-instance";`,
      `writeFileSync(join(dir,"sessiond.lock"),JSON.stringify({pid:process.pid,instanceId,createdAt:Date.now()}));`,
      `writeFileSync(join(dir,"sessiond.secret"),secret);`,
      `const server=new SessiondRpcServer({endpoint:${JSON.stringify(legacyEndpoint)},secret,handler:{handle:async(method)=>method==="system.ping"?{pong:true,serverTime:Date.now()}:method==="system.hello"?{protocolVersion:1,capabilities:["runtime.authority"]}:(()=>{throw new Error("unsupported")})()}});`,
      `await server.listen();process.stdout.write("ready");setInterval(()=>{},60000);`,
    ].join("");
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy daemon did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const status = await inspectSessiond(dir);
    assert.equal(status.alive, true);
    assert.equal(status.pingable, true);
    assert.equal(status.obstructed, false);
    assert.equal(status.endpointKind, "legacy-windows");
    assert.equal(status.endpoint, legacyEndpoint);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureSessiond reuses an authenticated legacy Windows daemon without disrupting it", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let legacy: ChildProcess | undefined;
  try {
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    const script = [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { SessiondRpcServer } from "@fffattiger/pix-sessiond";`,
      `const dir=${JSON.stringify(dir)};mkdirSync(dir,{recursive:true});`,
      `const secret="s".repeat(43),instanceId="legacy-instance";`,
      `writeFileSync(join(dir,"sessiond.lock"),JSON.stringify({pid:process.pid,instanceId,createdAt:Date.now()}));`,
      `writeFileSync(join(dir,"sessiond.secret"),secret);`,
      `const server=new SessiondRpcServer({endpoint:${JSON.stringify(legacyEndpoint)},secret,handler:{handle:async(method)=>method==="system.ping"?{pong:true,serverTime:Date.now()}:method==="system.hello"?{protocolVersion:1,capabilities:["runtime.authority"]}:(()=>{throw new Error("unsupported")})()}});`,
      `await server.listen();process.stdout.write("ready");setInterval(()=>{},60000);`,
    ].join("");
    legacy = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = legacy;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy daemon did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const legacyPid = proc.pid;
    assert.equal(typeof legacyPid, "number");
    const ensured = await ensureSessiond(dir);
    assert.equal(ensured.reused, true);
    assert.equal(ensured.pid, legacyPid);
    assert.equal(ensured.endpoint, legacyEndpoint);
    assert.equal(proc.exitCode, null);
    assert.equal(proc.signalCode, null);
    const status = await inspectSessiond(dir);
    assert.equal(status.pingable, true);
    assert.equal(status.endpointKind, "legacy-windows");
    assert.equal(status.pid, legacyPid);
  } finally {
    if (legacy && legacy.exitCode === null && legacy.signalCode === null) {
      const proc = legacy;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdownSessiond terminates only the authenticated legacy Windows pipe owner", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let legacy: ChildProcess | undefined;
  try {
    const paths = sessiondPaths(dir);
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    const script = [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { SessiondRpcServer } from "@fffattiger/pix-sessiond";`,
      `const dir=${JSON.stringify(dir)};mkdirSync(dir,{recursive:true});`,
      `const secret="s".repeat(43),instanceId="legacy-instance";`,
      `writeFileSync(join(dir,"sessiond.lock"),JSON.stringify({pid:process.pid,instanceId,createdAt:Date.now()}));`,
      `writeFileSync(join(dir,"sessiond.secret"),secret);`,
      `const server=new SessiondRpcServer({endpoint:${JSON.stringify(legacyEndpoint)},secret,handler:{handle:async(method)=>method==="system.ping"?{pong:true,serverTime:Date.now()}:method==="system.hello"?{protocolVersion:1,capabilities:["runtime.authority"]}:(()=>{throw new Error("unsupported")})()}});`,
      `await server.listen();process.stdout.write("ready");setInterval(()=>{},60000);`,
    ].join("");
    legacy = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = legacy;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy daemon did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const result = await shutdownSessiond(dir, { timeoutMs: 5_000 });
    assert.deepEqual(result, { action: "terminated", pid: proc.pid });
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    assert.equal(existsSync(paths.lockFile), false);
  } finally {
    if (legacy && legacy.exitCode === null && legacy.signalCode === null) {
      const proc = legacy;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy Windows shutdown refuses a lock whose createdAt proves PID reuse", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    const paths = sessiondPaths(dir);
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    const script = [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { SessiondRpcServer } from "@fffattiger/pix-sessiond";`,
      `const dir=${JSON.stringify(dir)};mkdirSync(dir,{recursive:true});`,
      `const secret="s".repeat(43),instanceId="legacy-reused-pid";`,
      `writeFileSync(join(dir,"sessiond.lock"),JSON.stringify({pid:process.pid,instanceId,createdAt:1}));`,
      `writeFileSync(join(dir,"sessiond.secret"),secret);`,
      `const server=new SessiondRpcServer({endpoint:${JSON.stringify(legacyEndpoint)},secret,handler:{handle:async(method)=>method==="system.ping"?{pong:true}:method==="system.hello"?{protocolVersion:1,capabilities:["runtime.authority"]}:(()=>{throw new Error("unsupported")})()}});`,
      `await server.listen();process.stdout.write("ready");setInterval(()=>{},60000);`,
    ].join("");
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy PID-reuse fixture did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const before = await readFile(paths.lockFile, "utf8");
    const result = await shutdownSessiond(dir, { timeoutMs: 1_000 });
    assert.equal(result.action, "obstructed");
    assert.match(result.reason, /PID was reused/);
    assert.equal(proc.exitCode, null);
    assert.equal(proc.signalCode, null);
    assert.equal(await readFile(paths.lockFile, "utf8"), before);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy Windows shutdown refuses a valid Pix pipe whose server does not own the lock PID", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let server: ChildProcess | undefined;
  let victim: ChildProcess | undefined;
  try {
    const paths = sessiondPaths(dir);
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    victim = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
    assert.equal(typeof victim.pid, "number");
    const script = [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { SessiondRpcServer } from "@fffattiger/pix-sessiond";`,
      `const dir=${JSON.stringify(dir)};mkdirSync(dir,{recursive:true});`,
      `const secret="s".repeat(43),instanceId="legacy-mismatch";`,
      `writeFileSync(join(dir,"sessiond.lock"),JSON.stringify({pid:${victim.pid},instanceId,createdAt:Date.now()}));`,
      `writeFileSync(join(dir,"sessiond.secret"),secret);`,
      `const server=new SessiondRpcServer({endpoint:${JSON.stringify(legacyEndpoint)},secret,handler:{handle:async(method)=>method==="system.ping"?{pong:true}:method==="system.hello"?{protocolVersion:1,capabilities:["runtime.authority"]}:(()=>{throw new Error("unsupported")})()}});`,
      `await server.listen();process.stdout.write("ready");setInterval(()=>{},60000);`,
    ].join("");
    server = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = server;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mismatched legacy server did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const before = await readFile(paths.lockFile, "utf8");
    const result = await shutdownSessiond(dir, { timeoutMs: 1_000 });
    assert.equal(result.action, "obstructed");
    assert.match(result.reason, /pipe server does not own the sessiond lock|PID was reused/);
    assert.equal(victim.exitCode, null);
    assert.equal(victim.signalCode, null);
    assert.equal(server.exitCode, null);
    assert.equal(server.signalCode, null);
    assert.equal(await readFile(paths.lockFile, "utf8"), before);
  } finally {
    for (const child of [server, victim]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const proc = child;
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy Windows migration refuses an endpoint that only answers ping", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    const paths = sessiondPaths(dir);
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    const script = [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { SessiondRpcServer } from "@fffattiger/pix-sessiond";`,
      `const dir=${JSON.stringify(dir)};mkdirSync(dir,{recursive:true});`,
      `const secret="s".repeat(43),instanceId="legacy-impostor";`,
      `writeFileSync(join(dir,"sessiond.lock"),JSON.stringify({pid:process.pid,instanceId,createdAt:Date.now()}));`,
      `writeFileSync(join(dir,"sessiond.secret"),secret);`,
      `const server=new SessiondRpcServer({endpoint:${JSON.stringify(legacyEndpoint)},secret,handler:{handle:async(method)=>method==="system.ping"?{pong:true,serverTime:Date.now()}:(()=>{throw new Error("unsupported")})()}});`,
      `await server.listen();process.stdout.write("ready");setInterval(()=>{},60000);`,
    ].join("");
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy impostor did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const before = await readFile(paths.lockFile, "utf8");
    const result = await shutdownSessiond(dir, { timeoutMs: 250 });
    assert.equal(result.action, "obstructed");
    assert.match(result.reason, /alive but not reachable/);
    assert.equal(proc.exitCode, null);
    assert.equal(proc.signalCode, null);
    assert.equal(await readFile(paths.lockFile, "utf8"), before);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectSessiond treats a legacy Windows listener without a lock as obstructed", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    const legacyEndpoint = legacyWindowsSessiondEndpoint(dir);
    const script = `const{createServer}=require("node:net");const s=createServer(()=>{});s.listen(${JSON.stringify(legacyEndpoint)},()=>process.stdout.write("ready"));setInterval(()=>{},60000);`;
    child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy listener did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    const status = await inspectSessiond(dir);
    assert.equal(status.obstructed, true);
    assert.match(status.obstruction ?? "", /live sessiond socket exists without an instance lock/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("ensureSessiond rejects a symlinked runtime directory", async (t) => {
  const parent = await tempDir();
  const target = join(parent, "target");
  const alias = join(parent, "alias");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(target));
    const { symlinkOrSkip } = await import("./symlink-support.js");
    if (!await symlinkOrSkip(t, target, alias, "dir")) return;
    await assert.rejects(() => ensureSessiond(alias), /runtime directory is not a private directory/);
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

test("shutdownSessiond uses the control RPC and clears lock + endpoint", async () => {
  const dir = await tempDir();
  try {
    // Spawn a separate detached daemon process so this verifies the real
    // cross-process control path used by `pix down --all`.
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

test("shutdownSessiond returns failed (timeout) when a reachable daemon ignores SIGTERM", async (t) => {
  if (process.platform === "win32") return t.skip("SIGTERM semantics differ on Windows");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // A controlled fixture: real lock + secret + public socket served by the
    // real SessiondRpcServer (so inspect reports healthy), but the process
    // ignores SIGTERM — shutdown must report failed(timeout), never success.
    const script =
      `import { mkdirSync, writeFileSync } from 'node:fs';` +
      `import { join } from 'node:path';` +
      `import { SessiondRpcServer } from '@fffattiger/pix-sessiond';` +
      `const dir=${JSON.stringify(dir)};` +
      `mkdirSync(dir,{recursive:true});` +
      `const secret='s'.repeat(43);` +
      `writeFileSync(join(dir,'sessiond.lock'),JSON.stringify({pid:process.pid,instanceId:'stubborn',createdAt:Date.now()}));` +
      `writeFileSync(join(dir,'sessiond.secret'),secret);` +
      `const server=new SessiondRpcServer({endpoint:join(dir,'sessiond.sock'),secret,handler:{handle:async(m)=>(m==='system.ping'?{pong:true,serverTime:Date.now()}:{pong:true})}});` +
      `await server.listen();` +
      `process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},60000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const proc = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stubborn child did not signal ready")), 5_000);
      proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
      proc.on("error", reject);
    });
    // The fixture must be genuinely reachable, so the failure is a timeout on
    // a healthy-but-stubborn daemon, not an obstructed classification.
    const status = await inspectSessiond(dir);
    assert.equal(status.pingable, true);
    assert.equal(status.obstructed, false);
    const result = await shutdownSessiond(dir, { timeoutMs: 300 });
    assert.equal(result.action, "failed");
    assert.equal(result.reason, "timeout");
    assert.equal(proc.exitCode, null); // SIGTERM ignored; process still alive
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
