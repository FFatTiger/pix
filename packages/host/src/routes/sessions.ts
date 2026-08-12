import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { SessionHistoryReadClient } from "../types.js";

/**
 * Read-only session history routes (D1A-2 phase 2).
 *
 * Three GET endpoints proxy the sessiond-backed catalog through a narrow
 * {@link SessionHistoryReadClient}: `sessions.list` / `sessions.read` /\n * `sessions.context`. None of them can activate a Worker — the catalog is pure
 * read-only JSONL access. The capability is advertised (`sessions` token) only
 * while sessiond is up; while down the RPC fails and these routes answer 503.
 *
 * This route module is deliberately protocol-independent: the narrow client
 * (wired in composition) returns the already schema-parsed sessiond result as
 * `unknown`, and this module narrows it to the response shape. Protocol schema
 * types stay confined to packages/pi-sdk-adapter + the composition layer.
 */

/** Hard bounds mirror the Protocol SessionsListParamsSchema (frozen). */
export const SESSIONS_MAX_LIMIT = 1_000;
export const SESSIONS_MAX_OFFSET = 100_000;

interface SessionRouteDeps {
  /** Narrow read-only client (the sessiond RPC catalog). */
  client: SessionHistoryReadClient;
}

/**
 * Map a sessiond catalog/RPC exception onto an honest HTTP error.
 *
 *   not_found                       → 404 SESSION_NOT_FOUND
 *   timeout / unavailable / auth /  → 503 SESSIONS_UNAVAILABLE
 *   worker_unavailable / unknown    → 503 SESSIONS_UNAVAILABLE (sanitized)
 *
 * The message is always a fixed, sanitized string: session ids, the endpoint
 * path, the secret and any stack are never forwarded to the caller.
 */
export function mapSessionCatalogError(error: unknown): HttpError {
  if (sessionErrorCode(error) === "not_found") {
    return new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
  }
  return new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
}

function sessionErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** Parse a query integer with a closed, frozen range. Invalid → 400. */
function boundedInt(
  raw: string | undefined,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  // Empty string is treated as "not provided" so a stray `?limit=` is not a 400.
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, "INVALID_QUERY", `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** Validate a session id path param is a non-empty string. */
function requireSessionId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpError(400, "SESSION_ID_REQUIRED", "session id is required");
  }
  return id;
}

// Structural views over the already-parsed sessiond results (no protocol import).
interface SessionListResult { sessions: Record<string, unknown>[] }
interface SessionContextResult { sessionId: string; leafId?: string; entries: unknown[] }

export function registerSessionRoutes(app: Hono<HostEnv>, deps: SessionRouteDeps): void {
  app.get("/v1/sessions", async (c) => {
    const cwdRaw = c.req.query("cwd");
    // An empty cwd is treated as absent (no filter), matching the client helper.
    const cwd = cwdRaw && cwdRaw.length > 0 ? cwdRaw : undefined;
    const limit = boundedInt(c.req.query("limit"), "limit", 1, SESSIONS_MAX_LIMIT);
    const offset = boundedInt(c.req.query("offset"), "offset", 0, SESSIONS_MAX_OFFSET);
    const params: { cwd?: string; limit?: number; offset?: number } = {};
    if (cwd !== undefined) params.cwd = cwd;
    if (limit !== undefined) params.limit = limit;
    if (offset !== undefined) params.offset = offset;
    let result: unknown;
    try {
      result = await deps.client.list(params);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const parsed = result as SessionListResult;
    return c.json({ sessions: [...parsed.sessions] });
  });

  app.get("/v1/sessions/:id", async (c) => {
    const sessionId = requireSessionId(c.req.param("id"));
    let result: unknown;
    try {
      result = await deps.client.read(sessionId);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    return c.json({ session: { ...(result as Record<string, unknown>) } });
  });

  app.get("/v1/sessions/:id/context", async (c) => {
    const sessionId = requireSessionId(c.req.param("id"));
    const leafIdRaw = c.req.query("leafId");
    const leafId = leafIdRaw && leafIdRaw.length > 0 ? leafIdRaw : undefined;
    let result: unknown;
    try {
      result = await deps.client.context(sessionId, leafId);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const parsed = result as SessionContextResult;
    return c.json({ context: { ...parsed, entries: [...parsed.entries] } });
  });
}
