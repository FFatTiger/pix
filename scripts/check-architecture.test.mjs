// scripts/check-architecture.test.mjs
// Tests for the architecture gate. Builds tiny fixture repos in a temp dir
// (with and without violations) and asserts the checks fire exactly where they
// should. Uses only Node builtins.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkBinTargets,
  checkDependencyBuildersSafe,
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
    JSON.stringify({ name: "fixture", version: "0.0.0", private: true, workspaces: ["packages/*"] }),
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

test("checkNoRmRfInScripts flags rm -rf in any manifest script", () => {
  const manifests = [
    { path: "a/package.json", manifest: { scripts: { clean: "rm -rf dist dist-test" } } },
    { path: "b/package.json", manifest: { scripts: { build: "rm -r out && tsc" } } },
    { path: "c/package.json", manifest: { scripts: { clean: "node ../../scripts/remove-paths.mjs dist" } } },
    { path: "d/package.json", manifest: { scripts: { test: "echo ok" } } },
  ];
  const result = checkNoRmRfInScripts(manifests);
  assert.equal(result.ok, false);
  assert.match(result.details, /a\/package\.json/);
  assert.match(result.details, /b\/package\.json/);
  assert.doesNotMatch(result.details, /c\/package\.json/);
  assert.doesNotMatch(result.details, /d\/package\.json/);
  assert.equal(checkNoRmRfInScripts(manifests.slice(2)).ok, true);
});

test("checkNoRawNodeTestGlob flags shell-dependent node --test globs", () => {
  const manifests = [
    { path: "a/package.json", manifest: { scripts: { test: `node --test 'scripts/**/*.test.mjs'` } } },
    { path: "b/package.json", manifest: { scripts: { test: `node --test "dist-test/**/*.test.js"` } } },
    { path: "c/package.json", manifest: { scripts: { test: `node --test test/*.test.mjs` } } },
    { path: "d/package.json", manifest: { scripts: { test: `node scripts/run-node-test.mjs "scripts/**/*.test.mjs"` } } },
    { path: "e/package.json", manifest: { scripts: { test: `node --test a.test.mjs b.test.mjs` } } },
    { path: "f/package.json", manifest: { scripts: { test: `node --test` } } },
  ];
  const result = checkNoRawNodeTestGlob(manifests);
  assert.equal(result.ok, false);
  assert.match(result.details, /a\/package\.json/);
  assert.match(result.details, /b\/package\.json/);
  assert.match(result.details, /c\/package\.json/);
  assert.doesNotMatch(result.details, /d\/package\.json/);
  assert.doesNotMatch(result.details, /e\/package\.json/);
  assert.doesNotMatch(result.details, /f\/package\.json/);
  assert.equal(checkNoRawNodeTestGlob(manifests.slice(3)).ok, true);
});

test("checkDependencyBuildersSafe flags npm.cmd / .bin/tsc / shell:true in builder code", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  // Violations live in executable code, not comments.
  const badNpm = write(dir, "packages/cli/scripts/prebuild-deps.mjs", `spawnSync("npm.cmd", ["run", "build"]);\n`);
  const badTsc = write(dir, "packages/host/scripts/prebuild-deps.mjs", `spawnSync(join(root, "node_modules/.bin/tsc"), [...]);\n`);
  const badShell = write(dir, "packages/sessiond/scripts/build-deps.mjs", `spawnSync(cmd, args, { shell: true });\n`);
  const good = write(dir, "packages/agent-worker/scripts/build-deps.mjs", `spawnSync(tsc.command, tsc.args);\n`);
  const unrelated = write(dir, "packages/host/scripts/check-boundaries.mjs", `spawnSync("npm.cmd", [], { shell: true });\n`);
  const result = checkDependencyBuildersSafe([badNpm, badTsc, badShell, good, unrelated]);
  assert.equal(result.ok, false);
  assert.match(result.details, /npm\.cmd/);
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

test("checkNoLegacyProductName excludes migration-ledger and the gate self-test", (t) => {
  const dir = makeRoot();
  t.after(() => cleanup(dir));
  const files = [
    write(dir, "docs/migration-ledger.md", `# legacy source: ${LEGACY_HYPHEN} worktrees`),
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
  const rel = files.map((f) => f.slice(dir.length + 1));
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
