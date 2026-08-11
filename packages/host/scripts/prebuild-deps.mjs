// Pre-build the workspace packages the Host's TypeScript depends on, in
// dependency order. The Host sorts after protocol/sessiond alphabetically in
// some orderings, so without this hook a fresh standalone build could compile
// the Host before protocol/sessiond (and transitive runtime-core) dist exists.
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
  "packages/sessiond",
];

for (const target of targets) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build", "--workspace", target],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`[pix-host] prebuild failed for ${target}`);
    process.exit(result.status ?? 1);
  }
}
