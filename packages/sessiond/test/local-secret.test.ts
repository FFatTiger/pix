import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { SessiondError } from "../src/errors.js";
import { loadOrCreateLocalSecret, sessiondPaths } from "../src/local.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "sessiond-secret-"));
const cleanup = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};
const isSessiondError = (codeOrMessage: RegExp) => (error: unknown): boolean =>
  error instanceof SessiondError && (codeOrMessage.test(error.code) || codeOrMessage.test(error.message));
const assertPrivateMode = async (path: string): Promise<void> => {
  if (process.platform === "win32") return;
  assert.equal((await stat(path)).mode & 0o777, 0o600);
};

test("creates a fresh secret at 0600 when none exists", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const secret = await loadOrCreateLocalSecret(paths);
    assert.ok(secret.length >= 32);
    const info = await stat(paths.secretFile);
    assert.equal(info.isFile(), true);
    await assertPrivateMode(paths.secretFile);
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
    await assertPrivateMode(paths.secretFile);
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
    await assertPrivateMode(paths.secretFile);
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
    await assertPrivateMode(paths.secretFile);
  } finally {
    await cleanup(dir);
  }
});

test("a symlink final is rejected (fail-closed)", async (t) => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    const target = join(dir, "elsewhere");
    await writeFile(target, "x".repeat(64), { mode: 0o600 });
    try {
      await symlink(target, paths.secretFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation requires Developer Mode or equivalent privileges");
        return;
      }
      throw error;
    }
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
