import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { readBoundedBody, readJsonObject } from "../resources/request-body.js";
import type { SessionDeleteSeam, SessionHistoryReadClient, SessionRenameSeam } from "../types.js";

/**
 * Session history routes (D1A-2 phase 2 read-only + D4 session-history delete
 * + D4 session rename).
 *
 * Three GET endpoints proxy the sessiond-backed catalog through a narrow
 * {@link SessionHistoryReadClient}: `sessions.list` / `sessions.read` /
 * `sessions.context`. None of them can activate a Worker — the catalog is pure
 * read-only JSONL access. The capability is advertised (`sessions` token) only
 * while sessiond is up; while down the RPC fails and these routes answer 503.
 *
 * D4: when a {@link SessionDeleteSeam} is wired, DELETE /v1/sessions/:id is
 * mounted. It runs the production mutation guard (sessiond `system.ping`) FIRST
 * and only then validates id/body and issues the narrow delete RPC. The route is
 * deliberately protocol-independent: the narrow delete client (wired in
 * composition) returns the already schema-parsed sessiond result as `unknown`.
 *
 * D4: when a {@link SessionRenameSeam} is wired, PATCH /v1/sessions/:id is
 * mounted. Same authority-first precedent: the production mutation guard runs
 * BEFORE any query/body parsing, then a strict single-field `name` body is
 * validated and canonicalized once and the narrow `sessions.rename` RPC is
 * issued exactly once. sessiond decides live vs offline; live rename is
 * supported and never mapped to busy.
 */

/** Hard bounds mirror the Protocol SessionsListParamsSchema (frozen). */
export const SESSIONS_MAX_LIMIT = 1_000;
export const SESSIONS_MAX_OFFSET = 100_000;

/** Small ceiling for detecting an unexpected DELETE body (rejected 400). */
const DELETE_BODY_LIMIT = 4 * 1024;

/** Frozen rename body ceiling (bounded body max 4 KiB). */
const RENAME_BODY_LIMIT = 4 * 1024;

/** Frozen session-name length cap (mirrors the adapter/sessiond/UX rule). */
const MAX_SESSION_NAME_LENGTH = 200;

interface SessionRouteDeps {
  /** Narrow read-only client (the sessiond RPC catalog). */
  client: SessionHistoryReadClient;
  /** D4 mutation seam; when absent the DELETE route is NOT mounted. */
  delete?: SessionDeleteSeam;
  /** D4 rename seam; when absent the PATCH route is NOT mounted. */
  rename?: SessionRenameSeam;
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

/**
 * Map a sessiond delete failure onto an honest HTTP error (D4).
 *
 *   not_found                       → 404 SESSION_NOT_FOUND
 *   session_busy / conflict (live)  → 409 SESSION_IN_USE (fixed)
 *   timeout / unavailable / auth /  → 503 SESSIONS_UNAVAILABLE
 *   worker_unavailable / unknown    → 503 SESSIONS_UNAVAILABLE (sanitized)
 *
 * The message is always a fixed, sanitized string: session ids, the endpoint
 * path, the secret and any stack are never forwarded to the caller.
 */
export function mapSessionDeleteError(error: unknown): HttpError {
  const code = sessionErrorCode(error);
  if (code === "not_found") {
    return new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
  }
  if (code === "session_busy" || code === "conflict") {
    return new HttpError(409, "SESSION_IN_USE", "Session is currently in use");
  }
  return new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
}

/**
 * Map a sessiond rename failure onto an honest HTTP error (D4).
 *
 *   not_found                      → 404 SESSION_NOT_FOUND
 *   conflict / epoch_changed       → 409 SESSION_CHANGED (identity changed)
 *   timeout / unavailable / auth / → 503 SESSION_RENAME_UNAVAILABLE
 *   unsupported / internal / busy / worker_unavailable / unknown → 503
 *                                   SESSION_RENAME_UNAVAILABLE (sanitized)
 *
 * Live rename is deliberately NOT mapped to busy: sessiond supports renaming a
 * live session (via set_session_name) so `session_busy` never means "in use"
 * here — it falls through to the fixed 503 with the other failures.
 *
 * The message is always a fixed, sanitized string: session ids, the endpoint
 * path, the secret, the raw name and any stack are never forwarded to the
 * caller.
 */
export function mapSessionRenameError(error: unknown): HttpError {
  const code = sessionErrorCode(error);
  if (code === "not_found") {
    return new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
  }
  if (code === "conflict" || code === "epoch_changed") {
    return new HttpError(409, "SESSION_CHANGED", "Session changed during rename");
  }
  return new HttpError(503, "SESSION_RENAME_UNAVAILABLE", "Session rename is unavailable");
}

/**
 * Parse a PATCH rename body into the single `name` field. The body must be a
 * strict object with EXACTLY ONE own enumerable field named `name` — arrays,
 * inherited/prototype keys, unknown fields and coercion are all rejected with a
 * fixed 400 INVALID_SESSION_NAME. The value must already be a string (no
 * coercion); full canonicalization happens in {@link canonicalizeSessionName}.
 */
function parseRenameBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "name") {
    throw new HttpError(400, "INVALID_SESSION_NAME", "Session name is invalid");
  }
  const name = body.name;
  if (typeof name !== "string") {
    throw new HttpError(400, "INVALID_SESSION_NAME", "Session name is invalid");
  }
  return name;
}

/**
 * Canonicalize a session display name with the current protocol/domain rule
 * (mirrors sessiond/adapter): string trimmed of outer whitespace, non-blank,
 * at most 200 Unicode JS (UTF-16) code units, and NUL / C0 / DEL control
 * characters rejected. Unicode/emoji/internal ordinary spaces are allowed.
 * No coercion: the value must already be a string. The trimmed name is what the
 * rename RPC receives and what sessiond returns. A raw user name never crosses
 * the boundary untrimmed. Every violation is a fixed 400 INVALID_SESSION_NAME
 * that never echoes the raw name.
 */
function canonicalizeSessionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "INVALID_SESSION_NAME", "Session name is invalid");
  }
  if (trimmed.length > MAX_SESSION_NAME_LENGTH) {
    throw new HttpError(400, "INVALID_SESSION_NAME", "Session name is invalid");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, "INVALID_SESSION_NAME", "Session name is invalid");
  }
  return trimmed;
}

/**
 * DELETE takes no request body and no `force`. Any non-empty body (declared via
 * Content-Length or streamed) is rejected with a fixed 400 BEFORE the RPC —
 * there is no force/busy-bypass surface on this route.
 */
async function requireNoBody(c: import("hono").Context<HostEnv>): Promise<void> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) === 0) return;
  const bytes = await readBoundedBody(c.req.raw, DELETE_BODY_LIMIT).catch(() => new Uint8Array([1]));
  if (bytes.byteLength > 0) {
    throw new HttpError(400, "REQUEST_BODY_NOT_ALLOWED", "This endpoint does not accept a request body");
  }
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
  // Only canonical unsigned decimal digit strings are accepted. `Number()` /
  // `Number.isInteger` would otherwise coerce `1e3`, `0x10`, signs, decimals and
  // surrounding whitespace into valid integers; reject them explicitly so a
  // query value is what it claims to be, byte for byte.
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new HttpError(400, "INVALID_QUERY", `${field} must be an integer in [${min}, ${max}]`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
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

  // D4 session-history delete. Mounted ONLY when the mutation seam is present
  // (production: narrow delete client + sessiond `system.ping` mutation guard).
  // A generic composition with no delete seam gets no DELETE route and no
  // `session.delete` capability token.
  if (deps.delete) {
    app.delete("/v1/sessions/:id", async (c) => {
      // Production mutation guard FIRST: sessiond must be up before any RPC or
      // catalog effect. A down authority 503s before touching anything. The
      // shared auth/LAN gate already ran in the global middleware chain.
      await deps.delete!.mutationGuard.assertAvailable();
      // No force/override/query surface: ANY query string (even a bare `?`) is
      // rejected with a fixed 400 BEFORE session id/body validation and the
      // delete RPC. There is no force/busy-bypass on this route.
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      const sessionId = requireSessionId(c.req.param("id"));
      await requireNoBody(c);
      try {
        await deps.delete!.client.delete(sessionId);
      } catch (error) {
        throw mapSessionDeleteError(error);
      }
      return c.json({ success: true });
    });
  }

  // D4 session rename. Mounted ONLY when the rename seam is present (production:
  // narrow rename client + sessiond `system.ping` mutation guard). A generic
  // composition with no rename seam gets no PATCH route and no `session.write`
  // capability token. Frozen order: auth/LAN gate (global) → mutation guard →
  // query reject → session id → content-type → bounded body → strict single
  // field → canonicalize name → rename RPC once → success only after sessiond
  // confirmed live/offline rename. Body/name/session/raw adapter/worker errors
  // are never logged or returned.
  if (deps.rename) {
    app.patch("/v1/sessions/:id", async (c) => {
      // Production mutation guard FIRST: sessiond must be up before parsing any
      // attacker-controlled query/body. A down authority 503s before touching
      // anything. The shared auth/LAN gate already ran in the global middleware
      // chain.
      await deps.rename!.mutationGuard.assertAvailable();
      // No query surface at all: ANY query string (even a bare `?`) is rejected
      // with a fixed 400 BEFORE session id/body validation and the rename RPC.
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      const sessionId = requireSessionId(c.req.param("id"));
      // Content-type must be application/json (existing 415), body bounded to
      // 4 KiB (413), malformed/non-object JSON is the existing fixed 400.
      const body = await readJsonObject(c, RENAME_BODY_LIMIT);
      // Strict object: exactly one own `name` field, no arrays/prototype/
      // unknown fields, string value only (no coercion).
      const name = parseRenameBody(body);
      // Canonicalize the name exactly once (trim / non-blank / ≤200 / no C0).
      const canonicalName = canonicalizeSessionName(name);
      try {
        await deps.rename!.client.rename(sessionId, canonicalName);
      } catch (error) {
        throw mapSessionRenameError(error);
      }
      return c.json({ success: true });
    });
  }
}
