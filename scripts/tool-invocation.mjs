// scripts/tool-invocation.mjs
//
// Resolve TypeScript and npm as JavaScript CLIs launched through the current
// Node binary, so dependency-build scripts never rely on PATH shims (`npm`,
// `npm.cmd`, `.bin/tsc`) or `shell: true`. Windows cannot execute the
// extensionless `.bin/tsc` shim or `.cmd` wrappers via spawn with
// `shell: false`, and `shell: true` breaks paths that contain spaces.
//
// Every returned invocation is `{ command: process.execPath, args: [jsCli],
// shell: false }`: one command to reason about, no argv joining, no PATH
// ambiguity, no shell interpolation. Both resolvers validate that the JS CLI
// is a real, regular file backed by the package it claims to be from, so an
// arbitrary environment-controlled path is never executed.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

/** True when `child` is `parent` itself or strictly beneath it. */
function isWithin(parent, child) {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  const p = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const c = process.platform === "win32" ? child.toLowerCase() : child;
  return c === p || c.startsWith(p);
}

/** True when `path` exists and is a regular file (not a directory/device). */
function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** realpath that yields null instead of throwing for a missing path. */
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Launch TypeScript's JS CLI with the current Node. `workspaceRoot` is the
 * pix monorepo root that owns the hoisted `typescript` package. The CLI path
 * comes from typescript's own package metadata (its `bin.tsc` field), not a
 * hardcoded `node_modules/.bin` layout, and is confined to the resolved
 * TypeScript package root even if a malicious manifest used `../` in its bin
 * target.
 */
export function resolveTscInvocation(workspaceRoot, { execPath = process.execPath } = {}) {
  const requireFromRoot = createRequire(join(workspaceRoot, "package.json"));
  let typescriptPkg;
  try {
    typescriptPkg = requireFromRoot.resolve("typescript/package.json");
  } catch {
    throw new Error(
      `[pix] typescript is not installed at ${workspaceRoot}; run npm ci`,
    );
  }
  const pkgDir = dirname(typescriptPkg);
  const manifest = JSON.parse(readFileSync(typescriptPkg, "utf8"));
  const bin = manifest.bin;
  const target = typeof bin === "string" ? bin : bin && bin.tsc;
  if (typeof target !== "string") {
    throw new Error(
      `[pix] typescript package at ${typescriptPkg} declares no tsc bin`,
    );
  }
  const cli = resolve(pkgDir, target);
  if (!isRegularFile(cli)) {
    throw new Error(`[pix] TypeScript CLI not found: ${cli}; run npm ci`);
  }
  // Confine the bin target to the resolved typescript package root even if
  // the manifest used a `../` escape.
  const pkgReal = safeRealpath(pkgDir);
  const cliReal = safeRealpath(cli);
  if (pkgReal === null || cliReal === null || !isWithin(pkgReal, cliReal)) {
    throw new Error(`[pix] typescript bin target escapes its package: ${cli}`);
  }
  return { command: execPath, args: [cli], shell: false };
}

/**
 * The npm CLI that invoked the current lifecycle script. All production
 * callers run from npm hooks, so use the documented `npm_execpath` contract
 * rather than guessing Node/npm installation layouts or falling back to a
 * PATH `npm`/`npm.cmd`. The JS CLI is launched through the current Node with
 * `shell: false`.
 *
 * The candidate is validated against the real npm package it claims to come
 * from: it must be a regular file whose parent package manifest declares
 * `name: "npm"` with a `bin` entry that resolves to that exact file, so an
 * arbitrary environment-controlled file named `npm-cli.js` is never executed.
 */
export function resolveNpmInvocation({
  execPath = process.execPath,
  env = process.env,
} = {}) {
  const cli = env.npm_execpath;
  if (!cli || !/npm-cli\.js$/i.test(cli) || !isRegularFile(cli)) {
    throw new Error(
      "[pix] npm_execpath does not name an installed npm-cli.js; run this script through npm",
    );
  }
  // npm ships `bin/npm-cli.js`; the package root is its parent's parent.
  const pkgDir = dirname(dirname(cli));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    throw new Error(
      "[pix] npm_execpath is not backed by an npm package; run this script through npm",
    );
  }
  const bin = manifest.bin;
  const npmBin = typeof bin === "string" ? bin : bin && bin.npm;
  if (manifest.name !== "npm" || typeof npmBin !== "string") {
    throw new Error(
      "[pix] npm_execpath is not backed by the npm package; run this script through npm",
    );
  }
  const declared = resolve(pkgDir, npmBin);
  if (safeRealpath(declared) !== safeRealpath(cli)) {
    throw new Error(
      "[pix] npm_execpath does not match the npm package's declared npm bin; run this script through npm",
    );
  }
  return { command: execPath, args: [cli], shell: false };
}
