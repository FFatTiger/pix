/**
 * Lore connection configuration (read/write `~/.lore/config.json`) and the
 * "test connection" probe.
 *
 * Pix NEVER installs or updates the Lore extension or CLI — it only manages
 * the shared connection settings so the user's other Lore clients see the
 * same server. File format and precedence mirror the official Lore Pi
 * extension (pinned 1.5.0): `~/.lore/config.json` `{ base_url, api_token }`
 * first, then `LORE_BASE_URL` / `LORE_API_TOKEN`; `LORE_HOME` overrides the
 * state directory. Writes preserve unknown sibling keys (installed_version,
 * docker_managed, …) and publish atomically with mode 0600. The API token is
 * write-only: nothing in this module ever returns it, and error paths never
 * include it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createPosixSecureStateBackend } from "@fffattiger/pix-local-authority";
import type { LoreConnectionMutation, LoreConnectionSnapshot, LoreTestOutcome, LoreTestRequest } from "@fffattiger/pix-runtime-core";

const LORE_CONFIG_MAX_BYTES = 64 * 1024;
const LORE_TEST_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const secureState = createPosixSecureStateBackend();

function runtimeError(code: "invalid_input" | "unavailable", message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Lore state directory (`LORE_HOME`, default `~/.lore`). */
export function resolveLoreHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = nonEmptyString(env.LORE_HOME);
  return fromEnv !== undefined ? fromEnv : join(homedir(), ".lore");
}

function loreConfigPath(env: NodeJS.ProcessEnv): string {
  return join(resolveLoreHomeDir(env), "config.json");
}

interface SharedLoreConfig {
  baseUrl?: string;
  apiToken?: string;
  raw: Record<string, unknown>;
}

function readSharedLoreConfig(env: NodeJS.ProcessEnv): SharedLoreConfig {
  let text: string;
  try {
    text = readFileSync(loreConfigPath(env), "utf8");
  } catch {
    return { raw: {} };
  }
  if (Buffer.byteLength(text, "utf8") > LORE_CONFIG_MAX_BYTES) return { raw: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: {} };
  }
  if (!isRecord(parsed)) return { raw: {} };
  const baseUrl = nonEmptyString(parsed.base_url);
  const apiToken = nonEmptyString(parsed.api_token);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiToken === undefined ? {} : { apiToken }),
    raw: parsed,
  };
}

/**
 * Effective Lore connection facts (no secrets): config file first, then
 * env — the same per-field precedence the Lore extension applies. Mirrors
 * runtime-core `LoreConnectionSnapshot`.
 */
export function detectLoreConnection(env: NodeJS.ProcessEnv = process.env): LoreConnectionSnapshot {
  const shared = readSharedLoreConfig(env);
  const envBaseUrl = nonEmptyString(env.LORE_BASE_URL);
  const baseUrl = shared.baseUrl ?? envBaseUrl ?? null;
  const tokenConfigured = shared.apiToken !== undefined || nonEmptyString(env.LORE_API_TOKEN) !== undefined;
  return {
    configured: baseUrl !== null && tokenConfigured,
    baseUrl,
    source: shared.baseUrl !== undefined ? "config" : envBaseUrl !== undefined ? "env" : "none",
    tokenConfigured,
  };
}

/** Parsed + validated base URL; http allowed only on loopback hosts. */
function validateLoreBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw runtimeError("invalid_input", "Lore base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw runtimeError("invalid_input", "Lore base URL must be http(s)");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw runtimeError("invalid_input", "plain HTTP is only allowed for loopback Lore servers");
  }
  return url;
}

/**
 * Save the connection into `~/.lore/config.json` (0600, atomic, unknown keys
 * preserved). Token rules mirror @loremem/cli: an explicit token replaces the
 * saved one; omitting the token keeps it when the base URL is unchanged and
 * clears it when the server changed.
 */
export async function saveLoreConnection(
  input: LoreConnectionMutation,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<LoreConnectionSnapshot> {
  if (!isRecord(input) || typeof input.baseUrl !== "string" || input.baseUrl.trim() === "") {
    throw runtimeError("invalid_input", "Lore connection input is invalid");
  }
  const normalizedBase = input.baseUrl.trim().replace(/\/+$/, "");
  validateLoreBaseUrl(normalizedBase);
  const env = options.env ?? process.env;
  const shared = readSharedLoreConfig(env);
  const previousBase = shared.baseUrl?.replace(/\/+$/, "");
  let apiToken: string | undefined;
  if (typeof input.apiToken === "string" && input.apiToken.length > 0) {
    apiToken = input.apiToken;
  } else if (previousBase === normalizedBase) {
    apiToken = shared.apiToken;
  }
  const document: Record<string, unknown> = { ...shared.raw, base_url: normalizedBase };
  if (apiToken === undefined) delete document.api_token;
  else document.api_token = apiToken;

  const loreHome = resolveLoreHomeDir(env);
  try {
    await secureState.ensurePrivateDirectory(loreHome);
    await secureState.writeStateDocument(join(loreHome, "config.json"), `${JSON.stringify(document, null, 2)}\n`, {
      maxBytes: LORE_CONFIG_MAX_BYTES,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw runtimeError("unavailable", "Lore connection could not be saved");
  }
  return detectLoreConnection(env);
}

type FetchLike = typeof fetch;

/**
 * Probe the Lore server health endpoint (`GET <base>/api/health` with the
 * Bearer token, `client_type=pi` — the same call the bundled extension's
 * startup health check makes). A failed probe is a normal outcome, never a
 * thrown error; the token is never included in the result.
 */
export async function testLoreConnection(
  input: LoreTestRequest,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<LoreTestOutcome> {
  const env = options.env ?? process.env;
  const shared = readSharedLoreConfig(env);
  const rawBase = (typeof input?.baseUrl === "string" && input.baseUrl.trim() !== ""
    ? input.baseUrl
    : shared.baseUrl ?? nonEmptyString(env.LORE_BASE_URL) ?? "")!.trim().replace(/\/+$/, "");
  if (rawBase === "") return { ok: false, reason: "invalid_url" };
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "invalid_url" };
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) return { ok: false, reason: "insecure_http" };
  const apiToken = (typeof input?.apiToken === "string" && input.apiToken.length > 0
    ? input.apiToken
    : shared.apiToken ?? nonEmptyString(env.LORE_API_TOKEN));
  if (apiToken === undefined) return { ok: false, reason: "missing_token" };

  // Same URL shape as the bundled extension's `buildApiUrl`: /api/health on
  // the (possibly sub-pathed) base, client_type=pi.
  const health = new URL(`${rawBase}/api/health`);
  health.searchParams.set("client_type", "pi");
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(health.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(LORE_TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "unreachable" };
  return { ok: true, baseUrl: rawBase };
}
