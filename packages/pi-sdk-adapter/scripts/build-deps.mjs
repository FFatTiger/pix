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

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const workspaceRoot = join(packageRoot, "..", "..");

const deps = [
  { name: "@fffattiger/pix-runtime-core", dir: join(workspaceRoot, "packages/runtime-core") },
  { name: "@fffattiger/pix-runtime-contract-tests", dir: join(workspaceRoot, "packages/runtime-contract-tests") },
];

/** Resolve the tsc executable: prefer the workspace-local .bin, then PATH. */
function resolveTsc() {
  const localBin = join(workspaceRoot, "node_modules", ".bin", "tsc");
  if (existsSync(localBin)) return { command: localBin, shell: false };
  return { command: "tsc", shell: true };
}

for (const dep of deps) {
  const tsconfig = join(dep.dir, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    throw new Error(`[pi-sdk-adapter] dependency tsconfig not found: ${tsconfig}`);
  }
  const { command, shell } = resolveTsc();
  const result = spawnSync(command, ["-p", tsconfig], {
    cwd: workspaceRoot,
    stdio: "inherit",
    shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[pi-sdk-adapter] failed to build dependency ${dep.name} (tsc exit ${result.status})`);
  }
}
