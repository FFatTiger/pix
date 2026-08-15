// scripts/sync-version.test.mjs
// Tests for the REL1 single-source-of-truth version script. Uses only Node
// builtins and temporary fixture directories; never touches the real repo.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersions, collectWorkspaceManifests, resolveCanonicalVersion, writeVersions } from "./sync-version.mjs";

function makeRoot({ canonical = "0.1.0", packages = { a: "0.1.0", b: "0.1.0" } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pix-ver-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pix-root", version: canonical, private: true, workspaces: ["packages/*"] }));
  for (const [name, version] of Object.entries(packages)) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name: `@pix/${name}`, version }));
  }
  return root;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("resolveCanonicalVersion reads the root version", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.equal(resolveCanonicalVersion(root), "0.1.0");
});

test("checkVersions passes when every package matches the canonical version", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  const result = checkVersions(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, true);
  assert.deepEqual(result.offenders, []);
});

test("checkVersions fails and lists offenders when a package version drifts", (t) => {
  const root = makeRoot({ packages: { a: "0.1.0", b: "0.2.0" } });
  t.after(() => cleanup(root));
  const result = checkVersions(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, false);
  assert.equal(result.offenders.length, 1);
  assert.match(result.offenders[0], /packages[\\/]b[\\/]package\.json: version "0\.2\.0" !== canonical 0\.1\.0/);
});

test("writeVersions normalizes drifted package versions to the canonical value and persists", (t) => {
  const root = makeRoot({ packages: { a: "0.1.0", b: "0.0.0" } });
  t.after(() => cleanup(root));
  const result = writeVersions(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, true);
  assert.deepEqual(result.offenders, []);
  const b = JSON.parse(readFileSync(join(root, "packages", "b", "package.json"), "utf8"));
  assert.equal(b.version, "0.1.0");
});

test("writeVersions is idempotent on an already-consistent tree", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  writeVersions(root, collectWorkspaceManifests(root));
  const result = checkVersions(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, true);
});

test("fixture writes produce readable manifests", (t) => {
  const root = makeRoot();
  t.after(() => cleanup(root));
  assert.equal(existsSync(join(root, "packages", "a", "package.json")), true);
});
