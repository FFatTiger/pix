import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Context } from "hono";
import type { HostEnv } from "../env.js";
import { apiErrorBody, isV1Path } from "../errors.js";

export interface SpaFallbackOptions {
  clientDist?: string;
}

function safeIndexHtml(clientDist: string | undefined): string | null {
  if (!clientDist) return null;
  try {
    const root = realpathSync(resolve(clientDist));
    const candidate = resolve(root, "index.html");
    if (lstatSync(candidate).isSymbolicLink()) return null;
    const canonical = realpathSync(candidate);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return null;
    return canonical;
  } catch {
    return null;
  }
}

/**
 * Terminal handler: JSON 404 for /v1/* (never index.html), SPA fallback to
 * index.html for HTML-accepting GET/HEAD requests, plain 404 otherwise.
 */
export function spaOrJsonNotFound(options: SpaFallbackOptions) {
  const indexHtml = safeIndexHtml(options.clientDist);
  return (c: Context<HostEnv>): Response => {
    const pathname = new URL(c.req.url).pathname;
    if (isV1Path(pathname)) {
      return c.json(apiErrorBody("NOT_FOUND", "Not Found"), 404);
    }
    if (
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      wantsHtml(c) &&
      indexHtml
    ) {
      try {
        const html = readFileSync(indexHtml);
        c.header("Content-Type", "text/html; charset=utf-8");
        c.header("Cache-Control", "no-cache");
        return c.body(html, 200);
      } catch {
        // fall through to plain 404
      }
    }
    return c.text("Not Found", 404);
  };
}

function wantsHtml(c: Context<HostEnv>): boolean {
  const accept = c.req.header("accept") ?? "";
  return accept === "" || accept.includes("text/html") || accept.includes("*/*");
}
