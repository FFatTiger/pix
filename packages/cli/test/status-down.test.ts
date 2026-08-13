import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePrivateEndpointPath,
  probeSocket,
  sessiondPaths,
  SESSIOND_DIR_ENV,
} from "@fffattiger/pix-sessiond/control";
import { ensureSessiond, shutdownSessiond } from "../src/supervise.js";
import { statusCommand } from "../src/commands/status.js";
import { downCommand } from "../src/commands/down.js";
import { symlinkOrSkip } from "./symlink-support.js";

/**
 * Honest status/stop reporting for S1 obstruction. When `inspectSessiond`
 * classifies a directory as obstructed (unsafe lock, live listener without a
 * lock, or a live-but-unreachable pid), `pix status` must report
 * `sessiond: obstructed` with a safe reason and exit non-zero, and
 * `pix down --all` must refuse without touching the offending resource — never
 * claiming "not running" / "already down". All fixtures live under /tmp.
 */

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-statusdown-"));

interface Capture {
  code: number;
  out: string[];
  err: string[];
}

/** Run a command function while capturing console.log (stdout) and console.error (stderr). */
async function capture(fn: () => Promise<number>): Promise<Capture> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (message?: unknown) => { out.push(String(message)); };
  console.error = (message?: unknown) => { err.push(String(message)); };
  try {
    return { code: await fn(), out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/** Run a command function with PIX_SESSIOND_DIR pointed at `dir`. */
async function withDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[SESSIOND_DIR_ENV];
  process.env[SESSIOND_DIR_ENV] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[SESSIOND_DIR_ENV];
    else process.env[SESSIOND_DIR_ENV] = prev;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bind a live Unix socket listener at `path` (server.close unlinks it). */
function bindSocket(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

/** Spawn a detached-ish live child that records its own pid to `pidFile`. */
function spawnLiveChild(pidFile: string): ChildProcess {
  return spawn(process.execPath, [
    "-e",
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},60000);`,
  ], { stdio: "ignore" });
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/**
 * Assert the shared contract for an obstructed directory: status reports
 * `sessiond: obstructed` (exit 1, reason + directory on stdout, never
 * "not running") and `down --all` refuses (exit 1, reason on stderr, never
 * "already down"), then `assertUnchanged` verifies the offending resource was
 * not deleted or rewritten.
 */
async function expectObstructed(
  dir: string,
  reasonPattern: RegExp,
  assertUnchanged: () => Promise<void> | void,
): Promise<void> {
  const st = await withDir(dir, () => capture(statusCommand));
  assert.equal(st.code, 1, `status must exit non-zero for obstructed; got ${st.out.join(" | ")} / ${st.err.join(" | ")}`);
  assert.ok(st.out.some((l) => l.includes("sessiond: obstructed")), `expected obstructed; got ${st.out.join(" | ")}`);
  assert.ok(st.out.some((l) => reasonPattern.test(l)), `expected reason ${reasonPattern}; got ${st.out.join(" | ")}`);
  assert.ok(st.out.some((l) => l.includes(`directory: ${dir}`)), `expected directory shown; got ${st.out.join(" | ")}`);
  assert.ok(!st.out.some((l) => l.includes("not running")), "obstructed must not claim not running");
  assert.equal(st.err.length, 0, `status must not write a stack to stderr: ${st.err.join(" | ")}`);
  assert.ok(!st.out.some((l) => /UnsafeSecretError|Error:|\s+at\s/.test(l)), `status must not leak a stack: ${st.out.join(" | ")}`);

  const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
  assert.equal(down.code, 1, `down must exit non-zero for obstructed; got ${down.out.join(" | ")} / ${down.err.join(" | ")}`);
  assert.ok(down.err.some((l) => l.includes("refusing to stop (obstructed)")), `expected refusal; got ${down.err.join(" | ")}`);
  assert.ok(down.err.some((l) => reasonPattern.test(l)), `expected reason ${reasonPattern}; got ${down.err.join(" | ")}`);
  assert.ok(!down.out.some((l) => l.includes("already down")), "obstructed must not claim already down");
  assert.ok(!down.err.some((l) => l.includes("already down")), "obstructed must not claim already down");
  assert.ok(!down.err.some((l) => /UnsafeSecretError|Error:|\s+at\s/.test(l)), `down must not leak a stack: ${down.err.join(" | ")}`);

  await assertUnchanged();
}

test("status/down report obstructed for a corrupt lock and leave it untouched", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    const corrupt = "definitely not json {{{";
    await writeFile(paths.lockFile, corrupt);
    await expectObstructed(dir, /sessiond lock file is corrupt/, async () => {
      assert.equal(await readFile(paths.lockFile, "utf8"), corrupt);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a symlink lock and leave it untouched", async (t) => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    await writeFile(join(dir, "target"), "payload");
    if (!await symlinkOrSkip(t, join(dir, "target"), paths.lockFile, "file")) return;
    await expectObstructed(dir, /sessiond lock file is not a regular file/, async () => {
      const info = await lstat(paths.lockFile);
      assert.equal(info.isSymbolicLink(), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a non-regular lock (directory) and leave it untouched", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    await mkdir(paths.lockFile);
    await expectObstructed(dir, /sessiond lock file is not a regular file/, async () => {
      const info = await lstat(paths.lockFile);
      assert.equal(info.isDirectory(), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a live public socket without a lock", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets only");
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  let server: Server | undefined;
  try {
    await mkdir(dir, { recursive: true });
    server = await bindSocket(paths.endpoint);
    await expectObstructed(dir, /a live sessiond socket exists without an instance lock/, async () => {
      assert.equal(await probeSocket(paths.endpoint), "live");
    });
  } finally {
    if (server) {
      const srv = server;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a live private alias socket without a lock", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets only");
  const dir = await tempDir();
  let server: Server | undefined;
  try {
    await mkdir(dir, { recursive: true });
    const alias = makePrivateEndpointPath(dir);
    server = await bindSocket(alias);
    await expectObstructed(dir, /a live sessiond socket exists without an instance lock/, async () => {
      assert.equal(await probeSocket(alias), "live");
    });
  } finally {
    if (server) {
      const srv = server;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a live pid that is unreachable, leaving pid and lock untouched", async () => {
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    const paths = sessiondPaths(dir);
    const pidFile = join(dir, "pid");
    child = spawnLiveChild(pidFile);
    await waitFor(pidFile);
    const pid = Number(await readFile(pidFile, "utf8"));
    await writeFile(paths.lockFile, JSON.stringify({ pid, instanceId: "ghost", createdAt: Date.now() }));
    assert.equal(pidAlive(pid), true);
    const lockBefore = await readFile(paths.lockFile, "utf8");
    await expectObstructed(dir, /sessiond pid is alive but not reachable/, async () => {
      assert.equal(pidAlive(pid), true, "down must not kill a live pid it cannot reach");
      assert.equal(await readFile(paths.lockFile, "utf8"), lockBefore);
    });
  } finally {
    if (child) {
      const proc = child;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A live pid with an unsafe secret file (symlink / non-regular / too-short)
 * cannot be confirmed as ours: status/down must report the fixed obstruction
 * reason without leaking a stack trace, and must not touch pid/lock/secret.
 */
async function expectUnsafeSecretWithLivePid(
  dir: string,
  setupSecret: () => Promise<void>,
  assertSecretUnchanged: () => Promise<void> | void,
): Promise<void> {
  const paths = sessiondPaths(dir);
  const pidFile = join(dir, "pid");
  const child = spawnLiveChild(pidFile);
  try {
    await waitFor(pidFile);
    const pid = Number(await readFile(pidFile, "utf8"));
    const lockContent = JSON.stringify({ pid, instanceId: "ghost", createdAt: Date.now() });
    await writeFile(paths.lockFile, lockContent);
    await setupSecret();
    assert.equal(pidAlive(pid), true);
    await expectObstructed(dir, /sessiond secret file is unsafe/, async () => {
      assert.equal(pidAlive(pid), true, "down must not kill a live pid whose secret is unsafe");
      assert.equal(await readFile(paths.lockFile, "utf8"), lockContent);
      await assertSecretUnchanged();
    });
  } finally {
    const proc = child;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  }
}

test("status/down report obstructed for a live pid with a symlink secret and leave it untouched", async (t) => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    await writeFile(join(dir, "target"), "x".repeat(64));
    if (!await symlinkOrSkip(t, join(dir, "target"), paths.secretFile, "file")) return;
    await expectUnsafeSecretWithLivePid(dir, async () => {}, async () => {
      const info = await lstat(paths.secretFile);
      assert.equal(info.isSymbolicLink(), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a live pid with a non-regular (directory) secret and leave it untouched", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    await expectUnsafeSecretWithLivePid(dir, async () => {
      await mkdir(paths.secretFile);
    }, async () => {
      const info = await lstat(paths.secretFile);
      assert.equal(info.isDirectory(), true);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status/down report obstructed for a live pid with an invalid (too-short) secret and leave it untouched", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    const tooShort = "not-long-enough";
    await expectUnsafeSecretWithLivePid(dir, async () => {
      await writeFile(paths.secretFile, tooShort);
    }, async () => {
      assert.equal(await readFile(paths.secretFile, "utf8"), tooShort);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status healthy + down terminated for a running daemon (regression)", async () => {
  const dir = await tempDir();
  try {
    const ensured = await ensureSessiond(dir);
    assert.equal(ensured.reused, false);
    const pid = ensured.pid;
    assert.equal(typeof pid, "number");

    const st = await withDir(dir, () => capture(statusCommand));
    assert.equal(st.code, 0);
    assert.ok(st.out.some((l) => l.includes("sessiond: running (healthy)")), `expected healthy; got ${st.out.join(" | ")}`);
    assert.ok(st.out.some((l) => l.includes(`pid: ${pid}`)), `expected pid ${pid}; got ${st.out.join(" | ")}`);

    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 0);
    assert.ok(down.out.some((l) => l.includes(`sessiond: terminated (pid ${pid})`)), `expected terminated; got ${down.out.join(" | ")}`);
    assert.equal(existsSync(sessiondPaths(dir).lockFile), false);
    if (process.platform !== "win32") {
      assert.equal(existsSync(sessiondPaths(dir).endpoint), false);
    }
  } finally {
    await shutdownSessiond(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("status stale + down already-down keep a stale valid dead-pid lock (regression)", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    const lockContent = JSON.stringify({ pid: 999999, instanceId: "dead", createdAt: 0 });
    await writeFile(paths.lockFile, lockContent);

    const st = await withDir(dir, () => capture(statusCommand));
    assert.equal(st.code, 0);
    assert.ok(st.out.some((l) => l.includes("sessiond: not running (stale lock)")), `expected stale; got ${st.out.join(" | ")}`);

    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 0);
    assert.ok(down.out.some((l) => l.includes("sessiond: already down")), `expected already down; got ${down.out.join(" | ")}`);
    // Existing safe semantics: a stale valid dead-pid lock is left untouched.
    assert.equal(await readFile(paths.lockFile, "utf8"), lockContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status not running + down already-down when nothing exists (regression)", async () => {
  const dir = await tempDir();
  try {
    const st = await withDir(dir, () => capture(statusCommand));
    assert.equal(st.code, 0);
    assert.ok(st.out.some((l) => l.includes("sessiond: not running")), `expected not running; got ${st.out.join(" | ")}`);
    assert.ok(!st.out.some((l) => l.includes("stale")), "absent directory must not be reported as stale");

    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 0);
    assert.ok(down.out.some((l) => l.includes("sessiond: already down")), `expected already down; got ${down.out.join(" | ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
