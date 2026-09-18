import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../env.js";
import type { HostLogger } from "../types.js";

/** Structured request logging with duration and request id. */
export function loggingMiddleware(logger: HostLogger): MiddlewareHandler<HostEnv> {
  return createMiddleware(async (c, next) => {
    const started = performance.now();
    await next();
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
      requestId: c.get("requestId"),
    };
    const message = `${c.req.method} ${c.req.path} ${status} ${durationMs}ms`;
    if (status >= 500) logger.error?.(message, fields);
    else if (status >= 400) logger.warn?.(message, fields);
    else logger.info?.(message, fields);
  });
}
