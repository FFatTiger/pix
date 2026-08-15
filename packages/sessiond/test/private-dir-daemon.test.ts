import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach } from "node:test";
import { LocalAuthorityError } from "@fffattiger/pix-local-authority/state";
import { SessiondError } from "../src/errors.js";
import { acquireInstanceLock, loadOrCreateLocalSecret, sessiondPaths } from "../src/local.js";
import { ensureSessiondPrivateDirectory } from "../src/local-posix.js";
import { startDaemon } from "../src/composition/index.js";

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

test("startDaemon fails closed on an existing 0755 runtime dir (forbidden, fixed message, mode untouched, no partial files)", async () => {
  const dir = await tempDir();
  chmodSync(dir, 0o755);
  try {
    await assert.rejects(
      startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } }),
      (error: unknown) => {
        assert.ok(isForbidden(error), "must be SessiondError forbidden");
        const message = (error as SessiondError).message;
        assert.ok(/0700/.test(message), `remediation note present: ${message}`);
        assert.ok(!message.includes(dir), `no runtime dir path in message: ${message}`);
        return true;
      },
    );
    // No partial mutation: mode untouched, no lock/secret/socket artifacts.
    assert.equal(lstatSync(dir).mode & 0o777, 0o755, "existing dir never chmod'd");
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
    assert.equal(lstatSync(real).mode & 0o777, 0o700, "target untouched");
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

test("acquireInstanceLock with a swapped directory ctx fails closed (bounded re-verify wiring)", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const ctx = await ensureSessiondPrivateDirectory(dir);
    // Swap the directory after preflight; the lock acquire must re-verify and
    // fail closed (UNSAFE_COMPONENT) instead of mutating the replacement.
    const moved = join(dirname(dir), `.${dir.split("/").pop()}.moved`);
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
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const ctx = await ensureSessiondPrivateDirectory(dir);
    const moved = join(dirname(dir), `.${dir.split("/").pop()}.moved`);
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
