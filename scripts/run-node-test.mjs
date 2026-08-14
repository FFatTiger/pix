// scripts/run-node-test.mjs
//
// Deterministic cross-platform test runner for package.json test scripts.
// Expands one or more glob or path patterns with Node's built-in glob (no
// shell/cmd expansion, no `.cmd`), sorts and dedupes to a stable explicit
// file list, then runs that list through `node --test`.
//
// Why: `node --test '<glob>'` relies on Node's own glob matching, which on
// Node 24 exits 0 when nothing matches and whose quoting is fragile under
// Windows cmd. Passing an explicit sorted file list keeps CI fail-closed and
// Windows safe. Value-taking node test flags must be passed as `--flag=value`
// (space-separated values are rejected) so a value can never be parsed as
// another pattern; watch modes are not supported by this finite runner.

import { spawnSync } from "node:child_process";
import { globSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const GLOB_MAGIC = /[*?{}[\]]/;

// Value-taking node --test flags. The runner requires the `--flag=value`
// form so a space-separated value can never be mistaken for another test
// pattern (which would let `node --test` consume an explicit test file as
// the flag value and silently skip it — a false green). Union of the flags
// supported on Node 22.19 and Node 24.
const VALUE_FLAGS = new Set([
  "test-concurrency",
  "test-coverage-branches",
  "test-coverage-exclude",
  "test-coverage-functions",
  "test-coverage-include",
  "test-coverage-lines",
  "test-global-setup",
  "test-isolation",
  "experimental-test-isolation",
  "test-name-pattern",
  "test-random-seed",
  "test-reporter",
  "test-reporter-destination",
  "test-rerun-failures",
  "test-shard",
  "test-skip-pattern",
  "test-timeout",
]);

// Boolean node --test flags that may coexist with later patterns. `--test` is
// included so an explicit pass-through is harmless (the runner adds it
// itself).
const BOOLEAN_FLAGS = new Set([
  "experimental-test-coverage",
  "experimental-test-module-mocks",
  "test",
  "test-force-exit",
  "test-only",
  "test-randomize",
  "test-update-snapshots",
]);

function usage() {
  console.error("usage: node scripts/run-node-test.mjs <glob-or-path> [<glob-or-path>...] [node-test-options...]");
  console.error("       node scripts/run-node-test.mjs \"scripts/**/*.test.mjs\" --test-name-pattern=helper");
  console.error("       node scripts/run-node-test.mjs \"dist-test/**/*.test.js\" --test-concurrency=1");
  console.error("value-taking node test flags must use --flag=value; --watch modes are not supported");
}

/**
 * Split argv into glob/path patterns and Node test flags. A literal `--`
 * marks every following argument as a node test flag (no further pattern
 * parsing). Value-taking flags MUST use the `--flag=value` form: the
 * space-separated form is rejected so a separate value can never be parsed
 * as another pattern. Watch modes and unknown flags are rejected fail-closed.
 * Throws a fixed Error for every invalid flag; callers must surface it
 * before any glob discovery or spawn.
 */
export function parseArgs(argv) {
  const patterns = [];
  const flags = [];
  let afterSeparator = false;
  for (const arg of argv) {
    if (!afterSeparator && arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (afterSeparator || arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const short = name.replace(/^-+/, "");
      if (short.startsWith("watch")) {
        throw new Error(`--watch mode is not supported by this finite runner (got ${name})`);
      }
      if (VALUE_FLAGS.has(short)) {
        if (eq === -1) {
          throw new Error(
            `${name} takes a value; use ${name}=<value> (space-separated flag values are rejected so they cannot be parsed as test patterns)`,
          );
        }
        flags.push(arg);
        continue;
      }
      if (BOOLEAN_FLAGS.has(short)) {
        flags.push(arg);
        continue;
      }
      throw new Error(`unsupported node --test flag: ${name}`);
    } else {
      patterns.push(arg);
    }
  }
  return { patterns, flags };
}

/** True when `child` is `parent` itself or strictly beneath it. */
function isWithin(parent, child) {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  const p = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  const c = process.platform === "win32" ? child.toLowerCase() : child;
  return c === p || c.startsWith(p);
}

/**
 * Expand `pattern` against `cwd` into a deterministic list of absolute test
 * files. Returns regular files only, sorted and deduped, with any match whose
 * realpath escapes the real cwd (symlink escape) excluded.
 */
export function discoverTestFiles(cwd, pattern) {
  // Normalize backslashes so `dist-test\**\*.test.js` works identically to
  // the forward-slash form on every platform. Node's glob already treats "/"
  // as the separator.
  const normalized = pattern.replace(/\\/g, "/");
  const matches = globSync(normalized, { cwd, nodir: true });
  const cwdReal = realpathSync(cwd);
  const seen = new Set();
  const out = [];
  for (const rel of matches) {
    const abs = resolve(cwd, rel);
    let real;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!isWithin(cwdReal, real)) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(abs);
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

/**
 * CLI entry point. Expands every pattern, fails closed (exit 1) when any
 * pattern matches nothing, then spawns `node --test` with the explicit file
 * list. Returns the child exit code (or re-raises the child's signal).
 */
export function main(argv = process.argv.slice(2), options = {}) {
  let patterns;
  let flags;
  try {
    ({ patterns, flags } = parseArgs(argv));
  } catch (err) {
    console.error(`[pix] ${err.message}`);
    usage();
    return 2;
  }
  if (patterns.length === 0) {
    usage();
    return 2;
  }
  const cwd = options.cwd ?? process.cwd();

  // Dedupe across patterns by canonical path while enforcing per-pattern
  // zero-match fail-closed.
  const files = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const matched = discoverTestFiles(cwd, pattern);
    if (matched.length === 0) {
      const literal = !GLOB_MAGIC.test(pattern.replace(/\\/g, "/"));
      if (literal) {
        console.error(`[pix] test path not found: ${JSON.stringify(pattern)} (cwd ${cwd})`);
      } else {
        console.error(`[pix] no test files matched ${JSON.stringify(pattern)} in ${cwd}`);
      }
      return 1;
    }
    for (const file of matched) {
      const canonical = realpathSync(file);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      files.push(file);
    }
  }
  files.sort((left, right) => left.localeCompare(right));

  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const killImpl = options.killImpl ?? process.kill;
  // Strip NODE_TEST_CONTEXT so a nested invocation (this runner started from
  // inside a test) still runs as a fresh top-level test runner instead of
  // silently skipping the file list and exiting 0 — a false green.
  const env = { ...(options.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSyncImpl(process.execPath, ["--test", ...flags, ...files], {
    cwd,
    stdio: options.stdio ?? "inherit",
    env,
  });
  if (result.error) {
    console.error(`[pix] failed to start node --test: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    // Re-raise the child's termination signal so the parent (npm) sees the
    // same signal that ended the test run, mirroring terminal Ctrl-C.
    killImpl(process.pid, result.signal);
    return 1;
  }
  return result.status ?? 1;
}

// Run only when executed directly. Compare canonical paths so symlinked
// prefixes such as /var -> /private/var on macOS still match.
if (process.argv[1]) {
  try {
    const isMain =
      realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
    if (isMain) process.exitCode = main();
  } catch {
    // Not the main module.
  }
}
