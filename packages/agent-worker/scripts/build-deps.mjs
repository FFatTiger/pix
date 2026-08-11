// scripts/build-deps.mjs
//
// Build this package's workspace dependencies in dependency order by invoking
// `tsc` directly against each dependency's tsconfig — WITHOUT re-entering the
// npm workspace runner. The root run-workspaces runner iterates packages in
// glob (alphabetical) order, so agent-worker (a) is built before protocol (p),
// pi-sdk-adapter (p) and runtime-core (r); this script ensures every
// dependency's dist/ exists first, in the right order, using a single tsc
// invocation per package.
//
// Order: runtime-core and protocol (no workspace deps between them), then
// pi-sdk-adapter (which type-checks against runtime-core's dist).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const workspaceRoot = join(packageRoot, "..", "..");

const deps = [
  { name: "@fffattiger/pix-runtime-core", dir: join(workspaceRoot, "packages/runtime-core") },
  { name: "@fffattiger/pix-protocol", dir: join(workspaceRoot, "packages/protocol") },
  { name: "@fffattiger/pix-pi-sdk-adapter", dir: join(workspaceRoot, "packages/pi-sdk-adapter") },
  // Test-only oracle: agent-worker tests project deltas through the REAL
  // sessiond SnapshotProjection to avoid a duplicated projection implementation.
  { name: "@fffattiger/pix-sessiond", dir: join(workspaceRoot, "packages/sessiond") },
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
    throw new Error(`[agent-worker] dependency tsconfig not found: ${tsconfig}`);
  }
  const { command, shell } = resolveTsc();
  const result = spawnSync(command, ["-p", tsconfig], {
    cwd: workspaceRoot,
    stdio: "inherit",
    shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[agent-worker] failed to build dependency ${dep.name} (tsc exit ${result.status})`);
  }
}
