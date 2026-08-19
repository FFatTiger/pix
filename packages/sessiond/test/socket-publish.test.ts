import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessiondError } from "../src/errors.js";
import { currentProcessStartIdentity } from "@fffattiger/pix-local-authority/process";
import {
  isPrivateSocketName,
  listPrivateSocketAliases,
  makePrivateEndpointPath,
  needsUnixSocketPublication,
  unixSocketPathBudgetBytes,
  probeSocket,
  publishPublicEndpoint,
  readInstanceLockStrict,
  releaseOwnedPublicEndpoint,
  sessiondPaths,
} from "../src/local.js";
import { SessiondRpcClient } from "../src/rpc.js";
import {
  closeTrackedDaemons,
  startTrackedDaemonCompat as startDaemon,
  trackServerClose,
} from "./helpers/tracked-daemon.js";
import { createPrivateRuntimeDirectory } from "./helpers/private-runtime-dir.js";

// A failing test must never leave a daemon or bare socket server alive past
// this file (previously the sessiond worker hung and locks leaked into the
// next run). All daemons go through the tracked alias; bare servers register
// their close function.
after(closeTrackedDaemons);

const isWindows = process.platform === "win32";
const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "sessiond-socket-"));
const cleanup = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });
const client = (handle: { endpoint: string; secret: string }): SessiondRpcClient =>
  new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret, timeoutMs: 2_000 });

/** Production locks are 0600; a 0644 seed is classified unreadable, not stale/live. */
async function writeLockFixture(path: string, payload: string): Promise<void> {
  await writeFile(path, payload, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Bind a live Unix socket listener at `path`; `close()` unlinks it. */
function bindSocketAt(path: string): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      const close = (): Promise<void> => new Promise<void>((r) => server.close(() => r()));
      trackServerClose(close);
      resolve({ close });
    });
  });
}

/** Leave a dead Unix socket file at `path` (SIGKILLed binder, like a crashed daemon). */
async function leaveDeadSocketAt(path: string): Promise<void> {
  const script = `const{createServer}=require("node:net");const s=createServer(()=>{});s.listen(${JSON.stringify(path)},()=>process.stdout.write("ready"));`;
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

async function socketNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name === "sessiond.sock" || isPrivateSocketName(name));
}

test("start/stop cleans public, private and lock; public connects and pings", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    assert.equal(typeof handle.privateEndpoint, "string", "unix daemon exposes its private socket path");
    const priv = handle.privateEndpoint!;
    const pub = handle.paths.endpoint;

    const pubInfo = await lstat(pub, { bigint: true });
    const privInfo = await lstat(priv, { bigint: true });
    assert.equal(pubInfo.isSocket(), true);
    assert.equal(privInfo.isSocket(), true);
    // The public endpoint is a hard link of the private socket: same identity.
    assert.equal(pubInfo.dev, privInfo.dev);
    assert.equal(pubInfo.ino, privInfo.ino);

    // Clients connect through the public endpoint and reach the RPC server.
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);

    // Both paths are on disk while running.
    assert.deepEqual((await socketNames(dir)).sort(), [priv.split("/").pop(), "sessiond.sock"].sort());

    await handle.shutdown();

    await assert.rejects(lstat(pub), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
    await assert.rejects(lstat(priv), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
    await assert.rejects(lstat(handle.paths.lockFile), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
    assert.deepEqual(await socketNames(dir), [], "no socket files remain after shutdown");
  } finally {
    await cleanup(dir);
  }
});

test("graceful shutdown does not remove a public endpoint replaced by another daemon (incident fix)", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const a = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const paths = a.paths;
    const aIno = (await lstat(paths.endpoint, { bigint: true })).ino;

    // Simulate "B" replacing A's public endpoint: unlink A's hard link, bind a
    // fresh private socket and hard-link it onto the public path.
    const bPriv = makePrivateEndpointPath(dir, "b2b2b2");
    await unlink(paths.endpoint);
    const b = await bindSocketAt(bPriv);
    await link(bPriv, paths.endpoint);
    const bIno = (await lstat(paths.endpoint, { bigint: true })).ino;
    assert.notEqual(bIno, aIno);

    // A's graceful shutdown must NOT delete B's public endpoint.
    await a.shutdown();
    assert.equal((await lstat(paths.endpoint, { bigint: true })).ino, bIno, "replaced public endpoint survives A shutdown");
    assert.equal(await probeSocket(paths.endpoint), "live", "B's listener still reachable through public");
    assert.equal((await lstat(bPriv, { bigint: true })).isSocket(), true, "B's private listener intact");

    await b.close();
    await rm(paths.endpoint, { force: true }); // hard link residue
  } finally {
    await cleanup(dir);
  }
});

test("graceful shutdown does not remove public when the lock was replaced", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const a = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const paths = a.paths;
    const aIno = (await lstat(paths.endpoint, { bigint: true })).ino;

    // Another owner takes over the lock while A is still running.
    await writeLockFixture(paths.lockFile, JSON.stringify({ pid: process.pid, instanceId: "other-owner", createdAt: 0 }));

    await a.shutdown();
    // A's lock check fails (instanceId mismatch) → A must not unlink public.
    assert.equal((await lstat(paths.endpoint, { bigint: true })).ino, aIno, "A's own public survives because lock is no longer A's");
    assert.equal(await probeSocket(paths.endpoint), "dead", "A's listener is gone (private unlinked)");
    // A's lock release is also owner-checked → the replaced lock is left intact.
    const lock = await readInstanceLockStrict(paths);
    assert.equal(lock.kind, "ok");
    if (lock.kind === "ok") assert.equal(lock.record.instanceId, "other-owner");

    await rm(paths.endpoint, { force: true });
  } finally {
    await cleanup(dir);
  }
});

test("a live public endpoint without a lock blocks a second start", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const a = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const paths = a.paths;
    await unlink(paths.lockFile); // orphan: lock externally removed, listener still live

    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );

    await a.shutdown();
    // With the lock gone, A's shutdown must not delete the public endpoint.
    assert.equal(await probeSocket(paths.endpoint), "dead", "public survives A shutdown as orphan debris");
    await rm(paths.endpoint, { force: true });
  } finally {
    await cleanup(dir);
  }
});

test("a live private alias without lock and public blocks a second start", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const a = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const paths = a.paths;
    const privA = a.privateEndpoint!;
    // Orphan: lock AND public are gone, but A still listens on its private alias.
    await unlink(paths.lockFile);
    await unlink(paths.endpoint);

    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    assert.equal(await probeSocket(privA), "live", "live private alias is not cleaned");

    await a.shutdown();
    assert.equal(await probeSocket(privA), "dead", "A cleanup removed its own private alias");
  } finally {
    await cleanup(dir);
  }
});

test("dead socket debris at the public endpoint is safely recovered", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    await leaveDeadSocketAt(paths.endpoint);
    await lstat(paths.endpoint); // dead debris present

    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("dead Pix-named private alias is cleaned on recovery", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const alias = makePrivateEndpointPath(dir, "d4d4d4");
    await leaveDeadSocketAt(alias);
    await lstat(alias);

    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
    assert.deepEqual(await socketNames(dir), [], "dead private alias was removed by recovery");
  } finally {
    await cleanup(dir);
  }
});

test("a live private alias is never cleaned and blocks startup", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const alias = makePrivateEndpointPath(dir, "e5e5e5");
    const live = await bindSocketAt(alias);

    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    assert.equal(await probeSocket(alias), "live", "live private alias untouched");

    await live.close();
  } finally {
    await cleanup(dir);
  }
});

test("public regular file / symlink fail closed and are never deleted", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await writeFile(paths.endpoint, "i am not a socket");
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "forbidden",
    );
    assert.equal(await readFile(paths.endpoint, "utf8"), "i am not a socket", "regular file untouched");
  } finally {
    await cleanup(dir);
  }

  const dir2 = await tempDir();
  const paths2 = sessiondPaths(dir2);
  try {
    await writeFile(join(dir2, "target"), "x");
    await symlink(join(dir2, "target"), paths2.endpoint);
    await assert.rejects(
      startDaemon({ directory: dir2, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "forbidden",
    );
    assert.equal((await lstat(paths2.endpoint)).isSymbolicLink(), true, "symlink untouched");
  } finally {
    await cleanup(dir2);
  }
});

test("non-socket file with Pix private naming is left alone and does not block startup", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const decoy = makePrivateEndpointPath(dir, "f6f6f6");
    await writeFile(decoy, "decoy");
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    assert.equal(await readFile(decoy, "utf8"), "decoy", "non-socket decoy untouched");
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("corrupt / symlink / non-regular lock fail closed and are never removed", { skip: isWindows }, async () => {
  // corrupt payload
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await writeLockFixture(paths.lockFile, "this is not json");
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "forbidden",
    );
    assert.equal(await readFile(paths.lockFile, "utf8"), "this is not json", "corrupt lock not removed");
  } finally {
    await cleanup(dir);
  }

  // symlink lock
  const dir2 = await tempDir();
  const paths2 = sessiondPaths(dir2);
  try {
    await writeFile(join(dir2, "target"), "x");
    await symlink(join(dir2, "target"), paths2.lockFile);
    await assert.rejects(
      startDaemon({ directory: dir2, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "forbidden",
    );
    assert.equal((await lstat(paths2.lockFile)).isSymbolicLink(), true, "symlink lock not removed");
  } finally {
    await cleanup(dir2);
  }

  // directory as lock
  const dir3 = await tempDir();
  const paths3 = sessiondPaths(dir3);
  try {
    await mkdir(paths3.lockFile);
    await assert.rejects(
      startDaemon({ directory: dir3, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "forbidden",
    );
    assert.equal((await lstat(paths3.lockFile)).isDirectory(), true, "directory lock not removed");
  } finally {
    await cleanup(dir3);
  }
});

test("live pid lock with an unavailable endpoint is a conflict, never taken over", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    // A live pid (this test process) holds the lock, but there is no socket and
    // no listener: the lock holder is authoritative until it dies. On Linux a
    // live pid without a start identity is obstructed, so carry our own start
    // identity like the production lock does.
    const start = currentProcessStartIdentity();
    await writeLockFixture(
      paths.lockFile,
      JSON.stringify({ pid: process.pid, instanceId: "live-unreachable", createdAt: 0, ...(start ? { start } : {}) }),
    );
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    const lock = await readInstanceLockStrict(paths);
    assert.equal(lock.kind, "ok");
    if (lock.kind === "ok") assert.equal(lock.record.instanceId, "live-unreachable");
    assert.equal((await lstat(paths.lockFile)).isFile(), true, "live lock not removed");
  } finally {
    await cleanup(dir);
  }
});

test("stale lock naming a dead pid is recovered together with dead socket debris", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await writeLockFixture(paths.lockFile, JSON.stringify({ pid: 999999, instanceId: "stale", createdAt: 0 }));
    await leaveDeadSocketAt(paths.endpoint);
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await cleanup(dir);
  }
});

test("link EEXIST never overwrites; dev/ino mismatch never deletes", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  const privA = makePrivateEndpointPath(dir, "a1a1a1");
  const privB = makePrivateEndpointPath(dir, "b2b2b2");
  try {
    const a = await bindSocketAt(privA);
    const pubA = await publishPublicEndpoint(paths, privA, "instA");
    const aIno = (await lstat(paths.endpoint, { bigint: true })).ino;
    assert.equal(pubA.ino, aIno);

    // Replace public with B, then a second publish must EEXIST (never overwrite).
    await unlink(paths.endpoint);
    const b = await bindSocketAt(privB);
    await link(privB, paths.endpoint);
    const bIno = (await lstat(paths.endpoint, { bigint: true })).ino;
    assert.notEqual(bIno, aIno);
    await assert.rejects(
      publishPublicEndpoint(paths, privB, "instB"),
      (error) => error instanceof SessiondError && error.code === "conflict",
    );
    assert.equal((await lstat(paths.endpoint, { bigint: true })).ino, bIno, "EEXIST did not overwrite B's public");

    // Owner release with matching lock but mismatched dev/ino must NOT delete.
    await writeLockFixture(paths.lockFile, JSON.stringify({ pid: process.pid, instanceId: "instA", createdAt: 0 }));
    await releaseOwnedPublicEndpoint(paths, pubA);
    assert.equal((await lstat(paths.endpoint, { bigint: true })).ino, bIno, "dev/ino mismatch left B's public alone");

    // Matching owner + identity DOES delete (idempotently), and the lock guard
    // is independent: with a mismatched lock the public is left alone.
    await unlink(paths.endpoint);
    const pubB = await publishPublicEndpoint(paths, privB, "instB");
    await releaseOwnedPublicEndpoint(paths, pubB); // lock says instA → skip
    assert.equal((await lstat(paths.endpoint, { bigint: true })).ino, pubB.ino);
    await writeLockFixture(paths.lockFile, JSON.stringify({ pid: process.pid, instanceId: "instB", createdAt: 0 }));
    await releaseOwnedPublicEndpoint(paths, pubB);
    await assert.rejects(lstat(paths.endpoint), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
    await releaseOwnedPublicEndpoint(paths, pubB); // idempotent no-op

    await a.close();
    await b.close();
  } finally {
    await cleanup(dir);
  }
});

test("private socket path length respects the platform sun_path limit", { skip: isWindows }, async () => {
  const maxBytes = process.platform === "darwin" ? 103 : 107;
  const tdir = tmpdir();
  // Private basename is fixed ("pixsd-" + 6 hex + ".sock") — derive its byte
  // length from the builder so this stays correct if the scheme ever changes.
  const privBasenameLen = Buffer.byteLength(makePrivateEndpointPath("", "123456"), "utf8");
  const dirNameLen = maxBytes - privBasenameLen - 1 - tdir.length - 1;

  // Exactly at the limit: bind + publish + ping work.
  const atLimit = join(tdir, "p".repeat(dirNameLen));
  const atLimitPriv = makePrivateEndpointPath(atLimit, "111111");
  assert.ok(Buffer.byteLength(atLimitPriv, "utf8") <= maxBytes, `private path within limit (${Buffer.byteLength(atLimitPriv, "utf8")})`);
  await mkdir(atLimit, { recursive: true, mode: 0o700 });
  try {
    const handle = await startDaemon({ directory: atLimit, serviceOptions: { idleTimeoutMs: 0 } });
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    await handle.shutdown();
  } finally {
    await rm(atLimit, { recursive: true, force: true });
  }

  // One byte over the limit: fail closed with a clear error, no partial state.
  const overLimit = join(tdir, "p".repeat(dirNameLen + 1));
  await mkdir(overLimit, { recursive: true, mode: 0o700 });
  try {
    const overPriv = makePrivateEndpointPath(overLimit, "222222");
    assert.ok(Buffer.byteLength(overPriv, "utf8") > maxBytes);
    await assert.rejects(
      startDaemon({ directory: overLimit, serviceOptions: { idleTimeoutMs: 0 } }),
      (error) => error instanceof SessiondError && error.code === "forbidden" && /too long/.test(error.message),
    );
    assert.deepEqual(await socketNames(overLimit), [], "no socket files left after length failure");
    await assert.rejects(lstat(sessiondPaths(overLimit).lockFile), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(overLimit, { recursive: true, force: true });
  }
});

test("idempotent shutdown and owner-safe public release", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const publication = {
      privatePath: handle.privateEndpoint!,
      publicPath: paths.endpoint,
      instanceId: handle.instanceId,
      dev: (await lstat(paths.endpoint, { bigint: true })).dev,
      ino: (await lstat(paths.endpoint, { bigint: true })).ino,
    };
    await handle.shutdown();
    await handle.shutdown();
    await handle.closed;
    await releaseOwnedPublicEndpoint(paths, publication); // already gone → idempotent no-op
    await assert.rejects(lstat(paths.endpoint), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await cleanup(dir);
  }
});

test("recoverStalePrivateAliases lists only live Pix sockets for orphan discovery", { skip: isWindows }, async () => {
  const dir = await tempDir();
  try {
    const alias = makePrivateEndpointPath(dir, "c3c3c3");
    const live = await bindSocketAt(alias);
    const found = await listPrivateSocketAliases(dir);
    assert.deepEqual(found, [alias]);
    await live.close();
    // After close the bound path is unlinked → no aliases remain.
    assert.deepEqual(await listPrivateSocketAliases(dir), []);
  } finally {
    await cleanup(dir);
  }
});

test("needsUnixSocketPublication matches the platform", async () => {
  assert.equal(needsUnixSocketPublication(), process.platform !== "win32");
});

test("unixSocketPathBudgetBytes is platform-native", () => {
  assert.equal(unixSocketPathBudgetBytes("win32"), null);
  assert.equal(unixSocketPathBudgetBytes("darwin"), 103);
  assert.equal(unixSocketPathBudgetBytes("linux"), 107);
});

// Windows branch proof: the daemon binds the public named pipe directly (no
// private path, no filesystem link/inode). Runs only on Windows; kept as the
// fixture proving the platform branch preserves named-pipe semantics.
test("windows: daemon binds the public pipe directly and leaves no socket files", { skip: !isWindows }, async () => {
  const fixture = await createPrivateRuntimeDirectory("sessiond-socket-");
  const dir = fixture.directory;
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    assert.equal(handle.privateEndpoint, undefined, "windows has no private socket path");
    const rpc = client(handle);
    assert.equal((await rpc.call("system.ping", {})).pong, true);
    assert.deepEqual(await socketNames(dir), [], "no socket files on windows");
    await handle.shutdown();
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent starts on one directory produce exactly one live daemon", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const moduleUrl = new URL("../src/composition/index.js", import.meta.url).href;
  const childScript = `import { runDaemon } from ${JSON.stringify(moduleUrl)};
const directory = process.argv[1];
if (!directory) { process.exitCode = 3; }
try {
  const code = await runDaemon({ directory, serviceOptions: { idleTimeoutMs: 0 } });
  process.exitCode = code;
} catch (error) {
  process.exitCode = 1;
}
`;
  const children: ReturnType<typeof spawn>[] = [];
  try {
    for (let round = 0; round < 3; round += 1) {
      const paths = sessiondPaths(dir);
      // Clean slate each round.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const spawned: ReturnType<typeof spawn>[] = [];
      for (let i = 0; i < 4; i += 1) {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, dir], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        spawned.push(child);
      }
      children.push(...spawned);

      // Wait for the losers to exit and the single winner to become pingable
      // through the public endpoint (the lock may appear before the socket).
      // WSL pays ~40s per fresh child to load the Pi SDK module graph, so the
      // deadline must cover slow platforms; macOS/Windows finish in seconds.
      let pinged = false;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !pinged) {
        const exits = spawned.filter((c) => c.exitCode !== null || c.signalCode !== null).length;
        const lock = await readInstanceLockStrict(paths);
        if (exits >= 3 && lock.kind === "ok") {
          try {
            const secret = (await readFile(paths.secretFile, "utf8")).trim();
            const rpc = new SessiondRpcClient({ endpoint: paths.endpoint, secret, timeoutMs: 1_000 });
            pinged = (await rpc.call("system.ping", {})).pong === true;
          } catch {
            /* not published yet */
          }
        }
        if (!pinged) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(pinged, `winner became pingable through the public endpoint (round ${round})`);
      const lock = await readInstanceLockStrict(paths);
      assert.equal(lock.kind, "ok", "exactly one winner holds the lock");

      // Winner count check: exactly one still-alive child.
      const alive = spawned.filter((c) => c.exitCode === null && c.signalCode === null);
      assert.equal(alive.length, 1, `exactly one daemon child remains (round ${round})`);

      // SIGTERM the winner; it must shut down cleanly and clear everything.
      process.kill(lock.record.pid, "SIGTERM");
      const exit = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("winner did not exit in time")), 5_000);
        const winner = alive[0]!;
        winner.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });
      assert.equal(exit, 0, "winner exits 0 after SIGTERM");
      const deadline2 = Date.now() + 3_000;
      while (Date.now() < deadline2 && (await readInstanceLockStrict(paths)).kind === "ok") {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal((await readInstanceLockStrict(paths)).kind, "missing", "lock cleared after winner shutdown");
      assert.deepEqual(await socketNames(dir), [], "sockets cleared after winner shutdown");
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    await cleanup(dir);
  }
});
