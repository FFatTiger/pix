import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const STATE_EXPORTS = [
  // error model
  "LocalAuthorityError",
  // predicates
  "isRecord",
  "isSafeInteger",
  "isIsoTimestamp",
  "hasControlChar",
  "isValidInstanceId",
  "isAbsoluteCanonicalShape",
  // canonical paths
  "canonicalizeAbsolutePath",
  // identity / principal
  "posixFileIdentity",
  "currentPrincipal",
  "isOwnedByCurrentUser",
  // secure directory
  "ensurePrivateDirectory",
  // state documents
  "readStateDocument",
  "writeStateDocument",
  // lifetime lock
  "isPidAlive",
  "readLifetimeLock",
  "acquireLifetimeLock",
  "releaseLifetimeLock",
  // backend factories
  "createPosixSecureStateBackend",
  "createSecureStateBackend",
].sort();

test("state surface: exact export set (no raw fs/os APIs leaked)", async () => {
  const state = await import("../dist/state/index.js");
  const actual = Object.keys(state).filter((k) => k !== "default").sort();
  assert.deepEqual(actual, STATE_EXPORTS, "state surface must be exactly the documented set");
});

test("top-level index re-exports the full state surface", async () => {
  const root = await import("../dist/index.js");
  const state = await import("../dist/state/index.js");
  for (const key of Object.keys(state).filter((k) => k !== "default")) {
    assert.equal(key in root, true, `top-level index must export ${key}`);
  }
});

test("contracts.ts is platform-neutral: zero node: / external imports", () => {
  const contractsSource = readFileSync(join(packageRoot, "src", "state", "contracts.ts"), "utf8");
  for (const match of contractsSource.matchAll(/from\s+["']([^"']+)["']/g)) {
    assert.fail(`contracts.ts must not import anything, found "${match[1]}"`);
  }
  // The POSIX implementation may import only node builtins + relative contracts.
  const posixSource = readFileSync(join(packageRoot, "src", "state", "posix.ts"), "utf8");
  for (const match of posixSource.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    const ok = specifier.startsWith("node:") || specifier.startsWith("./");
    assert.ok(ok, `posix.ts imports undeclared specifier "${specifier}"`);
  }
  const platformSource = readFileSync(join(packageRoot, "src", "state", "platform.ts"), "utf8");
  for (const match of platformSource.matchAll(/from\s+["']([^"']+)["']/g)) {
    assert.equal(match[1].startsWith("./"), true, `platform.ts imports non-relative specifier "${match[1]}"`);
  }
  // The native loader may additionally use node:module and node:url, both
  // builtins; no external/runtime dependency is allowed.
  const nativeLoaderSource = readFileSync(join(packageRoot, "src", "state", "native-windows.ts"), "utf8");
  for (const match of nativeLoaderSource.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    assert.equal(specifier.startsWith("node:") || specifier.startsWith("./"), true, `native-windows.ts imports undeclared specifier "${specifier}"`);
  }
});

test("manifest: zero runtime dependencies (dependency-free workspace)", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "no runtime dependencies");
  assert.equal(manifest.name, "@fffattiger/pix-local-authority");
  assert.equal(manifest.exports["./state"].import, "./dist/state/index.js");
  assert.ok(!("engines" in manifest) || manifest.engines.node.includes("22"), "engine aligned with workspace");
});

test("boundary script exists and can run", () => {
  const boundary = join(packageRoot, "scripts", "check-boundaries.mjs");
  assert.ok(readFileSync(boundary, "utf8").length > 0, "boundary script present");
});
