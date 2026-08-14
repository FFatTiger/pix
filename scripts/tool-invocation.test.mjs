// scripts/tool-invocation.test.mjs
// Tests for the safe npm/tsc JS-CLI resolvers. Uses only Node builtins and
// temporary fixture roots, so it runs with zero installed dependencies.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveNpmInvocation, resolveTscInvocation } from "./tool-invocation.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "pix-tools-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
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
    assert.throws(
      () => resolveTscInvocation(root),
      /typescript is not installed/,
    );
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

test("resolveNpmInvocation uses npm_execpath from the invoking npm", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const cli = join(root, "npm-cli.js");
  writeFileSync(cli, "");
  const inv = resolveNpmInvocation({
    execPath: "/usr/bin/node",
    env: { npm_execpath: cli },
  });
  assert.equal(inv.command, "/usr/bin/node");
  assert.deepEqual(inv.args, [cli]);
  assert.equal(inv.shell, false);
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
