import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeGypInvocation } from "../../../scripts/tool-invocation.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const NATIVE_ROOT = join(PACKAGE_ROOT, "native", "windows");
const TARGET = "win32-x64-msvc";
const OUTPUT_DIR = join(PACKAGE_ROOT, "dist", "native", TARGET);
const OUTPUT_FILE = join(OUTPUT_DIR, "pix_local_authority_windows.node");
const REMOVE_PATHS = join(REPO_ROOT, "scripts", "remove-paths.mjs");

function removeRelative(relativePath, { spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const result = spawnSyncImpl(
    process.execPath,
    [REMOVE_PATHS, relativePath],
    { cwd: PACKAGE_ROOT, env, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[pix-local-authority] failed to remove ${relativePath}`);
  }
}

export function buildWindowsNative({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "win32") return { built: false, reason: "not-windows" };
  if (arch !== "x64") {
    throw new Error(`[pix-local-authority] unsupported Windows native target: ${platform}-${arch}`);
  }
  const invocation = resolveNodeGypInvocation({ env });
  removeRelative("native/windows/build", { spawnSyncImpl, env });
  const result = spawnSyncImpl(
    invocation.command,
    [...invocation.args, "rebuild", "--release", "--directory", NATIVE_ROOT],
    { cwd: PACKAGE_ROOT, env, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[pix-local-authority] native build failed with exit ${result.status ?? "unknown"}`);
  }
  const built = join(NATIVE_ROOT, "build", "Release", "pix_local_authority_windows.node");
  if (!existsSync(built)) throw new Error("[pix-local-authority] native build produced no binding");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  copyFileSync(built, OUTPUT_FILE);
  return { built: true, target: TARGET, output: OUTPUT_FILE };
}

function main() {
  try {
    const result = buildWindowsNative();
    if (!result.built) console.log("[pix-local-authority] native build skipped (non-Windows)");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "[pix-local-authority] native build failed");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
