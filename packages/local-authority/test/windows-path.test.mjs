import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { LocalAuthorityError } from "../dist/state/index.js";
import { loadNativeWindowsBinding } from "../dist/state/native-windows.js";
import {
  canonicalizeWindowsAbsolutePath,
  isWindowsDriveAbsoluteShape,
} from "../dist/state/windows-path.js";

const isWindowsX64 = process.platform === "win32" && process.arch === "x64";

async function expectReject(path, code) {
  await assert.rejects(
    () => canonicalizeWindowsAbsolutePath(path),
    (error) => error instanceof LocalAuthorityError && error.code === code,
    `expected ${JSON.stringify(path)} to reject with ${code}`,
  );
}

test("isWindowsDriveAbsoluteShape accepts drive-absolute forms and rejects UNC/extended", () => {
  assert.equal(isWindowsDriveAbsoluteShape("C:\\"), true);
  assert.equal(isWindowsDriveAbsoluteShape("C:\\Users\\yzq"), true);
  assert.equal(isWindowsDriveAbsoluteShape("c:/Users/yzq"), true);
  assert.equal(isWindowsDriveAbsoluteShape("relative"), false);
  assert.equal(isWindowsDriveAbsoluteShape("C:foo"), false);
  assert.equal(isWindowsDriveAbsoluteShape("\\Windows"), false);
  assert.equal(isWindowsDriveAbsoluteShape("\\\\server\\share\\x"), false);
  assert.equal(isWindowsDriveAbsoluteShape("\\\\?\\C:\\Windows"), false);
  assert.equal(isWindowsDriveAbsoluteShape("C:\\foo\\..\\bar"), false);
  assert.equal(isWindowsDriveAbsoluteShape("C:\\foo\\"), false);
  assert.equal(isWindowsDriveAbsoluteShape("C:\\foo\\NUL"), false);
});

test("canonicalizeWindowsAbsolutePath rejects non-drive and traversal forms", async () => {
  await expectReject("", "INVALID_PATH");
  await expectReject("relative", "INVALID_PATH");
  await expectReject("C:foo", "INVALID_PATH");
  await expectReject("C:\\foo\\..\\bar", "PARENT_ESCAPE");
  await expectReject("C:\\foo\\.\\bar", "PARENT_ESCAPE");
  await expectReject("C:\\", "ROOT_PATH");
  await expectReject("c:/", "ROOT_PATH");
  await expectReject("\\\\server\\share\\x", "NETWORK_PATH");
  await expectReject("//server/share/x", "NETWORK_PATH");
  await expectReject("\\\\?\\C:\\Windows", "NETWORK_PATH");
  await expectReject("\\\\.\\C:\\Windows", "NETWORK_PATH");
  await expectReject("C:\\foo\\NUL", "UNSAFE_COMPONENT");
});

test("canonicalizeWindowsAbsolutePath pins an existing drive path without creating it", { skip: !isWindowsX64 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-win-canon-"));
  const nested = join(dir, "with space-测试", "leaf");
  try {
    mkdirSync(win32.dirname(nested), { recursive: true });
    writeFileSync(join(win32.dirname(nested), "marker.txt"), "x");
    const missing = join(dir, "with space-测试", "missing", "tail");
    const canonicalExisting = await canonicalizeWindowsAbsolutePath(win32.dirname(nested));
    const canonicalMissing = await canonicalizeWindowsAbsolutePath(missing);
    assert.match(canonicalExisting, /^[A-Z]:\\/u);
    assert.equal(canonicalExisting.includes("/"), false);
    assert.equal(canonicalMissing, win32.join(canonicalExisting, "missing", "tail"));
    await assert.rejects(
      () => import("node:fs/promises").then((fs) => fs.lstat(win32.join(canonicalExisting, "missing"))),
      (error) => error?.code === "ENOENT",
    );
    await expectReject(join(dir, "with space-测试", "marker.txt", "child"), "NOT_DIRECTORY");
    await expectReject(`${dir}\\a${"\u0000"}b`, "INVALID_PATH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tryCreateJunction(link, target) {
  try {
    symlinkSync(target, link, "junction");
    return true;
  } catch {
    return false;
  }
}

test("canonicalizeWindowsAbsolutePath fail-closes on a junction intermediate", { skip: !isWindowsX64 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-win-reparse-"));
  const real = join(dir, "real");
  const link = join(dir, "link");
  mkdirSync(real);
  writeFileSync(join(real, "marker.txt"), "x");
  try {
    if (!tryCreateJunction(link, real)) {
      // Creating a junction can fail without SeCreateSymbolicLinkPrivilege.
      // That is not Windows-backend success evidence.
      return;
    }
    const inspection = loadNativeWindowsBinding().inspectPath(link);
    assert.ok(inspection);
    assert.equal(inspection.isReparsePoint, true);
    assert.equal(inspection.isDirectory, true);
    await expectReject(join(link, "child"), "SYMLINK");
    await expectReject(link, "SYMLINK");
    await assert.rejects(
      () => import("node:fs/promises").then((fs) => fs.lstat(join(real, "child"))),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
