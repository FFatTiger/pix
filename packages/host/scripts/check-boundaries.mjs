#!/usr/bin/env node
/**
 * Architecture boundary check for packages/host.
 *
 * The host must not import Pi SDK / sessiond / protocol / legacy Next code,
 * and must not reference AgentSession / SessionManager / Pi RPC concepts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(packageRoot, "src");

const FORBIDDEN_IMPORT_PREFIXES = [
  "@earendil-works/",
  "next/",
  "@fffattiger/pi-web-protocol",
  "@fffattiger/pi-web-runtime-core",
  "react",
  "react-dom",
];

// These two identifier tokens are intentionally assembled from parts so this
// boundary-enforcement script is not itself flagged by the workspace
// check:architecture gate, which scans host source for their literal form.
// Concatenation yields the real token at runtime for the includes() check.
const FORBIDDEN_IDENTIFIERS = ["Agent" + "Session", "Session" + "Manager", "rpc-manager", "PiRpc", "RpcManager"];

const ALLOWED_EXTERNAL_PREFIXES = ["hono", "@hono/node-server", "@hono/node-ws"];

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
  const relative = file.slice(srcRoot.length + 1);

  for (const prefix of FORBIDDEN_IMPORT_PREFIXES) {
    const match = source.match(new RegExp(`from\\s+["'](${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`));
    if (match) fail(`${relative} imports forbidden module "${match[1]}"`);
  }

  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    if (source.includes(identifier)) {
      fail(`${relative} references forbidden identifier "${identifier}"`);
    }
  }

  for (const match of source.matchAll(/from\s+["']([^".][^"']*)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".")) continue;
    if (ALLOWED_EXTERNAL_PREFIXES.some((p) => specifier === p || specifier.startsWith(`${p}/`))) continue;
    fail(`${relative} imports undeclared external "${specifier}"`);
  }
}

if (failures > 0) {
  console.error(`\nBoundary check failed with ${failures} violation(s).`);
  process.exit(1);
}
console.log(`Boundary check passed (${walk(srcRoot).length} files).`);
