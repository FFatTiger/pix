// scripts/run-node-test.test.mjs
// Tests for the deterministic cross-platform test runner. Uses only Node
// builtins and temporary fixture directories.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTestFiles, main, parseArgs } from "./run-node-test.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "pix-node-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs splits patterns from node test flags", () => {
  assert.deepEqual(parseArgs(["dist-test/**/*.test.js", "--test-concurrency=1"]), {
    patterns: ["dist-test/**/*.test.js"],
    flags: ["--test-concurrency=1"],
  });
});

test("parseArgs supports a -- separator for flags after the patterns", () => {
  assert.deepEqual(
    parseArgs(["a.test.js", "b.test.js", "--", "--test-concurrency=1", "--test-name-pattern=x"]),
    {
      patterns: ["a.test.js", "b.test.js"],
      flags: ["--test-concurrency=1", "--test-name-pattern=x"],
    },
  );
});

test("parseArgs treats flags before patterns as flags", () => {
  assert.deepEqual(parseArgs(["--test-concurrency=1", "x/**/*.test.js"]), {
    patterns: ["x/**/*.test.js"],
    flags: ["--test-concurrency=1"],
  });
});

test("parseArgs returns no patterns for empty argv", () => {
  assert.deepEqual(parseArgs([]), { patterns: [], flags: [] });
});

// ---------------------------------------------------------------------------
// discoverTestFiles
// ---------------------------------------------------------------------------

test("discoverTestFiles expands recursive globs deterministically, files only", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "scripts", "nested"), { recursive: true });
  writeFileSync(join(root, "scripts", "b.test.mjs"), "");
  writeFileSync(join(root, "scripts", "a.test.mjs"), "");
  writeFileSync(join(root, "scripts", "skip.mjs"), "");
  writeFileSync(join(root, "scripts", "nested", "c.test.mjs"), "");
  // A directory whose name looks like a test file must be excluded.
  mkdirSync(join(root, "scripts", "d.test.mjs"), { recursive: true });
  const files = discoverTestFiles(root, "scripts/**/*.test.mjs");
  assert.deepEqual(files, [
    join(root, "scripts", "a.test.mjs"),
    join(root, "scripts", "b.test.mjs"),
    join(root, "scripts", "nested", "c.test.mjs"),
  ]);
});

test("discoverTestFiles accepts backslash patterns like Windows users write", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist-test"), { recursive: true });
  writeFileSync(join(root, "dist-test", "a.test.js"), "");
  const files = discoverTestFiles(root, "dist-test\\**\\*.test.js");
  assert.deepEqual(files, [join(root, "dist-test", "a.test.js")]);
});

test("discoverTestFiles resolves a literal path to that file", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  writeFileSync(join(root, "single.test.mjs"), "");
  assert.deepEqual(discoverTestFiles(root, "single.test.mjs"), [join(root, "single.test.mjs")]);
});

test("discoverTestFiles handles spaces and Unicode in file names", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "café tests"), { recursive: true });
  writeFileSync(join(root, "café tests", "ünïcode space.test.mjs"), "");
  const files = discoverTestFiles(root, "café tests/**/*.test.mjs");
  assert.deepEqual(files, [join(root, "café tests", "ünïcode space.test.mjs")]);
});

test("discoverTestFiles sorts deterministically and accepts both separator forms", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "dist-test"), { recursive: true });
  writeFileSync(join(root, "dist-test", "b.test.js"), "");
  writeFileSync(join(root, "dist-test", "a.test.js"), "");
  const forward = discoverTestFiles(root, "dist-test/**/*.test.js");
  const backslash = discoverTestFiles(root, "dist-test\\**\\*.test.js");
  assert.deepEqual(forward, backslash);
  assert.deepEqual(forward, [
    join(root, "dist-test", "a.test.js"),
    join(root, "dist-test", "b.test.js"),
  ]);
});

test("discoverTestFiles excludes a symlink whose target escapes the cwd", (t) => {
  const root = makeRoot();
  const outside = makeRoot();
  t.after(() => {
    cleanup(root);
    cleanup(outside);
  });
  writeFileSync(join(outside, "outside.test.mjs"), "");
  symlinkSync(join(outside, "outside.test.mjs"), join(root, "linked.test.mjs"));
  const files = discoverTestFiles(root, "*.test.mjs");
  assert.deepEqual(files, []);
});

test("discoverTestFiles includes a symlink whose target stays inside the cwd", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  writeFileSync(join(root, "real.test.mjs"), "");
  symlinkSync(join(root, "real.test.mjs"), join(root, "alias.test.mjs"));
  const files = discoverTestFiles(root, "*.test.mjs");
  // The two names share one realpath, so only one entry is produced; the
  // deterministic sorted representative is the alphabetically-first name.
  assert.deepEqual(files, [join(root, "alias.test.mjs")]);
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

test("main forwards node test flags before the explicit file list", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    const testFile = join(root, "tests", "a.test.mjs");
    writeFileSync(testFile, "");
    let invocation;
    const code = main(
      ["tests/**/*.test.mjs", "--test-name-pattern=focused", "--test-concurrency=1"],
      {
        cwd: root,
        spawnSyncImpl: (command, args, options) => {
          invocation = { command, args, options };
          return { status: 0 };
        },
      },
    );
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
    cleanup(root);
  }
});

test("main dedupes across overlapping patterns and forwards the merged list", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    const testFile = join(root, "tests", "a.test.mjs");
    writeFileSync(testFile, "");
    let args;
    const code = main(["tests/**/*.test.mjs", "tests/a.test.mjs"], {
      cwd: root,
      spawnSyncImpl: (_command, argv) => {
        args = argv;
        return { status: 0 };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(args, ["--test", testFile]);
  } finally {
    cleanup(root);
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

test("main reports a literal missing path distinctly from an empty glob", () => {
  const root = makeRoot();
  try {
    const logs = [];
    const original = console.error;
    console.error = (msg) => logs.push(String(msg));
    let code;
    try {
      code = main(["missing.test.mjs"], {
        cwd: root,
        spawnSyncImpl: () => {
          throw new Error("must not spawn");
        },
      });
    } finally {
      console.error = original;
    }
    assert.equal(code, 1);
    assert.match(logs[0], /test path not found/);
  } finally {
    cleanup(root);
  }
});

test("main returns usage code 2 when no pattern is provided", () => {
  assert.equal(main([], { spawnSyncImpl: () => ({ status: 0 }) }), 2);
});

test("main re-raises a child termination signal and reports the code", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "a.test.mjs"), "");
  let killed;
  const code = main(["tests/**/*.test.mjs"], {
    cwd: root,
    spawnSyncImpl: () => ({ status: null, signal: "SIGKILL" }),
    killImpl: (pid, signal) => {
      killed = { pid, signal };
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(killed, { pid: process.pid, signal: "SIGKILL" });
});

test("main surfaces a spawn failure as exit 1", () => {
  const code = main(["tests/**/*.test.mjs"], {
    cwd: tmpdir(),
    spawnSyncImpl: () => ({ error: new Error("spawn ENOENT") }),
  });
  assert.equal(code, 1);
});
