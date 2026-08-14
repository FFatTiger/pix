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
// ambiguity, no shell interpolation.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Launch TypeScript's JS CLI with the current Node. `workspaceRoot` is the
 * pix monorepo root that owns the hoisted `typescript` package. The CLI path
 * comes from typescript's own package metadata (its `bin.tsc` field), not a
 * hardcoded `node_modules/.bin` layout, so it keeps working across install
 * layouts and never touches the `.bin/tsc` shim.
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
  const manifest = JSON.parse(readFileSync(typescriptPkg, "utf8"));
  const bin = manifest.bin;
  const target = typeof bin === "string" ? bin : bin && bin.tsc;
  if (typeof target !== "string") {
    throw new Error(
      `[pix] typescript package at ${typescriptPkg} declares no tsc bin`,
    );
  }
  const cli = join(dirname(typescriptPkg), target);
  if (!existsSync(cli)) {
    throw new Error(`[pix] TypeScript CLI not found: ${cli}; run npm ci`);
  }
  return { command: execPath, args: [cli], shell: false };
}

/**
 * The npm CLI that invoked the current lifecycle script. All production
 * callers run from npm hooks, so use the documented `npm_execpath` contract
 * rather than guessing Node/npm installation layouts or falling back to a
 * PATH `npm`/`npm.cmd`. The JS CLI is always launched through the current
 * Node with `shell: false`.
 */
export function resolveNpmInvocation({
  execPath = process.execPath,
  env = process.env,
} = {}) {
  const cli = env.npm_execpath;
  if (cli && /npm-cli\.js$/i.test(cli) && existsSync(cli)) {
    return { command: execPath, args: [cli], shell: false };
  }
  throw new Error(
    "[pix] npm_execpath does not name an installed npm-cli.js; run this script through npm",
  );
}
