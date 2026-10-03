// scripts/sync-version.test.mjs
// Tests for the REL1 single-source-of-truth version script. Uses only Node
// builtins and temporary fixture directories; never touches the real repo.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAll, checkInternalRefs, checkVersions, collectInternalRefs, collectWorkspaceManifests, collectWorkspaceNames, resolveCanonicalVersion, writeVersions } from "./sync-version.mjs";

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

test("collectInternalRefs lists only refs whose name is a known workspace package", () => {
  const names = new Set(["@pix/a", "@pix/b"]);
  const manifest = {
    dependencies: { "@pix/a": "0.1.0", zod: "4.3.6" },
    devDependencies: { "@pix/b": "file:../b", typescript: "^5" },
    peerDependencies: { react: "^19" },
  };
  assert.deepEqual(collectInternalRefs(manifest, names), [
    { section: "dependencies", name: "@pix/a", specifier: "0.1.0" },
    { section: "devDependencies", name: "@pix/b", specifier: "file:../b" },
  ]);
});

test("checkInternalRefs flags a stale exact internal dependency ref", (t) => {
  const root = makeRoot({ canonical: "0.2.0", packages: { a: "0.2.0", b: "0.2.0" } });
  t.after(() => cleanup(root));
  const consumer = join(root, "packages", "b", "package.json");
  writeFileSync(consumer, JSON.stringify({ name: "@pix/b", version: "0.2.0", dependencies: { "@pix/a": "0.1.0" } }));
  const result = checkInternalRefs(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, false);
  assert.equal(result.offenders.length, 1);
  assert.match(result.offenders[0], /dependencies\.@pix\/a ref "0\.1\.0" !== canonical 0\.2\.0/);
  assert.equal(checkAll(root).ok, false);
});

test("checkInternalRefs exempts path refs but flags range refs", (t) => {
  const root = makeRoot({ canonical: "0.2.0", packages: { a: "0.2.0", b: "0.2.0" } });
  t.after(() => cleanup(root));
  const consumer = join(root, "packages", "b", "package.json");
  writeFileSync(consumer, JSON.stringify({
    name: "@pix/b",
    version: "0.2.0",
    dependencies: { "@pix/a": "workspace:^" },
    devDependencies: { "@pix/a": "file:../a" },
    optionalDependencies: { "@pix/a": "^0.2.0" },
  }));
  const result = checkInternalRefs(root, collectWorkspaceManifests(root));
  assert.deepEqual(result.offenders.map((o) => o.replace(/^.*package\.json: /, "")), [
    `optionalDependencies.@pix/a ref "^0.2.0" !== canonical 0.2.0`,
  ]);
});

test("writeVersions rewrites exact internal refs and leaves external deps/path refs/private untouched", (t) => {
  const root = makeRoot({ canonical: "0.2.0", packages: { a: "0.2.0", b: "0.1.0" } });
  t.after(() => cleanup(root));
  const consumer = join(root, "packages", "b", "package.json");
  writeFileSync(consumer, JSON.stringify({
    name: "@pix/b",
    version: "0.1.0",
    dependencies: { "@pix/a": "0.1.0", zod: "4.3.6" },
    devDependencies: { "@pix/a": "file:../a" },
    private: true,
  }));
  const result = writeVersions(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, true);
  const persisted = JSON.parse(readFileSync(consumer, "utf8"));
  assert.equal(persisted.version, "0.2.0");
  assert.equal(persisted.dependencies["@pix/a"], "0.2.0");
  assert.equal(persisted.dependencies.zod, "4.3.6");
  assert.equal(persisted.devDependencies["@pix/a"], "file:../a");
  assert.equal(persisted.private, true);
});

test("writeVersions leaves non-exact internal refs for check to flag (fail closed)", (t) => {
  const root = makeRoot({ canonical: "0.2.0", packages: { a: "0.2.0", b: "0.2.0" } });
  t.after(() => cleanup(root));
  const consumer = join(root, "packages", "b", "package.json");
  writeFileSync(consumer, JSON.stringify({ name: "@pix/b", version: "0.2.0", dependencies: { "@pix/a": "~0.1.0" } }));
  const result = writeVersions(root, collectWorkspaceManifests(root));
  assert.equal(result.ok, false);
  const persisted = JSON.parse(readFileSync(consumer, "utf8"));
  assert.equal(persisted.dependencies["@pix/a"], "~0.1.0");
});
