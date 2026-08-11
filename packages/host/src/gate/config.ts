import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateConfig, GateConfigSource } from "../types.js";

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
  /** Override the pi-web.json path (default: $PI_CODING_AGENT_DIR or ~/.pi). */
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
  return join(defaultAgentDir(env), "pi-web.json");
}

function parseDisabled(value: string | undefined): boolean | undefined | "invalid" {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return "invalid";
}

/**
 * Read the gate config from env + ~/.pi/pi-web.json. Semantics mirror the
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

  const envDisabled = parseDisabled(env.PI_WEB_AUTH_DISABLED);
  if (envDisabled === "invalid") {
    return {
      status: "error",
      source: "env",
      logMessage: "PI_WEB_AUTH_DISABLED must be true or false",
    };
  }

  const disabled = envDisabled ?? fileAuth.disabled ?? false;
  const password =
    env.PI_WEB_PASSWORD !== undefined ? env.PI_WEB_PASSWORD : fileAuth.password;

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
