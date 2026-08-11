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
 *   2. `<workspace-root>/packages/client/dist`
 *
 * Fails closed when `index.html` is absent so the host never silently serves an
 * empty document root. Returns an absolute path.
 */
export function resolveClientDist(): string {
  const override = process.env[CLIENT_DIST_ENV];
  const candidate =
    override !== undefined && override.length > 0
      ? override
      : join(resolveWorkspaceRoot(), "packages", "client", "dist");
  if (!existsSync(join(candidate, "index.html"))) {
    throw new Error(
      `[pix] client dist not found (index.html missing): ${candidate}\n` +
        "[pix] build the client first: npm run build",
    );
  }
  return resolve(candidate);
}

/** Path to the foreground `pix-sessiond` bin, resolved from this package. */
export function resolveSessiondBin(): string {
  return join(resolveCliPackageRoot(), "bin", "pix-sessiond.mjs");
}
