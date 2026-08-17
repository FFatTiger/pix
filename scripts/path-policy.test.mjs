// scripts/path-policy.test.mjs
// Separator-normalized containment and reporting for root tooling.

import test from "node:test";
import assert from "node:assert/strict";
import { isWithin, pathCompareForm, toPosixPath, toPosixRelative } from "./path-policy.mjs";

test("toPosixPath normalizes native separators", () => {
  assert.equal(toPosixPath("packages\\protocol\\src\\index.ts"), "packages/protocol/src/index.ts");
  assert.equal(toPosixPath("packages/protocol/src/index.ts"), "packages/protocol/src/index.ts");
});

test("isWithin is true for children and false for parents or siblings", () => {
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a"), false);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a/bc/d"), false);
});

test("isWithin treats mixed separators as the same path", () => {
  assert.equal(isWithin("C:\\foo", "C:\\foo\\bar"), true);
  assert.equal(isWithin("C:/foo", "C:\\foo\\bar"), true);
  assert.equal(isWithin("/a/b", "/a/b\\c"), true);
  assert.equal(isWithin("/a/b", "/a\\bc"), false);
});

test("isWithin contains Windows drive roots and rejects a different drive", () => {
  assert.equal(isWithin("C:\\", "C:\\Users"), true);
  assert.equal(isWithin("C:/", "C:/Users/name"), true);
  assert.equal(isWithin("C:\\", "D:\\Users"), false);
  assert.equal(pathCompareForm("C:\\"), process.platform === "win32" ? "c:" : "C:");
});

test("isWithin handles spaces in path segments", () => {
  assert.equal(isWithin("/a/my dir", "/a/my dir/x"), true);
  assert.equal(isWithin("/a/my dir", "/a/my dir-x"), false);
  assert.equal(isWithin("C:\\Program Files\\pix", "C:\\Program Files\\pix\\bin"), true);
});

test("isWithin case behavior follows the platform filesystem policy", () => {
  if (process.platform === "win32") {
    assert.equal(isWithin("C:\\Foo", "c:\\foo\\bar"), true);
    assert.equal(isWithin("C:\\Foo", "C:\\FOO"), true);
  } else {
    assert.equal(isWithin("/Foo", "/foo/bar"), false);
    assert.equal(isWithin("/Foo", "/Foo/bar"), true);
  }
});

test("toPosixRelative reports fixture paths with forward slashes", () => {
  assert.equal(toPosixRelative("/tmp/root", "/tmp/root/packages/a"), "packages/a");
  assert.equal(
    toPosixRelative("C:\\tmp\\root", "C:\\tmp\\root\\packages\\a"),
    "packages/a",
  );
});
