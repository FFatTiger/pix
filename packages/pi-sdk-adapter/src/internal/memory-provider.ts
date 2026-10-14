/**
 * Runtime memory-provider resolution (synchronous, worker-side).
 *
 * One function decides which bundled memory plugin loads and which "记忆"
 * copy the assistant prompt carries: the `pixMemoryProvider` key of the
 * global `<agentDir>/settings.json` (absent = migration default: Lore when a
 * Lore connection already exists on this machine, else local memory). Reads
 * are fail-closed: a malformed settings.json or an invalid provider value is
 * an error, never a silent fallback to local memory (that would split the
 * user's memory).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveMemoryProvider,
  normalizeMemoryProviderValue,
  type LoreConnectionSnapshot,
  type MemoryProvider,
} from "@fffattiger/pix-runtime-core";
import { stripJsonComments } from "./models-json.js";
import { detectLoreConnection } from "./lore-config-store.js";

/** settings.json key that owns the memory provider selection. */
export const MEMORY_PROVIDER_SETTINGS_KEY = "pixMemoryProvider";

export interface MemoryRuntimeState {
  provider: MemoryProvider;
  /** Explicitly persisted provider; undefined when the key is absent. */
  explicit: MemoryProvider | undefined;
  lore: LoreConnectionSnapshot;
}

function readSettingsJsonSync(agentDir: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(join(agentDir, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw runtimeError("unavailable", "settings.json could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    throw runtimeError("invalid_input", "settings.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw runtimeError("invalid_input", "settings.json must be an object");
  }
  return parsed as Record<string, unknown>;
}

function runtimeError(code: "invalid_input" | "unavailable", message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Effective memory provider for a session load. `env` injection keeps the
 * resolution deterministic in tests; production passes the worker env.
 */
export function readMemoryRuntimeStateSync(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryRuntimeState {
  const parsed = readSettingsJsonSync(agentDir);
  let explicit: MemoryProvider | undefined;
  if (parsed !== null && parsed[MEMORY_PROVIDER_SETTINGS_KEY] !== undefined) {
    explicit = normalizeMemoryProviderValue(parsed[MEMORY_PROVIDER_SETTINGS_KEY]);
    if (explicit === null) {
      throw runtimeError("invalid_input", `settings.json ${MEMORY_PROVIDER_SETTINGS_KEY} is invalid`);
    }
  }
  const lore = detectLoreConnection(env);
  return { provider: effectiveMemoryProvider(explicit, lore.configured), explicit, lore };
}
