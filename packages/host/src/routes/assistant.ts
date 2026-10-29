/**
 * Assistant routes (GET /v1/assistant, GET /v1/assistant/sessions).
 *
 * The assistant (Pixie) is ONE fixed, Host-managed working directory holding a
 * growing set of conversations. These routes expose exactly that workspace's
 * read surface and nothing else:
 *
 *  - `GET /v1/assistant` — the conversation binding: the canonical directory +
 *    the id of its MOST RECENT session (null until the user's first message
 *    creates one). `?sessionId=<id>` selects ONE exact conversation instead:
 *    the id must exist, be a ROOT session and have a cwd strictly equal to the
 *    server's assistant directory — anything else answers a fixed 404 and NEVER
 *    falls back to "latest".
 *  - `GET /v1/assistant/sessions?page=&pageSize=` — one true numbered page of
 *    the assistant workspace's own conversations (the canonical SessionPage
 *    DTO, identical to /v1/sessions), each row carrying the AllowedRoots
 *    `workspaceAccess` projection. The client never supplies a cwd: sessiond
 *    derives the single canonical assistant directory itself.
 *
 * All reads run through the read-only sessiond catalog (zero workers) and the
 * routes are mounted ONLY when the assistant workspace seam is wired (the
 * directory resolved and authorized within AllowedRoots at composition). A
 * sessiond outage answers 503; the `assistant` capability token is advertised
 * only while sessiond is up, so the entry degrades to hidden, never broken.
 */
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import { mapSessionCatalogError, projectSessionRecord } from "./sessions.js";

/**
 * Narrow read-only client for the sessiond assistant-conversation surface.
 *
 * `findLatest` / `listAssistant` / `read` wrap exactly the read-only
 * `sessions.findLatest` / `sessions.listAssistant` / `sessions.read` catalog
 * RPCs (zero workers) and never the runtime lifecycle. Results are
 * protocol-independent (`unknown`): the real RPC client already schema-validated
 * them and the Host narrows structurally.
 */
export interface AssistantSessionClient {
  findLatest(cwd: string): Promise<{ cwd: string; sessionId: string | null }>;
  /**
   * One true page of the assistant workspace's conversations. Optional: when
   * the seam is absent the history route answers a fixed 503 (never a fake
   * empty page).
   */
  listAssistant?(request: { page: number; pageSize: number }): Promise<unknown>;
  /**
   * Exact session header by id (zero workers), used by the `?sessionId=`
   * selector. Optional: absent ⇒ the selector answers a fixed 503.
   */
  read?(sessionId: string): Promise<unknown>;
}

export interface AssistantRouteDeps {
  /** Canonical assistant workspace directory (composition-authorized). */
  cwd: string;
  /** Narrow sessiond-backed assistant catalog client. */
  client: AssistantSessionClient;
  /**
   * Phase 6A AllowedRoots classifier for the history rows. Production wires
   * the SAME service as `resources.allowedRoots`. Omitted ⇒ history_only
   * (never guessed authorized).
   */
  roots?: AllowedRootService;
}

/** Fixed 404 body for an id that is not an assistant-workspace root session. */
function assistantSessionNotFound(): HttpError {
  return new HttpError(404, "ASSISTANT_SESSION_NOT_FOUND", "Assistant session not found");
}

/**
 * Reject unknown/duplicate query parameters with a fixed 400 BEFORE any RPC
 * (same fail-closed rule as the session history routes).
 */
function requireAssistantQueryKeys(url: string, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of new URL(url).searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) {
      throw new HttpError(400, "INVALID_QUERY", "Query parameters are invalid");
    }
    seen.add(key);
  }
}

/**
 * Parse the true-page query of the assistant history list with the SAME closed
 * bounds as /v1/sessions (canonical unsigned decimals only — no `1e3`, signs,
 * whitespace or fractions), defaulting to 1/50.
 */
function requireAssistantPage(url: string): { page: number; pageSize: number } {
  const params = new URL(url).searchParams;
  const parse = (field: string, max: number): number | undefined => {
    const raw = params.get(field);
    if (raw === null || raw === "") return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new HttpError(400, "INVALID_QUERY", `${field} must be an integer in [1, ${max}]`);
    }
    const value = Number(raw);
    if (value < 1 || value > max) {
      throw new HttpError(400, "INVALID_QUERY", `${field} must be an integer in [1, ${max}]`);
    }
    return value;
  };
  return {
    page: parse("page", Number.MAX_SAFE_INTEGER) ?? 1,
    pageSize: parse("pageSize", ASSISTANT_SESSIONS_MAX_PAGE_SIZE) ?? ASSISTANT_SESSIONS_DEFAULT_PAGE_SIZE,
  };
}

/** Hard bounds mirror the Protocol true-page schema (pageSize ≤ 100). */
const ASSISTANT_SESSIONS_MAX_PAGE_SIZE = 100;
const ASSISTANT_SESSIONS_DEFAULT_PAGE_SIZE = 50;

/** Structural read of the already-parsed `sessions.read` result. */
function readHeader(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
  }
  const record = raw as Record<string, unknown>;
  if (record.session !== null && typeof record.session === "object" && !Array.isArray(record.session)) {
    return record.session as Record<string, unknown>;
  }
  return record;
}

export function registerAssistantRoutes(app: Hono<HostEnv>, deps: AssistantRouteDeps): void {
  app.get("/v1/assistant", async (c) => {
    c.header("Cache-Control", "no-store");
    requireAssistantQueryKeys(c.req.url, ["sessionId"]);
    const selected = c.req.query("sessionId");
    if (selected === undefined) {
      try {
        const latest = await deps.client.findLatest(deps.cwd);
        return c.json({ cwd: deps.cwd, sessionId: latest.sessionId });
      } catch {
        // Fixed sanitized 503: the endpoint depends on the sessiond catalog.
        throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
      }
    }
    if (selected.length === 0) throw assistantSessionNotFound();
    const readSession = deps.client.read;
    if (readSession === undefined) {
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
    }
    let header: Record<string, unknown>;
    try {
      header = readHeader(await readSession(selected));
    } catch (error) {
      // A missing/unknown id is the selector's 404; a sessiond outage stays an
      // honest 503. Never a permissive "latest" fallback.
      const mapped = mapSessionCatalogError(error);
      if (mapped.status === 404) throw assistantSessionNotFound();
      throw mapped;
    }
    // Exact identity: the id must be a ROOT session whose recorded cwd is the
    // server's assistant directory, compared BYTE-FOR-BYTE (the same rule the
    // sessiond latest lookup uses — no case folding / separator normalization,
    // so a case-different directory on a case-sensitive filesystem is a
    // different workspace). A stale/wrong/child id answers 404 even though the
    // exact-id read itself succeeded.
    if (header.sessionId !== selected
      || header.cwd !== deps.cwd
      || header.parentSessionId !== undefined) {
      throw assistantSessionNotFound();
    }
    return c.json({ cwd: deps.cwd, sessionId: selected });
  });

  app.get("/v1/assistant/sessions", async (c) => {
    c.header("Cache-Control", "no-store");
    requireAssistantQueryKeys(c.req.url, ["page", "pageSize"]);
    const { page, pageSize } = requireAssistantPage(c.req.url);
    const listAssistant = deps.client.listAssistant;
    if (listAssistant === undefined) {
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
    }
    let result: unknown;
    try {
      result = await listAssistant({ page, pageSize });
    } catch (error) {
      throw mapSessionCatalogError(error);
    }
    const parsed = result as {
      page?: unknown;
      pageSize?: unknown;
      total?: unknown;
      totalPages?: unknown;
      catalogRevision?: unknown;
      sessions?: unknown;
    };
    if (parsed === null || typeof parsed !== "object"
      || !Array.isArray(parsed.sessions)
      || !Number.isSafeInteger(parsed.page) || (parsed.page as number) < 1
      || !Number.isSafeInteger(parsed.pageSize) || (parsed.pageSize as number) < 1
      || !Number.isSafeInteger(parsed.total) || (parsed.total as number) < 0
      || !Number.isSafeInteger(parsed.totalPages) || (parsed.totalPages as number) < 0
      || !Number.isSafeInteger(parsed.catalogRevision) || (parsed.catalogRevision as number) < 0) {
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
    }
    const sessions = await Promise.all(
      (parsed.sessions as unknown[]).map((session) => projectSessionRecord(deps.roots, session)),
    );
    return c.json({ ...parsed, sessions });
  });
}
