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

/** Fixed sanitized trust-mutation failure messages (never raw seam text). */
export const TRUST_MUTATION_UNAVAILABLE_MESSAGE = "Trust mutation is unavailable";
export const TRUST_MUTATION_FAILED_MESSAGE = "Trust mutation failed";

/** Frozen POST /v1/trust body ceiling (the strict body is a handful of bytes). */
const TRUST_MUTATION_BODY_LIMIT = 4 * 1024;
/** Bounded full models.json editor payload (matches adapter 1 MiB document cap). */
const MODELS_CONFIG_BODY_LIMIT = 1024 * 1024;
const SETTINGS_CONFIG_BODY_LIMIT = 256 * 1024 + 512;

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

function mapModelsConfigError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = catalogErrorCode(error);
  if (code === "invalid_input") return new HttpError(400, "INVALID_INPUT", "Invalid model configuration");
  if (code === "conflict") return new HttpError(409, "CONFLICT", "Model configuration changed; reload and try again");
  return new HttpError(503, "CATALOG_UNAVAILABLE", CATALOG_UNAVAILABLE_MESSAGE);
}

function mapSettingsConfigError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = catalogErrorCode(error);
  if (code === "invalid_input") return new HttpError(400, "INVALID_INPUT", "Invalid settings configuration");
  if (code === "conflict") return new HttpError(409, "CONFLICT", "Settings configuration changed; reload and try again");
  return new HttpError(503, "CATALOG_UNAVAILABLE", CATALOG_UNAVAILABLE_MESSAGE);
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
  if (code === "TRUST_STORE_UNSAFE") {
    return new HttpError(503, "TRUST_MUTATION_UNAVAILABLE", TRUST_MUTATION_UNAVAILABLE_MESSAGE);
  }
  return new HttpError(500, "TRUST_MUTATION_FAILED", TRUST_MUTATION_FAILED_MESSAGE);
}

function exactKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(raw);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function optionalNonEmptyString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = readField(raw, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw catalogUnavailable();
  return value;
}

function optionalPositiveInt(raw: Record<string, unknown>, key: string): number | undefined {
  const value = readField(raw, key);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw catalogUnavailable();
  return value;
}

function projectModelConfigModel(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const sourceIndex = readField(raw, "sourceIndex");
  if (sourceIndex !== null && (typeof sourceIndex !== "number" || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0)) throw catalogUnavailable();
  const out: Record<string, unknown> = {
    sourceIndex,
    id: requireNonEmptyString(readField(raw, "id")),
  };
  for (const key of ["name", "api"] as const) {
    const value = optionalNonEmptyString(raw, key);
    if (value !== undefined) out[key] = value;
  }
  const reasoning = readField(raw, "reasoning");
  if (reasoning !== undefined) {
    if (typeof reasoning !== "boolean") throw catalogUnavailable();
    out.reasoning = reasoning;
  }
  const input = readField(raw, "input");
  if (input !== undefined) {
    if (!Array.isArray(input) || input.some((value) => value !== "text" && value !== "image")) throw catalogUnavailable();
    out.input = [...input];
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    const value = optionalPositiveInt(raw, key);
    if (value !== undefined) out[key] = value;
  }
  const cost = readField(raw, "cost");
  if (cost !== undefined) {
    if (!isPlainObject(cost)) throw catalogUnavailable();
    const projected: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = readField(cost, key);
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw catalogUnavailable();
        projected[key] = value;
      }
    }
    out.cost = projected;
  }
  return out;
}

function projectModelsConfigSnapshot(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const revision = requireNonEmptyString(readField(raw, "revision"));
  if (!/^[0-9a-f]{64}$/.test(revision)) throw catalogUnavailable();
  const providersRaw = readField(raw, "providers");
  const availableRaw = readField(raw, "availableProviders");
  const providers = projectArray(providersRaw, (value) => {
    if (!isPlainObject(value)) throw catalogUnavailable();
    const sourceId = readField(value, "sourceId");
    if (sourceId !== null && (typeof sourceId !== "string" || sourceId.length === 0)) throw catalogUnavailable();
    const apiKeyConfigured = readField(value, "apiKeyConfigured");
    const modelsDefined = readField(value, "modelsDefined");
    if (typeof apiKeyConfigured !== "boolean" || typeof modelsDefined !== "boolean") throw catalogUnavailable();
    const out: Record<string, unknown> = {
      sourceId,
      id: requireNonEmptyString(readField(value, "id")),
      apiKeyConfigured,
      modelsDefined,
      models: projectArray(readField(value, "models"), projectModelConfigModel),
    };
    for (const key of ["baseUrl", "api"] as const) {
      const field = optionalNonEmptyString(value, key);
      if (field !== undefined) out[key] = field;
    }
    return out;
  });
  const availableProviders = projectArray(availableRaw, (value) => {
    if (!isPlainObject(value)) throw catalogUnavailable();
    const methods = readField(value, "methods");
    const modelCount = readField(value, "modelCount");
    if (!Array.isArray(methods) || methods.some((method) => method !== "oauth" && method !== "apiKey")) throw catalogUnavailable();
    if (typeof modelCount !== "number" || !Number.isSafeInteger(modelCount) || modelCount < 0) throw catalogUnavailable();
    return {
      id: requireNonEmptyString(readField(value, "id")),
      name: requireNonEmptyString(readField(value, "name")),
      methods: [...methods],
      modelCount,
    };
  });
  return { revision, providers, availableProviders };
}

function invalidModelsConfigBody(): never {
  throw new HttpError(400, "INVALID_MODELS_CONFIG", "Invalid model configuration body");
}

function invalidSettingsConfigBody(): never {
  throw new HttpError(400, "INVALID_SETTINGS_CONFIG", "Invalid settings configuration body");
}

function projectSettingsConfigSnapshot(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw catalogUnavailable();
  const revision = requireNonEmptyString(readField(raw, "revision"));
  if (!/^[0-9a-f]{64}$/.test(revision)) throw catalogUnavailable();
  const content = readField(raw, "content");
  if (typeof content !== "string") throw catalogUnavailable();
  return { revision, content };
}

function parseModelsConfigModel(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) invalidModelsConfigBody();
  const allowed = ["sourceIndex", "id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalidModelsConfigBody();
  const sourceIndex = raw.sourceIndex;
  if (sourceIndex !== null && (typeof sourceIndex !== "number" || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0)) invalidModelsConfigBody();
  if (typeof raw.id !== "string" || !raw.id.trim()) invalidModelsConfigBody();
  const out: Record<string, unknown> = { sourceIndex, id: raw.id };
  for (const key of ["name", "api"] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !value.length) invalidModelsConfigBody();
      out[key] = value;
    }
  }
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "boolean") invalidModelsConfigBody();
    out.reasoning = raw.reasoning;
  }
  if (raw.input !== undefined) {
    if (!Array.isArray(raw.input) || raw.input.some((value) => value !== "text" && value !== "image")) invalidModelsConfigBody();
    out.input = [...raw.input];
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalidModelsConfigBody();
      out[key] = value;
    }
  }
  if (raw.cost !== undefined) {
    if (!isPlainObject(raw.cost) || Object.keys(raw.cost).some((key) => !["input", "output", "cacheRead", "cacheWrite"].includes(key))) invalidModelsConfigBody();
    const cost: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = raw.cost[key];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalidModelsConfigBody();
        cost[key] = value;
      }
    }
    out.cost = cost;
  }
  return out;
}

function projectDiscoveredModels(raw: unknown): { models: Record<string, string>[] } {
  return {
    models: projectArray(raw, (value) => {
      if (!isPlainObject(value)) throw catalogUnavailable();
      const out: Record<string, string> = { id: requireNonEmptyString(readField(value, "id")) };
      const name = optionalNonEmptyString(value, "name");
      if (name !== undefined) out.name = name;
      return out;
    }),
  };
}

function parseModelDiscoveryInput(body: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["expectedRevision", "sourceId", "providerId", "baseUrl", "api", "apiKey"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalidModelsConfigBody();
  if (typeof body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) invalidModelsConfigBody();
  if (body.sourceId !== null && (typeof body.sourceId !== "string" || !body.sourceId.trim())) invalidModelsConfigBody();
  if (typeof body.providerId !== "string" || !body.providerId.trim()) invalidModelsConfigBody();
  if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) invalidModelsConfigBody();
  if (typeof body.api !== "string" || !body.api.length) invalidModelsConfigBody();
  if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || !body.apiKey.trim())) invalidModelsConfigBody();
  return {
    expectedRevision: body.expectedRevision,
    sourceId: body.sourceId,
    providerId: body.providerId,
    baseUrl: body.baseUrl,
    api: body.api,
    ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
  };
}

function parseSettingsConfigMutation(body: Record<string, unknown>): Record<string, unknown> {
  if (!exactKeys(body, ["expectedRevision", "content"])) invalidSettingsConfigBody();
  if (typeof body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) invalidSettingsConfigBody();
  if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 256 * 1024) invalidSettingsConfigBody();
  return { expectedRevision: body.expectedRevision, content: body.content };
}

function parseModelsConfigMutation(body: Record<string, unknown>): Record<string, unknown> {
  if (!exactKeys(body, ["expectedRevision", "providers"])) invalidModelsConfigBody();
  if (typeof body.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) invalidModelsConfigBody();
  if (!Array.isArray(body.providers)) invalidModelsConfigBody();
  const providers = body.providers.map((raw) => {
    if (!isPlainObject(raw)) invalidModelsConfigBody();
    const allowed = ["sourceId", "id", "baseUrl", "api", "apiKey", "modelsDefined", "models"];
    if (Object.keys(raw).some((key) => !allowed.includes(key))) invalidModelsConfigBody();
    const sourceId = raw.sourceId;
    if (sourceId !== null && (typeof sourceId !== "string" || !sourceId.trim())) invalidModelsConfigBody();
    if (typeof raw.id !== "string" || !raw.id.trim()) invalidModelsConfigBody();
    if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== "string" || !raw.baseUrl.length)) invalidModelsConfigBody();
    if (raw.api !== undefined && (typeof raw.api !== "string" || !raw.api.length)) invalidModelsConfigBody();
    if (typeof raw.modelsDefined !== "boolean" || !Array.isArray(raw.models)) invalidModelsConfigBody();
    if (!isPlainObject(raw.apiKey)) invalidModelsConfigBody();
    const mode = raw.apiKey.mode;
    if (mode !== "preserve" && mode !== "remove" && mode !== "replace") invalidModelsConfigBody();
    const apiKey = mode === "replace"
      ? (exactKeys(raw.apiKey, ["mode", "value"]) && typeof raw.apiKey.value === "string" && raw.apiKey.value.trim()
          ? { mode, value: raw.apiKey.value }
          : invalidModelsConfigBody())
      : exactKeys(raw.apiKey, ["mode"])
        ? { mode }
        : invalidModelsConfigBody();
    return {
      sourceId,
      id: raw.id,
      ...(raw.baseUrl === undefined ? {} : { baseUrl: raw.baseUrl }),
      ...(raw.api === undefined ? {} : { api: raw.api }),
      apiKey,
      modelsDefined: raw.modelsDefined,
      models: raw.models.map(parseModelsConfigModel),
    };
  });
  return { expectedRevision: body.expectedRevision, providers };
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
      // Global catalog: no cwd and no legacy/unknown query surface. Reject
      // even a bare `?` before touching the adapter.
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      try {
        const modelsRaw = await deps.models!.listModels();
        const defaultRaw = await deps.models!.getDefaultModel();
        const models = projectArray(modelsRaw, projectModelInfo);
        const defaultModel = projectDefaultModel(defaultRaw);
        return c.json({ models, defaultModel });
      } catch (error) {
        throw mapCatalogError(error, "model");
      }
    });
  }

  if (deps.modelsMutation) {
    app.get("/v1/models/config", async (c) => {
      noStore(c);
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      try {
        return c.json(projectModelsConfigSnapshot(await deps.modelsMutation!.readConfig()));
      } catch (error) {
        throw mapModelsConfigError(error);
      }
    });

    app.post("/v1/models/discover", async (c) => {
      noStore(c);
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      const input = parseModelDiscoveryInput(await readJsonObject(c, MODELS_CONFIG_BODY_LIMIT));
      try {
        return c.json(projectDiscoveredModels(await deps.modelsMutation!.discoverModels(input)));
      } catch (error) {
        throw mapModelsConfigError(error);
      }
    });

    app.put("/v1/models/config", async (c) => {
      noStore(c);
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      const body = await readJsonObject(c, MODELS_CONFIG_BODY_LIMIT);
      const input = parseModelsConfigMutation(body);
      try {
        const result = await deps.modelsMutation!.writeConfig(input);
        return c.json(projectModelsConfigSnapshot(result));
      } catch (error) {
        throw mapModelsConfigError(error);
      }
    });
  }

  if (deps.settingsMutation) {
    app.get("/v1/settings/config", async (c) => {
      noStore(c);
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      try {
        return c.json(projectSettingsConfigSnapshot(await deps.settingsMutation!.readConfig()));
      } catch (error) {
        throw mapSettingsConfigError(error);
      }
    });

    app.put("/v1/settings/config", async (c) => {
      noStore(c);
      if (c.req.url.includes("?")) {
        throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
      }
      const input = parseSettingsConfigMutation(await readJsonObject(c, SETTINGS_CONFIG_BODY_LIMIT));
      try {
        return c.json(projectSettingsConfigSnapshot(await deps.settingsMutation!.writeConfig(input)));
      } catch (error) {
        throw mapSettingsConfigError(error);
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
