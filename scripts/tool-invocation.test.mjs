// scripts/tool-invocation.test.mjs
// Tests for the safe npm/tsc JS-CLI resolvers. Uses only Node builtins and
// temporary fixture roots, so it runs with zero installed dependencies.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveNodeGypInvocation, resolveNpmInvocation, resolveTscInvocation } from "./tool-invocation.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "pix-tools-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Build a realistic npm package at `root/node_modules/npm` with bin/npm-cli.js. */
function addNpmPackage(root, { withNodeGyp = false } = {}) {
  const pkgDir = join(root, "node_modules", "npm");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  const dependencies = withNodeGyp ? { "node-gyp": "^12.3.0" } : undefined;
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" }, ...(dependencies ? { dependencies } : {}) }));
  const cli = join(pkgDir, "bin", "npm-cli.js");
  writeFileSync(cli, "");
  if (withNodeGyp) {
    const gypDir = join(pkgDir, "node_modules", "node-gyp");
    mkdirSync(join(gypDir, "bin"), { recursive: true });
    writeFileSync(join(gypDir, "package.json"), JSON.stringify({ name: "node-gyp", bin: { "node-gyp": "bin/node-gyp.js" } }));
    writeFileSync(join(gypDir, "bin", "node-gyp.js"), "");
  }
  return cli;
}

test("resolveTscInvocation resolves typescript's JS CLI from package metadata", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const pkgDir = join(root, "node_modules", "typescript");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: { tsc: "./bin/tsc" } }));
  const cli = join(pkgDir, "bin", "tsc");
  writeFileSync(cli, "");
  const inv = resolveTscInvocation(root, { execPath: "/usr/bin/node" });
  assert.equal(inv.command, "/usr/bin/node");
  // require.resolve returns the canonical (/private/var) form of the path on
  // macOS, so compare against the realpath of the fixture CLI.
  assert.deepEqual(inv.args, [realpathSync(cli)]);
  assert.equal(inv.shell, false);
});

test("resolveTscInvocation fails closed when typescript is not installed", () => {
  const root = makeRoot();
  try {
    assert.throws(() => resolveTscInvocation(root), /typescript is not installed/);
  } finally {
    cleanup(root);
  }
});

test("resolveTscInvocation fails closed when typescript declares no tsc bin", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const pkgDir = join(root, "node_modules", "typescript");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: { tsserver: "./bin/tsserver" } }));
  assert.throws(() => resolveTscInvocation(root), /declares no tsc bin/);
});

test("resolveTscInvocation fails closed when the tsc bin file is missing", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const pkgDir = join(root, "node_modules", "typescript");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: { tsc: "./bin/tsc" } }));
  assert.throws(() => resolveTscInvocation(root), /TypeScript CLI not found/);
});

test("resolveTscInvocation rejects a bin target that escapes the package root", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const pkgDir = join(root, "node_modules", "typescript");
  mkdirSync(pkgDir, { recursive: true });
  // Malicious `../` in the manifest's bin target pointing outside the package.
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ bin: { tsc: "../evil.js" } }));
  writeFileSync(join(root, "node_modules", "evil.js"), "");
  assert.throws(() => resolveTscInvocation(root), /escapes its package/);
});

test("resolveNpmInvocation uses npm_execpath validated against the npm package", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const cli = addNpmPackage(root);
  const inv = resolveNpmInvocation({
    execPath: "/usr/bin/node",
    env: { npm_execpath: cli },
  });
  assert.equal(inv.command, "/usr/bin/node");
  assert.deepEqual(inv.args, [cli]);
  assert.equal(inv.shell, false);
});

test("resolveNodeGypInvocation uses npm's declared bundled JS CLI", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const npmCli = addNpmPackage(root, { withNodeGyp: true });
  const inv = resolveNodeGypInvocation({ execPath: "/usr/bin/node", env: { npm_execpath: npmCli } });
  assert.equal(inv.command, "/usr/bin/node");
  assert.equal(inv.args[0], realpathSync(join(root, "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js")));
  assert.equal(inv.shell, false);
});

test("resolveNodeGypInvocation fails closed when npm does not declare node-gyp", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const npmCli = addNpmPackage(root);
  assert.throws(
    () => resolveNodeGypInvocation({ env: { npm_execpath: npmCli } }),
    /does not declare its bundled node-gyp/,
  );
});

test("resolveNpmInvocation rejects direct execution outside npm", () => {
  assert.throws(
    () => resolveNpmInvocation({ execPath: "/usr/bin/node", env: {} }),
    /run this script through npm/,
  );
});

test("resolveNpmInvocation rejects a non npm-cli.js npm_execpath", () => {
  assert.throws(
    () => resolveNpmInvocation({ execPath: "/usr/bin/node", env: { npm_execpath: "npm.cmd" } }),
    /run this script through npm/,
  );
});

test("resolveNpmInvocation rejects a directory named npm-cli.js", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  mkdirSync(join(root, "npm-cli.js"), { recursive: true });
  assert.throws(
    () => resolveNpmInvocation({ execPath: "/usr/bin/node", env: { npm_execpath: join(root, "npm-cli.js") } }),
    /run this script through npm/,
  );
});

test("resolveNpmInvocation rejects a stray file named npm-cli.js with no npm package", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const cli = join(root, "npm-cli.js");
  writeFileSync(cli, "");
  assert.throws(
    () => resolveNpmInvocation({ execPath: "/usr/bin/node", env: { npm_execpath: cli } }),
    /not backed by an npm package|run this script through npm/,
  );
});

test("resolveNpmInvocation rejects an npm package whose bin does not match npm_execpath", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const pkgDir = join(root, "node_modules", "npm");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  // Package claims bin.npm points elsewhere than the actual npm_execpath file.
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "npm", bin: { npm: "bin/other.js" } }));
  const cli = join(pkgDir, "bin", "npm-cli.js");
  writeFileSync(cli, "");
  assert.throws(
    () => resolveNpmInvocation({ execPath: "/usr/bin/node", env: { npm_execpath: cli } }),
    /does not match the npm package's declared npm bin/,
  );
});
