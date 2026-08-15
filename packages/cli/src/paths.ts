import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variable overriding the Vite client dist location. */
export const CLIENT_DIST_ENV = "PIX_CLIENT_DIST";

interface PackageManifest {
  name?: string;
  workspaces?: unknown;
}

function readManifest(path: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function isWorkspaceRoot(dir: string): boolean {
  const manifest = readManifest(join(dir, "package.json"));
  return (
    manifest !== undefined &&
    Array.isArray(manifest.workspaces) &&
    manifest.workspaces.some((p) => p === "packages/*")
  );
}

/**
 * Locate the pix workspace root by walking up from `fromUrl` until a manifest
 * declares the `packages/*` workspace. Robust to the CLI being reached from
 * `dist/`, `dist-test/`, or a bin shim, so client-dist resolution never depends
 * on the process cwd.
 */
export function resolveWorkspaceRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("[pix] could not locate pix workspace root");
    }
    dir = parent;
  }
}

/**
 * Locate the pix-cli package root (the directory holding `bin/` and this
 * package's manifest). Used to spawn the sibling `pix-sessiond` bin reliably.
 */
export function resolveCliPackageRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  while (true) {
    const manifest = readManifest(join(dir, "package.json"));
    if (manifest?.name === "@fffattiger/pix-cli" && existsSync(join(dir, "bin"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("[pix] could not locate pix-cli package root");
    }
    dir = parent;
  }
}

/**
 * Resolve the absolute path to the built Vite client dist. Precedence:
 *   1. `PIX_CLIENT_DIST`
 *   2. `<workspace-root>/packages/client/dist` (workspace source layout)
 *   3. `<cli-package-root>/client` (REL1 self-contained bundle: the built
 *      Vite dist is shipped inside the release tarball so `pix start` serves
 *      the UI from a standalone `npm i -g` install with no workspace root)
 *
 * Fails closed when `index.html` is absent so the host never silently serves an
 * empty document root. Returns an absolute path.
 */
export function resolveClientDist(): string {
  const override = process.env[CLIENT_DIST_ENV];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(join(override, "index.html"))) {
      throw new Error(
        `[pix] client dist not found (index.html missing): ${override}\n` +
          "[pix] build the client first: npm run build",
      );
    }
    return resolve(override);
  }
  // Workspace source layout: <workspace-root>/packages/client/dist. Missing or
  // absent workspace root falls through to the bundle layout below.
  try {
    const workspaceCandidate = join(resolveWorkspaceRoot(), "packages", "client", "dist");
    if (existsSync(join(workspaceCandidate, "index.html"))) {
      return resolve(workspaceCandidate);
    }
  } catch {
    // no workspace root (standalone REL1 bundle install) — fall through
  }
  // REL1 bundle layout: <cli-package-root>/client (built Vite dist shipped in
  // the self-contained release tarball).
  const bundleCandidate = join(resolveCliPackageRoot(), "client");
  if (!existsSync(join(bundleCandidate, "index.html"))) {
    throw new Error(
      `[pix] client dist not found (index.html missing): ${bundleCandidate}\n` +
        "[pix] build the client first: npm run build (or set PIX_CLIENT_DIST)",
    );
  }
  return resolve(bundleCandidate);
}

/** Path to the foreground `pix-sessiond` bin, resolved from this package. */
export function resolveSessiondBin(): string {
  return join(resolveCliPackageRoot(), "bin", "pix-sessiond.mjs");
}
