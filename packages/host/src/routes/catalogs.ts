/**
 * Read-only catalog routes (D3B-R1B).
 *
 * Project-scoped endpoints require an absolute authorized existing directory
 * via `?cwd=` and never fall back to process.cwd. Global credentials endpoints
 * do not take a cwd. Routes are registered only for the seams that are
 * actually mounted on {@link CatalogDeps}.
 *
 * This module is deliberately protocol-independent: catalog methods return
 * `unknown` and this route narrows the response shape. No runtime-core /
 * pi-sdk-adapter / protocol imports.
 */
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { CatalogDeps } from "../types.js";

/** Fixed sanitized catalog-unavailable body. Never includes raw Error/path/stack/secret. */
export const CATALOG_UNAVAILABLE_MESSAGE = "Catalog is unavailable";

/**
 * Map a catalog exception onto an honest HTTP error.
 *
 *   not_found      → 404 with a fixed domain message
 *   invalid_input  → 400 INVALID_INPUT
 *   everything else → 503 CATALOG_UNAVAILABLE (fixed sanitized message)
 *
 * Paths, stacks, secrets and raw Error messages are never forwarded.
 */
export function mapCatalogError(error: unknown, domain: string): HttpError {
  const code = catalogErrorCode(error);
  if (code === "not_found") {
    return new HttpError(404, `${domain.toUpperCase()}_NOT_FOUND`, `${capitalize(domain)} not found`);
  }
  if (code === "invalid_input") {
    return new HttpError(400, "INVALID_INPUT", "Invalid catalog input");
  }
  return new HttpError(503, "CATALOG_UNAVAILABLE", CATALOG_UNAVAILABLE_MESSAGE);
}

function catalogErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}

/**
 * Require `?cwd=` as an absolute authorized existing directory. Missing → 400
 * CWD_REQUIRED. Relative/traversal/out-of-root follow the allowed-roots
 * 400/403/404 semantics. No process.cwd fallback.
 */
export async function requireAuthorizedCwd(
  deps: CatalogDeps,
  raw: string | undefined,
): Promise<string> {
  if (raw === undefined || raw === "") {
    throw new HttpError(400, "CWD_REQUIRED", "cwd query parameter is required");
  }
  const authorized = await deps.roots.authorizeExisting(raw, "directory");
  return authorized.canonicalPath;
}

function noStore(c: { header: (name: string, value: string) => void }): void {
  c.header("Cache-Control", "no-store");
}

/**
 * Register catalog routes for every mounted sub-seam. Skills/plugins/commands
 * require the resources seam; trust is independent; models and credentials are
 * independent of each other.
 */
export function registerCatalogRoutes(app: Hono<HostEnv>, deps: CatalogDeps): void {
  if (deps.models) {
    app.get("/v1/models", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      const catalog = deps.models!.forCwd(cwd);
      let models: unknown;
      let defaultModel: unknown;
      try {
        models = await catalog.listModels();
        defaultModel = await catalog.getDefaultModel();
      } catch (error) {
        throw mapCatalogError(error, "model");
      }
      return c.json({
        models: Array.isArray(models) ? [...models] : [],
        defaultModel: defaultModel ?? null,
      });
    });
  }

  if (deps.credentials) {
    app.get("/v1/auth/providers", async (c) => {
      noStore(c);
      let providers: unknown;
      try {
        providers = await deps.credentials!.listProviders();
      } catch (error) {
        throw mapCatalogError(error, "provider");
      }
      return c.json({ providers: Array.isArray(providers) ? [...providers] : [] });
    });

    app.get("/v1/auth/providers/:id/status", async (c) => {
      noStore(c);
      const id = c.req.param("id");
      if (typeof id !== "string" || id.length === 0) {
        throw new HttpError(400, "PROVIDER_ID_REQUIRED", "provider id is required");
      }
      let status: unknown;
      let configured: boolean;
      try {
        status = await deps.credentials!.getProviderStatus(id);
        configured = await deps.credentials!.isConfigured(id);
      } catch (error) {
        throw mapCatalogError(error, "provider");
      }
      return c.json({ status: status ?? {}, configured: configured === true });
    });
  }

  if (deps.resources) {
    app.get("/v1/skills", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
      const catalog = deps.resources!.forCwd(cwd, trusted);
      let skills: unknown;
      try {
        skills = await catalog.listSkills();
      } catch (error) {
        throw mapCatalogError(error, "skill");
      }
      return c.json({ skills: Array.isArray(skills) ? [...skills] : [] });
    });

    app.get("/v1/plugins", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
      const catalog = deps.resources!.forCwd(cwd, trusted);
      let plugins: unknown;
      try {
        plugins = await catalog.listPlugins();
      } catch (error) {
        throw mapCatalogError(error, "plugin");
      }
      return c.json({ plugins: Array.isArray(plugins) ? [...plugins] : [] });
    });

    app.get("/v1/commands", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
      const catalog = deps.resources!.forCwd(cwd, trusted);
      let commands: unknown;
      try {
        commands = await catalog.listCommands();
      } catch (error) {
        throw mapCatalogError(error, "command");
      }
      return c.json({ commands: Array.isArray(commands) ? [...commands] : [] });
    });
  }

  if (deps.trust) {
    app.get("/v1/trust", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      let level: unknown;
      let trusted: boolean;
      let canReload: unknown;
      try {
        level = await deps.trust!.getProjectTrustState(cwd);
        trusted = await deps.trust!.isTrusted(cwd);
        canReload = await deps.trust!.canReloadResources(cwd);
      } catch (error) {
        throw mapCatalogError(error, "trust");
      }
      // Structural view over the trust gate result (no protocol/runtime import).
      const reload =
        canReload !== null && typeof canReload === "object"
          ? (canReload as { allowed?: unknown; level?: unknown; reason?: unknown })
          : {};
      const canReloadResources: {
        allowed: boolean;
        level: unknown;
        reason?: string;
      } = {
        allowed: reload.allowed === true,
        level: reload.level ?? level ?? "unknown",
      };
      if (typeof reload.reason === "string" && reload.reason.length > 0) {
        canReloadResources.reason = reload.reason;
      }
      return c.json({
        cwd,
        level: typeof level === "string" ? level : "unknown",
        trusted: trusted === true,
        canReloadResources,
      });
    });
  }
}
