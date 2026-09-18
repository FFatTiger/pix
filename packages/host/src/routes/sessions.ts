import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import { readBoundedBody, readJsonObject } from "../resources/request-body.js";
import { classifyWorkspaceAccess } from "../resources/workspace-access.js";
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
 *
 * Phase 6A: GET list/detail project additive `workspaceAccess` from AllowedRoots.
 * Catalog visibility is never authorization; classification never expands roots,
 * never parses JSONL/Pi SDK, and never advertises models/files/skills/send.
 */

/** Hard bounds mirror the Protocol true-page schemas. */
export const SESSIONS_MAX_PAGE_SIZE = 100;
export const PROJECTS_MAX_PAGE_SIZE = 50;

/** Small ceiling for detecting an unexpected DELETE body (rejected 400). */
const DELETE_BODY_LIMIT = 4 * 1024;

/** Frozen rename body ceiling (bounded body max 4 KiB). */
const RENAME_BODY_LIMIT = 4 * 1024;

/** Frozen session-name length cap (mirrors the adapter/sessiond/UX rule). */
const MAX_SESSION_NAME_LENGTH = 200;

interface SessionRouteDeps {
  /** Narrow read-only client (the sessiond RPC catalog). */
  client: SessionHistoryReadClient;
  /**
   * Phase 6A AllowedRoots classifier. Production wires the same service as
   * resources.allowedRoots. Omitted ⇒ history_only (never guessed authorized).
   */
  roots?: AllowedRootService;
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
  // Protocol v2: an invalid/absent history cursor fails closed with a FIXED
  // 400 INVALID_HISTORY_CURSOR. The cursor value, branch/path and any backend
  // text are never echoed.
  if (sessionErrorCode(error) === "invalid_input") {
    return new HttpError(400, "INVALID_HISTORY_CURSOR", "History cursor is invalid");
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
 * Map a sessiond deferred-thinking failure onto an honest HTTP error
 * (direct source-history parity).
 *
 *   not_found (session/entry/non-thinking block) → 404 SESSION_ENTRY_NOT_FOUND
 *   invalid_input (malformed identity)          → 400 INVALID_HISTORY_CURSOR
 *   timeout / unavailable / auth / unknown      → 503 SESSIONS_UNAVAILABLE
 *
 * The message is always a fixed, sanitized string: entry ids, block indexes,
 * the endpoint path, the secret and any backend text are never forwarded.
 */
export function mapSessionThinkingError(error: unknown): HttpError {
  const code = sessionErrorCode(error);
  if (code === "not_found") {
    return new HttpError(404, "SESSION_ENTRY_NOT_FOUND", "Session entry not found");
  }
  if (code === "invalid_input") {
    return new HttpError(400, "INVALID_HISTORY_CURSOR", "History cursor is invalid");
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

/**
 * Parse a direct-history deferral flag. The ONLY canonical spelling is `1`
 * (`?deferThinking=1`); the flag is absent → undefined (no deferral).
 * Everything else — a bare `?deferThinking`, `=true`, `=yes`, `=0`, `=01`,
 * whitespace or repeated values — is a fixed 400 INVALID_QUERY (fail-closed,
 * never a truthy coercion and never silently ignored).
 */
function canonicalFlag(raw: string | undefined, field: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "1") return true;
  throw new HttpError(400, "INVALID_QUERY", `${field} must be 1`);
}

function requireOnlyQueryKeys(url: string, allowed: readonly string[]): void {
  const keys = [...new URL(url).searchParams.keys()];
  const seen = new Set<string>();
  for (const key of keys) {
    if (!allowed.includes(key) || seen.has(key)) {
      throw new HttpError(400, "INVALID_QUERY", "Query parameters are invalid");
    }
    seen.add(key);
  }
}

/** Validate a session id path param is a non-empty string. */
function requireSessionId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new HttpError(400, "SESSION_ID_REQUIRED", "session id is required");
  }
  return id;
}

// Structural views over the already-parsed sessiond results (no protocol import).
interface PageMetaResult {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  catalogRevision: number;
}
interface SessionListResult extends PageMetaResult { sessions: Record<string, unknown>[] }
interface ProjectListResult extends PageMetaResult { projects: Record<string, unknown>[] }
interface SessionContextResult {
  sessionId: string;
  leafId?: string;
  entries: unknown[];
  settings?: { model: unknown; thinkingLevel: unknown };
  contextTokens?: number | null;
  pageInfo: { hasMore: boolean; nextCursor?: string };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project a session header/detail onto the Host wire. Host ALWAYS overwrites
 * `workspaceAccess` from AllowedRoots — adapter/sessiond values are ignored
 * (never guessed authorized, never a visibility grant). Catalog errors stay
 * honest: this projector is only reached after a successful catalog read.
 */
function validPageMeta(value: unknown): value is PageMetaResult {
  if (!isPlainObject(value)) return false;
  return Number.isSafeInteger(value.page) && (value.page as number) >= 1
    && Number.isSafeInteger(value.pageSize) && (value.pageSize as number) >= 1
    && Number.isSafeInteger(value.total) && (value.total as number) >= 0
    && Number.isSafeInteger(value.totalPages) && (value.totalPages as number) >= 0
    && Number.isSafeInteger(value.catalogRevision) && (value.catalogRevision as number) >= 0;
}

async function projectSessionRecord(
  roots: AllowedRootService | undefined,
  raw: unknown,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(raw)) {
    throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
  }
  const projected: Record<string, unknown> = { ...raw };
  // Adapter-supplied classification is never trusted; Host is the authority.
  delete projected.workspaceAccess;
  try {
    projected.workspaceAccess = await classifyWorkspaceAccess(roots, {
      cwd: projected.cwd,
      projectRoot: projected.projectRoot,
    });
  } catch {
    throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
  }
  return projected;
}

export function registerSessionRoutes(app: Hono<HostEnv>, deps: SessionRouteDeps): void {
  app.get("/v1/projects", async (c) => {
    requireOnlyQueryKeys(c.req.url, ["page", "pageSize"]);
    const page = boundedInt(c.req.query("page"), "page", 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const pageSize = boundedInt(c.req.query("pageSize"), "pageSize", 1, PROJECTS_MAX_PAGE_SIZE) ?? 10;
    let result: unknown;
    try {
      result = await deps.client.projects({ page, pageSize });
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const parsed = result as ProjectListResult;
    if (!validPageMeta(parsed) || !Array.isArray(parsed.projects) || parsed.projects.some((project) => !isPlainObject(project))) {
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Project catalog is unavailable");
    }
    return c.json(parsed);
  });

  app.get("/v1/sessions", async (c) => {
    requireOnlyQueryKeys(c.req.url, ["page", "pageSize", "cwd", "projectRoot"]);
    const cwdRaw = c.req.query("cwd");
    const cwd = cwdRaw && cwdRaw.length > 0 ? cwdRaw : undefined;
    const projectRootRaw = c.req.query("projectRoot");
    const projectRoot = projectRootRaw && projectRootRaw.length > 0 ? projectRootRaw : undefined;
    const page = boundedInt(c.req.query("page"), "page", 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const pageSize = boundedInt(c.req.query("pageSize"), "pageSize", 1, SESSIONS_MAX_PAGE_SIZE) ?? 50;
    const params: { page: number; pageSize: number; cwd?: string; projectRoot?: string } = { page, pageSize };
    if (cwd !== undefined) params.cwd = cwd;
    if (projectRoot !== undefined) params.projectRoot = projectRoot;
    let result: unknown;
    try {
      result = await deps.client.list(params);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const parsed = result as SessionListResult;
    if (!validPageMeta(parsed) || !Array.isArray(parsed.sessions)) {
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
    }
    const sessions = await Promise.all(
      parsed.sessions.map((session) => projectSessionRecord(deps.roots, session)),
    );
    return c.json({ ...parsed, sessions });
  });

  app.get("/v1/sessions/:id", async (c) => {
    const sessionId = requireSessionId(c.req.param("id"));
    let result: unknown;
    try {
      result = await deps.client.read(sessionId);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const session = await projectSessionRecord(deps.roots, result);
    // Detail is the exact workspace/header authority, not a second transcript
    // transport. Current sessiond already omits entries; strip defensively for
    // older/mixed producers so HTTP can never duplicate the bounded context
    // pages or make Client authorization depend on a huge response.
    delete session.entries;
    return c.json({ session });
  });

  app.get("/v1/sessions/:id/context", async (c) => {
    const sessionId = requireSessionId(c.req.param("id"));
    const leafIdRaw = c.req.query("leafId");
    const leafId = leafIdRaw && leafIdRaw.length > 0 ? leafIdRaw : undefined;
    const beforeRaw = c.req.query("before");
    const before = beforeRaw && beforeRaw.length > 0 ? beforeRaw : undefined;
    const limit = boundedInt(c.req.query("limit"), "limit", 1, 200);
    // Direct-history deferral flags: ONLY the canonical `1` spelling is
    // accepted; anything else fails closed with a fixed 400 (never coerced,
    // never silently ignored).
    const deferThinking = canonicalFlag(c.req.query("deferThinking"), "deferThinking");
    const deferMedia = canonicalFlag(c.req.query("deferMedia"), "deferMedia");
    const params: {
      leafId?: string;
      before?: string;
      limit?: number;
      deferThinking?: boolean;
      deferMedia?: boolean;
    } = {};
    if (leafId !== undefined) params.leafId = leafId;
    if (before !== undefined) params.before = before;
    if (limit !== undefined) params.limit = limit;
    if (deferThinking !== undefined) params.deferThinking = deferThinking;
    if (deferMedia !== undefined) params.deferMedia = deferMedia;
    let result: unknown;
    try {
      result = await deps.client.context(sessionId, params);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const parsed = result as SessionContextResult;
    return c.json({
      context: {
        sessionId: parsed.sessionId,
        ...(parsed.leafId === undefined ? {} : { leafId: parsed.leafId }),
        entries: [...parsed.entries],
        ...(parsed.settings === undefined ? {} : { settings: { ...parsed.settings } }),
        ...(parsed.contextTokens === undefined ? {} : { contextTokens: parsed.contextTokens }),
        pageInfo: {
          hasMore: parsed.pageInfo.hasMore,
          ...(parsed.pageInfo.nextCursor === undefined ? {} : { nextCursor: parsed.pageInfo.nextCursor }),
        },
      },
    });
  });

  // Direct source-history parity: resolve ONE deferred thinking block by exact
  // session/entry/block identity. `blockIndex` must be a canonical non-negative
  // decimal (`?blockIndex=2`); a missing or malformed value is a fixed 400
  // BEFORE the RPC. Identity errors stay fail-closed: unknown session / entry /
  // non-assistant entry / non-thinking block → fixed 404 SESSION_ENTRY_NOT_FOUND
  // (never a partial or guessed block); daemon failures → sanitized 503. Zero
  // workers — the seam is the same read-only catalog as context/tree.
  app.get("/v1/sessions/:id/entries/:entryId/thinking", async (c) => {
    const sessionId = requireSessionId(c.req.param("id"));
    const entryIdRaw = c.req.param("entryId");
    if (typeof entryIdRaw !== "string" || entryIdRaw.length === 0) {
      throw new HttpError(400, "SESSION_ID_REQUIRED", "entry id is required");
    }
    const entryId = entryIdRaw;
    const blockIndex = boundedInt(c.req.query("blockIndex"), "blockIndex", 0, Number.MAX_SAFE_INTEGER);
    if (blockIndex === undefined) {
      throw new HttpError(400, "INVALID_QUERY", "blockIndex must be an integer in [0, 9007199254740991]");
    }
    let result: unknown;
    try {
      result = await deps.client.thinking(sessionId, entryId, blockIndex);
    } catch (error) {
      throw mapSessionThinkingError(error);
    }
    if (
      !isPlainObject(result)
      || result.sessionId !== sessionId
      || result.entryId !== entryId
      || result.blockIndex !== blockIndex
      || typeof result.thinking !== "string"
    ) {
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
    }
    return c.json({ thinking: result.thinking, entryId });
  });

  // Read-only normalized branch tree (BranchNavigator slice). Strict GET with
  // NO query surface: ANY query string (even a bare `?`) is a fixed 400 before
  // the session id is validated or the catalog is touched — leaf selection is
  // the client's job (context?leafId), the tree itself takes no parameters.
  // Errors reuse the shared catalog mapping (not_found → 404, everything else
  // → sanitized 503); the response is the strict tree DTO under `tree`.
  app.get("/v1/sessions/:id/tree", async (c) => {
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    const sessionId = requireSessionId(c.req.param("id"));
    let result: unknown;
    try {
      result = await deps.client.tree(sessionId);
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    return c.json({ tree: { ...(result as Record<string, unknown>) } });
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
