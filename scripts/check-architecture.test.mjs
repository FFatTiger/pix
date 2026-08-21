// scripts/check-architecture.test.mjs
// Tests for the architecture gate. Builds tiny fixture repos in a temp dir
// (with and without violations) and asserts the checks fire exactly where they
// should. Uses only Node builtins.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toPosixRelative } from "./path-policy.mjs";
import {
  checkBinTargets,
  checkDependencyBuildersSafe,
  checkLocalAuthorityBoundary,
  checkNodeEngineFloor,
  checkNoAgentSession,
  checkNoNextDependency,
  checkNoNextImport,
  checkNoNextProductPath,
  checkNoLegacyProductName,
  checkNoRawNodeTestGlob,
  checkNoRmRfInScripts,
  checkPiSdkBoundary,
  checkProtocolBoundary,
  checkRuntimeCoreBoundary,
  checkWorkspaceLayout,
  collectFiles,
  extractSpecifiers,
  main,
  runChecks,
} from "./check-architecture.mjs";

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "pix-arch-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      private: true,
      workspaces: ["packages/*"],
      engines: { node: ">=22.22.0" },
    }),
  );
  return dir;
}

function write(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// extractSpecifiers
// ---------------------------------------------------------------------------

test("extractSpecifiers finds import/require/dynamic-import specifiers", () => {
  const body = [
    `import { a } from "next/link";`,
    `import "hono";`,
    `const b = require('react');`,
    `const c = import("@earendil-works/pi-coding-agent");`,
    `export type T = import("zod").infer<Z>;`,
    `// from "ignored/comment"`,
  ].join("\n");
  assert.deepEqual(extractSpecifiers(body), [
    "next/link",
    "hono",
    "react",
    "@earendil-works/pi-coding-agent",
    "zod",
  ]);
});

// ---------------------------------------------------------------------------
// workspace layout
// ---------------------------------------------------------------------------

test("checkWorkspaceLayout requires private root and packages/*", () => {
  assert.equal(checkWorkspaceLayout({ private: true, workspaces: ["packages/*"] }).ok, true);
  assert.equal(checkWorkspaceLayout({ workspaces: ["packages/*"] }).ok, false);
  assert.equal(
    checkWorkspaceLayout({ private: true, workspaces: "packages/*" }).ok,
    false,
  );
  assert.equal(
    checkWorkspaceLayout({ private: true, workspaces: ["packages/**"] }).ok,
    false,
  );
});

test("checkNodeEngineFloor aligns manifests, lockfile records, and strict minimum CI jobs", () => {
  const root = {
    path: "/repo/package.json",
    manifest: { engines: { node: ">=22.22.0" } },
    isRoot: true,
  };
  const workspace = {
    path: "/repo/packages/host/package.json",
    manifest: { engines: { node: ">=22.22.0" } },
    isRoot: false,
  };
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": { engines: { node: ">=22.22.0" } },
      "packages/host": { engines: { node: ">=22.22.0" } },
    },
  };
  const ci = [
    "jobs:",
    "  tooling:",
    "    strategy:",
    "      matrix:",
    '        node: ["22.22.x", "24.12.x"]',
    "    steps:",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: ${{ matrix.node }}",
    "      - run: npm ci --engine-strict",
  ].join("\n");
  const input = { manifests: [root, workspace], ciWorkflow: ci, lockfile };
  assert.equal(checkNodeEngineFloor(input).ok, true);

  const staleWorkspace = {
    ...workspace,
    manifest: { engines: { node: ">=22.19.0" } },
  };
  assert.match(
    checkNodeEngineFloor({ ...input, manifests: [root, staleWorkspace] }).details,
    /must equal root/,
  );
  assert.match(
    checkNodeEngineFloor({ ...input, ciWorkflow: ci.replace("22.22.x", "22.19.x") }).details,
    /minimum Node lane/,
  );
  assert.match(
    checkNodeEngineFloor({ ...input, ciWorkflow: ci.replace("npm ci --engine-strict", "npm ci") }).details,
    /lacks npm ci --engine-strict/,
  );
  assert.match(
    checkNodeEngineFloor({
      ...input,
      lockfile: {
        ...lockfile,
        packages: {
          ...lockfile.packages,
          "": { engines: { node: ">=22.19.0" } },
        },
      },
    }).details,
    /package-lock\.json: "" engines\.node must equal root/,
  );
  assert.match(
    checkNodeEngineFloor({
      ...input,
      lockfile: {
        ...lockfile,
        packages: {
          ...lockfile.packages,
          "packages/host": { engines: { node: ">=22.19.0" } },
        },
      },
    }).details,
    /package-lock\.json: "packages\/host" engines\.node must equal root/,
  );

  const strictElsewhere = [
    "jobs:",
    "  minimum:",
    "    steps:",
    "      - uses: actions/setup-node@v4",
    "        with:",
    '          node-version: "22.22.x"',
    "      - run: npm ci",
    "  newer:",
    "    steps:",
    "      - uses: actions/setup-node@v4",
    "        with:",
    '          node-version: "24.12.x"',
    "      - run: npm ci --engine-strict",
  ].join("\n");
  assert.match(
    checkNodeEngineFloor({ ...input, ciWorkflow: strictElsewhere }).details,
    /job "minimum" runs "22\.22\.x" but lacks npm ci --engine-strict/,
  );
  assert.match(
    checkNodeEngineFloor({
      ...input,
      manifests: [{ ...root, manifest: { engines: { node: "^22.22.0" } } }],
    }).details,
    /exact minimum range/,
  );
});

// ---------------------------------------------------------------------------
// no Next
// ---------------------------------------------------------------------------

test("checkNoNextDependency flags next and eslint-config-next in any manifest", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const manifests = [
    { path: join(dir, "package.json"), manifest: { dependencies: { next: "16.2.12" } } },
    { path: join(dir, "a.json"), manifest: { devDependencies: { "eslint-config-next": "16.2.12" } } },
    { path: join(dir, "b.json"), manifest: { dependencies: { react: "^19" } } },
  ];
  const result = checkNoNextDependency(manifests);
  assert.equal(result.ok, false);
  assert.match(result.details, /next/);
  assert.match(result.details, /eslint-config-next/);
  assert.doesNotMatch(result.details, /react/);
  assert.equal(checkNoNextDependency(manifests.slice(2)).ok, true);
});

test("checkNoNextImport flags next specifiers in source files", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const f1 = write(dir, "a.ts", `import Link from "next/link";`);
  const f2 = write(dir, "b.mjs", `require("next");`);
  const f3 = write(dir, "c.ts", `import { h } from "hono";`);
  const bad = checkNoNextImport([f1, f2, f3]);
  assert.equal(bad.ok, false);
  assert.match(bad.details, /a\.ts/);
  assert.match(bad.details, /b\.mjs/);
  assert.doesNotMatch(bad.details, /c\.ts/);
  assert.equal(checkNoNextImport([f3]).ok, true);
});

test("checkNoNextProductPath flags root app/, next.config.*, .next", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  assert.equal(checkNoNextProductPath(dir).ok, true);
  mkdirSync(join(dir, "app"), { recursive: true });
  assert.equal(checkNoNextProductPath(dir).ok, false);
  rmSync(join(dir, "app"), { recursive: true, force: true });
  write(dir, "next.config.mjs", "export default {};");
  assert.equal(checkNoNextProductPath(dir).ok, false);
  rmSync(join(dir, "next.config.mjs"));
  mkdirSync(join(dir, "packages", "client", ".next"), { recursive: true });
  assert.equal(checkNoNextProductPath(dir).ok, false);
});

// ---------------------------------------------------------------------------
// Pi SDK boundary
// ---------------------------------------------------------------------------

test("checkPiSdkBoundary only allows Pi SDK inside packages/pi-sdk-adapter", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const manifests = [
    {
      path: join(dir, "package.json"),
      dir: dir,
      manifest: { dependencies: { "@earendil-works/pi-ai": "0.84.0" } },
      isRoot: true,
    },
    {
      path: join(dir, "packages", "protocol", "package.json"),
      dir: join(dir, "packages", "protocol"),
      manifest: { dependencies: { "@earendil-works/pi-coding-agent": "0.84.0" } },
      isRoot: false,
    },
    {
      path: join(dir, "packages", "pi-sdk-adapter", "package.json"),
      dir: join(dir, "packages", "pi-sdk-adapter"),
      manifest: { dependencies: { "@earendil-works/pi-coding-agent": "0.84.0" } },
      isRoot: false,
    },
  ];
  const sourceFiles = [
    write(dir, "packages/host/src/x.ts", `import { foo } from "@earendil-works/pi-ai";`),
    write(
      dir,
      "packages/pi-sdk-adapter/src/y.ts",
      `import { foo } from "@earendil-works/pi-coding-agent";`,
    ),
  ];
  const result = checkPiSdkBoundary({ manifests, sourceFiles });
  assert.equal(result.ok, false);
  assert.match(result.details, /root package\.json/);
  assert.match(result.details, /packages[\\/]protocol[\\/]package\.json/);
  assert.match(result.details, /packages[\\/]host[\\/]src[\\/]x\.ts/);
  assert.doesNotMatch(result.details, /pi-sdk-adapter[\\/]package\.json/);
  assert.doesNotMatch(result.details, /pi-sdk-adapter[\\/]src[\\/]y\.ts/);
});

// ---------------------------------------------------------------------------
// runtime-core / protocol boundaries
// ---------------------------------------------------------------------------

test("checkRuntimeCoreBoundary forbids Protocol/Pi SDK/Hono/React", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const sourceFiles = [
    write(dir, "packages/runtime-core/src/a.ts", `import { p } from "@fffattiger/pix-protocol";`),
    write(dir, "packages/runtime-core/src/b.ts", `import { p } from "hono";`),
    write(dir, "packages/runtime-core/src/c.ts", `import { p } from "react";`),
    write(dir, "packages/runtime-core/src/d.ts", `import { p } from "@earendil-works/pi-ai";`),
    write(dir, "packages/runtime-core/src/ok.ts", `import { Port } from "./port";`),
    write(dir, "packages/protocol/src/ok.ts", `import { p } from "@fffattiger/pix-protocol";`),
  ];
  const result = checkRuntimeCoreBoundary({ manifests: [], sourceFiles });
  assert.equal(result.ok, false);
  for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) assert.match(result.details, new RegExp(f));
  assert.doesNotMatch(result.details, /ok\.ts/);
  const clean = sourceFiles.filter((f) => f.endsWith("ok.ts"));
  assert.equal(checkRuntimeCoreBoundary({ manifests: [], sourceFiles: clean }).ok, true);
});

test("checkProtocolBoundary forbids Runtime Core/Pi SDK/Hono/React", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const sourceFiles = [
    write(
      dir,
      "packages/protocol/src/a.ts",
      `import { p } from "@fffattiger/pix-runtime-core";`,
    ),
    write(dir, "packages/protocol/src/b.ts", `import { p } from "hono";`),
    write(dir, "packages/protocol/src/c.ts", `import { p } from "react-dom";`),
    write(dir, "packages/protocol/src/ok.ts", `import { z } from "zod";`),
  ];
  const result = checkProtocolBoundary({ manifests: [], sourceFiles });
  assert.equal(result.ok, false);
  for (const f of ["a.ts", "b.ts", "c.ts"]) assert.match(result.details, new RegExp(f));
  assert.doesNotMatch(result.details, /ok\.ts/);
  const clean = sourceFiles.filter((f) => f.endsWith("ok.ts"));
  assert.equal(checkProtocolBoundary({ manifests: [], sourceFiles: clean }).ok, true);
});

test("boundary checks also flag offending package.json dependencies", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const manifests = [
    {
      path: join(dir, "packages/runtime-core/package.json"),
      dir: join(dir, "packages/runtime-core"),
      manifest: { dependencies: { hono: "^4" } },
    },
    {
      path: join(dir, "packages/protocol/package.json"),
      dir: join(dir, "packages/protocol"),
      manifest: { devDependencies: { "@fffattiger/pix-runtime-core": "0.1.0" } },
    },
  ];
  assert.equal(checkRuntimeCoreBoundary({ manifests, sourceFiles: [] }).ok, false);
  assert.equal(checkProtocolBoundary({ manifests, sourceFiles: [] }).ok, false);
});

test("checkLocalAuthorityBoundary forbids Protocol/Runtime Core/Pi SDK/Hono/React", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const sourceFiles = [
    write(dir, "packages/local-authority/src/a.ts", `import { p } from "@fffattiger/pix-protocol";`),
    write(dir, "packages/local-authority/src/b.ts", `import { p } from "@fffattiger/pix-runtime-core";`),
    write(dir, "packages/local-authority/src/c.ts", `import { p } from "hono";`),
    write(dir, "packages/local-authority/src/d.ts", `import { p } from "react";`),
    write(dir, "packages/local-authority/src/e.ts", `import { p } from "@earendil-works/pi-ai";`),
    write(dir, "packages/local-authority/src/ok.ts", `import { fs } from "node:fs"; import { x } from "./contracts";`),
    write(dir, "packages/protocol/src/ok.ts", `import { p } from "@fffattiger/pix-protocol";`),
  ];
  const result = checkLocalAuthorityBoundary({ manifests: [], sourceFiles });
  assert.equal(result.ok, false);
  for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
    assert.match(result.details, new RegExp(f));
  }
  assert.doesNotMatch(result.details, /ok\.ts/);
  const clean = sourceFiles.filter((f) => f.endsWith("ok.ts"));
  assert.equal(checkLocalAuthorityBoundary({ manifests: [], sourceFiles: clean }).ok, true);
});

// ---------------------------------------------------------------------------
// AgentSession / SessionManager
// ---------------------------------------------------------------------------

test("checkNoAgentSession flags AgentSession/SessionManager in host/sessiond/agent-worker", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const sourceFiles = [
    write(dir, "packages/host/src/a.ts", `// eslint-disable\nconst s = new AgentSession();`),
    write(dir, "packages/sessiond/src/b.ts", `import { SessionManager } from "x";`),
    write(dir, "packages/agent-worker/src/c.ts", `type T = AgentSession;`),
    write(dir, "packages/runtime-core/src/d.ts", `interface AgentSession {}`),
    write(dir, "packages/host/src/ok.ts", `export const x = 1;`),
  ];
  const result = checkNoAgentSession(sourceFiles);
  assert.equal(result.ok, false);
  assert.match(result.details, /a\.ts/);
  assert.match(result.details, /b\.ts/);
  assert.match(result.details, /c\.ts/);
  assert.doesNotMatch(result.details, /runtime-core/);
  assert.doesNotMatch(result.details, /ok\.ts/);
  const clean = [sourceFiles[3], sourceFiles[4]];
  assert.equal(checkNoAgentSession(clean).ok, true);
});

// ---------------------------------------------------------------------------
// bin targets
// ---------------------------------------------------------------------------

test("checkBinTargets verifies declared production bins exist", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const good = join(dir, "packages", "cli");
  mkdirSync(join(good, "bin"), { recursive: true });
  writeFileSync(join(good, "bin", "cli.js"), "#!/usr/bin/env node\n");
  const manifests = [
    { dir: good, manifest: { bin: { "pix": "bin/cli.js" } } },
    { dir: good, manifest: { bin: "bin/cli.js" } },
    { dir: good, manifest: { bin: { missing: "bin/nope.js" } } },
    { dir: good, manifest: {} },
  ];
  const result = checkBinTargets(manifests);
  assert.equal(result.ok, false);
  assert.match(result.details, /missing/);
  assert.equal(checkBinTargets(manifests.slice(0, 2).concat(manifests[3])).ok, true);
});

// ---------------------------------------------------------------------------
// cross-platform tooling
// ---------------------------------------------------------------------------

test("checkNoRmRfInScripts flags every recursive-rm form in command position", () => {
  const manifests = [
    { path: "a/package.json", manifest: { scripts: { clean: "rm -rf dist dist-test" } } },
    { path: "b/package.json", manifest: { scripts: { build: "rm -fr out && tsc" } } },
    { path: "c/package.json", manifest: { scripts: { clean: "rm -r dist" } } },
    { path: "d/package.json", manifest: { scripts: { clean: "rm -r -f dist" } } },
    { path: "e/package.json", manifest: { scripts: { clean: "rm -f -r dist" } } },
    { path: "f/package.json", manifest: { scripts: { clean: "rm -RF dist" } } },
    { path: "g/package.json", manifest: { scripts: { clean: "rm --recursive --force dist" } } },
    { path: "h/package.json", manifest: { scripts: { clean: "echo ok && rm -rf dist-test" } } },
    { path: "i/package.json", manifest: { scripts: { clean: "foo; rm -R out" } } },
    { path: "j/package.json", manifest: { scripts: { clean: "node ../../scripts/remove-paths.mjs dist" } } },
    { path: "k/package.json", manifest: { scripts: { test: "echo rm -rf is just text" } } },
    { path: "l/package.json", manifest: { scripts: { clean: "# rm -rf dist is commented out" } } },
    { path: "m/package.json", manifest: { scripts: { clean: "rm -f single.txt" } } },
  ];
  const result = checkNoRmRfInScripts(manifests);
  assert.equal(result.ok, false);
  for (const p of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
    assert.match(result.details, new RegExp(`${p}\\/package\\.json`), `should flag ${p}`);
  }
  for (const p of ["j", "k", "l", "m"]) {
    assert.doesNotMatch(result.details, new RegExp(`${p}\\/package\\.json`), `should not flag ${p}`);
  }
  assert.equal(checkNoRmRfInScripts(manifests.slice(9)).ok, true);
});

test("checkNoRmRfInScripts does not flag a commented-out rm on a later segment", () => {
  const manifests = [
    { path: "a/package.json", manifest: { scripts: { clean: "foo # comment && rm -rf dist" } } },
    { path: "b/package.json", manifest: { scripts: { clean: 'echo "rm -rf" && echo hi' } } },
  ];
  const result = checkNoRmRfInScripts(manifests);
  assert.equal(result.ok, true, result.details);
});

test("checkNoRawNodeTestGlob flags shell-dependent node --test globs", () => {
  const manifests = [
    { path: "a/package.json", manifest: { scripts: { test: `node --test 'scripts/**/*.test.mjs'` } } },
    { path: "b/package.json", manifest: { scripts: { test: `node --test "dist-test/**/*.test.js"` } } },
    { path: "c/package.json", manifest: { scripts: { test: `node --test test/*.test.mjs` } } },
    // F3: the glob is on a LATER command segment, not the first occurrence.
    { path: "g/package.json", manifest: { scripts: { test: `node --test a.test.mjs && node --test 'b/**/*.test.js'` } } },
    { path: "h/package.json", manifest: { scripts: { test: `npm run build && node --test "dist/**/*.test.js"` } } },
    { path: "d/package.json", manifest: { scripts: { test: `node scripts/run-node-test.mjs "scripts/**/*.test.mjs"` } } },
    { path: "e/package.json", manifest: { scripts: { test: `node --test a.test.mjs b.test.mjs` } } },
    { path: "f/package.json", manifest: { scripts: { test: `node --test` } } },
  ];
  const result = checkNoRawNodeTestGlob(manifests);
  assert.equal(result.ok, false);
  for (const p of ["a", "b", "c", "g", "h"]) {
    assert.match(result.details, new RegExp(`${p}\\/package\\.json`), `should flag ${p}`);
  }
  for (const p of ["d", "e", "f"]) {
    assert.doesNotMatch(result.details, new RegExp(`${p}\\/package\\.json`), `should not flag ${p}`);
  }
  assert.equal(checkNoRawNodeTestGlob(manifests.slice(5)).ok, true);
});

test("checkDependencyBuildersSafe flags npm.cmd / .bin/tsc / shell:true in builder code", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  // Violations live in executable code, not comments.
  const badNpm = write(dir, "packages/cli/scripts/prebuild-deps.mjs", `spawnSync("npm.cmd", ["run", "build"]);\n`);
  const badTsc = write(dir, "packages/host/scripts/prebuild-deps.mjs", `spawnSync(join(root, "node_modules/.bin/tsc"), [...]);\n`);
  const badShell = write(dir, "packages/sessiond/scripts/build-deps.mjs", `spawnSync(cmd, args, { shell: true });\n`);
  const good = write(dir, "packages/agent-worker/scripts/build-deps.mjs", `spawnSync(tsc.command, tsc.args);\n`);
  const badNative = write(dir, "packages/local-authority/scripts/build-native.mjs", `spawnSync("node-gyp.cmd", [], { shell: true });\n`);
  const unrelated = write(dir, "packages/host/scripts/check-boundaries.mjs", `spawnSync("npm.cmd", [], { shell: true });\n`);
  const result = checkDependencyBuildersSafe([badNpm, badTsc, badShell, good, badNative, unrelated]);
  assert.equal(result.ok, false);
  assert.match(result.details, /npm\.cmd/);
  assert.match(result.details.replace(/\\/g, "/"), /local-authority\/scripts\/build-native\.mjs/);
  assert.match(result.details, /\.bin\/tsc/);
  assert.match(result.details, /shell:true/);
  assert.doesNotMatch(result.details, /agent-worker\/scripts\/build-deps\.mjs/);
  assert.doesNotMatch(result.details, /check-boundaries\.mjs/);
  assert.equal(checkDependencyBuildersSafe([good, unrelated]).ok, true);
});

test("checkDependencyBuildersSafe ignores forbidden tokens inside comments", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const body = [
    `// never use npm.cmd, the .bin/tsc shim, or shell: true here`,
    `/* multi-line: spawnSync("npm.cmd") is forbidden */`,
    `const result = spawnSync(tsc.command, tsc.args, { cwd, stdio: "inherit" });`,
  ].join("\n");
  const file = write(dir, "packages/protocol/scripts/build-deps.mjs", body);
  assert.equal(checkDependencyBuildersSafe([file]).ok, true);
});

test("comment stripping preserves URL strings so a same-line violation is seen (F4)", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const body = `const u = "https://x.example/path"; spawnSync("npm.cmd", ["run", "build"]);\n`;
  const file = write(dir, "packages/cli/scripts/prebuild-deps.mjs", body);
  const result = checkDependencyBuildersSafe([file]);
  assert.equal(result.ok, false);
  assert.match(result.details, /npm\.cmd/);
});

test("comment stripping handles escaped quotes and template literals (F4)", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const body = [
    'const s = "escaped \\" quote";',
    "const t = `npm.cmd // not a comment here`;",
    'spawnSync("npm.cmd", []);',
  ].join("\n");
  const file = write(dir, "packages/host/scripts/prebuild-deps.mjs", body);
  const result = checkDependencyBuildersSafe([file]);
  assert.equal(result.ok, false);
  assert.match(result.details, /npm\.cmd/);
});

test("comment stripping does not truncate at // inside a regex literal (F4)", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const body = [
    `const re = /https:\\/\\//;`,
    `spawnSync("npm.cmd", []);`,
  ].join("\n");
  const file = write(dir, "packages/sessiond/scripts/build-deps.mjs", body);
  const result = checkDependencyBuildersSafe([file]);
  assert.equal(result.ok, false);
  assert.match(result.details, /npm\.cmd/);
});

test("comment stripping keeps block comments off the executable scan (F4)", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const body = [
    `/* spawnSync("npm.cmd") */`,
    `/* block with \n newline: shell: true */`,
    `const ok = spawnSync(tsc.command, tsc.args);`,
  ].join("\n");
  const file = write(dir, "packages/pi-sdk-adapter/scripts/build-deps.mjs", body);
  assert.equal(checkDependencyBuildersSafe([file]).ok, true);
});

test("runChecks includes the cross-platform tooling gates", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  write(dir, "scripts/placeholder.mjs", `console.log("x");\n`);
  const result = runChecks(dir);
  const names = result.checks.map((c) => c.name);
  assert.ok(names.includes("no rm -rf in production/test scripts"), JSON.stringify(names));
  assert.ok(names.includes("no shell-dependent node --test glob"), JSON.stringify(names));
  assert.ok(names.includes("dependency builders use safe tool invocation"), JSON.stringify(names));
});

test("runChecks fails on a fixture that shells out to rm -rf", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  write(
    dir,
    "packages/protocol/package.json",
    JSON.stringify({ name: "@fffattiger/pix-protocol", private: true, scripts: { clean: "rm -rf dist" } }),
  );
  const result = runChecks(dir);
  assert.equal(result.ok, false);
  const names = result.failed.map((c) => c.name);
  assert.ok(names.includes("no rm -rf in production/test scripts"), JSON.stringify(names));
});

// ---------------------------------------------------------------------------
// no legacy product name
// ---------------------------------------------------------------------------

// Forbidden brand tokens are assembled from parts so this self-test file does
// not itself contain the contiguous strings the production gate scans for.
const LEGACY_HYPHEN = "pi" + "-web";
const LEGACY_UNDER = "pi" + "_web";
const LEGACY_SPACE_TITLE = "Pi" + " Web";
const LEGACY_SPACE_UPPER = "PI" + " WEB";

test("checkNoLegacyProductName flags every legacy brand casing", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const files = [
    write(dir, "packages/host/src/a.ts", `// brand: ${LEGACY_HYPHEN} host`),
    write(dir, "packages/host/src/b.ts", `const cookie = "${LEGACY_UNDER}_session";`),
    write(dir, "packages/client/src/c.tsx", `const title = "${LEGACY_SPACE_TITLE}";`),
    write(dir, "README.md", `# ${LEGACY_SPACE_UPPER} is legacy`),
    write(dir, "packages/protocol/package.json", `{"name":"@fffattiger/${LEGACY_HYPHEN}-protocol"}`),
    write(dir, "packages/client/public/manifest.webmanifest", `{"name":"${LEGACY_SPACE_TITLE}"}`),
  ];
  const result = checkNoLegacyProductName({ files, rootDir: dir });
  assert.equal(result.ok, false);
  for (const f of ["a.ts", "b.ts", "c.tsx", "README.md", "protocol/package.json", "manifest.webmanifest"]) {
    assert.match(result.details, new RegExp(f));
  }
});

test("checkNoLegacyProductName does not flag upstream Pi concepts", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const files = [
    write(dir, "packages/pi-sdk-adapter/src/a.ts", `import { x } from "@earendil-works/pi-coding-agent";`),
    write(dir, "packages/host/src/config.ts", `const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");`),
    write(dir, "packages/runtime-core/src/ports.ts", `// anti-corruption boundary against Pi SDK`),
    write(dir, "docs/notes.md", `Sessiond lives under ~/.pi/pix/sessiond. The adapter dir is packages/pi-sdk-adapter.`),
  ];
  const result = checkNoLegacyProductName({ files, rootDir: dir });
  assert.equal(result.ok, true, result.details);
});

test("checkNoLegacyProductName excludes historical, legal, generated, and self-test evidence", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const files = [
    write(dir, "docs/migration-ledger.md", `# legacy source: ${LEGACY_HYPHEN} worktrees`),
    write(dir, "THIRD_PARTY_NOTICES.md", `Upstream attribution: ${LEGACY_HYPHEN}`),
    write(dir, "scripts/check-architecture.test.mjs", `const t = "${LEGACY_HYPHEN}";`),
    write(dir, "package-lock.json", `"${LEGACY_HYPHEN}": {}`),
    write(dir, "packages/host/src/clean.ts", `export const ok = 1;`),
  ];
  const result = checkNoLegacyProductName({ files, rootDir: dir });
  assert.equal(result.ok, true, result.details);
});

test("runChecks includes the legacy product name gate", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  write(dir, "scripts/placeholder.mjs", `console.log("x");\n`);
  const result = runChecks(dir);
  const names = result.checks.map((c) => c.name);
  assert.ok(names.includes("Node engine floor"), JSON.stringify(names));
  assert.ok(names.includes("no legacy product name"), JSON.stringify(names));
});

// ---------------------------------------------------------------------------
// runChecks end-to-end on fixture repos
// ---------------------------------------------------------------------------

test("runChecks passes on a clean fixture repo", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  write(dir, "scripts/placeholder.mjs", `console.log("x");\n`);
  const result = runChecks(dir);
  assert.equal(result.ok, true);
  assert.equal(result.failed.length, 0);
});

test("runChecks fails when a workspace package imports next", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  write(
    dir,
    "packages/client/src/page.ts",
    `import { useRouter } from "next/router";\n`,
  );
  write(
    dir,
    "packages/client/package.json",
    JSON.stringify({ name: "@fffattiger/pix-client", private: true }),
  );
  const result = runChecks(dir);
  assert.equal(result.ok, false);
  const names = result.failed.map((c) => c.name);
  assert.ok(names.includes("no next import"), JSON.stringify(names));
});

test("main returns 0 for clean and 1 for violating repos", async (t) => {
  const clean = makeRoot();
  t.after(() => cleanup(clean));
  const bad = makeRoot();
  t.after(() => cleanup(bad));
  write(bad, "next.config.ts", `export default {};\n`);
  const silent = { log() {} };
  assert.equal(await main(clean, silent), 0);
  assert.equal(await main(bad, silent), 1);
});

test("collectFiles skips node_modules, dist, dist-test, coverage and dot-entries", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  write(dir, "node_modules/next/package.json", "{}");
  write(dir, "packages/protocol/dist/index.js", "x");
  write(dir, "packages/protocol/dist-test/index.test.js", "x");
  write(dir, "coverage/lcov.info", "x");
  write(dir, ".hidden/secret.ts", "x");
  write(dir, "packages/protocol/src/index.ts", "export {};");
  const files = collectFiles(dir);
  const rel = files.map((f) => toPosixRelative(dir, f));
  assert.ok(rel.includes("packages/protocol/src/index.ts"));
  for (const bad of [
    "node_modules/next/package.json",
    "packages/protocol/dist/index.js",
    "packages/protocol/dist-test/index.test.js",
    "coverage/lcov.info",
    ".hidden/secret.ts",
  ]) {
    assert.ok(!rel.includes(bad), `should not collect ${bad}`);
  }
});
