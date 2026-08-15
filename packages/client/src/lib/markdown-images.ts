import { urls } from "@/api/urls";
import { resolveLocalFileHref } from "./file-links";

/**
 * Resolve a markdown image src to a renderable URL.
 *
 * Local filesystem paths (relative to the markdown file / cwd, absolute
 * paths, and `file:` URIs) are rewritten to the pix files read endpoint so
 * the browser can actually fetch them. http(s) URLs and data:image URIs pass
 * through unchanged. Anything else (`javascript:`, `data:text/html`, …)
 * returns null so the caller can drop the image.
 *
 * This is the security gate that replaces the sanitize protocol check for
 * `img src`: the sanitize schema (lib/markdown.ts) deliberately lets `src`
 * through untouched so local paths survive to the render component, and only
 * the URL shapes handled here are ever emitted into the DOM.
 *
 * pix adapter note: the source rewrote local paths to the legacy files read
 * route; pix uses the same-origin /v1/files resource endpoint (op=read) via
 * the shared URL builder in @/api/urls.
 */
export function resolveMarkdownImageSrc(
  src: string | Blob | undefined,
  baseDir?: string,
  relativeRoot = baseDir,
  sessionId?: string | null,
): string | null {
  if (typeof src !== "string" || !src) return null;

  const localPath = resolveLocalFileHref(src, baseDir, relativeRoot);
  if (localPath) {
    return urls.files.file(localPath, "read", { sessionId });
  }

  // Same-origin pix API endpoints are trusted.
  if (/^\/v1\//.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:image\//i.test(src)) return src;

  return null;
}
