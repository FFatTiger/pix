import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTestFiles, main } from "./run-node-test.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "pix-node-test-"));
}

test("discoverTestFiles matches recursive globs without depending on the shell", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "scripts", "nested"), { recursive: true });
  writeFileSync(join(root, "scripts", "a.test.mjs"), "");
  writeFileSync(join(root, "scripts", "a.spec.mjs"), "");
  writeFileSync(join(root, "scripts", "nested", "b.test.mjs"), "");
  writeFileSync(join(root, "scripts", "skip.mjs"), "");
  const files = discoverTestFiles(root, "scripts/**/*.{test,spec}.mjs");
  assert.deepEqual(files, [
    join(root, "scripts", "a.spec.mjs"),
    join(root, "scripts", "a.test.mjs"),
    join(root, "scripts", "nested", "b.test.mjs"),
  ]);
});

test("main forwards extra node test arguments before explicit files", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    const testFile = join(root, "tests", "a.test.mjs");
    writeFileSync(testFile, "");
    let invocation;
    const code = main(["tests/**/*.test.mjs", "--test-name-pattern=focused", "--test-concurrency=1"], {
      cwd: root,
      spawnSyncImpl: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [
      "--test",
      "--test-name-pattern=focused",
      "--test-concurrency=1",
      testFile,
    ]);
    assert.equal(invocation.options.cwd, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main fails closed when a glob matches no files", () => {
  const code = main(["definitely-missing/**/*.test.mjs"], {
    cwd: tmpdir(),
    spawnSyncImpl: () => {
      throw new Error("must not spawn");
    },
  });
  assert.equal(code, 1);
});

test("main reports usage when no glob is provided", () => {
  assert.equal(main([]), 2);
});
