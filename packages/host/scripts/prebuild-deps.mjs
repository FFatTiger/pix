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
import { resolveNpmInvocation } from "../../../scripts/tool-invocation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

const targets = [
  "packages/protocol",
  "packages/runtime-core",
  "packages/sessiond",
  // D3B-R1B: composition imports four pi-sdk-adapter catalog subpaths.
  "packages/pi-sdk-adapter",
];

// Launch the invoking npm as a JS CLI through the current Node — never
// `npm`/`npm.cmd` from PATH and never `shell: true`.
const npm = resolveNpmInvocation();

for (const target of targets) {
  const result = spawnSync(npm.command, [...npm.args, "run", "build", "--workspace", target], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[pix-host] failed to start npm for ${target}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[pix-host] prebuild failed for ${target}`);
    process.exit(result.status ?? 1);
  }
}
