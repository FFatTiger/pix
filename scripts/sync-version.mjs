/**
 * Single source of truth for the workspace version (REL1).
 *
 * The canonical version lives in the root package.json `version` field. Every
 * workspace package must carry the SAME version so per-package `npm pack`
 * tarballs, the bundled CLI release artifact, and `pix --version` never
 * disagree.
 *
 * Modes:
 *   check  — assert every workspace package.json version === canonical. Exit 1
 *            (listing offenders) when any mismatch.
 *   write  — rewrite every workspace package.json version to the canonical
 *            value. Never touches `dependencies`/`devDependencies` specifiers
 *            (those are fixed by the frozen REL1 dependency-graph list).
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

/** Rewrite every workspace package version to the canonical value. */
export function writeVersions(root = ROOT, manifests = collectWorkspaceManifests(root)) {
  const canonical = resolveCanonicalVersion(root);
  for (const { path, manifest } of manifests) {
    if (manifest.version === canonical) continue;
    manifest.version = canonical;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return checkVersions(root, manifests);
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
  const result = checkVersions();
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
