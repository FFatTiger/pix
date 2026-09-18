import type { Context } from "hono";
import type { HostLogger } from "./types.js";

/** Standard JSON error body. `message` is a top-level alias so the C0 client's
 *  HttpError (which reads `body.message`) renders a useful message. */
export interface ApiErrorBody {
  error: string;
  code: string;
  message: string;
}

export function apiErrorBody(code: string, message: string): ApiErrorBody {
  return { error: message, code, message };
}

/** Throwable error with an HTTP status, mapped by the unified error handler. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function isV1Path(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

/** Unified error mapping: HttpError → its status, everything else → 500. */
export function unifiedErrorHandler(logger: HostLogger) {
  return (err: Error, c: Context): Response => {
    if (err instanceof HttpError) {
      return c.json(apiErrorBody(err.code, err.message), err.status as 400);
    }
    logger.error?.(`unhandled error: ${String(err?.stack ?? err)}`, {
      requestId: c.get("requestId"),
      path: c.req.path,
    });
    return c.json(apiErrorBody("INTERNAL", "Internal server error"), 500);
  };
}
