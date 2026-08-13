import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import { SessiondError } from "../src/errors.js";
import { instanceAlive, readInstanceLock, sessiondPaths } from "../src/control.js";
import { SessiondRpcClient } from "../src/rpc.js";
import { UnavailableWorkerFactory, startDaemon } from "../src/composition/index.js";

const isWindows = process.platform === "win32";
const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "sessiond-daemon-"));
const cleanup = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};
const client = (handle: { endpoint: string; secret: string }): SessiondRpcClient =>
  new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 2_000 });

/**
 * Leave a real Unix socket file behind with NO live listener, mimicking a
 * daemon killed (SIGKILL) mid-run. A graceful close would unlink it, so we
 * hard-kill a child that bound the socket.
 */
async function leaveDeadSocket(endpoint: string): Promise<void> {
  const script = `const{createServer}=require("node:net");const s=createServer(()=>{});s.listen(${JSON.stringify(endpoint)},()=>process.stdout.write("ready"));`;
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stale-socket child did not signal ready")), 2_000);
    child.stdout?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("daemon serves system.ping and system.hello", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    const ping = await rpc.call("system.ping", {});
    assert.equal(ping.pong, true);
    assert.equal(typeof ping.serverTime, "number");
    const hello = await rpc.call("system.hello", {});
    assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("authenticated system.shutdown acknowledges before closing the daemon", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    const result = await rpc.call("system.shutdown", { instanceId: handle.instanceId });
    assert.deepEqual(result, { accepted: true, instanceId: handle.instanceId });
    await handle.closed;
    assert.equal(await instanceAlive(handle.paths), false);
  } finally {
    await cleanup(dir);
  }
});

test("system.shutdown rejects a mismatched instanceId without stopping the daemon", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    await assert.rejects(
      rpc.call("system.shutdown", { instanceId: "another-instance" }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("a second daemon on the same directory is rejected as a conflict (single instance)", async () => {
  const dir = await tempDir();
  try {
    const first = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await assert.rejects(
      startDaemon({ directory: dir }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    assert.equal(first.instanceId.length > 0, true);
    await first.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("stale socket is recovered before listen so the daemon boots", async (t) => {
  if (isWindows) return t.skip("unix domain socket debris recovery");
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await leaveDeadSocket(paths.endpoint);
    await stat(paths.endpoint); // dead debris present, no listener

    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("shutdown removes the instance lock and socket", async (t) => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
    await assert.rejects(stat(handle.paths.lockFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    if (!isWindows) {
      await assert.rejects(stat(handle.paths.endpoint), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    }
  } finally {
    await cleanup(dir);
  }
});

test("shutdown is idempotent and resolves closed", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
    await handle.shutdown();
    await handle.closed;
  } finally {
    await cleanup(dir);
  }
});

test("unavailable worker runtime rejects create without starting a worker", async () => {
  const dir = await tempDir();
  try {
    const factory = new UnavailableWorkerFactory();
    const handle = await startDaemon({ directory: dir, workerFactory: factory, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    await assert.rejects(
      rpc.call("runtime.create", { createRequestId: "create-m1", cwd: "/project", projectRoot: "/project" }),
      (error) => error instanceof SessiondError && error.code === "worker_unavailable",
    );
    // start() was attempted exactly once and never produced a live worker.
    assert.equal(factory.attempts, 1);
    assert.equal((await rpc.call("runtime.listRunning", {})).sessions.length, 0);
    // The control/read surface still works.
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("control surface reports liveness tied to the lock", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    assert.equal(await instanceAlive(paths), false);
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const lock = await readInstanceLock(paths);
    assert.equal(lock?.instanceId, handle.instanceId);
    assert.equal(typeof lock?.pid, "number");
    assert.equal(await instanceAlive(paths), true);
    await handle.shutdown();
    assert.equal(await instanceAlive(paths), false);
  } finally {
    await cleanup(dir);
  }
});

test("a very-early signal during startup shuts down gracefully and leaves no brick", async (t) => {
  if (isWindows) return t.skip("unix signal delivery during startup");
  const dir = await tempDir();
  // The child imports the compiled composition root, installs runDaemon's signal
  // handlers, then SIGINTs itself on the next tick while startup is delayed.
  const moduleUrl = new URL("../src/composition/index.js", import.meta.url).href;
  const childScript = `import { runDaemon } from ${JSON.stringify(moduleUrl)};
setImmediate(() => process.kill(process.pid, "SIGINT"));
const code = await runDaemon({ directory: process.argv[2], __testStartupDelayMs: 100, serviceOptions: { idleTimeoutMs: 0 } });
process.exitCode = code;
`;
  const scriptPath = join(dir, "child.mjs");
  try {
    await writeFile(scriptPath, childScript);
    const child = spawn(process.execPath, [scriptPath, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("daemon child did not exit in time")); }, 5_000);
      child.once("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
    });
    assert.equal(code, 0, `daemon child exited ${code}; stderr: ${stderr}`);
    // No brick: the instance lock was released by graceful shutdown.
    assert.equal(await instanceAlive(sessiondPaths(dir)), false);
    // Recovery: a fresh start on the same directory succeeds.
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});
