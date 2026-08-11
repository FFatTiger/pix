// scripts/check-architecture.mjs
//
// Architecture gate for the pix workspace. Enforces the documented invariants
// from docs/refactor-architecture.md (硬规则) and docs/refactor-execution-plan.md
// §9.2. Exits 0 (PASS) when every check passes, 1 (FAIL) with a list of
// violations otherwise.
//
// Checks (each is a no-op / passes when the relevant package does not exist yet):
//   1. workspace layout — root is private and workspaces include "packages/*"
//   2. no `next` / `eslint-config-next` dependency in any manifest
//   3. no `next` / `next/*` import in any source file
//   4. no Next product path: root app/, next.config.*, .next/
//   5. Pi SDK imports (@earendil-works/pi-*) only inside packages/pi-sdk-adapter
//   6. runtime-core has no Protocol / Pi SDK / Hono / React import or dependency
//   7. protocol has no runtime-core / Pi SDK / Hono / React import or dependency
//   8. host / sessiond / agent-worker have no AgentSession / SessionManager usage
//   9. production bin targets exist for every manifest that declares a bin
//
// Only Node builtins; runs with zero installed dependencies.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx", ".cjs", ".mts", ".cts"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "dist-test", "coverage"]);

const NEXT_DEPS = new Set(["next", "eslint-config-next"]);
const PI_SDK_PREFIX = "@earendil-works/pi-";
const PROTOCOL_SPECIFIERS = ["@fffattiger/pi-web-protocol"];
const RUNTIME_CORE_SPECIFIERS = ["@fffattiger/pi-web-runtime-core"];

/** True when a specifier targets a sibling package by name or by repo path. */
function matchesSiblingPackage(specifier, packageNames, packageDirName) {
  if (packageNames.some((p) => specifier === p || specifier.startsWith(p + "/"))) return true;
  return specifier.includes(`packages/${packageDirName}`);
}

const FORBIDDEN_RUNTIME_CORE = [
  {
    label: "Protocol",
    match: (s) => matchesSiblingPackage(s, PROTOCOL_SPECIFIERS, "protocol"),
  },
  { label: "Pi SDK", match: (s) => s.startsWith(PI_SDK_PREFIX) },
  { label: "Hono", match: (s) => s === "hono" || s.startsWith("hono/") },
  {
    label: "React",
    match: (s) =>
      s === "react" || s === "react-dom" || s.startsWith("react/") || s.startsWith("react-dom/"),
  },
];

const FORBIDDEN_PROTOCOL = [
  {
    label: "Runtime Core",
    match: (s) => matchesSiblingPackage(s, RUNTIME_CORE_SPECIFIERS, "runtime-core"),
  },
  { label: "Pi SDK", match: (s) => s.startsWith(PI_SDK_PREFIX) },
  { label: "Hono", match: (s) => s === "hono" || s.startsWith("hono/") },
  {
    label: "React",
    match: (s) =>
      s === "react" || s === "react-dom" || s.startsWith("react/") || s.startsWith("react-dom/"),
  },
];

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function basename(file) {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i >= 0 ? file.slice(i + 1) : file;
}

function extname(file) {
  const i = file.lastIndexOf(".");
  return i >= 0 ? file.slice(i) : "";
}

/** Recursively list files under `dir`, skipping excluded dirs and dot-entries. */
export function collectFiles(rootDir = ROOT_DIR) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  walk(rootDir);
  return files;
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(extname(file));
}

/** Every manifest in the tree as { path, dir, manifest, isRoot }. */
function collectManifests(files, rootDir) {
  return files
    .filter((f) => basename(f) === "package.json")
    .map((path) => ({
      path,
      dir: dirname(path),
      manifest: JSON.parse(readFileSync(path, "utf8")),
      isRoot: dirname(path) === rootDir,
    }));
}

/** Extract import/require/dynamic-import specifiers from a source body. */
export function extractSpecifiers(body) {
  const specifiers = [];
  const cleaned = stripComments(body);
  const re = /(?:from|import\s*\(|require\s*\(|\bimport\b)\s*["']([^"']+)["']/g;
  for (const m of cleaned.matchAll(re)) specifiers.push(m[1]);
  return specifiers;
}

function stripComments(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function exists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `file` lives under a path segment named `segment` (package dir). */
function underPackage(file, segment) {
  return file.split(/[\\/]/).includes(segment);
}

// ---------------------------------------------------------------------------
// Individual checks. Each returns { ok, details }.
// ---------------------------------------------------------------------------

export function checkWorkspaceLayout(rootManifest) {
  if (rootManifest.private !== true) {
    return { ok: false, details: "root package.json must be private: true" };
  }
  const workspaces = rootManifest.workspaces;
  if (!Array.isArray(workspaces)) {
    return {
      ok: false,
      details: `root "workspaces" must be an array, got ${JSON.stringify(workspaces)}`,
    };
  }
  if (!workspaces.includes("packages/*")) {
    return {
      ok: false,
      details: `root "workspaces" must include "packages/*", got ${JSON.stringify(workspaces)}`,
    };
  }
  return { ok: true, details: `workspaces: ${workspaces.join(", ")}` };
}

export function checkNoNextDependency(manifests) {
  const offenders = [];
  for (const { path, manifest } of manifests) {
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const deps = manifest[section];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (NEXT_DEPS.has(name)) offenders.push(`${path} (${section}.${name})`);
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "no next / eslint-config-next dependency" }
    : { ok: false, details: offenders.join("; ") };
}

export function checkNoNextImport(sourceFiles) {
  const offenders = [];
  for (const file of sourceFiles) {
    const body = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(body)) {
      if (specifier === "next" || specifier.startsWith("next/")) {
        offenders.push(`${file}: imports "${specifier}"`);
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "no next / next/* import" }
    : { ok: false, details: offenders.join("; ") };
}

export function checkNoNextProductPath(rootDir = ROOT_DIR) {
  const offenders = [];
  if (isDir(join(rootDir, "app"))) offenders.push("root app/ directory exists");

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".next") offenders.push(`.next/ directory: ${full}`);
        walk(full);
      } else if (entry.name.startsWith("next.config.")) {
        offenders.push(`next.config file: ${full}`);
      }
    }
  };
  walk(rootDir);

  return offenders.length === 0
    ? { ok: true, details: "no root app/, next.config.*, .next" }
    : { ok: false, details: offenders.join("; ") };
}

export function checkPiSdkBoundary({ manifests, sourceFiles }) {
  const offenders = [];
  for (const { path, manifest, isRoot } of manifests) {
    const isAdapter = underPackage(path, "pi-sdk-adapter");
    if (isAdapter) continue;
    const manifestLabel = isRoot ? "root package.json" : path;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = manifest[section];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (name.startsWith(PI_SDK_PREFIX)) {
          offenders.push(`${manifestLabel}: ${section} depends on Pi SDK "${name}"`);
        }
      }
    }
  }
  for (const file of sourceFiles) {
    if (underPackage(file, "pi-sdk-adapter")) continue;
    const body = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(body)) {
      if (specifier.startsWith(PI_SDK_PREFIX)) {
        offenders.push(`${file}: imports Pi SDK "${specifier}" outside packages/pi-sdk-adapter`);
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "Pi SDK imports confined to packages/pi-sdk-adapter" }
    : { ok: false, details: offenders.join("; ") };
}

function scanBoundary(sourceFiles, packageDirName, rules) {
  const offenders = [];
  for (const file of sourceFiles) {
    if (!underPackage(file, packageDirName)) continue;
    const body = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(body)) {
      for (const rule of rules) {
        if (rule.match(specifier)) {
          offenders.push(`${file}: imports ${rule.label} "${specifier}"`);
        }
      }
    }
  }
  return offenders;
}

function scanPackageDeps(manifests, packageDirName, rules) {
  const offenders = [];
  for (const { path, manifest, isRoot } of manifests) {
    if (isRoot || !underPackage(path, packageDirName)) continue;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = manifest[section];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        for (const rule of rules) {
          if (rule.match(name)) {
            offenders.push(`${path}: ${section} depends on ${rule.label} "${name}"`);
          }
        }
      }
    }
  }
  return offenders;
}

export function checkRuntimeCoreBoundary({ manifests, sourceFiles }) {
  const offenders = [
    ...scanBoundary(sourceFiles, "runtime-core", FORBIDDEN_RUNTIME_CORE),
    ...scanPackageDeps(manifests, "runtime-core", FORBIDDEN_RUNTIME_CORE),
  ];
  return offenders.length === 0
    ? { ok: true, details: "runtime-core has no Protocol/Pi SDK/Hono/React import or dependency" }
    : { ok: false, details: offenders.join("; ") };
}

export function checkProtocolBoundary({ manifests, sourceFiles }) {
  const offenders = [
    ...scanBoundary(sourceFiles, "protocol", FORBIDDEN_PROTOCOL),
    ...scanPackageDeps(manifests, "protocol", FORBIDDEN_PROTOCOL),
  ];
  return offenders.length === 0
    ? { ok: true, details: "protocol has no Runtime Core/Pi SDK/Hono/React import or dependency" }
    : { ok: false, details: offenders.join("; ") };
}

export function checkNoAgentSession(sourceFiles) {
  const targetPackages = new Set(["host", "sessiond", "agent-worker"]);
  const offenders = [];
  const token = /\b(AgentSession|SessionManager)\b/;
  for (const file of sourceFiles) {
    if (!file.split(/[\\/]/).some((seg) => targetPackages.has(seg))) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (token.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return offenders.length === 0
    ? { ok: true, details: "host/sessiond/agent-worker have no AgentSession/SessionManager usage" }
    : { ok: false, details: offenders.join("; ") };
}

export function checkBinTargets(manifests) {
  const offenders = [];
  for (const { dir, manifest } of manifests) {
    const bin = manifest.bin;
    if (!bin) continue;
    const entries = typeof bin === "string" ? [[basename(dir), bin]] : Object.entries(bin);
    for (const [name, target] of entries) {
      if (!exists(join(dir, target))) {
        offenders.push(`${join(dir, "package.json")}: bin "${name}" -> ${target} not found`);
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "all declared production bin targets exist" }
    : { ok: false, details: offenders.join("; ") };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function runChecks(rootDir = ROOT_DIR) {
  const files = collectFiles(rootDir);
  // This gate's own adversarial tests intentionally contain forbidden import
  // strings as fixtures. Exclude only that self-test from production scans;
  // package tests remain subject to the architecture rules.
  const sourceFiles = files.filter(
    (file) => isSourceFile(file) && basename(file) !== "check-architecture.test.mjs",
  );
  const manifests = collectManifests(files, rootDir);
  const rootManifest = manifests.find((m) => m.isRoot)?.manifest ?? {};
  const ctx = { manifests, sourceFiles };
  const checks = [
    { name: "workspace layout", result: checkWorkspaceLayout(rootManifest) },
    { name: "no next / eslint-config-next dependency", result: checkNoNextDependency(manifests) },
    { name: "no next import", result: checkNoNextImport(sourceFiles) },
    { name: "no Next product path", result: checkNoNextProductPath(rootDir) },
    { name: "Pi SDK import boundary", result: checkPiSdkBoundary(ctx) },
    { name: "runtime-core boundary", result: checkRuntimeCoreBoundary(ctx) },
    { name: "protocol boundary", result: checkProtocolBoundary(ctx) },
    {
      name: "no AgentSession/SessionManager in host/sessiond/agent-worker",
      result: checkNoAgentSession(sourceFiles),
    },
    { name: "production bin targets exist", result: checkBinTargets(manifests) },
  ];
  const failed = checks.filter((c) => !c.result.ok);
  return { ok: failed.length === 0, checks, failed };
}

/** CLI entry point; resolves with the process exit code. */
export async function main(rootDir = ROOT_DIR, io = console) {
  const { ok, checks, failed } = runChecks(rootDir);
  io.log("[pix] check:architecture");
  for (const { name, result } of checks) {
    io.log(`  ${result.ok ? "✓" : "✗"} ${name}${result.ok ? "" : ` — ${result.details}`}`);
  }
  if (ok) {
    io.log("PASS");
    return 0;
  }
  io.log("FAIL");
  for (const { name, result } of failed) {
    io.log(`- ${name}: ${result.details}`);
  }
  return 1;
}

// Run only when executed directly. Compare canonical paths so symlinked
// prefixes such as /var -> /private/var on macOS still match.
if (process.argv[1]) {
  try {
    const isMain =
      realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
    if (isMain) {
      main().then((code) => {
        process.exitCode = code;
      });
    }
  } catch {
    // Not the main module.
  }
}
