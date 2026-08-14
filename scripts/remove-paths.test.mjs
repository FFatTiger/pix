// scripts/remove-paths.test.mjs
// Tests for the safe cross-platform `rm -rf` replacement. Uses only Node
// builtins and temporary fixture directories; symlink/junction behavior is
// exercised as far as the current OS permits (macOS supports symlinks).

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRootPath, isWithin, main, resolveTarget } from "./remove-paths.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "pix-rm-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// resolveTarget validation
// ---------------------------------------------------------------------------

test("isRootPath recognizes posix root and Windows-style roots", () => {
  assert.equal(isRootPath("/"), true);
  assert.equal(isRootPath("C:\\"), true);
  assert.equal(isRootPath("C:/"), true);
  assert.equal(isRootPath("C:\\foo"), false);
  assert.equal(isRootPath("/Users/x"), false);
});

test("isWithin is true for children and false for parents or siblings", () => {
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a"), false);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a/bc/d"), false);
});

test("resolveTarget rejects empty, NUL, whitespace-only and root paths", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.throws(() => resolveTarget(root, ""), /empty path/);
  assert.throws(() => resolveTarget(root, "a\0b"), /NUL/);
  assert.throws(() => resolveTarget(root, "   "), /whitespace-only path/);
  assert.throws(() => resolveTarget(root, "\t \n"), /whitespace-only path/);
  // "/" is both absolute and a root; the relative-only contract rejects it
  // as an absolute path first.
  assert.throws(() => resolveTarget(root, "/"), /absolute path|root path/);
});

test("resolveTarget rejects the working directory itself", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.throws(() => resolveTarget(root, "."), /working directory itself/);
  // The absolute form is rejected as an absolute path (relative-only contract).
  assert.throws(() => resolveTarget(root, root), /absolute path/);
});

test("resolveTarget rejects parent escape and absolute paths outside cwd", (t) => {
  const root = makeRoot();
  const outside = makeRoot();
  t.after(() => {
    cleanup(root);
    cleanup(outside);
  });
  assert.throws(() => resolveTarget(root, ".."), /outside the working directory/);
  assert.throws(() => resolveTarget(root, "../other"), /outside the working directory/);
  assert.throws(() => resolveTarget(root, join(outside, "x")), /absolute path/);
});

test("resolveTarget rejects an absolute path even when it is beneath cwd", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist"), { recursive: true });
  assert.throws(() => resolveTarget(root, join(root, "dist")), /absolute path/);
});

test("resolveTarget rejects Windows drive paths and UNC roots as probes", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.throws(() => resolveTarget(root, "C:\\"), /drive path|root path/);
  assert.throws(() => resolveTarget(root, "C:\\foo"), /drive path/);
  assert.throws(() => resolveTarget(root, "C:/foo"), /drive path/);
  assert.throws(() => resolveTarget(root, "\\\\server\\share"), /UNC root/);
  assert.throws(() => resolveTarget(root, "\\\\server\\share\\"), /UNC root/);
});

test("resolveTarget accepts nested paths inside cwd", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist"), { recursive: true });
  assert.equal(resolveTarget(root, "dist"), join(root, "dist"));
  assert.equal(resolveTarget(root, "dist/sub"), join(root, "dist", "sub"));
  // A missing path under cwd is still accepted (force no-op removal).
  assert.equal(resolveTarget(root, "never-existed"), join(root, "never-existed"));
});

// ---------------------------------------------------------------------------
// main: removal behavior
// ---------------------------------------------------------------------------

test("main removes a nested directory tree and a file", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist", "nested"), { recursive: true });
  writeFileSync(join(root, "dist", "nested", "a.js"), "x");
  writeFileSync(join(root, "single.txt"), "x");
  const code = main(["dist", "single.txt"], { cwd: root });
  assert.equal(code, 0);
  assert.equal(existsSync(join(root, "dist")), false);
  assert.equal(existsSync(join(root, "single.txt")), false);
});

test("main handles spaces and Unicode in paths", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "my dist"), { recursive: true });
  writeFileSync(join(root, "my dist", "café ünïcode.test.js"), "x");
  const code = main(["my dist/café ünïcode.test.js", "my dist"], { cwd: root });
  assert.equal(code, 0);
  assert.equal(existsSync(join(root, "my dist")), false);
});

test("main removes a read-only file", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const file = join(root, "locked.txt");
  writeFileSync(file, "x");
  chmodSync(file, 0o444);
  const code = main(["locked.txt"], { cwd: root });
  assert.equal(code, 0);
  assert.equal(existsSync(file), false);
});

test("main treats a missing path as a force no-op success", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.equal(main(["never-existed"], { cwd: root }), 0);
});

test("main removes a top-level symlink but never its target", (t) => {
  const root = makeRoot();
  const outside = makeRoot();
  t.after(() => {
    cleanup(root);
    cleanup(outside);
  });
  mkdirSync(join(outside, "keep"), { recursive: true });
  writeFileSync(join(outside, "keep", "file.txt"), "x");
  symlinkSync(join(outside, "keep"), join(root, "link"));
  const code = main(["link"], { cwd: root });
  assert.equal(code, 0);
  assert.equal(existsSync(join(root, "link")), false, "link removed");
  assert.equal(existsSync(join(outside, "keep", "file.txt")), true, "target intact");
});

test("main refuses a path that reaches through an escaping symlink", (t) => {
  const root = makeRoot();
  const outside = makeRoot();
  t.after(() => {
    cleanup(root);
    cleanup(outside);
  });
  mkdirSync(join(outside, "keep"), { recursive: true });
  writeFileSync(join(outside, "keep", "file.txt"), "x");
  symlinkSync(join(outside, "keep"), join(root, "link"));
  const code = main(["link/sub"], { cwd: root });
  assert.equal(code, 2, "escape refused");
  assert.equal(existsSync(join(root, "link")), true, "link untouched");
  assert.equal(existsSync(join(outside, "keep", "file.txt")), true, "target intact");
});

test("main refuses the whole run when any path is unsafe", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "a.js"), "x");
  const code = main(["dist", "../escape"], { cwd: root });
  assert.equal(code, 2);
  assert.equal(existsSync(join(root, "dist", "a.js")), true, "dist untouched after refusal");
});

test("main returns usage code 2 with no arguments", () => {
  assert.equal(main([], { cwd: tmpdir() }), 2);
});

test("main reports a persistent removal failure honestly as exit 1", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist"), { recursive: true });
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(String(msg));
  let code;
  try {
    code = main(["dist"], {
      cwd: root,
      rmImpl: () => {
        const err = new Error("EPERM: operation not permitted, unlink");
        err.code = "EPERM";
        throw err;
      },
    });
  } finally {
    console.error = original;
  }
  assert.equal(code, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /failed to remove/);
  assert.match(errors[0], /EPERM/);
});
