// scripts/tool-invocation.mjs
//
// Resolve TypeScript and npm as JavaScript CLIs launched through the current
// Node binary. Windows cannot execute the extensionless `.bin/tsc` shim or
// `.cmd` wrappers via spawnSync({ shell: false }), and `shell: true` breaks
// paths that contain spaces.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Launch TypeScript's JS CLI with the current Node. `workspaceRoot` is the
 * pix monorepo root that owns `node_modules/typescript`.
 */
export function resolveTscInvocation(workspaceRoot, { execPath = process.execPath } = {}) {
  const cli = join(workspaceRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(cli)) {
    throw new Error(`[pix] TypeScript CLI not found: ${cli}; run npm ci`);
  }
  return { command: execPath, args: [cli], shell: false };
}

/**
 * The npm CLI that invoked the current lifecycle script. All production callers
 * run from npm hooks, so require the documented `npm_execpath` contract rather
 * than guessing Node/npm installation layouts. Always launch the JS CLI through
 * the current Node with `shell: false`.
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
