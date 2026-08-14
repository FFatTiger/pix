import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeAbsolutePath,
  LocalAuthorityError,
  isAbsoluteCanonicalShape,
} from "../dist/state/index.js";

const temporary = [];
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop();
    rmSync(value, { recursive: true, force: true });
  }
});

async function expectReject(path, code) {
  await assert.rejects(
    () => canonicalizeAbsolutePath(path),
    (e) => e instanceof LocalAuthorityError && e.code === code,
    `expected ${JSON.stringify(path)} to reject with ${code}`,
  );
}

// ---------------------------------------------------------------------------
// Requirement / shape validation
// ---------------------------------------------------------------------------

test("canonicalize: requires absolute bounded path without NUL/control chars", async () => {
  await expectReject("", "INVALID_PATH");
  await expectReject("relative", "INVALID_PATH");
  await expectReject("~/.pi/pix/host", "INVALID_PATH");
  await expectReject(`/a\u0000b`, "INVALID_PATH");
  await expectReject(`/a\nb`, "INVALID_PATH");
  await expectReject(`/a\u0001b`, "INVALID_PATH");
  await expectReject(`/${"x".repeat(5000)}`, "INVALID_PATH");
});

test("canonicalize: rejects roots, parent escapes, network and Windows claims", async () => {
  await expectReject("/", "ROOT_PATH");
  await expectReject("/a/../b", "PARENT_ESCAPE");
  await expectReject("/a/./b", "PARENT_ESCAPE");
  await expectReject("/a/b/..", "PARENT_ESCAPE");
  await expectReject("//server/share", "NETWORK_PATH");
  await expectReject("C:\\foo", "WINDOWS_PATH");
  await expectReject("C:/foo/bar", "WINDOWS_PATH");
});

test("canonicalize: existing plain path returns the realpath (no-op for canonical input)", async () => {
  const dir = temp("canon-plain-");
  assert.equal(await canonicalizeAbsolutePath(dir), realpathSync(dir));
  // A canonical subpath (no missing tail) stays identical.
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(await canonicalizeAbsolutePath(nested), realpathSync(nested));
});

test("canonicalize: missing multi-component tail appends validated components", async () => {
  const dir = temp("canon-tail-");
  const target = join(dir, "missing1", "missing2", "leaf");
  const canonical = await canonicalizeAbsolutePath(target);
  assert.equal(canonical, join(realpathSync(dir), "missing1", "missing2", "leaf"));
  assert.ok(isAbsoluteCanonicalShape(canonical), "canonical result satisfies canonical shape");
  // Nothing was created by canonicalization (it is read-only).
  assert.equal(await import("node:fs/promises").then((m) => m.lstat(target).then(() => true, () => false)), false);
});

test("canonicalize: generic symlink alias resolves to the real target without an unsafe component", async () => {
  const dir = temp("canon-alias-");
  const real = join(dir, "real");
  const link = join(dir, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  // A path THROUGH the alias resolves to the real target.
  const canonical = await canonicalizeAbsolutePath(join(link, "child"));
  assert.equal(canonical, join(real, "child"));
  // An unsafe component (parent escape) in the tail is never permitted, even
  // through an alias. (Raw strings: path.join would normalize `..` away.)
  await expectReject(`${link}/../evil`, "PARENT_ESCAPE");
  await expectReject(`${link}/a/../evil`, "PARENT_ESCAPE");
  // The canonical result itself never contains a symlinked component.
  assert.equal(canonical.includes(link), false);
  assert.equal(await canonicalizeAbsolutePath(canonical), canonical);
});

test("canonicalize: UTF-8 and space components are accepted", async () => {
  const dir = temp("canon-utf8-");
  const nested = join(dir, "ütf dir", "with space", "файл-名");
  const canonical = await canonicalizeAbsolutePath(nested);
  assert.equal(canonical, join(realpathSync(dir), "ütf dir", "with space", "файл-名"));
});

test("canonicalize: a symlink to a file fails closed", async () => {
  const dir = temp("canon-filesym-");
  const { writeFileSync } = await import("node:fs");
  const file = join(dir, "target.txt");
  writeFileSync(file, "x");
  const link = join(dir, "link");
  symlinkSync(file, link);
  // Canonicalizing the link itself resolves to a file → NOT_DIRECTORY.
  await expectReject(link, "NOT_DIRECTORY");
  // Traversing under a file is ENOTDIR (fail-closed, INVALID_PATH).
  await expectReject(join(link, "child"), "INVALID_PATH");
});

test("canonicalize: an existing non-directory component fails closed", async () => {
  const dir = temp("canon-nondir-");
  const { writeFileSync } = await import("node:fs");
  const file = join(dir, "plain.txt");
  writeFileSync(file, "x");
  await expectReject(file, "NOT_DIRECTORY");
});

// ---------------------------------------------------------------------------
// macOS /var system alias (platform-applicable)
// ---------------------------------------------------------------------------

test("canonicalize: macOS /var alias resolves under /private/var (no false reject)", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS system alias only");
    return;
  }
  assert.equal(await canonicalizeAbsolutePath("/var/foo"), "/private/var/foo");
  assert.equal(await canonicalizeAbsolutePath("/var"), "/private/var");
  // An existing canonical directory (never a file) resolves through the alias.
  assert.equal(await canonicalizeAbsolutePath("/etc"), "/private/etc");
});

test("canonicalize: realpath alias of a real system dir is stable", async () => {
  const real = await import("node:fs/promises").then((m) => m.realpath("/usr"));
  assert.equal(await canonicalizeAbsolutePath("/usr"), real);
});
