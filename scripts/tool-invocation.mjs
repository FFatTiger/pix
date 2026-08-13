// scripts/tool-invocation.mjs
//
// Resolve TypeScript and npm as JavaScript CLIs launched through the current
// Node binary. Windows cannot execute the extensionless `.bin/tsc` shim or
// `.cmd` wrappers via spawnSync({ shell: false }), and `shell: true` breaks
// paths that contain spaces.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * The npm CLI paired with the current Node, as `{ command, args, shell }`.
 * Always `shell: false`. Prefer `npm-cli.js` over `.cmd` / PATH shims.
 */
export function resolveNpmInvocation({
  execPath = process.execPath,
  env = process.env,
} = {}) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /npm-cli\.js$/i.test(npmExecPath) && existsSync(npmExecPath)) {
    return { command: execPath, args: [npmExecPath], shell: false };
  }
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const cli of candidates) {
    if (existsSync(cli)) return { command: execPath, args: [cli], shell: false };
  }
  const sibling = join(nodeDir, "npm");
  if (existsSync(sibling)) {
    return { command: sibling, args: [], shell: false };
  }
  throw new Error(
    `[pix] cannot resolve npm-cli.js next to ${execPath}; run via npm or install Node with a bundled npm`,
  );
}
