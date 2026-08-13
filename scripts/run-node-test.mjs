// scripts/run-node-test.mjs
//
// Discover test files for a glob, fail if none match, then hand the explicit
// list to `node --test`. This avoids:
//   - Windows cmd.exe treating single quotes as literal characters (0 tests, exit 0)
//   - POSIX shells expanding unquoted `**` without globstar
//   - silent empty suites

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.error("usage: node scripts/run-node-test.mjs <glob> [node-test-options...]");
  console.error("       node scripts/run-node-test.mjs \"scripts/**/*.test.mjs\" --test-name-pattern=helper");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index) && (index + 2 === pattern.length || pattern[index + 2] === "/")) {
      source += ".*";
      index += 2;
      continue;
    }
    const ch = pattern[index];
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\^$+{}[]()|.".includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

function collectFiles(root) {
  const out = [];
  function walk(dir) {
    if (!isDirectory(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  walk(root);
  return out;
}

export function discoverTestFiles(cwd, pattern) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const slash = normalized.indexOf("/");
  const rootName = slash === -1 ? "." : normalized.slice(0, slash);
  const searchRoot = rootName === "." ? cwd : join(cwd, rootName);
  if (!existsSync(searchRoot)) return [];
  const matcher = globToRegExp(normalized);
  return collectFiles(searchRoot)
    .map((file) => relative(cwd, file).split(sep).join("/"))
    .filter((rel) => matcher.test(rel))
    .sort()
    .map((rel) => join(cwd, ...rel.split("/")));
}

export function main(argv = process.argv.slice(2), options = {}) {
  const pattern = argv[0];
  if (!pattern) {
    usage();
    return 2;
  }
  const cwd = options.cwd ?? process.cwd();
  const files = discoverTestFiles(cwd, pattern);
  if (files.length === 0) {
    console.error(`[pix] no test files matched ${JSON.stringify(pattern)} in ${cwd}`);
    return 1;
  }
  const nodeTestArgs = argv.slice(1);
  const result = (options.spawnSyncImpl ?? spawnSync)(process.execPath, ["--test", ...nodeTestArgs, ...files], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[pix] failed to start node --test: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1]) {
  try {
    if (realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
      process.exitCode = main();
    }
  } catch {
    /* not the main module */
  }
}
