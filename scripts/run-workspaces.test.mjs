// scripts/run-workspaces.test.mjs
// Tests for the cross-platform workspace runner. Uses only Node builtins and
// temporary fixture directories, so it runs with zero installed dependencies
// and never touches the repository layout.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toPosixRelative } from "./path-policy.mjs";
import { fileURLToPath } from "node:url";
import {
  buildSpawnArgs,
  expandPattern,
  main,
  readWorkspaceConfig,
  resolveNpmInvocation,
  runWorkspaceScript,
} from "./run-workspaces.mjs";

const WRAPPER_URL = new URL("./run-workspaces.mjs", import.meta.url).href;

function makeRoot({ workspaces, noManifest = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pix-rws-"));
  if (!noManifest) {
    const manifest = { name: "fixture-root", version: "0.0.0", private: true };
    if (workspaces !== undefined) manifest.workspaces = workspaces;
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }
  return dir;
}

function addWorkspace(root, name, manifest = {}) {
  const dir = join(root, "packages", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "0.0.0", private: true, ...manifest }),
  );
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function copyWorkspaceRunner(root) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["run-workspaces.mjs", "tool-invocation.mjs", "path-policy.mjs"]) {
    writeFileSync(join(root, "scripts", name), readFileSync(join(here, name), "utf8"));
  }
  return join(root, "scripts", "run-workspaces.mjs");
}

async function capture(target, fn) {
  const original = console[target];
  const logs = [];
  console[target] = (msg) => logs.push(String(msg));
  try {
    return { value: await fn(), logs };
  } finally {
    console[target] = original;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("discovers zero workspaces when packages/* matches nothing", (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  assert.deepEqual(readWorkspaceConfig(root), { patterns: ["packages/*"], dirs: [] });
});

test("discovers only directories that contain a package.json", (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  addWorkspace(root, "a");
  mkdirSync(join(root, "packages", "b"), { recursive: true }); // no manifest
  addWorkspace(root, "c");
  const dirs = readWorkspaceConfig(root).dirs.map((d) => toPosixRelative(root, d));
  assert.deepEqual(dirs.sort(), ["packages/a", "packages/c"]);
});

test("supports recursive ** and literal workspace patterns", (t) => {
  const root = makeRoot({ workspaces: ["packages/**", "tools/meta"] });
  t.after(() => cleanup(root));
  addWorkspace(root, "a");
  const deep = join(root, "packages", "nested", "deep");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "package.json"), JSON.stringify({ name: "deep" }));
  const meta = join(root, "tools", "meta");
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, "package.json"), JSON.stringify({ name: "meta" }));
  const dirs = readWorkspaceConfig(root).dirs.map((d) => toPosixRelative(root, d));
  assert.deepEqual(dirs.sort(), ["packages/a", "packages/nested/deep", "tools/meta"]);
});

test("returns no workspaces when the root manifest has no workspaces field", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.deepEqual(readWorkspaceConfig(root), { patterns: [], dirs: [] });
});

test("throws a clear error for an invalid workspace manifest", (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  writeFileSync(join(addWorkspace(root, "a"), "package.json"), "{ not json");
  assert.throws(() => readWorkspaceConfig(root), /invalid workspace manifest at .*package\.json/);
});

test("throws a clear error for a missing literal workspace path", (t) => {
  const root = makeRoot({ workspaces: ["packages/missing"] });
  t.after(() => cleanup(root));
  assert.throws(
    () => readWorkspaceConfig(root),
    /workspace path from root package\.json not found: .*packages[\\/]missing/,
  );
});

test("throws for a non-array workspaces field", (t) => {
  const root = makeRoot({ workspaces: "packages/*" });
  t.after(() => cleanup(root));
  assert.throws(() => readWorkspaceConfig(root), /"workspaces" must be an array/);
});

test("throws for a missing root package.json", (t) => {
  const root = makeRoot({ noManifest: true });
  t.after(() => cleanup(root));
  assert.throws(() => readWorkspaceConfig(root), /cannot read root package\.json/);
});

test("expandPattern handles a literal dir without a manifest", (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  mkdirSync(join(root, "packages", "empty"), { recursive: true });
  assert.deepEqual(expandPattern(root, "packages/*"), []);
});

// ---------------------------------------------------------------------------
// npm invocation resolution and spawn args
// ---------------------------------------------------------------------------

function addNpmPackage(root) {
  const pkgDir = join(root, "node_modules", "npm");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }));
  const cli = join(pkgDir, "bin", "npm-cli.js");
  writeFileSync(cli, "");
  return cli;
}

test("resolveNpmInvocation reuses the validated npm JS CLI (no npm.cmd / shell:true)", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const cli = addNpmPackage(root);
  const inv = resolveNpmInvocation({
    execPath: process.execPath,
    env: { npm_execpath: cli },
  });
  assert.equal(inv.command, process.execPath);
  assert.deepEqual(inv.args, [cli]);
  assert.equal(inv.shell, false);
});

test("resolveNpmInvocation fails closed without a validated npm_execpath", () => {
  assert.throws(
    () => resolveNpmInvocation({ execPath: process.execPath, env: {} }),
    /run this script through npm/,
  );
});

test("buildSpawnArgs always produces npm run <script> --workspaces --if-present", () => {
  const plain = buildSpawnArgs("typecheck", { command: "npm", args: [], shell: false });
  assert.equal(plain.command, "npm");
  assert.deepEqual(plain.args, ["run", "typecheck", "--workspaces", "--if-present"]);
  const withCli = buildSpawnArgs("build", {
    command: process.execPath,
    args: ["/x/npm-cli.js"],
    shell: false,
  });
  assert.deepEqual(withCli.args, ["/x/npm-cli.js", "run", "build", "--workspaces", "--if-present"]);
});

// ---------------------------------------------------------------------------
// runWorkspaceScript behavior
// ---------------------------------------------------------------------------

test("zero workspaces: exits 0 with a short note and never spawns", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  let spawned = false;
  const { value: code, logs } = await capture("log", () =>
    runWorkspaceScript("build", {
      rootDir: root,
      spawnImpl: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    }),
  );
  assert.equal(code, 0);
  assert.equal(spawned, false);
  assert.ok(logs.length > 0, "expected a log line");
  assert.match(logs[0], /no workspace package\.json found for root workspaces \(packages\/\*\)/);
});

test("spawns with cwd at the root and inherited stdio, then propagates exit code", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  addWorkspace(root, "a");
  t.after(() => cleanup(root));
  let captured;
  const fakeChild = new EventEmitter();
  const pending = runWorkspaceScript("typecheck", {
    rootDir: root,
    npmInvocation: { command: "npm", args: [], shell: false },
    spawnImpl: (command, args, opts) => {
      captured = { command, args, opts };
      return fakeChild;
    },
  });
  assert.ok(captured, "spawnImpl was called");
  assert.equal(captured.command, "npm");
  assert.deepEqual(captured.args, ["run", "typecheck", "--workspaces", "--if-present"]);
  assert.equal(captured.opts.cwd, root);
  assert.equal(captured.opts.stdio, "inherit");
  fakeChild.emit("exit", 0, null);
  assert.equal(await pending, 0);
});

test("propagates a non-zero child exit code", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  addWorkspace(root, "a");
  t.after(() => cleanup(root));
  const fakeChild = new EventEmitter();
  const pending = runWorkspaceScript("build", {
    rootDir: root,
    npmInvocation: { command: "npm", args: [], shell: false },
    spawnImpl: () => fakeChild,
  });
  fakeChild.emit("exit", 42, null);
  assert.equal(await pending, 42);
});

test("resolves 1 and reports when the child fails to start", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  addWorkspace(root, "a");
  t.after(() => cleanup(root));
  const fakeChild = new EventEmitter();
  const { value: code, logs } = await capture("error", async () => {
    const pending = runWorkspaceScript("test", {
      rootDir: root,
      npmInvocation: { command: "npm", args: [], shell: false },
      spawnImpl: () => fakeChild,
    });
    fakeChild.emit("error", new Error("ENOENT boom"));
    return await pending;
  });
  assert.equal(code, 1);
  assert.ok(logs.some((line) => /failed to start npm/.test(line)));
});

test("end-to-end: runs the real npm invocation with a fake npm child script", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  addWorkspace(root, "a");
  t.after(() => cleanup(root));
  const out = join(root, "out.jsonl");
  const fakeNpm = join(root, "fake-npm.mjs");
  writeFileSync(
    fakeNpm,
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.PIX_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");\n` +
      `process.exit(Number(process.env.PIX_CODE ?? "0"));\n`,
  );
  const code = await runWorkspaceScript("typecheck", {
    rootDir: root,
    npmInvocation: { command: process.execPath, args: [fakeNpm], shell: false },
    env: { ...process.env, PIX_OUT: out, PIX_CODE: "0" },
  });
  assert.equal(code, 0);
  const recorded = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(recorded.args, ["run", "typecheck", "--workspaces", "--if-present"]);
  assert.equal(recorded.cwd, realpathSync(root));
});

test("end-to-end: child failure exit code is propagated from the real spawn", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  addWorkspace(root, "a");
  t.after(() => cleanup(root));
  const out = join(root, "out.jsonl");
  const fakeNpm = join(root, "fake-npm.mjs");
  writeFileSync(
    fakeNpm,
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.PIX_OUT, "ran\\n");\n` +
      `process.exit(Number(process.env.PIX_CODE ?? "0"));\n`,
  );
  const code = await runWorkspaceScript("test", {
    rootDir: root,
    npmInvocation: { command: process.execPath, args: [fakeNpm], shell: false },
    env: { ...process.env, PIX_OUT: out, PIX_CODE: "42" },
  });
  assert.equal(code, 42);
  assert.ok(readFileSync(out, "utf8").includes("ran"));
});

test(
  "re-raises a child termination signal on itself",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = makeRoot({ workspaces: ["packages/*"] });
    addWorkspace(root, "a");
    t.after(() => cleanup(root));
    const killer = join(root, "killer.mjs");
    writeFileSync(killer, `process.kill(process.pid, "SIGTERM");\n`);
    const driver = join(root, "driver.mjs");
    writeFileSync(
      driver,
      `import { runWorkspaceScript } from ${JSON.stringify(WRAPPER_URL)};\n` +
        `const code = await runWorkspaceScript("test", {\n` +
        `  rootDir: ${JSON.stringify(root)},\n` +
        `  npmInvocation: { command: process.execPath, args: [${JSON.stringify(killer)}], shell: false },\n` +
        `});\n` +
        `process.exit(code);\n`,
    );
    const result = await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [driver], { stdio: "ignore" });
      child.on("close", (code, signal) => resolvePromise({ code, signal }));
    });
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.code, null);
  },
);

// ---------------------------------------------------------------------------
// main / CLI
// ---------------------------------------------------------------------------

test("main: missing script name is a usage error (exit 2)", async () => {
  const { value: code, logs } = await capture("error", () =>
    main([], {
      runWorkspaceScript: async () => {
        throw new Error("must not run");
      },
    }),
  );
  assert.equal(code, 2);
  assert.ok(logs.some((line) => /usage: node scripts\/run-workspaces\.mjs/.test(line)));
});

test("main: forwards the runner exit code", async () => {
  const code = await main(["build"], { runWorkspaceScript: async () => 7 });
  assert.equal(code, 7);
});

test("main: turns a thrown error into exit 1 with a message", async () => {
  const { value: code, logs } = await capture("error", () =>
    main(["typecheck"], {
      runWorkspaceScript: async () => {
        throw new Error("boom");
      },
    }),
  );
  assert.equal(code, 1);
  assert.ok(logs.some((line) => /\[run-workspaces\] boom/.test(line)));
});

test("end-to-end: CLI exits 0 with a note when there are no workspaces", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  const copy = copyWorkspaceRunner(root);
  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [copy, "typecheck"], { cwd: root });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /no workspace package\.json found/);
});

test("end-to-end: CLI usage error exits 2", async (t) => {
  const root = makeRoot({ workspaces: ["packages/*"] });
  t.after(() => cleanup(root));
  const copy = copyWorkspaceRunner(root);
  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [copy], { cwd: root });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: node scripts\/run-workspaces\.mjs/);
});
