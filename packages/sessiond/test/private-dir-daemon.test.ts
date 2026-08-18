import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm as rmAsync, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { afterEach } from "node:test";
import { createSecureStateBackend, LocalAuthorityError } from "@fffattiger/pix-local-authority/state";
import { SessiondError } from "../src/errors.js";
import { acquireInstanceLock, loadOrCreateLocalSecret, readInstanceLockStrict, sessiondPaths } from "../src/local.js";
import { ensureSessiondPrivateDirectory } from "../src/local-posix.js";
import { startDaemon } from "../src/composition/index.js";
import { SessiondRpcClient } from "../src/rpc.js";

const isWindows = process.platform === "win32";
const temporary: string[] = [];
function tempDir(prefix = "sessiond-priv-"): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop()!;
    rmSync(value, { recursive: true, force: true });
  }
});

const isForbidden = (error: unknown): boolean =>
  error instanceof SessiondError && error.code === "forbidden";

test("instance lock stale recovery never deletes a concurrent replacement", { skip: isWindows }, async () => {
  const dir = await tempDir();
  chmodSync(dir, 0o700);
  const paths = sessiondPaths(dir);
  try {
    await writeFile(paths.lockFile, JSON.stringify({ pid: 999_999_999, instanceId: "stale-owner", createdAt: 0 }), { mode: 0o600 });
    await assert.rejects(
      acquireInstanceLock(paths, undefined, {
        beforeStaleLockRemoval: async () => {
          await rmAsync(paths.lockFile, { force: true });
          await writeFile(paths.lockFile, JSON.stringify({ pid: process.pid, instanceId: "live-replacement", createdAt: 1 }), { mode: 0o600 });
        },
      }),
      (error: unknown) => error instanceof SessiondError && error.code === "conflict",
    );
    const after = await readInstanceLockStrict(paths);
    assert.equal(after.kind, "ok");
    if (after.kind === "ok") assert.equal(after.record.instanceId, "live-replacement");
  } finally {
    await rmAsync(dir, { recursive: true, force: true });
  }
});

test("instance lock release requires exact inode and regular-file type", { skip: isWindows }, async () => {
  const dir = await tempDir();
  chmodSync(dir, 0o700);
  const paths = sessiondPaths(dir);
  try {
    const lock = await acquireInstanceLock(paths, undefined, {
      beforeReleaseRemoval: async () => {
        await rmAsync(paths.lockFile, { force: true });
        await writeFile(paths.lockFile, JSON.stringify({ pid: process.pid, instanceId: lock.instanceId, createdAt: 2 }), { mode: 0o600 });
      },
    });
    await lock.release();
    assert.equal(existsSync(paths.lockFile), true, "same-content replacement inode must survive release");
    const replacement = await readInstanceLockStrict(paths);
    assert.equal(replacement.kind, "ok");

    await rmAsync(paths.lockFile, { force: true });
    const target = join(dir, "replacement-target");
    await writeFile(target, JSON.stringify({ pid: process.pid, instanceId: "target-owner", createdAt: 3 }), { mode: 0o600 });
    const symlinkLock = await acquireInstanceLock(paths);
    await rmAsync(paths.lockFile, { force: true });
    await symlink(target, paths.lockFile);
    await symlinkLock.release();
    assert.equal(lstatSync(paths.lockFile).isSymbolicLink(), true, "non-regular replacement must survive release");
  } finally {
    await rmAsync(dir, { recursive: true, force: true });
  }
});

test("startDaemon default-denies uid 0 before creating any runtime state", async () => {
  const parent = tempDir("sessiond-root-policy-");
  const dir = join(parent, "runtime");
  await assert.rejects(
    startDaemon({ directory: dir, processUid: 0, serviceOptions: { idleTimeoutMs: 0 } }),
    (error: unknown) => error instanceof SessiondError
      && error.code === "forbidden"
      && error.message === "Running as root is disabled unless PIX_ALLOW_ROOT=1 is set explicitly"
      && !error.message.includes(dir),
  );
  assert.equal(existsSync(dir), false, "root denial must not create the runtime directory");
});

test("startDaemon fails closed on an existing 0755 runtime dir (forbidden, fixed message, mode untouched, no partial files)", async () => {
  const dir = await tempDir();
  chmodSync(dir, 0o755);
  try {
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error: unknown) => {
        assert.ok(isForbidden(error), "must be SessiondError forbidden");
        const message = (error as SessiondError).message;
        assert.ok(/private/.test(message), `remediation note present: ${message}`);
        assert.ok(!message.includes(dir), `no runtime dir path in message: ${message}`);
        return true;
      },
    );
    // No partial mutation: POSIX mode stays 0755; Windows mode bits are not the privacy proof.
    if (!isWindows) {
      assert.equal(lstatSync(dir).mode & 0o777, 0o755, "existing dir never chmod'd");
    }
    assert.deepEqual(readdirSync(dir), [], "no partial lock/secret/socket artifacts");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("startDaemon creates a missing nested runtime dir 0700 and boots with private state", { skip: isWindows }, async () => {
  // Keep the runtime path short: the AF_UNIX socket must stay within the macOS
  // sun_path budget, so the base is the short `/var/...` form (not realpath'd).
  const base = await mkdtemp(join(tmpdir(), "sd-"));
  temporary.push(base);
  const dir = join(base, "a", "sessiond");
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    try {
      assert.equal(lstatSync(dir).mode & 0o777, 0o700, "created runtime dir is 0700");
      assert.equal(lstatSync(join(base, "a")).mode & 0o777, 0o700, "created intermediate 0700");
      assert.equal((await stat(handle.paths.lockFile)).mode & 0o777, 0o600, "lock 0600");
      assert.equal((await stat(handle.paths.secretFile)).mode & 0o777, 0o600, "secret 0600");
      const secret = (await readFile(handle.paths.secretFile, "utf8")).trim();
      assert.equal(secret, handle.secret);
      assert.equal((await stat(handle.paths.endpoint)).isSocket(), true, "public socket published");
    } finally {
      await handle.shutdown();
    }
  } finally {
    await rmSync(base, { recursive: true, force: true });
  }
});

test("startDaemon fails closed on a symlink runtime-dir leaf (fixed SYMLINK→forbidden, target untouched)", async () => {
  const base = await tempDir();
  const real = join(base, "real");
  mkdirSync(real, { mode: 0o700 });
  const marker = join(real, "content.txt");
  writeFileSync(marker, "payload", { mode: 0o600 });
  const link = join(base, "link");
  symlinkSync(real, link);
  try {
    await assert.rejects(
      startDaemon({ directory: link, serviceOptions: { idleTimeoutMs: 0 } }),
      (error: unknown) => {
        assert.ok(isForbidden(error), "symlink leaf must fail closed as forbidden");
        assert.ok(!(error as SessiondError).message.includes(link), "no path leak");
        assert.ok(!(error as SessiondError).message.includes(real), "no target leak");
        return true;
      },
    );
    if (!isWindows) {
      assert.equal(lstatSync(real).mode & 0o777, 0o700, "target untouched");
    }
    assert.equal(await readFile(marker, "utf8"), "payload", "target content untouched");
  } finally {
    await rmSync(base, { recursive: true, force: true });
  }
});

test("secret marker probe: no raw path/errno leakage in any daemon-level thrown error", async () => {
  const dir = await tempDir("sessiond-priv-marker-");
  const marker = "leaf-secret-marker-xyz";
  // 0755 existing dir → NOT_PRIVATE mapped to a fixed message; must not echo path.
  chmodSync(dir, 0o755);
  try {
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error: unknown) => {
        assert.ok(isForbidden(error));
        const message = (error as SessiondError).message;
        assert.ok(!message.includes(marker), `marker leaked into message: ${message}`);
        assert.ok(!message.includes(dir), `path leaked into message: ${message}`);
        assert.ok(!/EACCES|ENOTDIR|ELOOP|permission denied|error: /i.test(message), `raw os text: ${message}`);
        return true;
      },
    );
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows sessiond can start against a dedicated private directory", { skip: !isWindows }, async () => {
  const parent = tempDir("sessiond-win-");
  const dir = join(parent, "runtime");
  const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
  try {
    assert.ok(handle.endpoint.startsWith("\\\\.\\pipe\\pix-sessiond-"));
    const hashed = createHash("sha256").update(dir).digest("hex").slice(0, 24);
    assert.ok(handle.endpoint.endsWith(hashed), "pipe name must use a bounded directory hash");
    assert.equal(handle.endpoint.includes(Buffer.from(dir).toString("hex").slice(0, 24)), false);
    assert.equal(typeof handle.secret, "string");
    assert.ok(handle.secret.length >= 32);
    const backend = createSecureStateBackend();
    assert.equal(backend.kind, "windows");
    await backend.protectNamedPipe(handle.endpoint);
    const ping = await new SessiondRpcClient({
      endpoint: handle.endpoint,
      secret: handle.secret,
      timeoutMs: 2_000,
    }).call("system.ping", {});
    assert.equal(ping.pong, true);
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error: unknown) => error instanceof SessiondError && error.code === "conflict",
    );
    const lock = await readInstanceLockStrict(sessiondPaths(dir));
    assert.equal(lock.kind, "ok");
    if (lock.kind === "ok") {
      assert.equal(lock.record.start?.kind, "windows-creation-time");
      assert.match(lock.record.start?.value ?? "", /^[0-9]+$/u);
    }
  } finally {
    await handle.shutdown();
  }
});

test("acquireInstanceLock with a swapped directory ctx fails closed (bounded re-verify wiring)", async () => {
  const parent = tempDir();
  const dir = join(parent, "runtime");
  const paths = sessiondPaths(dir);
  try {
    const ctx = await ensureSessiondPrivateDirectory(dir);
    // Swap the directory after preflight; the lock acquire must re-verify and
    // fail closed (UNSAFE_COMPONENT) instead of mutating the replacement.
    const moved = join(dirname(dir), `.${basename(dir)}.moved`);
    renameSync(dir, moved);
    temporary.push(moved);
    mkdirSync(dir, { mode: 0o700 });
    await assert.rejects(
      acquireInstanceLock(paths, ctx),
      (error: unknown) => error instanceof LocalAuthorityError && error.code === "UNSAFE_COMPONENT",
    );
    // Nothing was mutated inside the replacement directory.
    assert.deepEqual(readdirSync(dir), [], "no lock created in the swapped directory");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateLocalSecret with a swapped directory ctx fails closed", async () => {
  const parent = tempDir();
  const dir = join(parent, "runtime");
  const paths = sessiondPaths(dir);
  try {
    const ctx = await ensureSessiondPrivateDirectory(dir);
    const moved = join(dirname(dir), `.${basename(dir)}.moved`);
    renameSync(dir, moved);
    temporary.push(moved);
    mkdirSync(dir, { mode: 0o700 });
    await assert.rejects(
      loadOrCreateLocalSecret(paths, {}, ctx),
      (error: unknown) => error instanceof LocalAuthorityError && error.code === "UNSAFE_COMPONENT",
    );
    assert.deepEqual(readdirSync(dir), [], "no secret/temp written into the swapped directory");
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});

test("single-instance, stale recovery and live-pid blocking semantics are unchanged (hardening regression)", { skip: isWindows }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const first = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    try {
      // Live pid lock blocks a second daemon (conflict).
      await assert.rejects(
        startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
        (error: unknown) => error instanceof SessiondError && error.code === "conflict",
      );
    } finally {
      await first.shutdown();
    }
    // Stale dead-pid lock still recovers.
    await writeFile(paths.lockFile, JSON.stringify({ pid: 999_999_999, instanceId: "stale", createdAt: 0 }), { mode: 0o600 });
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    await handle.shutdown();
  } finally {
    await rmSync(dir, { recursive: true, force: true });
  }
});
