/**
 * Read-only catalog routes (D3B-R1B).
 *
 * Project-scoped endpoints require an absolute authorized existing directory
 * via `?cwd=` and never fall back to process.cwd. Global credentials endpoints
 * do not take a cwd. Routes are registered only for the seams that are
 * actually mounted on {@link CatalogDeps}.
 *
 * This module is deliberately protocol-independent: catalog methods return
 * `unknown` and Host-side projectors emit only plain JSON primitives. No
 * runtime-core / pi-sdk-adapter / protocol imports. Malformed shape, getter
 * throws, proxies, or extra nested material never reach the wire as raw data.
 */
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { hasTrustMutationSeam } from "./health.js";
import { readJsonObject } from "../resources/request-body.js";
import type { CatalogDeps } from "../types.js";

/** Fixed sanitized catalog-unavailable body. Never includes raw Error/path/stack/secret. */
export const CATALOG_UNAVAILABLE_MESSAGE = "Catalog is unavailable";

/** Fixed trust reason when reload is denied. Never forwards free-form backend text. */
export const TRUST_NOT_TRUSTED_REASON = "Project resources are not trusted";

/** Fixed sanitized trust-mutation failure message (never raw seam text). */
export const TRUST_MUTATION_FAILED_MESSAGE = "Trust mutation failed";

/** Frozen POST /v1/trust body ceiling (the strict body is a handful of bytes). */
const TRUST_MUTATION_BODY_LIMIT = 4 * 1024;

const AUTH_METHODS = new Set(["oauth", "apiKey", "deviceCode"]);
const COMMAND_SOURCES = new Set(["extension", "prompt", "skill"]);
const TRUST_LEVELS = new Set(["unknown", "trusted", "denied"]);

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
  // Projector failures are already fixed HttpErrors — rethrow as-is.
  if (error instanceof HttpError) return error;
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

function catalogUnavailable(): HttpError {
  return new HttpError(503, "CATALOG_UNAVAILABLE", CATALOG_UNAVAILABLE_MESSAGE);
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw catalogUnavailable();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a property from an untrusted catalog value. Any getter/proxy throw is
 * mapped to catalog-unavailable so raw Error text never reaches the handler.
 */
function readField(raw: Record<string, unknown>, key: string): unknown {
  try {
    return raw[key];
  } catch {
    throw catalogUnavailable();
  }
}

// ---------------------------------------------------------------------------
// Strict Host-side projectors — plain primitives only, no extra/nested fields
// ---------------------------------------------------------------------------

export function projectModelInfo(raw: unknown): {
  id: string;
  provider: string;
  displayName?: string;
  thinking?: boolean;
  contextWindow?: number;
} {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const out: {
    id: string;
    provider: string;
    displayName?: string;
    thinking?: boolean;
    contextWindow?: number;
  } = {
    id: requireNonEmptyString(readField(raw, "id")),
    provider: requireNonEmptyString(readField(raw, "provider")),
  };
  const displayName = readField(raw, "displayName");
  if (displayName !== undefined) {
    if (typeof displayName !== "string") throw catalogUnavailable();
    out.displayName = displayName;
  }
  const thinking = readField(raw, "thinking");
  if (thinking !== undefined) {
    if (typeof thinking !== "boolean") throw catalogUnavailable();
    out.thinking = thinking;
  }
  const contextWindow = readField(raw, "contextWindow");
  if (contextWindow !== undefined) {
    if (
      typeof contextWindow !== "number" ||
      !Number.isInteger(contextWindow) ||
      contextWindow <= 0
    ) {
      throw catalogUnavailable();
    }
    out.contextWindow = contextWindow;
  }
  return out;
}

export function projectDefaultModel(raw: unknown): { id: string; provider: string } | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) throw catalogUnavailable();
  return {
    id: requireNonEmptyString(readField(raw, "id")),
    provider: requireNonEmptyString(readField(raw, "provider")),
  };
}

export function projectAuthProviderInfo(raw: unknown): {
  id: string;
  name?: string;
  methods: string[];
} {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const id = requireNonEmptyString(readField(raw, "id"));
  const methodsRaw = readField(raw, "methods");
  if (!Array.isArray(methodsRaw) || methodsRaw.length === 0) throw catalogUnavailable();
  const methods: string[] = [];
  for (const method of methodsRaw) {
    if (typeof method !== "string" || !AUTH_METHODS.has(method)) throw catalogUnavailable();
    methods.push(method);
  }
  const out: { id: string; name?: string; methods: string[] } = { id, methods };
  const name = readField(raw, "name");
  if (name !== undefined) {
    if (typeof name !== "string") throw catalogUnavailable();
    out.name = name;
  }
  return out;
}

export function projectAuthProviderStatus(raw: unknown): {
  providerId: string;
  authorized: boolean;
  accountName?: string;
  expiresAt?: number;
} {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const authorized = readField(raw, "authorized");
  if (typeof authorized !== "boolean") throw catalogUnavailable();
  const out: {
    providerId: string;
    authorized: boolean;
    accountName?: string;
    expiresAt?: number;
  } = {
    providerId: requireNonEmptyString(readField(raw, "providerId")),
    authorized,
  };
  const accountName = readField(raw, "accountName");
  if (accountName !== undefined) {
    if (typeof accountName !== "string") throw catalogUnavailable();
    out.accountName = accountName;
  }
  const expiresAt = readField(raw, "expiresAt");
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
      throw catalogUnavailable();
    }
    out.expiresAt = expiresAt;
  }
  return out;
}

export function projectSkillInfo(raw: unknown): {
  name: string;
  enabled: boolean;
  description?: string;
  version?: string;
  updateAvailable?: boolean;
} {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const enabled = readField(raw, "enabled");
  if (typeof enabled !== "boolean") throw catalogUnavailable();
  const out: {
    name: string;
    enabled: boolean;
    description?: string;
    version?: string;
    updateAvailable?: boolean;
  } = {
    name: requireNonEmptyString(readField(raw, "name")),
    enabled,
  };
  const description = readField(raw, "description");
  if (description !== undefined) {
    if (typeof description !== "string") throw catalogUnavailable();
    out.description = description;
  }
  const version = readField(raw, "version");
  if (version !== undefined) {
    if (typeof version !== "string") throw catalogUnavailable();
    out.version = version;
  }
  const updateAvailable = readField(raw, "updateAvailable");
  if (updateAvailable !== undefined) {
    if (typeof updateAvailable !== "boolean") throw catalogUnavailable();
    out.updateAvailable = updateAvailable;
  }
  return out;
}

export function projectPluginInfo(raw: unknown): {
  name: string;
  enabled: boolean;
  version?: string;
} {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const enabled = readField(raw, "enabled");
  if (typeof enabled !== "boolean") throw catalogUnavailable();
  const out: { name: string; enabled: boolean; version?: string } = {
    name: requireNonEmptyString(readField(raw, "name")),
    enabled,
  };
  const version = readField(raw, "version");
  if (version !== undefined) {
    if (typeof version !== "string") throw catalogUnavailable();
    out.version = version;
  }
  return out;
}

export function projectSlashCommandInfo(raw: unknown): {
  name: string;
  source: string;
  description?: string;
} {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const source = readField(raw, "source");
  if (typeof source !== "string" || !COMMAND_SOURCES.has(source)) throw catalogUnavailable();
  const out: { name: string; source: string; description?: string } = {
    name: requireNonEmptyString(readField(raw, "name")),
    source,
  };
  // sourceInfo is intentionally never read — never forwarded (unknown/unsafe).
  const description = readField(raw, "description");
  if (description !== undefined) {
    if (typeof description !== "string") throw catalogUnavailable();
    out.description = description;
  }
  return out;
}

export function projectTrustLevel(raw: unknown): "unknown" | "trusted" | "denied" {
  if (typeof raw !== "string") return "unknown";
  if (TRUST_LEVELS.has(raw)) return raw as "unknown" | "trusted" | "denied";
  // Fail closed: unrecognized levels become unknown (never free-form leak).
  return "unknown";
}

export function projectCanReloadResources(
  raw: unknown,
  fallbackLevel: "unknown" | "trusted" | "denied",
): { allowed: boolean; level: "unknown" | "trusted" | "denied"; reason?: string } {
  if (!isPlainObject(raw)) {
    return { allowed: false, level: fallbackLevel, reason: TRUST_NOT_TRUSTED_REASON };
  }
  const allowed = readField(raw, "allowed");
  if (typeof allowed !== "boolean") throw catalogUnavailable();
  const level = projectTrustLevel(readField(raw, "level") ?? fallbackLevel);
  if (allowed === true) {
    return { allowed: true, level };
  }
  // Never forward free-form backend reason text (do not read raw.reason).
  return { allowed: false, level, reason: TRUST_NOT_TRUSTED_REASON };
}

function projectArray<T>(raw: unknown, project: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw catalogUnavailable();
  const projected: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    // Array#map skips sparse holes, which JSON would otherwise encode as null
    // without ever running the strict DTO projector. Catalog arrays must be
    // dense: every wire element is either validated or the request fails closed.
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      throw catalogUnavailable();
    }
    projected.push(project(raw[index]));
  }
  return projected;
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
 * Strict POST /v1/trust body: EXACTLY `{ cwd: string, level: "trusted" }` —
 * no extra fields, no missing fields, no coercion. This slice records an
 * explicit trusted decision only; any other level is a fixed 400 (never
 * forwarded to the seam).
 */
export function parseTrustMutationBody(
  body: Record<string, unknown>,
): { cwd: string } {
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(body, "cwd") ||
    !Object.prototype.hasOwnProperty.call(body, "level")
  ) {
    throw new HttpError(400, "INVALID_TRUST_BODY", "Body must be exactly {cwd, level}");
  }
  const cwd = body.cwd;
  if (typeof cwd !== "string" || cwd === "") {
    throw new HttpError(400, "CWD_REQUIRED", "cwd is required");
  }
  if (body.level !== "trusted") {
    throw new HttpError(400, "UNSUPPORTED_TRUST_LEVEL", 'Only level "trusted" is supported');
  }
  return { cwd };
}

/**
 * Map a trust-mutation seam exception onto an honest HTTP error. The seam
 * raises fixed-code sanitized errors; anything else (including raw Error
 * objects carrying paths/stacks) collapses to a fixed 500. Raw messages,
 * paths, trust.json content and stacks are never forwarded.
 */
export function mapTrustMutationError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = catalogErrorCode(error);
  if (code === "TRUST_INPUT_INVALID") {
    return new HttpError(400, "INVALID_TRUST_BODY", "Body must be exactly {cwd, level}");
  }
  // D-01: the adapter no longer throws TRUST_STORE_UNSAFE (Pi owns persistence
  // path-safety). Unknown / write / unverified codes collapse to a fixed 500.
  return new HttpError(500, "TRUST_MUTATION_FAILED", TRUST_MUTATION_FAILED_MESSAGE);
}

/**
 * Register catalog routes for every mounted sub-seam. Skills/plugins/commands
 * require the resources seam; trust is independent; models and credentials are
 * independent of each other. Seam call + projection are always in one try so
 * shape/getter failures map to fixed 503 and never hit the unified 500 path.
 */
export function registerCatalogRoutes(app: Hono<HostEnv>, deps: CatalogDeps): void {
  if (deps.models) {
    app.get("/v1/models", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      try {
        const catalog = deps.models!.forCwd(cwd);
        const modelsRaw = await catalog.listModels();
        const defaultRaw = await catalog.getDefaultModel();
        const models = projectArray(modelsRaw, projectModelInfo);
        const defaultModel = projectDefaultModel(defaultRaw);
        return c.json({ models, defaultModel });
      } catch (error) {
        throw mapCatalogError(error, "model");
      }
    });
  }

  if (deps.credentials) {
    app.get("/v1/auth/providers", async (c) => {
      noStore(c);
      try {
        const providersRaw = await deps.credentials!.listProviders();
        const providers = projectArray(providersRaw, projectAuthProviderInfo);
        return c.json({ providers });
      } catch (error) {
        throw mapCatalogError(error, "provider");
      }
    });

    app.get("/v1/auth/providers/:id/status", async (c) => {
      noStore(c);
      const id = c.req.param("id");
      if (typeof id !== "string" || id.length === 0) {
        throw new HttpError(400, "PROVIDER_ID_REQUIRED", "provider id is required");
      }
      try {
        const statusRaw = await deps.credentials!.getProviderStatus(id);
        const configuredRaw = await deps.credentials!.isConfigured(id);
        if (typeof configuredRaw !== "boolean") throw catalogUnavailable();
        const status = projectAuthProviderStatus(statusRaw);
        return c.json({ status, configured: configuredRaw });
      } catch (error) {
        throw mapCatalogError(error, "provider");
      }
    });
  }

  if (deps.resources) {
    app.get("/v1/skills", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      try {
        const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
        const catalog = deps.resources!.forCwd(cwd, trusted === true);
        const skills = projectArray(await catalog.listSkills(), projectSkillInfo);
        return c.json({ skills });
      } catch (error) {
        throw mapCatalogError(error, "skill");
      }
    });

    app.get("/v1/plugins", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      try {
        const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
        const catalog = deps.resources!.forCwd(cwd, trusted === true);
        const plugins = projectArray(await catalog.listPlugins(), projectPluginInfo);
        return c.json({ plugins });
      } catch (error) {
        throw mapCatalogError(error, "plugin");
      }
    });

    app.get("/v1/commands", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      try {
        const trusted = deps.trust ? await deps.trust.isTrusted(cwd) : false;
        const catalog = deps.resources!.forCwd(cwd, trusted === true);
        const commands = projectArray(await catalog.listCommands(), projectSlashCommandInfo);
        return c.json({ commands });
      } catch (error) {
        throw mapCatalogError(error, "command");
      }
    });
  }

  if (deps.trust) {
    app.get("/v1/trust", async (c) => {
      noStore(c);
      const cwd = await requireAuthorizedCwd(deps, c.req.query("cwd"));
      try {
        const levelRaw = await deps.trust!.getProjectTrustState(cwd);
        const trustedRaw = await deps.trust!.isTrusted(cwd);
        const canReloadRaw = await deps.trust!.canReloadResources(cwd);
        if (typeof trustedRaw !== "boolean") throw catalogUnavailable();
        const level = projectTrustLevel(levelRaw);
        const canReloadResources = projectCanReloadResources(canReloadRaw, level);
        return c.json({
          cwd,
          level,
          trusted: trustedRaw,
          canReloadResources,
        });
      } catch (error) {
        throw mapCatalogError(error, "trust");
      }
    });
  }

  // D3B trust-mutation slice: mounted ONLY when the mutation seam (and the
  // trust read seam for the strict post-write projection) exists — the same
  // source of truth as the `project.trust` capability token, so a route can
  // never exist unadvertised and a token can never exist unmounted.
  if (hasTrustMutationSeam(deps)) {
    app.post("/v1/trust", async (c) => {
      noStore(c);
      // The auth/LAN gate already ran in the global middleware chain (gate
      // first). NO sessiond mutation guard: the persisted trust decision is a
      // Host catalog capability that never depends on the per-session Worker;
      // the seam's own authority (the trust store) fail-closes per request.
      // No query surface at all: ANY query string (even a bare `?`) is a
      // fixed 400 before body parsing (cwd travels in the strict body only).
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      // Content-type must be application/json (415), body bounded (413),
      // malformed/non-object JSON is the fixed 400 from readJsonObject.
      const body = await readJsonObject(c, TRUST_MUTATION_BODY_LIMIT);
      const { cwd: rawCwd } = parseTrustMutationBody(body);
      // AllowedRoot authorization BEFORE the seam: canonical existing
      // absolute directory only (no process.cwd fallback, no traversal, no
      // symlink-escaped root — the shared 400/403/404 roots semantics).
      const cwd = await requireAuthorizedCwd(deps, rawCwd);
      try {
        await deps.trustMutation!.setTrusted(cwd);
      } catch (error) {
        throw mapTrustMutationError(error);
      }
      // Strict post-write state from the READ seam (same projectors as GET) —
      // honest read-after-write, never the mutation return value verbatim.
      try {
        const levelRaw = await deps.trust!.getProjectTrustState(cwd);
        const trustedRaw = await deps.trust!.isTrusted(cwd);
        const canReloadRaw = await deps.trust!.canReloadResources(cwd);
        if (typeof trustedRaw !== "boolean") throw catalogUnavailable();
        const level = projectTrustLevel(levelRaw);
        const canReloadResources = projectCanReloadResources(canReloadRaw, level);
        if (level !== "trusted" || trustedRaw !== true) {
          // The write reported success but the read surface disagrees — never
          // publish a stale/contradictory state to the client.
          throw new HttpError(500, "TRUST_MUTATION_FAILED", TRUST_MUTATION_FAILED_MESSAGE);
        }
        return c.json({ cwd, level, trusted: true, canReloadResources });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw mapCatalogError(error, "trust");
      }
    });
  }
}
