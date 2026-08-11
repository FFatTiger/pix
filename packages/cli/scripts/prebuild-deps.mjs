// Pre-build the workspace packages the CLI's TypeScript depends on, in
// dependency order. The CLI sorts before its dependencies alphabetically, so
// without this hook a fresh `npm ci && npm run build` compiles the CLI before
// host/sessiond dist (and their transitive protocol/runtime-core dist) exist.
//
// Each target is built by workspace PATH (not package name) so this stays
// correct regardless of package-name changes, and none of these packages
// declares its own prebuild, so there is no recursion.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

const targets = [
  "packages/protocol",
  "packages/runtime-core",
  "packages/host",
  "packages/sessiond",
];

for (const target of targets) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "--workspace", target],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`[pix] prebuild failed for ${target}`);
    process.exit(result.status ?? 1);
  }
}
