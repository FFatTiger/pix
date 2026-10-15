/**
 * path-canonical win32 semantics, unit-tested on macOS via the injectable
 * platform (realpath `\\?\` prefixes, NTFS case folding, prefix-safe
 * containment). POSIX branches assert the frozen exact-string behavior.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeRealpath,
  isPathOrChildOf,
  pathKey,
  pathWithin,
  samePath,
  stripExtendedPrefix,
} from "../dist/resources/path-canonical.js";

const B = "\\";

test("stripExtendedPrefix maps extended forms back to plain win32 paths", () => {
  assert.equal(stripExtendedPrefix(`\\\\?\\C:\\repo`), `C:\\repo`);
  assert.equal(stripExtendedPrefix(`\\\\?\\UNC\\srv\\share\\repo`), `\\\\srv\\share\\repo`);
  assert.equal(stripExtendedPrefix(`/tmp/x`), "/tmp/x");
  assert.equal(stripExtendedPrefix(`C:\\plain`), `C:\\plain`);
});

test("canonicalizeRealpath: win32 strips prefix and resolves; case stays, pathKey folds it", () => {
  // Stored and returned paths keep the case realpath reported. NTFS folding
  // is a comparison concern, so only pathKey is lowercase.
  assert.equal(canonicalizeRealpath(`\\\\?\\C:\\Repo\\Src`, "win32"), `C:\\Repo\\Src`);
  assert.equal(pathKey(`\\\\?\\C:\\Repo\\Src`, "win32"), `c:\\repo\\src`);
  assert.equal(canonicalizeRealpath(`c:/REPO/src`, "win32"), `c:\\REPO\\src`);
  assert.equal(pathKey(`c:/REPO/src`, "win32"), `c:\\repo\\src`);
  assert.equal(canonicalizeRealpath(`\\\\?\\UNC\\SRV\\share\\a`, "win32"), `\\\\SRV\\share\\a`);
  assert.equal(pathKey(`\\\\?\\UNC\\SRV\\share\\a`, "win32"), `\\\\srv\\share\\a`);
  // POSIX identity (frozen).
  assert.equal(canonicalizeRealpath("/tmp/X", "darwin"), "/tmp/X");
  assert.equal(canonicalizeRealpath(`\\\\?\\C:\\a`, "linux"), `\\\\?\\C:\\a`);
});

test("samePath: win32 case/separator/prefix tolerant, POSIX exact", () => {
  assert.equal(samePath(`C:\\Repo`, `c:/repo`, "win32"), true);
  assert.equal(samePath(`\\\\?\\C:\\repo`, `C:\\repo`, "win32"), true);
  assert.equal(samePath(`C:\\repo`, `C:\\other`, "win32"), false);
  assert.equal(samePath("/tmp/x", "/tmp/X", "darwin"), false);
});

test("pathWithin: prefix-safe containment on win32 (case-insensitive, separator-tolerant)", () => {
  assert.equal(pathWithin(`C:\\proj`, `C:\\proj\\src\\a.ts`, "win32"), true);
  assert.equal(pathWithin(`C:\\proj`, `c:\\PROJ\\src`, "win32"), true);
  assert.equal(pathWithin(`C:\\proj`, `\\\\?\\C:\\proj\\a`, "win32"), true);
  assert.equal(pathWithin(`C:\\proj`, `C:\\proj-evil`, "win32"), false, "sibling prefix must not match");
  assert.equal(pathWithin(`C:\\proj`, `C:${B}${B}..${B}..${B}escape`, "win32"), false, "relative escapes rejected");
  assert.equal(pathWithin(`C:\\proj`, `D:\\proj`, "win32"), false, "different drive is outside");
  assert.equal(pathWithin(`C:\\proj`, `C:\\proj`, "win32"), true);
  // POSIX frozen behavior.
  assert.equal(pathWithin("/proj", "/proj/src", "darwin"), true);
  assert.equal(pathWithin("/proj", "/proj-evil", "linux"), false);
  assert.equal(pathWithin("/proj", "/other", "linux"), false);
});

test("isPathOrChildOf: root or direct-prefix child with win32 folding", () => {
  assert.equal(isPathOrChildOf(`C:\\dist`, `C:\\dist`, "win32"), true);
  assert.equal(isPathOrChildOf(`c:\\DIST\\assets\\a.js`, `C:\\dist`, "win32"), true);
  assert.equal(isPathOrChildOf(`C:\\distX`, `C:\\dist`, "win32"), false);
  assert.equal(isPathOrChildOf("/dist/assets/a.js", "/dist", "darwin"), true);
  assert.equal(isPathOrChildOf("/distX", "/dist", "linux"), false);
});

test("pathKey stability: same file reported three ways yields one key", () => {
  const keys = new Set([
    pathKey(`C:\\Users\\x\\.pi`, "win32"),
    pathKey(`\\\\?\\C:\\users\\X\\\\.pi`, "win32"),
    pathKey(`c:/users/x/.pi`, "win32"),
  ]);
  assert.equal(keys.size, 1, `expected a single key, got ${[...keys].join(" | ")}`);
});
