/**
 * Lore connection configuration (read/write `~/.lore/config.json`) and the
 * "test connection" probe.
 *
 * Pix NEVER installs or updates the Lore extension or CLI — it only manages
 * the shared connection settings so the user's other Lore clients see the
 * same server. File format and precedence mirror the official Lore Pi
 * extension (pinned 1.5.1): `~/.lore/config.json` `{ base_url, api_token }`
 * first, then `LORE_BASE_URL` / `LORE_API_TOKEN`; `LORE_HOME` overrides the
 * state directory. Writes preserve unknown sibling keys (installed_version,
 * docker_managed, …) and publish atomically with mode 0600. The API token is
 * write-only: nothing in this module ever returns it, and error paths never
 * include it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
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

/**
 * Lore state directory (`LORE_HOME`, default `~/.lore`).
 *
 * Synchronous lexical form for reads. Writes must not feed this straight into
 * the private-directory walk: on macOS `os.tmpdir()` is `/var/folders/...`
 * while `/var` is a symlink to `/private/var`, and the walk fail-closes on any
 * symlinked component. {@link canonicalLoreHomeDir} resolves that alias first.
 */
export function resolveLoreHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = nonEmptyString(env.LORE_HOME);
  return fromEnv !== undefined ? fromEnv : join(homedir(), ".lore");
}

async function canonicalLoreHomeDir(env: NodeJS.ProcessEnv): Promise<string> {
  return secureState.canonicalizePath(resolveLoreHomeDir(env));
}

function loreConfigPath(env: NodeJS.ProcessEnv): string {
  return join(resolveLoreHomeDir(env), "config.json");
}

/** Same file, addressed through the canonical home so reads match a canonical write. */
function canonicalLoreConfigPath(home: string): string {
  return join(home, "config.json");
}

interface SharedLoreConfig {
  baseUrl?: string;
  apiToken?: string;
  raw: Record<string, unknown>;
}

function readSharedLoreConfigAt(path: string): SharedLoreConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
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

function readSharedLoreConfig(env: NodeJS.ProcessEnv): SharedLoreConfig {
  return readSharedLoreConfigAt(loreConfigPath(env));
}

/**
 * Effective Lore connection facts (no secrets): config file first, then
 * env — the same per-field precedence the Lore extension applies. Mirrors
 * runtime-core `LoreConnectionSnapshot`.
 */
function projectLoreConnection(shared: SharedLoreConfig, env: NodeJS.ProcessEnv): LoreConnectionSnapshot {
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

export function detectLoreConnection(env: NodeJS.ProcessEnv = process.env): LoreConnectionSnapshot {
  return projectLoreConnection(readSharedLoreConfig(env), env);
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

  const loreHome = await canonicalLoreHomeDir(env);
  try {
    await ensureLoreStateDirectory(loreHome);
    await secureState.writeStateDocument(canonicalLoreConfigPath(loreHome), `${JSON.stringify(document, null, 2)}\n`, {
      maxBytes: LORE_CONFIG_MAX_BYTES,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw runtimeError("unavailable", "Lore connection could not be saved");
  }
  return detectLoreConnectionAt(loreHome, env);
}

/**
 * Ensure the Lore state directory exists WITHOUT demanding 0700 on a
 * directory Lore itself created (the official tooling ships 0755). Pix never
 * owns or chmods ~/.lore: an EXISTING directory only has to be a real
 * non-symlink directory owned by the current user (POSIX only); a MISSING
 * one is created through the secure-state walk with its usual 0700. Privacy
 * of the secret itself is enforced by config.json (0600, atomic, fsynced) in
 * {@link secureState.writeStateDocument}.
 */
async function ensureLoreStateDirectory(home: string): Promise<void> {
  const info = lstatSync(home, { throwIfNoEntry: false });
  if (info !== undefined) {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw runtimeError("invalid_input", "Lore state directory is not a directory");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw runtimeError("unavailable", "Lore state directory is owned by another user");
    }
    return;
  }
  await secureState.ensurePrivateDirectory(home);
}

/** Connection facts read from one already-canonical home (post-save read-back). */
function detectLoreConnectionAt(loreHome: string, env: NodeJS.ProcessEnv): LoreConnectionSnapshot {
  return projectLoreConnection(readSharedLoreConfigAt(canonicalLoreConfigPath(loreHome)), env);
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
  const hasInputBase = typeof input?.baseUrl === "string" && input.baseUrl.trim() !== "";
  const rawBase = (hasInputBase
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
  const explicitToken = typeof input?.apiToken === "string" && input.apiToken.length > 0 ? input.apiToken : undefined;
  // The saved token only ever travels to the CURRENTLY EFFECTIVE base. A
  // probe of any other origin must carry its own explicit token — never the
  // stored secret (and never LORE_API_TOKEN), or the endpoint would leak it.
  const effectiveBase = (shared.baseUrl ?? nonEmptyString(env.LORE_BASE_URL) ?? "").trim().replace(/\/+$/, "");
  const apiToken = hasInputBase && rawBase !== effectiveBase
    ? explicitToken
    : explicitToken ?? shared.apiToken ?? nonEmptyString(env.LORE_API_TOKEN);
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
      // A redirect would move the Authorization header to another origin;
      // manual mode surfaces the 3xx instead and the probe fails closed.
      redirect: "manual",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, reason: "unreachable" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "unreachable" };
  return { ok: true, baseUrl: rawBase };
}
