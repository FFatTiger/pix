import { lstat, stat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../env.js";
import { isV1Path } from "../errors.js";

export interface StaticAssetsOptions {
  /** Absolute path to the Vite client build output. */
  clientDist?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";
/** Assets that must never be cached (service worker / manifest / offline page). */
const NO_CACHE_ASSETS = new Set(["/sw.js", "/manifest.webmanifest", "/offline.html"]);

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) return IMMUTABLE_CACHE;
  return NO_CACHE;
}

/**
 * Resolve a decoded URL pathname to a file inside `root`, or null when the
 * path is unsafe (traversal / control chars) or outside the root.
 */
export function resolveClientFile(root: string, pathname: string): string | null {
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  return target;
}

function isNoCacheAsset(pathname: string): boolean {
  return NO_CACHE_ASSETS.has(pathname);
}

async function canonicalFileWithinRoot(root: string, target: string): Promise<string | null> {
  let canonicalRoot: string;
  let canonicalTarget: string;
  try {
    canonicalRoot = await realpath(root);
    const linkStats = await lstat(target);
    if (linkStats.isSymbolicLink()) return null;
    canonicalTarget = await realpath(target);
  } catch {
    return null;
  }
  if (
    canonicalTarget !== canonicalRoot &&
    !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)
  ) {
    return null;
  }
  return canonicalTarget;
}

/**
 * Vite static asset serving. Runs after routing so /v1/* is never intercepted;
 * only GET/HEAD non-API paths are considered. Missing files fall through to
 * the SPA fallback (notFound handler).
 */
export function staticAssetsMiddleware(
  options: StaticAssetsOptions,
): MiddlewareHandler<HostEnv> {
  const root = options.clientDist ? resolve(options.clientDist) : null;
  if (!root) {
    return createMiddleware(async (_c, next) => {
      await next();
    });
  }

  return createMiddleware(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const pathname = new URL(c.req.url).pathname;
    if (isV1Path(pathname)) return next();

    const target = resolveClientFile(root, pathname);
    if (!target) return c.text("Not Found", 404);

    try {
      await lstat(target);
    } catch {
      return next();
    }
    let canonicalTarget = await canonicalFileWithinRoot(root, target);
    if (!canonicalTarget) return c.text("Not Found", 404);

    let stats;
    try {
      stats = await stat(canonicalTarget);
    } catch {
      return next();
    }

    if (stats.isDirectory()) {
      const index = `${canonicalTarget}${sep}index.html`;
      try {
        await lstat(index);
      } catch {
        return next();
      }
      canonicalTarget = await canonicalFileWithinRoot(root, index);
      if (!canonicalTarget) return c.text("Not Found", 404);
      try {
        stats = await stat(canonicalTarget);
      } catch {
        return next();
      }
      if (!stats.isFile()) return next();
      return serveFile(c, canonicalTarget, cacheControlFor(pathname));
    }
    if (!stats.isFile()) return next();

    return serveFile(c, canonicalTarget, cacheControlFor(pathname));
  });
}

async function serveFile(
  c: Context<HostEnv>,
  filePath: string,
  cacheControl: string,
): Promise<Response> {
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    return c.text("Not Found", 404);
  }
  const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  c.header("Content-Type", type);
  c.header("Cache-Control", cacheControl);
  const payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return c.body(payload, 200);
}

export { isNoCacheAsset };
