// scripts/run-workspaces.mjs
//
// Cross-platform runner for `npm run <script>` across every workspace package,
// implemented as `npm run <script> --workspaces --if-present`.
//
// Why a wrapper at all: with zero real workspace package.json files, plain
// `npm run <script> --workspaces` fails with "No workspaces found!" (exit 1),
// which would break root `build`/`typecheck`/`test` until B1 lands. This
// wrapper instead:
//
//   - reads the root manifest's `workspaces` patterns;
//   - discovers the directories that actually contain a parseable package.json;
//   - with no workspaces, prints a short note and exits 0;
//   - otherwise launches the validated npm JS CLI from tool-invocation.mjs
//     (`process.execPath` + `npm-cli.js`, `shell: false`; no npm.cmd / PATH
//     / `shell:true` fallback) as `npm run <script> --workspaces --if-present`.
//
// The root package's own script of the same name is never executed:
// `--workspaces` restricts npm to the workspace directories.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmInvocation } from "./tool-invocation.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Expand a single workspace pattern into directories that contain a
 * package.json. Supported forms mirror npm: `packages/*` (immediate
 * children), `packages/**` (recursive), and literal paths. Negations (`!`)
 * are not supported by npm either and are ignored.
 */
export function expandPattern(rootDir, pattern) {
  if (!pattern || pattern.startsWith("!")) return [];
  const base = join(rootDir, pattern.slice(0, -3));
  if (pattern.endsWith("/**")) {
    const out = [];
    if (hasManifest(base)) out.push(base);
    walkDirs(base, (dir) => {
      if (hasManifest(dir)) out.push(dir);
    });
    return out;
  }
  if (pattern.endsWith("/*")) {
    const parent = join(rootDir, pattern.slice(0, -2));
    if (!isDirectory(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(parent, entry.name))
      .filter(hasManifest);
  }
  // Literal path: npm would fail if it does not exist; say so clearly here.
  if (!existsSync(join(rootDir, pattern))) {
    throw new Error(`workspace path from root package.json not found: ${join(rootDir, pattern)}`);
  }
  return hasManifest(join(rootDir, pattern)) ? [join(rootDir, pattern)] : [];
}

/** True when `dir/package.json` exists. */
function hasManifest(dir) {
  return existsSync(join(dir, "package.json"));
}

/** Recursively visit every non-hidden subdirectory of `dir`. */
function walkDirs(dir, visit) {
  if (!isDirectory(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const child = join(dir, entry.name);
    visit(child);
    walkDirs(child, visit);
  }
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Read the root manifest and return `{ patterns, dirs }`. */
export function readWorkspaceConfig(rootDir = ROOT_DIR) {
  const manifestPath = join(rootDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read root package.json at ${manifestPath}: ${err.message}`);
  }
  const patterns = manifest.workspaces;
  if (patterns === undefined) return { patterns: [], dirs: [] };
  if (!Array.isArray(patterns)) {
    throw new Error(`root package.json "workspaces" must be an array, got ${JSON.stringify(patterns)}`);
  }
  const seen = new Set();
  const dirs = [];
  for (const pattern of patterns) {
    for (const dir of expandPattern(rootDir, pattern)) {
      if (!seen.has(dir)) {
        seen.add(dir);
        dirs.push(dir);
      }
    }
  }
  for (const dir of dirs) {
    try {
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (err) {
      throw new Error(`invalid workspace manifest at ${join(dir, "package.json")}: ${err.message}`);
    }
  }
  return { patterns, dirs };
}

export { resolveNpmInvocation };

/** `npm run <script> --workspaces --if-present` for the given npm invocation. */
export function buildSpawnArgs(scriptName, invocation) {
  return {
    command: invocation.command,
    args: [...invocation.args, "run", scriptName, "--workspaces", "--if-present"],
    shell: invocation.shell ?? false,
  };
}

/**
 * Run `<script>` in every workspace that defines it. Resolves with the child
 * exit code; returns 0 without spawning when no workspace manifests exist.
 */
export async function runWorkspaceScript(scriptName, options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const { patterns, dirs } = readWorkspaceConfig(rootDir);
  if (dirs.length === 0) {
    console.log(
      `[run-workspaces] no workspace package.json found for root workspaces ` +
        `(${patterns.join(", ") || "none"}); nothing to run.`,
    );
    return 0;
  }
  const invocation = options.npmInvocation ?? resolveNpmInvocation();
  const { command, args, shell } = buildSpawnArgs(scriptName, invocation);
  const spawnImpl = options.spawnImpl ?? spawn;
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: rootDir,
        stdio: options.stdio ?? "inherit",
        env: options.env ?? process.env,
        shell,
      });
    } catch (err) {
      console.error(`[run-workspaces] failed to start ${command}: ${err.message}`);
      resolvePromise(1);
      return;
    }
    child.on("error", (err) => {
      console.error(`[run-workspaces] failed to start ${command}: ${err.message}`);
      resolvePromise(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

/** CLI entry point; resolves with the process exit code. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const scriptName = argv[0];
  if (!scriptName) {
    console.error("usage: node scripts/run-workspaces.mjs <script>");
    console.error("       node scripts/run-workspaces.mjs build|typecheck|test");
    return 2;
  }
  const run = deps.runWorkspaceScript ?? runWorkspaceScript;
  try {
    return await run(scriptName, deps.options ?? {});
  } catch (err) {
    console.error(`[run-workspaces] ${err.message}`);
    return 1;
  }
}

// Run only when executed directly. Compare canonical paths (realpathSync) so
// symlinked prefixes such as /var -> /private/var on macOS still match.
if (process.argv[1]) {
  try {
    const isMain =
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url));
    if (isMain) {
      main().then((code) => {
        process.exitCode = code;
      });
    }
  } catch {
    // Not the main module.
  }
}
