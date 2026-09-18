import { compress } from "hono/compress";
import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../env.js";

/**
 * Response compression scoped to the compressible text payloads pix actually
 * serves: JSON API bodies, JavaScript modules and CSS. Everything else — HTML,
 * SSE (`text/event-stream`), images, fonts, binaries — passes through
 * uncompressed (SSE events must never be buffered behind a compression
 * window, and already-compressed media would only grow).
 *
 * The underlying transform is Hono's official `compress` middleware
 * (Web-standard `CompressionStream`; gzip/deflate negotiated via
 * `Accept-Encoding`, `Vary: Accept-Encoding` set, small bodies and
 * `no-transform` responses skipped). Only the content-type scope is pix policy.
 */
const COMPRESSIBLE_CONTENT_TYPE_REGEX =
  /^\s*(?:application\/json|application\/[a-z0-9.+-]+\+json|text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/css)\b/i;

/** Exposed for tests: exactly the JSON/JS/CSS content-type scope. */
export function compressibleContentType(contentType: string): boolean {
  return COMPRESSIBLE_CONTENT_TYPE_REGEX.test(contentType);
}

/** JSON/JS/CSS response compression (see {@link compressibleContentType}). */
export function compressionMiddleware(thresholdBytes = 1024): MiddlewareHandler<HostEnv> {
  return compress({
    threshold: thresholdBytes,
    contentTypeFilter: compressibleContentType,
  });
}
