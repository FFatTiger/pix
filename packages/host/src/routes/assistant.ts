/**
 * Assistant route (GET /v1/assistant).
 *
 * Returns the assistant conversation binding: the fixed assistant working
 * directory and the id of its MOST RECENT session (null when the user has
 * not started one yet — the client creates on first send). The lookup runs
 * through the read-only sessiond catalog (`sessions.findLatest`, zero
 * workers); a sessiond outage answers 503 (the `assistant` capability token
 * is only advertised while sessiond is up, so the entry is hidden, not
 * broken). Mounted ONLY when the assistant workspace seam is wired (the
 * directory resolved and authorized within AllowedRoots at composition).
 */
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";

/** Narrow read-only client for the sessiond assistant-conversation lookup. */
export interface AssistantLatestClient {
  findLatest(cwd: string): Promise<{ cwd: string; sessionId: string | null }>;
}

export interface AssistantRouteDeps {
  /** Canonical assistant workspace directory (composition-authorized). */
  cwd: string;
  /** Narrow sessiond-backed latest-session lookup. */
  client: AssistantLatestClient;
}

export function registerAssistantRoutes(app: Hono<HostEnv>, deps: AssistantRouteDeps): void {
  app.get("/v1/assistant", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const latest = await deps.client.findLatest(deps.cwd);
      return c.json({ cwd: deps.cwd, sessionId: latest.sessionId });
    } catch {
      // Fixed sanitized 503: the endpoint depends on the sessiond catalog.
      throw new HttpError(503, "SESSIONS_UNAVAILABLE", "Session history is unavailable");
    }
  });
}
