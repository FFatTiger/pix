import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNpmInvocation, resolveTscInvocation } from "./tool-invocation.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "pix-tools-"));
}

test("resolveTscInvocation uses TypeScript's JS CLI through the current Node", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "node_modules", "typescript", "bin", "tsc");
  mkdirSync(join(cli, ".."), { recursive: true });
  writeFileSync(cli, "");
  const inv = resolveTscInvocation(root, { execPath: "/usr/bin/node" });
  assert.equal(inv.command, "/usr/bin/node");
  assert.deepEqual(inv.args, [cli]);
  assert.equal(inv.shell, false);
});

test("resolveTscInvocation fails closed when typescript is not installed", () => {
  assert.throws(
    () => resolveTscInvocation(join(tmpdir(), "pix-missing-tsc-root")),
    /TypeScript CLI not found/,
  );
});

test("resolveNpmInvocation prefers npm_execpath from the invoking npm", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
