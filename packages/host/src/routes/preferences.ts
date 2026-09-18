import { bodyLimit } from "hono/body-limit";
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import type { GatePasswordStore, GatePreferencesStore, HostLogger } from "../types.js";

interface PreferencesFailureBody {
  ok: false;
  error: string;
  message: string;
  code?: string;
}

function failure(message: string, code?: string): PreferencesFailureBody {
  return { ok: false, error: message, message, ...(code === undefined ? {} : { code }) };
}

/**
 * Server-side user preferences surface (stored in ~/.pi/pix.json):
 *  - GET /v1/preferences               → { preferences: Record<string, string> }
 *  - PUT /v1/preferences { patch }     → per-key patch (null deletes)
 *
 * Behind the gate middleware like every /v1 API. Values are the client's raw
 * localStorage strings; the client remains per-domain owner of semantics.
 */
export function registerPreferencesRoutes(
  app: Hono<HostEnv>,
  deps: { preferencesStore: GatePreferencesStore; passwordStore?: GatePasswordStore; logger: HostLogger; bodyLimitBytes?: number },
): void {
  const store = deps.preferencesStore;

  app.get("/v1/preferences", (c) => {
    c.header("Cache-Control", "no-store");
    let preferences: Record<string, string>;
    try {
      preferences = store.read();
    } catch (error) {
      deps.logger.error?.(`Failed to read preferences: ${error instanceof Error ? error.message : String(error)}`);
      return c.json(failure("Failed to read preferences", "PREFERENCES_READ_FAILED"), 500);
    }
    return c.json({ preferences });
  });

  app.put(
    "/v1/preferences",
    bodyLimit({
      maxSize: deps.bodyLimitBytes ?? 128 * 1024,
      onError: (c) => c.json(failure("Request body too large", "BODY_TOO_LARGE"), 413),
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        return c.json(failure("Content-Type must be application/json", "UNSUPPORTED_MEDIA_TYPE"), 415);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(failure("Invalid request body"), 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json(failure("Invalid request body"), 400);
      }
      const { patch } = body as { patch?: unknown };
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return c.json(failure("Invalid request body: patch must be an object", "INVALID_INPUT"), 400);
      }
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        if (typeof key !== "string" || (value !== null && typeof value !== "string")) {
          return c.json(failure("Invalid request body: patch values must be strings or null", "INVALID_INPUT"), 400);
        }
      }
      let preferences: Record<string, string>;
      try {
        preferences = store.patch(patch as Record<string, string | null>);
      } catch (error) {
        deps.logger.error?.(`Failed to persist preferences: ${error instanceof Error ? error.message : String(error)}`);
        return c.json(failure("Failed to persist preferences", "PREFERENCES_WRITE_FAILED"), 500);
      }
      return c.json({ ok: true, preferences });
    },
  );
}
