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
//  10. no legacy product name in production source, manifests, README or docs
//  11. no production/test script uses `rm -rf` (use scripts/remove-paths.mjs)
//  12. no shell-dependent `node --test` glob in scripts (use scripts/run-node-test.mjs)
//  13. dependency builders launch tsc/npm as JS CLIs through the current Node
//      (no npm.cmd / .bin/tsc / shell:true)
//
// Only Node builtins; runs with zero installed dependencies.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx", ".cjs", ".mts", ".cts"]);
const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".json",
  ".html",
  ".htm",
  ".webmanifest",
  ".md",
  ".markdown",
  ".css",
  ".txt",
]);
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "dist-test", "coverage"]);

const NEXT_DEPS = new Set(["next", "eslint-config-next"]);
const PI_SDK_PREFIX = "@earendil-works/pi-";
const PROTOCOL_SPECIFIERS = ["@fffattiger/pix-protocol"];
const RUNTIME_CORE_SPECIFIERS = ["@fffattiger/pix-runtime-core"];

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
// Cross-platform tooling
// ---------------------------------------------------------------------------

// `rm -rf` / `rm -r` in a package.json script value. The lookbehind keeps
// `remove-paths.mjs` (which contains “rm” inside “remove”) from matching.
const RM_RF_IN_SCRIPT = /(?:^|[^A-Za-z0-9_.-])rm\s+-(?:r|R)(?:f|F)?\b/;
const RAW_NODE_TEST = /\bnode\s+--test\b/;
const GLOB_CHARS = /[*?{}[\]]/;
const DEP_BUILDER_NAMES = new Set(["build-deps.mjs", "prebuild-deps.mjs"]);

/** True when `script` runs `node --test` with a glob argument. */
function isShellDependentNodeTestGlob(script) {
  const match = RAW_NODE_TEST.exec(script);
  if (!match) return false;
  // Examine only the segment after `node --test` up to the next `&&` / `||`
  // / `;` so unrelated later shell commands are not blamed.
  const segment = script.slice(match.index + match[0].length).split(/\s*(?:&&|\|\||;)\s*/)[0];
  return GLOB_CHARS.test(segment);
}

/** No production/test script may shell out to `rm -rf`. */
export function checkNoRmRfInScripts(manifests) {
  const offenders = [];
  for (const { path, manifest } of manifests) {
    const scripts = manifest.scripts;
    if (!scripts) continue;
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script === "string" && RM_RF_IN_SCRIPT.test(script)) {
        offenders.push(`${path}: script "${name}" calls rm -rf (use scripts/remove-paths.mjs)`);
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "no production/test script uses rm -rf" }
    : { ok: false, details: offenders.join("; ") };
}

/**
 * No script may pass a glob to raw `node --test`: Node 24 exits 0 when the
 * glob matches nothing, and the quoting is fragile under Windows cmd. Use
 * scripts/run-node-test.mjs so the file list is explicit and fail-closed.
 */
export function checkNoRawNodeTestGlob(manifests) {
  const offenders = [];
  for (const { path, manifest } of manifests) {
    const scripts = manifest.scripts;
    if (!scripts) continue;
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script === "string" && isShellDependentNodeTestGlob(script)) {
        offenders.push(
          `${path}: script "${name}" runs node --test with a shell-dependent glob (use scripts/run-node-test.mjs)`,
        );
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "no shell-dependent node --test glob in scripts" }
    : { ok: false, details: offenders.join("; ") };
}

// Tokens inspected in the executable code of dependency builders (after
// comments are stripped), so explanatory comment text can never trip the
// gate. `node_modules/.bin/tsc` may be written as one string or as the
// joined `.bin`, "tsc" array args, so both forms are matched.
const NPM_CMD_TOKEN = /npm\.cmd\b/;
const BIN_TSC_TOKEN = /\.bin[\\/]tsc\b|["'`]\.bin["'`]\s*,\s*["'`]tsc["'`]/;
const SHELL_TRUE_TOKEN = /shell\s*:\s*true\b/;

/**
 * Dependency builders (build-deps.mjs / prebuild-deps.mjs) must launch tsc
 * and npm as JS CLIs through the current Node. This is a precise guard on
 * the executable code of those files only (comments are ignored); other
 * scripts that legitimately need a shell are not touched.
 */
export function checkDependencyBuildersSafe(sourceFiles) {
  const offenders = [];
  for (const file of sourceFiles) {
    if (!DEP_BUILDER_NAMES.has(basename(file))) continue;
    const body = stripComments(readFileSync(file, "utf8"));
    if (NPM_CMD_TOKEN.test(body)) {
      offenders.push(`${file}: spawns npm.cmd (use scripts/tool-invocation.mjs)`);
    }
    if (BIN_TSC_TOKEN.test(body)) {
      offenders.push(`${file}: spawns the .bin/tsc shim (use scripts/tool-invocation.mjs)`);
    }
    if (SHELL_TRUE_TOKEN.test(body)) {
      offenders.push(`${file}: spawns with shell:true (use scripts/tool-invocation.mjs)`);
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "dependency builders invoke tsc/npm through the current Node" }
    : { ok: false, details: offenders.join("; ") };
}

// ---------------------------------------------------------------------------
// No legacy product name
// ---------------------------------------------------------------------------

// The legacy brand tokens this gate forbids, assembled from parts so this
// file's own source is not flagged by the contiguous-string scan below. The
// space form covers every casing of the spaced brand name.
const LEGACY_PRODUCT_TOKENS = ["pi" + "-web", "pi" + "_web", "pi" + " web"];

/**
 * Files that are allowed to keep the old brand as historical evidence or are
 * generated artifacts: the migration ledger (old source paths / commits), the
 * regenerated dependency lockfile, and this gate's own adversarial self-test.
 */
function legacyProductNameSkipSet(rootDir) {
  return new Set(
    [
      join(rootDir, "docs", "migration-ledger.md"),
      join(rootDir, "package-lock.json"),
      join(rootDir, "scripts", "check-architecture.test.mjs"),
    ].map((p) => realpathIfExists(p) ?? p),
  );
}

function realpathIfExists(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function checkNoLegacyProductName({ files, rootDir = ROOT_DIR }) {
  const skip = legacyProductNameSkipSet(rootDir);
  const offenders = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    if (skip.has(file) || skip.has(realpathIfExists(file) ?? file)) continue;
    const lowered = readFileSync(file, "utf8").toLowerCase();
    for (const token of LEGACY_PRODUCT_TOKENS) {
      if (lowered.includes(token)) {
        const rel = file.startsWith(rootDir) ? file.slice(rootDir.length).replace(/^[\\/]+/, "") : file;
        offenders.push(`${rel}: legacy product name "${token.trim()}"`);
        break;
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, details: "no legacy product name in source, manifests, README or docs" }
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
    { name: "no rm -rf in production/test scripts", result: checkNoRmRfInScripts(manifests) },
    {
      name: "no shell-dependent node --test glob",
      result: checkNoRawNodeTestGlob(manifests),
    },
    {
      name: "dependency builders use safe tool invocation",
      result: checkDependencyBuildersSafe(sourceFiles),
    },
    { name: "no legacy product name", result: checkNoLegacyProductName({ files, rootDir }) },
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
