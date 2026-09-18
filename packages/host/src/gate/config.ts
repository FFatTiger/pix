import { readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateConfig, GateConfigSource, GatePasswordStore } from "../types.js";

export function normalizeGateConfig(input: unknown): GateConfig {
  const candidate = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  const source = typeof candidate?.source === "string" && candidate.source.length > 0
    ? candidate.source
    : "injected";
  const invalid = (reason: string): GateConfig => ({
    status: "error",
    source,
    logMessage: `Invalid gate configuration from ${source}: ${reason}`,
  });
  if (!candidate) return invalid("expected an object");

  switch (candidate.status) {
    case "enabled":
      if (typeof candidate.password !== "string" || candidate.password.length === 0) {
        return invalid("enabled status requires a non-empty string password");
      }
      if (candidate.logMessage !== undefined) {
        return invalid("enabled status must not include logMessage");
      }
      return { status: "enabled", source, password: candidate.password };
    case "disabled":
    case "unconfigured":
      if (candidate.password !== undefined || candidate.logMessage !== undefined) {
        return invalid(`${candidate.status} status must not include password or logMessage`);
      }
      return { status: candidate.status, source };
    case "error":
      if (candidate.password !== undefined) {
        return invalid("error status must not include password");
      }
      if (candidate.logMessage !== undefined && typeof candidate.logMessage !== "string") {
        return invalid("error logMessage must be a string");
      }
      return candidate.logMessage === undefined
        ? { status: "error", source }
        : { status: "error", source, logMessage: candidate.logMessage };
    default:
      return invalid("unknown status");
  }
}

/** Wrap any injected source so every consumer sees the same strict config. */
export function createNormalizedGateConfigSource(source: GateConfigSource): GateConfigSource {
  return { read: () => normalizeGateConfig(source.read()) };
}

export interface ReadGateConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the pix.json path (default: $PI_CODING_AGENT_DIR or ~/.pi). */
  configPath?: string;
  /** Test seam for file reads. */
  readFile?: (path: string, encoding: "utf8") => string;
}

/**
 * Legacy `getAgentDir()` semantics without importing the Pi SDK: the agent
 * directory is $PI_CODING_AGENT_DIR, falling back to ~/.pi.
 */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override || join(homedir(), ".pi");
}

export function defaultGateConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultAgentDir(env), "pix.json");
}

function parseDisabled(value: string | undefined): boolean | undefined | "invalid" {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return "invalid";
}

/**
 * Read the gate config from env + ~/.pi/pix.json. Semantics mirror the
 * legacy `lib/web-auth-config.ts` (referenced, never imported):
 * env overrides file; blank password is "unconfigured"; explicit disable wins.
 */
export function readGateConfig(options: ReadGateConfigOptions = {}): GateConfig {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultGateConfigPath(env);
  const readFile = options.readFile ?? readFileSync;

  let fileAuth: { password?: string; disabled?: boolean } = {};
  try {
    const parsed: unknown = JSON.parse(readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "error",
        source: configPath,
        logMessage: `${configPath} must contain a JSON object`,
      };
    }
    const auth = (parsed as { auth?: unknown }).auth;
    if (auth !== undefined) {
      if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
        return {
          status: "error",
          source: configPath,
          logMessage: `${configPath}: auth must be an object`,
        };
      }
      const candidate = auth as { password?: unknown; disabled?: unknown };
      if (candidate.password !== undefined && typeof candidate.password !== "string") {
        return {
          status: "error",
          source: configPath,
          logMessage: `${configPath}: auth.password must be a string`,
        };
      }
      if (candidate.disabled !== undefined && typeof candidate.disabled !== "boolean") {
        return {
          status: "error",
          source: configPath,
          logMessage: `${configPath}: auth.disabled must be a boolean`,
        };
      }
      fileAuth = {};
      if (typeof candidate.password === "string") fileAuth.password = candidate.password;
      if (typeof candidate.disabled === "boolean") fileAuth.disabled = candidate.disabled;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        status: "error",
        source: configPath,
        logMessage: `Failed to read ${configPath}: ${String(error)}`,
      };
    }
  }

  const envDisabled = parseDisabled(env.PIX_AUTH_DISABLED);
  if (envDisabled === "invalid") {
    return {
      status: "error",
      source: "env",
      logMessage: "PIX_AUTH_DISABLED must be true or false",
    };
  }

  const disabled = envDisabled ?? fileAuth.disabled ?? false;
  const password =
    env.PIX_PASSWORD !== undefined ? env.PIX_PASSWORD : fileAuth.password;

  if (disabled) return { status: "disabled", source: configPath };
  if (typeof password === "string" && password.length > 0) {
    return { status: "enabled", password, source: configPath };
  }
  return { status: "unconfigured", source: configPath };
}

export function createEnvGateConfigSource(
  options: ReadGateConfigOptions = {},
): GateConfigSource {
  return { read: () => normalizeGateConfig(readGateConfig(options)) };
}

/** True when PIX_PASSWORD overrides whatever the config file says. */
export function isEnvPasswordManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIX_PASSWORD !== undefined;
}

/** Fixed failure codes for the access-key write (mapped to sanitized host errors). */
export type GatePasswordWriteCode = "INVALID_CONFIG" | "UNSAFE_CONFIG_PATH" | "WRITE_FAILED";

export class GatePasswordWriteError extends Error {
  readonly code: GatePasswordWriteCode;
  constructor(code: GatePasswordWriteCode, message: string) {
    super(message);
    this.name = "GatePasswordWriteError";
    this.code = code;
  }
}

export interface WriteGatePasswordOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the pix.json path (default: $PI_CODING_AGENT_DIR or ~/.pi). */
  configPath?: string;
  /** Test seams (same-shape sync fs functions). */
  readFile?: (path: string, encoding: "utf8") => string;
  writeFile?: (path: string, data: string) => void;
  rename?: (from: string, to: string) => void;
  lstat?: (path: string) => { isSymbolicLink(): boolean };
  mkdir?: (path: string) => void;
  randomSuffix?: () => string;
}

interface PixDocumentFsSeams {
  readFile: (path: string, encoding: "utf8") => string;
  writeFile: (path: string, data: string) => void;
  rename: (from: string, to: string) => void;
  lstat: (path: string) => { isSymbolicLink(): boolean };
  mkdir: (path: string) => void;
  randomSuffix: () => string;
}

const MAX_CONFIG_BYTES = 256 * 1024;

/** Read + parse the pix.json root object (ENOENT → fresh {}). */
function readPixDocument(configPath: string, seams: PixDocumentFsSeams): Record<string, unknown> {
  let root: Record<string, unknown> = {};
  try {
    const stats = seams.lstat(configPath);
    if (stats.isSymbolicLink()) {
      throw new GatePasswordWriteError("UNSAFE_CONFIG_PATH", "config path is a symbolic link");
    }
    const raw = seams.readFile(configPath, "utf8");
    if (raw.length > MAX_CONFIG_BYTES) {
      throw new GatePasswordWriteError("INVALID_CONFIG", "config document exceeds the size bound");
    }
    const parsed: unknown = raw.length === 0 ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GatePasswordWriteError("INVALID_CONFIG", "config document must contain a JSON object");
    }
    root = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GatePasswordWriteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GatePasswordWriteError("INVALID_CONFIG", `failed to read config: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    }
  }
  return root;
}

/** Atomic publish: same-dir 0600 temp → fsync-free rename → best-effort dir ensure. */
function publishPixDocument(configPath: string, root: Record<string, unknown>, seams: PixDocumentFsSeams): void {
  const tempPath = `${configPath}.tmp-${process.pid}-${seams.randomSuffix()}`;
  try {
    seams.mkdir(dirname(configPath));
    seams.writeFile(tempPath, `${JSON.stringify(root, null, 2)}\n`);
    seams.rename(tempPath, configPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best-effort temp cleanup */ }
    throw new GatePasswordWriteError("WRITE_FAILED", `failed to write config: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}

/**
 * Persist a new access key into pix.json (`auth.password`), preserving every
 * other field. Same owner as `readGateConfig`: this module is the single
 * authority for the pix.json auth file shape. The write is atomic (same-dir
 * 0600 temp file → rename) and refuses a symlinked config path.
 */
export function writeGatePassword(input: { password: string } & WriteGatePasswordOptions): void {
  const { password } = input;
  if (typeof password !== "string" || password.length === 0 || password.length > 128) {
    throw new GatePasswordWriteError("INVALID_CONFIG", "password must be a non-empty string of at most 128 characters");
  }
  const env = input.env ?? process.env;
  const configPath = input.configPath ?? defaultGateConfigPath(env);
  const seams: PixDocumentFsSeams = {
    readFile: input.readFile ?? readFileSync,
    writeFile: input.writeFile ?? ((path, data) => writeFileSync(path, data, { mode: 0o600 })),
    rename: input.rename ?? renameSync,
    lstat: input.lstat ?? lstatSync,
    mkdir: input.mkdir ?? ((path) => mkdirSync(path, { recursive: true, mode: 0o700 })),
    randomSuffix: input.randomSuffix ?? (() => randomUUID().slice(0, 8)),
  };

  const root = readPixDocument(configPath, seams);

  const auth = root.auth;
  if (auth !== undefined && (!auth || typeof auth !== "object" || Array.isArray(auth))) {
    throw new GatePasswordWriteError("INVALID_CONFIG", "config auth must be an object");
  }
  const nextAuth: Record<string, unknown> = { ...(auth as Record<string, unknown> | undefined), password };
  if (nextAuth.disabled !== undefined && typeof nextAuth.disabled !== "boolean") {
    throw new GatePasswordWriteError("INVALID_CONFIG", "config auth.disabled must be a boolean");
  }
  publishPixDocument(configPath, { ...root, auth: nextAuth }, seams);
}

/** Default file-backed access-key store over `~/.pi/pix.json`. */
export function createFileGatePasswordStore(options: WriteGatePasswordOptions = {}): GatePasswordStore {
  return {
    write: (password) => {
      writeGatePassword({ ...options, password });
    },
  };
}

// ── Server-side user preferences (same pix.json document) ───────────────────

export type GatePreferences = Record<string, string>;
export interface GatePreferencesStore {
  read(): GatePreferences;
  /** Per-key patch: null deletes; returns the resulting map. */
  patch(patch: Record<string, string | null>): GatePreferences;
}

const PREFERENCE_KEY_PATTERN = /^pi-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PREFERENCE_KEYS = 64;
const MAX_PREFERENCE_VALUE_CHARS = 16 * 1024;

/**
 * The server-side preference map in pix.json (`preferences`). Values are the
 * SAME raw strings the client mirrors into localStorage (no per-key parsing,
 * byte-faithful round-trip). One file owner: this module.
 */
export function readGatePreferences(options: WriteGatePasswordOptions = {}): GatePreferences {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultGateConfigPath(env);
  const seams = preferenceSeams(options);
  const root = readPixDocument(configPath, seams);
  return normalizePreferences(root.preferences);
}

export function patchGatePreferences(input: { patch: Record<string, string | null> } & WriteGatePasswordOptions): GatePreferences {
  const patch = input.patch;
  const keys = Object.keys(patch);
  if (keys.length > MAX_PREFERENCE_KEYS) {
    throw new GatePasswordWriteError("INVALID_CONFIG", `preference patch exceeds ${MAX_PREFERENCE_KEYS} keys`);
  }
  for (const key of keys) {
    if (!PREFERENCE_KEY_PATTERN.test(key) || key.length > 64) {
      throw new GatePasswordWriteError("INVALID_CONFIG", "preference key must match pi-kebab-case (max 64 chars)");
    }
    const value = patch[key];
    if (value !== null && (typeof value !== "string" || value.length > MAX_PREFERENCE_VALUE_CHARS)) {
      throw new GatePasswordWriteError("INVALID_CONFIG", `preference value for ${key} must be a string of at most ${MAX_PREFERENCE_VALUE_CHARS} characters or null`);
    }
  }
  const env = input.env ?? process.env;
  const configPath = input.configPath ?? defaultGateConfigPath(env);
  const seams = preferenceSeams(input);
  const root = readPixDocument(configPath, seams);
  const current = normalizePreferences(root.preferences);
  const next: GatePreferences = { ...current };
  for (const key of keys) {
    const value = patch[key];
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  const nextKeys = Object.keys(next);
  if (nextKeys.length > MAX_PREFERENCE_KEYS) {
    throw new GatePasswordWriteError("INVALID_CONFIG", `preference map exceeds ${MAX_PREFERENCE_KEYS} keys`);
  }
  publishPixDocument(configPath, { ...root, preferences: next }, seams);
  return next;
}

export function createFileGatePreferencesStore(options: WriteGatePasswordOptions = {}): GatePreferencesStore {
  return {
    read: () => readGatePreferences(options),
    patch: (patch) => patchGatePreferences({ ...options, patch }),
  };
}

function preferenceSeams(options: WriteGatePasswordOptions): PixDocumentFsSeams {
  return {
    readFile: options.readFile ?? readFileSync,
    writeFile: options.writeFile ?? ((path, data) => writeFileSync(path, data, { mode: 0o600 })),
    rename: options.rename ?? renameSync,
    lstat: options.lstat ?? lstatSync,
    mkdir: options.mkdir ?? ((path) => mkdirSync(path, { recursive: true, mode: 0o700 })),
    randomSuffix: options.randomSuffix ?? (() => randomUUID().slice(0, 8)),
  };
}

function normalizePreferences(value: unknown): GatePreferences {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatePasswordWriteError("INVALID_CONFIG", "config preferences must be an object");
  }
  const out: GatePreferences = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
