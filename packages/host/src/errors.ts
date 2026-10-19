import type { Context } from "hono";
import type { HostLogger } from "./types.js";

/** Standard JSON error body. `message` is a top-level alias so the C0 client's
 *  HttpError (which reads `body.message`) renders a useful message. `details`
 *  carries structured, sanitized rejection facts (for models.json: which
 *  provider / model / field was refused) so the client can name the field. */
export interface ApiErrorBody {
  error: string;
  code: string;
  message: string;
  details?: unknown;
}

export function apiErrorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: message, code, message, ...(details === undefined ? {} : { details }) };
}

/** Throwable error with an HTTP status, mapped by the unified error handler. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Structured sanitized rejection facts; never raw backend text/paths. */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isV1Path(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

/** Unified error mapping: HttpError → its status, everything else → 500. */
export function unifiedErrorHandler(logger: HostLogger) {
  return (err: Error, c: Context): Response => {
    if (err instanceof HttpError) {
      return c.json(apiErrorBody(err.code, err.message, err.details), err.status as 400);
    }
    logger.error?.(`unhandled error: ${String(err?.stack ?? err)}`, {
      requestId: c.get("requestId"),
      path: c.req.path,
    });
    return c.json(apiErrorBody("INTERNAL", "Internal server error"), 500);
  };
}
