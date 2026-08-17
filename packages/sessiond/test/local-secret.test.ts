import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { SessiondError } from "../src/errors.js";
import { readExistingSecret, validateExistingSecretInfo } from "../src/internal/local-state-security.js";
import { loadOrCreateLocalSecret, sessiondPaths } from "../src/local.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "sessiond-secret-"));
const cleanup = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};
const isSessiondError = (codeOrMessage: RegExp) => (error: unknown): boolean =>
  error instanceof SessiondError && (codeOrMessage.test(error.code) || codeOrMessage.test(error.message));
const validatedExistingSecret = (
  paths: ReturnType<typeof sessiondPaths>,
  hooks: Parameters<typeof loadOrCreateLocalSecret>[1] = {},
): Promise<string | undefined> => readExistingSecret(paths, hooks);
const forgedSecretInfo = (overrides: Partial<BigIntStats>): BigIntStats => ({
  dev: 1n,
  ino: 2n,
  mode: 0o100600n,
  nlink: 1n,
  uid: typeof process.getuid === "function" ? BigInt(process.getuid()) : 0n,
  gid: 0n,
  rdev: 0n,
  size: 64n,
  blksize: 4096n,
  blocks: 1n,
  atimeMs: 0n,
  mtimeMs: 0n,
  ctimeMs: 0n,
  birthtimeMs: 0n,
  atimeNs: 0n,
  mtimeNs: 0n,
  ctimeNs: 0n,
  birthtimeNs: 0n,
  atime: new Date(0),
  mtime: new Date(0),
  ctime: new Date(0),
  birthtime: new Date(0),
  isFile: () => true,
  isDirectory: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isSymbolicLink: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  ...overrides,
} as BigIntStats);

test("creates a fresh secret at 0600 when none exists", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const secret = await loadOrCreateLocalSecret(paths);
    assert.ok(secret.length >= 32);
    const info = await stat(paths.secretFile);
    assert.equal(info.isFile(), true);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await readFile(paths.secretFile, "utf8")).trim(), secret);
  } finally {
    await cleanup(dir);
  }
});

test("a zero-byte final from a legacy interrupted publish is rebuilt (self-heal)", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    // Simulate the legacy bug: a 0-byte `final` left by an interrupted publish.
    await writeFile(paths.secretFile, "", { flag: "wx", mode: 0o600 });
    assert.equal((await stat(paths.secretFile)).size, 0);

    const secret = await loadOrCreateLocalSecret(paths);
    assert.ok(secret.length >= 32);
    const info = await stat(paths.secretFile);
    assert.ok(info.size > 0); // rebuilt, complete
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await readFile(paths.secretFile, "utf8")).trim(), secret);
  } finally {
    await cleanup(dir);
  }
});

test("publish interruption leaves no partial final and cleans the temp", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await assert.rejects(
      loadOrCreateLocalSecret(paths, { beforePublish: async () => { throw new Error("interrupted"); } }),
      /interrupted/,
    );
    // `final` was never linked → no partial/0-byte final.
    await assert.rejects(stat(paths.secretFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    // The temp was cleaned up.
    const leftover = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  } finally {
    await cleanup(dir);
  }
});

test("stale temp from a dead process is swept; a live owner's temp is left", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  await mkdir(dir, { recursive: true });
  try {
    const stale = join(dir, "sessiond.secret.999999999.dead-uuid.tmp");
    const live = join(dir, `sessiond.secret.${process.pid}.live-uuid.tmp`);
    await writeFile(stale, "stale", { mode: 0o600 });
    await writeFile(live, "live", { mode: 0o600 });

    await loadOrCreateLocalSecret(paths);

    await assert.rejects(stat(stale), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
    assert.equal((await stat(live)).isFile(), true);
  } finally {
    await cleanup(dir);
  }
});

test("concurrent creation converges on the same published secret (no overwrite)", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    // The delayed publisher loses the link race and must adopt the fast one's secret.
    const slow = loadOrCreateLocalSecret(paths, { beforePublish: async () => { await new Promise((r) => setTimeout(r, 15)); } });
    const fast = loadOrCreateLocalSecret(paths);
    const [a, b] = await Promise.all([slow, fast]);
    assert.equal(a, b);
    assert.ok(a.length >= 32);
    assert.equal((await stat(paths.secretFile)).mode & 0o777, 0o600);
  } finally {
    await cleanup(dir);
  }
});

test("an existing valid secret is returned unchanged", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const preset = randomBytes(32).toString("base64url");
    await writeFile(paths.secretFile, `${preset}\n`, { mode: 0o600 });

    const got = await loadOrCreateLocalSecret(paths);
    assert.equal(got, preset);
    // Content untouched (not regenerated/overwritten).
    assert.equal((await readFile(paths.secretFile, "utf8")).trim(), preset);
    assert.equal((await stat(paths.secretFile)).mode & 0o777, 0o600);
  } finally {
    await cleanup(dir);
  }
});

test("secret validator rejects wrong owner deterministically", { skip: typeof process.getuid !== "function" }, () => {
  const uid = BigInt(process.getuid!());
  assert.throws(
    () => validateExistingSecretInfo(forgedSecretInfo({ uid: uid + 1n })),
    isSessiondError(/forbidden/),
  );
});

test("existing secret validation fails closed before read and never repairs permissions", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  const preset = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.secretFile, `${preset}\n`, { mode: 0o600 });
    await chmod(paths.secretFile, 0o644);
    await assert.rejects(validatedExistingSecret(paths), isSessiondError(/forbidden/));
    const after = await stat(paths.secretFile);
    if (process.platform === "win32") {
      assert.notEqual(after.mode & 0o777, 0o600, "unsafe mode is not silently repaired");
    } else {
      assert.equal(after.mode & 0o777, 0o644, "unsafe mode is not silently repaired");
    }
    assert.equal((await readFile(paths.secretFile, "utf8")).trim(), preset);
  } finally {
    await cleanup(dir);
  }
});

test("hard-linked and oversized existing secrets are rejected untouched", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const preset = randomBytes(32).toString("base64url");
    const alias = join(dir, "secret-alias");
    await writeFile(paths.secretFile, `${preset}\n`, { mode: 0o600 });
    await link(paths.secretFile, alias);
    await assert.rejects(validatedExistingSecret(paths), isSessiondError(/forbidden/));
    assert.equal((await lstat(paths.secretFile)).nlink > 1, true);

    await rm(alias, { force: true });
    await writeFile(paths.secretFile, "x".repeat(2048), { mode: 0o600 });
    await assert.rejects(validatedExistingSecret(paths), isSessiondError(/forbidden/));
    assert.equal((await stat(paths.secretFile)).size, 2048);
  } finally {
    await cleanup(dir);
  }
});

test("existing secret identity replacement during read is rejected", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  const original = randomBytes(32).toString("base64url");
  const replacement = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.secretFile, `${original}\n`, { mode: 0o600 });
    await assert.rejects(
      validatedExistingSecret(paths, {
        beforeSecretRead: async () => {
          await rm(paths.secretFile, { force: true });
          await writeFile(paths.secretFile, `${replacement}\n`, { flag: "wx", mode: 0o600 });
        },
      }),
      isSessiondError(/forbidden/),
    );
    assert.equal((await readFile(paths.secretFile, "utf8")).trim(), replacement);
  } finally {
    await cleanup(dir);
  }
});

test("zero-byte self-heal never deletes a concurrent valid replacement", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  const replacement = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.secretFile, "", { mode: 0o600 });
    const first = await validatedExistingSecret(paths, {
      beforeZeroByteRemoval: async () => {
        await rm(paths.secretFile, { force: true });
        await writeFile(paths.secretFile, `${replacement}\n`, { flag: "wx", mode: 0o600 });
      },
    });
    assert.equal(first, undefined);
    const got = await validatedExistingSecret(paths);
    assert.equal(got, replacement);
    assert.equal((await readFile(paths.secretFile, "utf8")).trim(), replacement);
  } finally {
    await cleanup(dir);
  }
});

test("a symlink final is rejected (fail-closed)", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const target = join(dir, "elsewhere");
    await writeFile(target, "x".repeat(64), { mode: 0o600 });
    await symlink(target, paths.secretFile);
    await assert.rejects(loadOrCreateLocalSecret(paths), isSessiondError(/forbidden/));
  } finally {
    await cleanup(dir);
  }
});

test("a non-zero malformed final is fail-closed, not silently rebuilt", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await writeFile(paths.secretFile, "tooshort", { mode: 0o600 });
    await assert.rejects(loadOrCreateLocalSecret(paths), isSessiondError(/invalid sessiond secret/));
    // Untouched.
    assert.equal((await readFile(paths.secretFile, "utf8")), "tooshort");
  } finally {
    await cleanup(dir);
  }
});
