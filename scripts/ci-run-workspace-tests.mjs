// scripts/ci-run-workspace-tests.mjs
//
// Run one npm script (default `test`) in every workspace, one package at a
// time, and keep going after a failure. `npm run --workspaces` stops at the
// first failing package, which hides every later result; this runner prints
// each package's own output, then a summary, and exits 1 when any package
// failed. A package with no such script is skipped, not failed.
//
// Usage: node scripts/ci-run-workspace-tests.mjs [script]

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspaceConfig, resolveNpmInvocation } from "./run-workspaces.mjs";

/** Workspaces that define `scriptName`, as `{ dir, name }`, in discovery order. */
export function workspacesWithScript(rootDir, scriptName) {
  const { dirs } = readWorkspaceConfig(rootDir);
  const selected = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const script = manifest.scripts?.[scriptName];
    if (typeof script !== "string") continue;
    selected.push({ dir, name: manifest.name ?? dir });
  }
  return selected;
}

/** Spawn one package's script. Resolves with `{ name, code }`. */
export function runOne(workspace, scriptName, options = {}) {
  const invocation = options.npmInvocation ?? resolveNpmInvocation();
  const spawnImpl = options.spawnImpl ?? spawn;
  const command = invocation.command;
  const args = [...invocation.args, "run", scriptName];
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: workspace.dir,
        stdio: options.stdio ?? "inherit",
        env: options.env ?? process.env,
        shell: invocation.shell ?? false,
      });
    } catch (err) {
      console.error(`[ci-tests] ${workspace.name}: failed to start: ${err.message}`);
      resolvePromise({ name: workspace.name, code: 1 });
      return;
    }
    child.on("error", (err) => {
      console.error(`[ci-tests] ${workspace.name}: failed to start: ${err.message}`);
      resolvePromise({ name: workspace.name, code: 1 });
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`[ci-tests] ${workspace.name}: terminated by ${signal}`);
        resolvePromise({ name: workspace.name, code: 1 });
        return;
      }
      resolvePromise({ name: workspace.name, code: code ?? 1 });
    });
  });
}

/**
 * Run `scriptName` in every workspace that defines it. Returns 0 when every
 * one passed, 1 otherwise. Prints a pass/fail line per package and the names
 * of the failures at the end.
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const scriptName = argv[0] ?? "test";
  const rootDir = options.rootDir ?? process.cwd();
  let workspaces;
  try {
    workspaces = (options.discover ?? workspacesWithScript)(rootDir, scriptName);
  } catch (err) {
    console.error(`[ci-tests] ${err.message}`);
    return 1;
  }
  if (workspaces.length === 0) {
    console.log(`[ci-tests] no workspace defines "${scriptName}"; nothing to run.`);
    return 0;
  }

  const results = [];
  for (const workspace of workspaces) {
    console.log(`\n[ci-tests] ${workspace.name}: npm run ${scriptName}`);
    results.push(await runOne(workspace, scriptName, options));
  }

  const failed = results.filter((result) => result.code !== 0);
  console.log("\n[ci-tests] summary");
  for (const result of results) {
    console.log(`  ${result.code === 0 ? "pass" : "FAIL"} ${result.name} (exit ${result.code})`);
  }
  if (failed.length > 0) {
    console.error(`[ci-tests] ${failed.length} failed: ${failed.map((result) => result.name).join(", ")}`);
    return 1;
  }
  console.log(`[ci-tests] ${results.length} passed`);
  return 0;
}

if (process.argv[1]) {
  try {
    const isMain =
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    if (isMain) {
      main().then((code) => {
        process.exitCode = code;
      });
    }
  } catch {
    // Not the main module.
  }
}
