import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { createPosixSecureStateBackend } from "@fffattiger/pix-local-authority";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  SettingsConfigMutation,
  SettingsConfigSnapshot,
  SettingsConfigStorePort,
  ToolSettingsMutation,
  ToolSettingsSnapshot,
  ToolsSelection,
} from "@fffattiger/pix-runtime-core";
import { stripJsonComments } from "./models-json.js";

const SETTINGS_MAX_BYTES = 256 * 1024;
const secureState = createPosixSecureStateBackend();

function runtimeError(code: "invalid_input" | "conflict" | "unavailable", message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

const mutationQueues = new Map<string, Promise<unknown>>();

function withMutationQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  mutationQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

function revisionOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Non-empty string tool name without control characters. */
function isToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Validate the candidate settings text before publishing. Mirrors the Pi CLI
 * loader's tolerance (`//` line comments, trailing commas) and the model
 * catalog's consumed-field type checks so a saved file can never break the
 * running global model catalog. Unknown keys round-trip untouched.
 */
function validateSettingsText(content: string): void {
  if (!content.trim()) {
    throw runtimeError("invalid_input", "settings.json cannot be empty");
  }
  if (Buffer.byteLength(content, "utf8") > SETTINGS_MAX_BYTES) {
    throw runtimeError("invalid_input", "settings.json is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content));
  } catch {
    throw runtimeError("invalid_input", "settings.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw runtimeError("invalid_input", "settings.json must be an object");
  }
  validateKnownFieldTypes(parsed);
}

/**
 * Type-check the fields whose types other readers depend on (models catalog,
 * tools selection). A wrong type fails closed instead of being silently
 * reinterpreted at read time.
 */
function validateKnownFieldTypes(parsed: Record<string, unknown>): void {
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    const value = parsed[key];
    if (value !== undefined && typeof value !== "string") {
      throw runtimeError("invalid_input", `settings.json ${key} must be a string`);
    }
  }
  const enabled = parsed.enabledModels;
  if (enabled !== undefined && !Array.isArray(enabled)) {
    throw runtimeError("invalid_input", "settings.json enabledModels must be an array");
  }
  const defaultTools = parsed.defaultTools;
  if (
    defaultTools !== undefined
    && (!Array.isArray(defaultTools) || !defaultTools.every((entry) => typeof entry === "string"))
  ) {
    throw runtimeError("invalid_input", "settings.json defaultTools must be an array of strings");
  }
  const pixDefaultTools = parsed.pixDefaultTools;
  if (
    pixDefaultTools !== undefined
    && pixDefaultTools !== null
    && (!Array.isArray(pixDefaultTools) || !pixDefaultTools.every(isToolName))
  ) {
    throw runtimeError("invalid_input", "settings.json pixDefaultTools must be null or an array of tool names");
  }
}

/** Strict, order-preserving normalization of a `pixDefaultTools` allowlist. */
function normalizeToolNamesList(value: readonly unknown[]): string[] | null {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isToolName(raw)) return null;
    if (!seen.has(raw)) { seen.add(raw); names.push(raw); }
  }
  return names;
}

/**
 * Resolve the persisted global tool selection from a parsed settings object.
 *
 * `pixDefaultTools` wins when present (`null` = all, array = custom). When the
 * key is absent the native Pi `defaultTools` selection (including `+`/`-`
 * modifiers) is honored — resolved through the SDK SettingsManager so pix
 * never copies the Pi +/- algorithm. Neither key means Pix defaults to all.
 */
function resolveToolsSelection(parsed: Record<string, unknown>): ToolsSelection {
  const pixDefaultTools = parsed.pixDefaultTools;
  if (pixDefaultTools === null) return { mode: "all" };
  if (Array.isArray(pixDefaultTools)) {
    const names = normalizeToolNamesList(pixDefaultTools);
    if (names === null) {
      throw runtimeError("invalid_input", "settings.json pixDefaultTools must be null or an array of tool names");
    }
    return { mode: "custom", toolNames: names };
  }
  if (pixDefaultTools !== undefined) {
    throw runtimeError("invalid_input", "settings.json pixDefaultTools must be null or an array of tool names");
  }
  const native = SettingsManager.inMemory(parsed as never).getDefaultTools();
  return native === undefined ? { mode: "all" } : { mode: "native", toolNames: native };
}

function parseSettingsObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    throw runtimeError("invalid_input", "settings.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw runtimeError("invalid_input", "settings.json must be an object");
  }
  validateKnownFieldTypes(parsed);
  return parsed;
}

/**
 * Runtime and settings UI share strict parsing. Only a missing file or absent
 * pixDefaultTools key inherits native defaults; unreadable or malformed
 * preferences must never silently enable tools.
 */
export type GlobalToolsPreference = Exclude<ToolsSelection, { mode: "native" }> | { mode: "unset" };

export async function readGlobalToolsPreference(agentDir: string): Promise<GlobalToolsPreference> {
  const source = await readSource(agentDir);
  if (!source.present) return { mode: "unset" };
  const parsed = parseSettingsObject(source.text);
  if (parsed.pixDefaultTools === undefined) return { mode: "unset" };
  const selection = resolveToolsSelection(parsed);
  // With a present, validated Pix key the resolver cannot select native mode.
  if (selection.mode === "native") throw runtimeError("invalid_input", "tools configuration is invalid");
  return selection;
}

interface RawSource {
  text: string;
  revision: string;
  present: boolean;
}

async function readSource(agentDir: string): Promise<RawSource> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", revision: revisionOf(""), present: false };
    throw runtimeError("unavailable", "settings.json could not be read");
  }
  return { text, revision: revisionOf(text), present: true };
}

export interface PiSdkSettingsConfigOptions {
  agentDir?: string;
}

/**
 * Raw-text global settings.json editor store. The user's bytes are returned
 * and written verbatim (comments/formatting preserved); writes are validated
 * offline, fenced by a SHA-256 revision, serialized per agentDir, and
 * persisted with an owner-only atomic document write. The structured tools
 * selection read/write rides the SAME queue, lock and CAS fence, so a raw
 * editor save and a tools toggle can never interleave.
 */
export function createPiSdkSettingsConfigStore(options: PiSdkSettingsConfigOptions = {}): SettingsConfigStorePort {
  const configuredAgentDir = resolve(options.agentDir ?? getAgentDir());
  const canonicalAgentDir = () => secureState.canonicalizePath(configuredAgentDir);
  return {
    readConfig: async () => {
      const source = await readSource(await canonicalAgentDir());
      return { revision: source.revision, content: source.text };
    },
    writeConfig: (input: SettingsConfigMutation) => withMutationQueue(configuredAgentDir, async () => {
      if (!/^[0-9a-f]{64}$/.test(input.expectedRevision)) {
        throw runtimeError("invalid_input", "settings configuration input is invalid");
      }
      validateSettingsText(input.content);
      const agentDir = await canonicalAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      try {
        await secureState.ensurePrivateDirectory(agentDir);
      } catch {
        throw runtimeError("unavailable", "settings configuration is unavailable");
      }
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(agentDir, {
          realpath: false,
          lockfilePath: `${settingsPath}.lock`,
          retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
        });
        const current = await readSource(agentDir);
        if (current.revision !== input.expectedRevision) {
          throw runtimeError("conflict", "settings configuration changed");
        }
        await secureState.writeStateDocument(settingsPath, input.content, { maxBytes: SETTINGS_MAX_BYTES });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw runtimeError("unavailable", "settings configuration could not be saved");
      } finally {
        await release?.().catch(() => {});
      }
      const source = await readSource(agentDir);
      return { revision: source.revision, content: source.text };
    }),
    readToolsConfig: async () => {
      const source = await readSource(await canonicalAgentDir());
      // A present-but-corrupt settings.json is an explicit error: the tools
      // selection cannot be determined, never silently "all".
      const selection = !source.present
        ? { mode: "all" } as const
        : resolveToolsSelection(parseSettingsObject(source.text));
      return { revision: source.revision, selection };
    },
    writeToolsConfig: (input: ToolSettingsMutation) => withMutationQueue(configuredAgentDir, async () => {
      if (!/^[0-9a-f]{64}$/.test(input.expectedRevision)) {
        throw runtimeError("invalid_input", "tools configuration input is invalid");
      }
      let toolNames: string[] | null;
      if (input.toolNames === null) {
        toolNames = null;
      } else if (Array.isArray(input.toolNames)) {
        const normalized = normalizeToolNamesList(input.toolNames);
        if (normalized === null) {
          throw runtimeError("invalid_input", "tools configuration input is invalid");
        }
        toolNames = normalized;
      } else {
        throw runtimeError("invalid_input", "tools configuration input is invalid");
      }
      const agentDir = await canonicalAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      try {
        await secureState.ensurePrivateDirectory(agentDir);
      } catch {
        throw runtimeError("unavailable", "tools configuration is unavailable");
      }
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(agentDir, {
          realpath: false,
          lockfilePath: `${settingsPath}.lock`,
          retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
        });
        const current = await readSource(agentDir);
        if (current.revision !== input.expectedRevision) {
          throw runtimeError("conflict", "settings configuration changed");
        }
        const parsed = current.present ? parseSettingsObject(current.text) : {};
        // Structured write touches ONLY pixDefaultTools. Unknown keys and the
        // native defaultTools key round-trip untouched; serialization via
        // JSON.stringify normalizes formatting/comments of the whole document
        // (the raw editor remains the verbatim-bytes path).
        parsed.pixDefaultTools = toolNames;
        await secureState.writeStateDocument(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, {
          maxBytes: SETTINGS_MAX_BYTES,
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw runtimeError("unavailable", "tools configuration could not be saved");
      } finally {
        await release?.().catch(() => {});
      }
      const source = await readSource(agentDir);
      const selection = resolveToolsSelection(parseSettingsObject(source.text));
      return { revision: source.revision, selection };
    }),
  };
}
