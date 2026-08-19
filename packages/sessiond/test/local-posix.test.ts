import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { LocalAuthorityError } from "@fffattiger/pix-local-authority/state";
import {
  ensureSessiondPrivateDirectory,
  reverifySessiondPrivateDirectory,
} from "../src/local-posix.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const CANON_TMP = realpathSync(tmpdir());
const temporary: string[] = [];
const isWindows = process.platform === "win32";

function temp(prefix: string): string {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}

afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop()!;
    rmSync(value, { recursive: true, force: true });
  }
});

async function expectReject(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => e instanceof LocalAuthorityError && e.code === code, `expected reject with ${code}`);
}

function assertSanitized(error: unknown, code: string, marker: string): void {
  assert.ok(error instanceof LocalAuthorityError, "must be LocalAuthorityError");
  assert.equal(error.code, code, "fixed code");
  assert.ok(!error.message.includes(marker), `no marker/path in message (got "${error.message}")`);
  assert.ok(!/EACCES|ENOTDIR|ELOOP|permission denied|error: /i.test(error.message), `no raw os text (got "${error.message}")`);
}

test("existing 0755 directory fails closed NOT_PRIVATE, mode untouched, no mutation", { skip: isWindows }, async () => {
  const dir = temp("posix-0755-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o755 });
  chmodSync(leaf, 0o755);
  const marker = join(leaf, "marker.txt");
  writeFileSync(marker, "payload", { mode: 0o600 });

  await expectReject(() => ensureSessiondPrivateDirectory(leaf), "NOT_PRIVATE");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o755, "existing leaf must never be chmod'd");
  assert.equal(readFileSync(marker, "utf8"), "payload", "content untouched");
});

test("existing 0700 current-user directory validates and is never chmod'd (created:false)", { skip: isWindows }, async () => {
  const dir = temp("posix-ok-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o700 });
  const result = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(result.created, false, "existing leaf is never reported created");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700);
});

test("symlink leaf fails closed SYMLINK, target untouched", { skip: isWindows }, async () => {
  const dir = temp("posix-sym-");
  const external = join(dir, "external");
  mkdirSync(external, { mode: 0o700 });
  const payload = join(external, "content.txt");
  writeFileSync(payload, "payload", { mode: 0o600 });
  const leaf = join(dir, "leaf");
  symlinkSync(external, leaf);

  await expectReject(() => ensureSessiondPrivateDirectory(leaf), "SYMLINK");
  assert.equal(lstatSync(external).mode & 0o777, 0o700, "external target untouched");
  assert.equal(readFileSync(payload, "utf8"), "payload", "external content untouched");
});

test("nested all-missing path created 0700, created:true", { skip: isWindows }, async () => {
  const dir = temp("posix-create-");
  const leaf = join(dir, "a", "b", "leaf");
  const result = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(result.created, true);
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700, "leaf 0700 via backend");
  assert.equal(lstatSync(join(dir, "a", "b")).mode & 0o777, 0o700, "intermediate leaves 0700");
});

test("production entry under os.tmpdir() resolves macOS /tmp and /var aliases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "posix-tmp-alias-"));
  temporary.push(dir);
  const leaf = join(dir, "sessiond");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(ctx.created, true);
  assert.equal(ctx.operationalPath, leaf);
  if (!isWindows) {
    assert.equal(lstatSync(leaf).mode & 0o777, 0o700);
    assert.equal(lstatSync(ctx.canonicalPath).dev, lstatSync(leaf).dev);
    assert.equal(lstatSync(ctx.canonicalPath).ino, lstatSync(leaf).ino);
  }
});

test("production entry creates a missing runtime directory (created:true, canonical/operational split)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "posix-prod-create-"));
  temporary.push(dir);
  const leaf = join(dir, "missing", "sessiond");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(ctx.created, true);
  assert.equal(ctx.operationalPath, leaf);
  if (isWindows) {
    assert.equal(ctx.identity.kind, "windows");
    assert.equal(ctx.identity.isDirectory, true);
    assert.equal(ctx.identity.isReparsePoint, false);
  } else {
    assert.equal(lstatSync(leaf).mode & 0o777, 0o700);
    assert.equal(lstatSync(ctx.canonicalPath).dev, lstatSync(leaf).dev);
    assert.equal(lstatSync(ctx.canonicalPath).ino, lstatSync(leaf).ino);
  }
});

test("reverify detects a directory identity swap (fail closed)", async () => {
  const dir = temp("posix-rv-swap-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(ctx.created, true);
  renameSync(leaf, join(dir, "leaf.original"));
  mkdirSync(leaf, { mode: 0o700 });
  await expectReject(() => reverifySessiondPrivateDirectory(ctx), "UNSAFE_COMPONENT");
});

test("reverify detects a missing directory (fail closed)", async () => {
  const dir = temp("posix-rv-missing-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  rmSync(leaf, { recursive: true, force: true });
  await expectReject(() => reverifySessiondPrivateDirectory(ctx), "UNSAFE_COMPONENT");
});

test("reverify detects a swapped-in symlink leaf (fail closed, target untouched)", { skip: isWindows }, async () => {
  const dir = temp("posix-rv-sym-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  const external = join(dir, "external");
  mkdirSync(external, { mode: 0o700 });
  const payload = join(external, "content.txt");
  writeFileSync(payload, "payload", { mode: 0o600 });
  renameSync(leaf, join(dir, "leaf.original"));
  symlinkSync(external, leaf);
  await expectReject(() => reverifySessiondPrivateDirectory(ctx), "UNSAFE_COMPONENT");
  assert.equal(readFileSync(payload, "utf8"), "payload", "external target untouched");
});

test("reverify passes when the directory is unchanged", async () => {
  const dir = temp("posix-rv-ok-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  await reverifySessiondPrivateDirectory(ctx);
});

test("marker probes: no raw path/errno leakage in any thrown error", { skip: isWindows }, async () => {
  const dir = temp("posix-leak-");
  const leaf = join(dir, "leaf-secret-marker-xyz");
  mkdirSync(leaf, { mode: 0o755 });
  chmodSync(leaf, 0o755);
  try {
    await ensureSessiondPrivateDirectory(leaf);
    assert.fail("expected rejection for 0755 leaf");
  } catch (error) {
    assertSanitized(error, "NOT_PRIVATE", leaf);
  }

  const ctxDir = temp("posix-leak-ctx-");
  const ctx = await ensureSessiondPrivateDirectory(ctxDir);
  rmSync(ctxDir, { recursive: true, force: true });
  try {
    await reverifySessiondPrivateDirectory(ctx);
    assert.fail("expected rejection for missing dir");
  } catch (error) {
    assertSanitized(error, "UNSAFE_COMPONENT", ctxDir);
  }
});

test("sessiond no longer owns a second private-directory walk", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(PACKAGE_ROOT, "src", "local-posix.ts"), "utf8");
  assert.equal(src.includes("ensureSessiondPrivateDirectoryWithFs"), false);
  assert.equal(/mkdirFulfilled/.test(src), false);
  assert.match(src, /backend\.ensurePrivateDirectory/);
});
