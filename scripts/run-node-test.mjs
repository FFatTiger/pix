// scripts/run-node-test.mjs
//
// Expand a test glob with Node's cross-platform glob implementation, fail if
// nothing matches, then pass an explicit sorted file list to `node --test`.
// Node 22.19 expands test globs itself but intentionally exits 0 for an empty
// match, so this thin wrapper keeps the repository's fail-closed CI policy.

import { spawnSync } from "node:child_process";
import { globSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error("usage: node scripts/run-node-test.mjs <glob> [node-test-options...]");
  console.error("       node scripts/run-node-test.mjs \"scripts/**/*.test.mjs\" --test-name-pattern=helper");
}

export function discoverTestFiles(cwd, pattern) {
  return globSync(pattern, { cwd, withFileTypes: false })
    .sort((left, right) => left.localeCompare(right))
    .map((file) => resolve(cwd, file));
}

export function main(argv = process.argv.slice(2), options = {}) {
  const pattern = argv[0];
  if (!pattern) {
    usage();
    return 2;
  }
  const cwd = options.cwd ?? process.cwd();
  const files = discoverTestFiles(cwd, pattern);
  if (files.length === 0) {
    console.error(`[pix] no test files matched ${JSON.stringify(pattern)} in ${cwd}`);
    return 1;
  }
  const nodeTestArgs = argv.slice(1);
  const result = (options.spawnSyncImpl ?? spawnSync)(process.execPath, ["--test", ...nodeTestArgs, ...files], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[pix] failed to start node --test: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
      process.exitCode = main();
    }
  } catch {
    /* not the main module */
  }
}
