// scripts/ci-run-workspace-tests.test.mjs
// A failing package must not stop the rest, and the summary exit code must
// still be 1. Uses a fake spawn so it never launches npm.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, workspacesWithScript } from "./ci-run-workspace-tests.mjs";

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "pix-ci-tests-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  return dir;
}

function addPackage(root, name, scripts) {
  const dir = join(root, "packages", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts }));
  return dir;
}

test("workspacesWithScript keeps only packages that define the script", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addPackage(root, "a", { test: "node test.js" });
  addPackage(root, "b", { build: "tsc" });
  addPackage(root, "c", { test: "node test.js" });
  assert.deepEqual(
    workspacesWithScript(root, "test").map((workspace) => workspace.name),
    ["a", "c"],
  );
});

test("main runs every package and exits 1 naming the failures", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addPackage(root, "a", { test: "ok" });
  addPackage(root, "b", { test: "bad" });
  addPackage(root, "c", { test: "ok" });

  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, cwd: options.cwd });
    const child = new EventEmitter();
    const code = options.cwd.endsWith(join("packages", "b")) ? 1 : 0;
    queueMicrotask(() => child.emit("exit", code, null));
    return child;
  };

  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message) => lines.push(String(message));
  console.error = (message) => lines.push(String(message));
  try {
    const code = await main(["test"], {
      rootDir: root,
      spawnImpl,
      npmInvocation: { command: "npm", args: [], shell: false },
    });
    assert.equal(code, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(
    spawned.map((call) => call.args),
    [
      ["run", "test"],
      ["run", "test"],
      ["run", "test"],
    ],
  );
  assert.equal(spawned[1].cwd.endsWith(join("packages", "b")), true);
  const summary = lines.join("\n");
  assert.match(summary, /FAIL b/);
  assert.match(summary, /pass a/);
  assert.match(summary, /pass c/);
  assert.match(summary, /1 failed: b/);
});

test("main exits 0 when every package passes", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addPackage(root, "a", { test: "ok" });
  const spawnImpl = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const code = await main(["test"], {
    rootDir: root,
    spawnImpl,
    npmInvocation: { command: "npm", args: [], shell: false },
  });
  assert.equal(code, 0);
});

test("main exits 0 when no package defines the script", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  addPackage(root, "a", { build: "tsc" });
  const code = await main(["test"], { rootDir: root });
  assert.equal(code, 0);
});
