/**
 * MCP settings routes (Pix settings "MCP" page).
 *
 *   GET    /v1/settings/mcp                       → config + cached probe results
 *   POST   /v1/settings/mcp/servers               → create/replace one server
 *   PUT    /v1/settings/mcp/servers/:name         → edit one server
 *   PATCH  /v1/settings/mcp/servers/:name         → { enabled } toggle
 *   DELETE /v1/settings/mcp/servers/:name         → remove one server
 *   POST   /v1/settings/mcp/servers/:name/test    → probe (30s cache; refresh)
 *   POST   /v1/settings/mcp/import-preview        → validate pasted JSON, no write
 *   POST   /v1/settings/mcp/import                → import pasted JSON (atomic)
 *
 * Mounted only with the `mcpSettings` catalog seam (production wires the
 * adapter's `<agentDir>/mcp.json` authority); the same seam advertises the
 * `mcp.configure` capability token. The route module is protocol-shaped at the
 * boundary only: request bodies are parsed with the strict Protocol zod
 * schemas, responses are the seam's already-canonical snapshots passed through
 * a strict re-validation so a malformed adapter result can never reach the
 * wire as raw data. Server names are validated against the Pi pattern before
 * any seam call. Errors are fixed sanitized 400/404/503 bodies — secrets,
 * paths, stacks and raw JSON never ride an error.
 */
import type { Hono } from "hono";
import {
  McpEnabledMutationSchema,
  McpImportPreviewResponseSchema,
  McpImportRequestSchema,
  McpProbeRequestSchema,
  McpServerWriteSchema,
  McpSettingsResponseSchema,
} from "@fffattiger/pix-protocol/mcp-settings";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { readJsonObject } from "../resources/request-body.js";
import type { CatalogDeps } from "../types.js";

/** Frozen body ceiling (import payloads are bounded at 128 KiB in the schema). */
const MCP_BODY_LIMIT = 256 * 1024;

/** Server names: letters, digits, `_`, `-` — the Pi `mcp.json` rule. */
const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Fixed sanitized bodies. Never include raw seam text, secrets or paths. */
export const MCP_SETTINGS_UNAVAILABLE = "MCP settings are unavailable";
export const MCP_INVALID_INPUT = "Invalid MCP configuration";
export const MCP_SERVER_NOT_FOUND = "MCP server not found";

/**
 * Rate limit for the probe route: the probe spawns local processes and sends
 * stored credentials to user-configured origins, so a tight loop must not be
 * drivable. Fixed window, per process, far above human cadence (a page load
 * tests its servers once each).
 */
const MCP_TEST_RATE_LIMIT_MAX = 60;
const MCP_TEST_RATE_WINDOW_MS = 60_000;

function createMcpTestRateLimiter(now: () => number = Date.now): () => boolean {
  let windowStart = 0;
  let used = 0;
  return () => {
    const at = now();
    if (at - windowStart >= MCP_TEST_RATE_WINDOW_MS) {
      windowStart = at;
      used = 0;
    }
    used += 1;
    return used <= MCP_TEST_RATE_LIMIT_MAX;
  };
}

function mcpNameParam(c: { req: { param: (name: string) => string | undefined } }): string {
  const name = c.req.param("name");
  if (typeof name !== "string" || !MCP_NAME_PATTERN.test(name)) {
    throw new HttpError(400, "INVALID_MCP_NAME", "Invalid MCP server name");
  }
  return name;
}

/**
 * Map a seam exception onto an honest HTTP error.
 *   invalid_input → 400 INVALID_MCP_INPUT (fixed message)
 *   not_found     → 404 MCP_SERVER_NOT_FOUND
 *   else          → 503 MCP_SETTINGS_UNAVAILABLE (sanitized)
 */
function mapMcpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "invalid_input") return new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
  if (code === "not_found") return new HttpError(404, "MCP_SERVER_NOT_FOUND", MCP_SERVER_NOT_FOUND);
  return new HttpError(503, "MCP_SETTINGS_UNAVAILABLE", MCP_SETTINGS_UNAVAILABLE);
}

/** Strict response projection: the seam result must satisfy the wire schema. */
function projectMcpSnapshot(result: unknown): unknown {
  const parsed = McpSettingsResponseSchema.safeParse(result);
  if (!parsed.success) throw new HttpError(503, "MCP_SETTINGS_UNAVAILABLE", MCP_SETTINGS_UNAVAILABLE);
  return parsed.data;
}

function projectMcpPreview(result: unknown): unknown {
  const parsed = McpImportPreviewResponseSchema.safeParse(result);
  if (!parsed.success) throw new HttpError(503, "MCP_SETTINGS_UNAVAILABLE", MCP_SETTINGS_UNAVAILABLE);
  return parsed.data;
}

/** No-op without the seam; with it, mounts the whole MCP settings surface. */
export function registerMcpSettingsRoutes(app: Hono<HostEnv>, catalogs: CatalogDeps): void {
  const seam = catalogs.mcpSettings;
  if (!seam) return;
  const testAllowed = createMcpTestRateLimiter();

  app.get("/v1/settings/mcp", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    try {
      return c.json(projectMcpSnapshot(await seam.readSettings()));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.post("/v1/settings/mcp/servers", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    const input = McpServerWriteSchema.safeParse(await readJsonObject(c, MCP_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    try {
      return c.json(projectMcpSnapshot(await seam.upsertServer(input.data)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.put("/v1/settings/mcp/servers/:name", async (c) => {
    c.header("Cache-Control", "no-store");
    const name = mcpNameParam(c);
    const input = McpServerWriteSchema.safeParse(await readJsonObject(c, MCP_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    if (input.data.name !== name) {
      // The body names the entry; the path names it too. They must agree —
      // no renames ride an edit.
      throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    }
    try {
      return c.json(projectMcpSnapshot(await seam.upsertServer(input.data)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.patch("/v1/settings/mcp/servers/:name", async (c) => {
    c.header("Cache-Control", "no-store");
    const name = mcpNameParam(c);
    const input = McpEnabledMutationSchema.safeParse(await readJsonObject(c, MCP_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    try {
      return c.json(projectMcpSnapshot(await seam.setEnabled(name, input.data)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.delete("/v1/settings/mcp/servers/:name", async (c) => {
    c.header("Cache-Control", "no-store");
    const name = mcpNameParam(c);
    try {
      return c.json(projectMcpSnapshot(await seam.removeServer(name)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.post("/v1/settings/mcp/servers/:name/test", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!testAllowed()) {
      throw new HttpError(429, "RATE_LIMITED", "Too many MCP connection tests; wait a minute and retry");
    }
    const name = mcpNameParam(c);
    const input = McpProbeRequestSchema.safeParse(await readJsonObject(c, MCP_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    try {
      return c.json(projectMcpSnapshot(await seam.testServer(name, input.data)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.post("/v1/settings/mcp/import-preview", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    const input = McpImportRequestSchema.safeParse(await readJsonObject(c, MCP_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    try {
      return c.json(projectMcpPreview(await seam.importPreview(input.data)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });

  app.post("/v1/settings/mcp/import", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    const input = McpImportRequestSchema.safeParse(await readJsonObject(c, MCP_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_MCP_INPUT", MCP_INVALID_INPUT);
    try {
      return c.json(projectMcpSnapshot(await seam.importServers(input.data)));
    } catch (error) {
      throw mapMcpError(error);
    }
  });
}
