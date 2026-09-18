import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { createPosixSecureStateBackend } from "@fffattiger/pix-local-authority";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  SettingsConfigMutation,
  SettingsConfigSnapshot,
  SettingsConfigStorePort,
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
}

interface RawSource {
  text: string;
  revision: string;
}

async function readSource(agentDir: string): Promise<RawSource> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", revision: revisionOf("") };
    throw runtimeError("unavailable", "settings.json could not be read");
  }
  return { text, revision: revisionOf(text) };
}

export interface PiSdkSettingsConfigOptions {
  agentDir?: string;
}

/**
 * Raw-text global settings.json editor store. The user's bytes are returned
 * and written verbatim (comments/formatting preserved); writes are validated
 * offline, fenced by a SHA-256 revision, serialized per agentDir, and
 * persisted with an owner-only atomic document write.
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
  };
}
