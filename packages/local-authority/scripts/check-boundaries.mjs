#!/usr/bin/env node
/**
 * Architecture boundary check for packages/local-authority.
 *
 * The secure-state workspace is dependency-free: source may import ONLY
 * node: builtins and relative modules. It must never import the Protocol,
 * Runtime Core, Pi SDK, Hono, React, or any other workspace/external package
 * (runtime or dev dependency). This enforces the platform-neutral contract +
 * POSIX-backend-only shape of Slice 1.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(packageRoot, "src");

const FORBIDDEN_PREFIXES = [
  "@fffattiger/",
  "@earendil-works/",
  "next/",
  "hono",
  "@hono/",
  "react",
  "react-dom",
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

for (const file of walk(srcRoot)) {
  const source = readFileSync(file, "utf8");
  const relativePath = file.slice(srcRoot.length + 1);
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".")) continue;
    if (FORBIDDEN_PREFIXES.some((p) => specifier === p || specifier.startsWith(p))) {
      fail(`${relativePath} imports forbidden module "${specifier}"`);
    } else {
      fail(`${relativePath} imports undeclared external "${specifier}"`);
    }
  }
}

if (failures > 0) {
  console.error(`\nBoundary check failed with ${failures} violation(s).`);
  process.exit(1);
}
console.log(`Boundary check passed (${walk(srcRoot).length} files).`);
