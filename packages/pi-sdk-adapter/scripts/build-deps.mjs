// scripts/build-deps.mjs
//
// Build this package's workspace dependencies in dependency order by invoking
// `tsc` directly against each dependency's tsconfig — WITHOUT re-entering the
// npm workspace runner (`npm run build --workspace …`). The root
// run-workspaces runner iterates packages in glob (alphabetical) order, so
// pi-sdk-adapter is built before runtime-core and runtime-contract-tests;
// this script ensures both dependencies' dist/ exist first, in the right
// order, using a single tsc invocation per package.
//
// Order: runtime-core first (it has no workspace deps), then
// runtime-contract-tests (which type-checks against runtime-core's dist).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTscInvocation } from "../../../scripts/tool-invocation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const workspaceRoot = join(packageRoot, "..", "..");

const deps = [
  { name: "@fffattiger/pix-runtime-core", dir: join(workspaceRoot, "packages/runtime-core") },
  { name: "@fffattiger/pix-runtime-contract-tests", dir: join(workspaceRoot, "packages/runtime-contract-tests") },
];

// Launch tsc as a JS CLI through the current Node — never the `.bin/tsc`
// shim and never `shell: true`.
const tsc = resolveTscInvocation(workspaceRoot);

for (const dep of deps) {
  const tsconfig = join(dep.dir, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    throw new Error(`[pi-sdk-adapter] dependency tsconfig not found: ${tsconfig}`);
  }
  const result = spawnSync(tsc.command, [...tsc.args, "-p", tsconfig], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[pi-sdk-adapter] failed to build dependency ${dep.name} (tsc exit ${result.status})`);
  }
}
