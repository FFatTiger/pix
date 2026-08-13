// scripts/build-deps.mjs
//
// Ensure workspace dependencies that sessiond needs at runtime/typecheck are
// built without re-entering the npm workspace runner (which would recurse
// through agent-worker → sessiond). Invokes `tsc` directly against each
// dependency's tsconfig.
//
// Order: runtime-core + protocol (no mutual deps), then agent-worker which
// itself needs pi-sdk-adapter. We deliberately do NOT build sessiond here.
// agent-worker's own prebuild already builds sessiond for its test oracle;
// sessiond only needs agent-worker's dist for worker-main resolution.

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
  { name: "@fffattiger/pix-protocol", dir: join(workspaceRoot, "packages/protocol") },
  { name: "@fffattiger/pix-pi-sdk-adapter", dir: join(workspaceRoot, "packages/pi-sdk-adapter") },
  // agent-worker dist is required so createRequire/import.meta.resolve can
  // locate worker-main. Building it via tsc (not npm run build) avoids the
  // agent-worker prebuild that would re-enter sessiond and recurse.
  { name: "@fffattiger/pix-agent-worker", dir: join(workspaceRoot, "packages/agent-worker") },
];

const tsc = resolveTscInvocation(workspaceRoot);

for (const dep of deps) {
  const tsconfig = join(dep.dir, "package.json");
  if (!existsSync(tsconfig)) {
    throw new Error(`[sessiond] dependency package not found: ${dep.dir}`);
  }
  const distEntry =
    dep.name === "@fffattiger/pix-agent-worker"
      ? join(dep.dir, "dist/composition/worker-main.js")
      : join(dep.dir, "dist/index.js");
  // Skip rebuild when dist already exists (root build / parallel packages).
  // Always rebuild when missing so typecheck/test stay green after clean.
  if (existsSync(distEntry)) continue;

  // agent-worker depends on pi-sdk-adapter/protocol/runtime-core dist; those
  // are earlier in the list. Invoke tsc only — never npm run build.
  const result = spawnSync(tsc.command, [...tsc.args, "-p", join(dep.dir, "tsconfig.json")], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[sessiond] failed to build dependency ${dep.name} (tsc exit ${result.status})`);
  }
}
