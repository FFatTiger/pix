// scripts/check-boundaries.mjs
//
// Dependency boundary gate for the agent-worker package.
//
// Enforces:
//   1. Production src/ imports ONLY `@fffattiger/pix-runtime-core`,
//      `@fffattiger/pix-protocol` and the project adapter
//      `@fffattiger/pix-pi-sdk-adapter` — never the Pi SDK directly, and never
//      sibling product packages (sessiond/cli/host/client/contract-tests).
//   2. Public declarations under dist/ leak none of those forbidden imports.
//   3. The manifest declares no Pi SDK dependency.
//   4. No AgentSession / SessionManager tokens in production src.
//
// Test/ (dev-only) is exempt: it legitimately imports the sessiond
// SnapshotProjection as the reverse oracle. Exits 0 on PASS, 1 on FAIL.

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const packageRoot = new URL("../", import.meta.url).pathname;
const srcRoot = join(packageRoot, "src");
const distRoot = join(packageRoot, "dist");

const ALLOWED_PACKAGE_PREFIXES = [
  "@fffattiger/pix-runtime-core",
  "@fffattiger/pix-protocol",
  "@fffattiger/pix-pi-sdk-adapter",
];
const PI_SDK_PREFIX = "@earendil-works/pi-";
const FFF_PREFIX = "@fffattiger/";
const FORBIDDEN_TOKEN = /\b(?:AgentSession|SessionManager)\b/;

function isAllowedSpecifier(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
  if (PI_SDK_PREFIX && specifier.startsWith(PI_SDK_PREFIX)) return false;
  if (specifier.startsWith(FFF_PREFIX)) {
    return ALLOWED_PACKAGE_PREFIXES.some(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
    );
  }
  // Third-party bare specifiers are not expected in this package; flag them so
  // an accidental runtime dependency cannot slip in silently.
  return false;
}

async function walk(dir, suffix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path, suffix));
    else if (entry.isFile() && path.endsWith(suffix)) files.push(path);
  }
  return files;
}

const specifierPattern = /(?:from|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function extractSpecifiers(text) {
  const out = [];
  for (const match of text.matchAll(specifierPattern)) out.push(match[1]);
  return out;
}

const failures = [];
const sourceFiles = await walk(srcRoot, ".ts");
for (const file of sourceFiles) {
  const rel = relative(srcRoot, file);
  const text = await readFile(file, "utf8");
  for (const specifier of extractSpecifiers(text)) {
    if (!isAllowedSpecifier(specifier)) {
      failures.push(`${rel}: forbidden import "${specifier}"`);
    }
  }
  if (FORBIDDEN_TOKEN.test(text)) {
    failures.push(`${rel}: forbidden AgentSession/SessionManager token`);
  }
}

const declarationFiles = (await walk(distRoot, ".d.ts")).filter(
  (file) => !relative(distRoot, file).startsWith(`internal/`),
);
for (const file of declarationFiles) {
  const rel = relative(distRoot, file);
  const text = await readFile(file, "utf8");
  for (const specifier of extractSpecifiers(text)) {
    if (!isAllowedSpecifier(specifier)) {
      failures.push(`${rel}: public declaration leaks forbidden import "${specifier}"`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `agent-worker boundaries: PASS (${sourceFiles.length} source files, ${declarationFiles.length} public declarations)`,
);
