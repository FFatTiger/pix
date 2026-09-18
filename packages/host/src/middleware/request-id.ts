import { randomUUID } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { HostEnv } from "../env.js";

export const REQUEST_ID_HEADER = "x-request-id";

/** Assigns a unique request id and echoes it back on the response. */
export function requestIdMiddleware(): MiddlewareHandler<HostEnv> {
  return createMiddleware(async (c, next) => {
    const id = randomUUID();
    c.set("requestId", id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
  });
}
