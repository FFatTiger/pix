/**
 * Single source of truth for the workspace version (REL1).
 *
 * The canonical version lives in the root package.json `version` field. Every
 * workspace package must carry the SAME version so per-package `npm pack`
 * tarballs, the bundled CLI release artifact, and `pix --version` never
 * disagree.
 *
 * Modes:
 *   check  — assert every workspace package.json version === canonical AND
 *            every internal `@fffattiger/pix-*` dependency specifier (known
 *            workspace names only) === canonical. Exit 1 (listing offenders)
 *            when any mismatch. `file:`/`workspace:`/`link:` protocol refs
 *            are exempt (they are not version refs).
 *   write  — rewrite every workspace package.json version AND every
 *            exact-version internal dependency specifier to the canonical
 *            value. Never touches external dependency specifiers, private
 *            flags, or non-exact (range) internal refs — those stay flagged
 *            by `check` for an owner decision.
 *
 * Internal refs matter because a bump that leaves stale exact refs (e.g.
 * `0.1.0` while the workspace publishes `0.2.0`) makes `npm ci` resolve them
 * against the public registry instead of the workspace, silently installing
 * foreign packages.
 *
 * Pure and dependency-free (Node built-ins only). No network, no lock churn.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Read a JSON manifest, returning null when missing/unparseable. */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Absolute path to every workspace package manifest under `packages/*`. */
export function collectWorkspaceManifests(root = ROOT) {
  const packagesDir = join(root, "packages");
  const manifests = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    const manifest = readManifest(manifestPath);
    if (manifest !== null) manifests.push({ dir: join(packagesDir, entry.name), path: manifestPath, manifest });
  }
  return manifests;
}

/** Resolve the canonical workspace version from the root manifest. */
export function resolveCanonicalVersion(root = ROOT) {
  const rootManifest = readManifest(join(root, "package.json"));
  const version = rootManifest?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`[pix] root package.json has no valid "version" (got ${JSON.stringify(version)})`);
  }
  return version;
}

/** Dependency manifest sections that may carry internal workspace refs. */
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** True for specifiers that locate a workspace by path, not by version. */
function isPathRef(specifier) {
  return typeof specifier === "string" && /^(file|workspace|link|git\+file):/.test(specifier);
}

/** True for a bare exact semver specifier (the only form `write` rewrites). */
function isExactVersion(specifier) {
  return typeof specifier === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(specifier);
}

/** Every internal dependency reference in a manifest as {section, name, specifier}. */
export function collectInternalRefs(manifest, workspaceNames) {
  const refs = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = manifest?.[section];
    if (deps === null || typeof deps !== "object") continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (workspaceNames.has(name)) refs.push({ section, name, specifier });
    }
  }
  return refs;
}

/** Names of every workspace package under `manifests`. */
export function collectWorkspaceNames(manifests = collectWorkspaceManifests()) {
  return new Set(manifests.map(({ manifest }) => manifest?.name).filter((name) => typeof name === "string"));
}

/** Verify all workspace package versions match the canonical version. */
export function checkVersions(root = ROOT, manifests = collectWorkspaceManifests(root)) {
  const canonical = resolveCanonicalVersion(root);
  const offenders = [];
  for (const { path, manifest } of manifests) {
    if (manifest.version !== canonical) {
      offenders.push(`${path}: version ${JSON.stringify(manifest.version)} !== canonical ${canonical}`);
    }
  }
  return { ok: offenders.length === 0, canonical, offenders };
}

/** Verify internal @fffattiger/pix-* dependency refs match the canonical version. */
export function checkInternalRefs(root = ROOT, manifests = collectWorkspaceManifests(root)) {
  const canonical = resolveCanonicalVersion(root);
  const workspaceNames = collectWorkspaceNames(manifests);
  const offenders = [];
  for (const { path, manifest } of manifests) {
    for (const { section, name, specifier } of collectInternalRefs(manifest, workspaceNames)) {
      if (isPathRef(specifier) || specifier === canonical) continue;
      offenders.push(`${path}: ${section}.${name} ref ${JSON.stringify(specifier)} !== canonical ${canonical}`);
    }
  }
  return { ok: offenders.length === 0, canonical, offenders };
}

/** Rewrite workspace versions and exact internal references to the canonical
 * value. Other manifest fields and external dependency values are preserved. */
export function writeVersions(root = ROOT, manifests = collectWorkspaceManifests(root)) {
  const canonical = resolveCanonicalVersion(root);
  const workspaceNames = collectWorkspaceNames(manifests);
  for (const { path, manifest } of manifests) {
    const refs = collectInternalRefs(manifest, workspaceNames)
      .filter(({ specifier }) => isExactVersion(specifier) && specifier !== canonical);
    if (manifest.version === canonical && refs.length === 0) continue;
    manifest.version = canonical;
    for (const { section, name } of refs) manifest[section][name] = canonical;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return checkAll(root, manifests);
}

/** Combined version + internal-ref consistency result. */
export function checkAll(root = ROOT, manifests = collectWorkspaceManifests(root)) {
  const versions = checkVersions(root, manifests);
  const refs = checkInternalRefs(root, manifests);
  return {
    ok: versions.ok && refs.ok,
    canonical: versions.canonical,
    offenders: [...versions.offenders, ...refs.offenders],
  };
}

/** CLI entry. Resolves with the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (mode !== "check" && mode !== "write") {
    console.error("[pix] sync-version: expected mode 'check' or 'write'");
    return 2;
  }
  const canonical = resolveCanonicalVersion();
  if (mode === "write") {
    const result = writeVersions();
    for (const offender of result.offenders) console.error(`[pix] ${offender}`);
    console.log(`[pix] sync-version: write -> workspace version ${canonical} (${result.ok ? "consistent" : "STILL INCONSISTENT"})`);
    return result.ok ? 0 : 1;
  }
  const result = checkAll();
  for (const offender of result.offenders) console.error(`[pix] ${offender}`);
  console.log(`[pix] sync-version: check -> workspace version ${canonical} (${result.ok ? "consistent" : "INCONSISTENT"})`);
  return result.ok ? 0 : 1;
}

// Run only when executed directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => {
    process.exitCode = code;
  });
}
