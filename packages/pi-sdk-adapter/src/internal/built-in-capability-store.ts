import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { createPosixSecureStateBackend } from "@fffattiger/pix-local-authority";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  BUILT_IN_CAPABILITY_IDS,
  defaultBuiltInCapabilities,
  normalizeBuiltInCapabilityList,
  type BuiltInCapabilityConfigStorePort,
  type BuiltInCapabilityConfigWrite,
  type BuiltInCapabilityState,
} from "@fffattiger/pix-runtime-core";

const DOCUMENT_NAME = "pix-builtins.json";
const DOCUMENT_MAX_BYTES = 4 * 1024;
const SCHEMA_VERSION = 1;
const secureState = createPosixSecureStateBackend();
const mutationQueues = new Map<string, Promise<unknown>>();

function runtimeError(code: "invalid_input" | "conflict" | "unavailable", message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

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

function serializeDocument(capabilities: readonly BuiltInCapabilityState[]): string {
  const body: Record<string, unknown> = { version: SCHEMA_VERSION };
  for (const row of capabilities) body[row.id] = row.enabled;
  return `${JSON.stringify(body, null, 2)}\n`;
}

function parseDocument(text: string): BuiltInCapabilityState[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== SCHEMA_VERSION) return null;
  const allowed = new Set<string>(["version", ...BUILT_IN_CAPABILITY_IDS]);
  const keys = Object.keys(parsed);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) return null;
  const rows: BuiltInCapabilityState[] = [];
  for (const id of BUILT_IN_CAPABILITY_IDS) {
    const enabled = parsed[id];
    if (typeof enabled !== "boolean") return null;
    rows.push({ id, enabled });
  }
  return rows;
}

interface SourceSnapshot {
  revision: string;
  capabilities: readonly BuiltInCapabilityState[];
}

async function readSource(agentDir: string): Promise<SourceSnapshot> {
  const path = join(agentDir, DOCUMENT_NAME);
  let result;
  try {
    result = await secureState.readStateDocument(path, { maxBytes: DOCUMENT_MAX_BYTES });
  } catch {
    throw runtimeError("unavailable", "built-in configuration is unavailable");
  }
  if ("missing" in result) {
    return { revision: revisionOf(""), capabilities: defaultBuiltInCapabilities() };
  }
  const capabilities = parseDocument(result.content);
  if (!capabilities) {
    throw runtimeError("unavailable", "built-in configuration is unavailable");
  }
  return { revision: revisionOf(result.content), capabilities };
}

function snapshotOf(source: SourceSnapshot) {
  return { revision: source.revision, capabilities: source.capabilities };
}

export interface PiSdkBuiltInCapabilityConfigOptions {
  agentDir?: string;
}

export interface BuiltInCapabilityConfigRead {
  revision: string;
  capabilities: readonly BuiltInCapabilityState[];
}

/**
 * Bounded sync reader for extension reload. Corrupt/unsafe documents throw so
 * reload fails closed instead of applying a stale desired set.
 */
export function readBuiltInCapabilityConfigSync(agentDir: string): BuiltInCapabilityConfigRead {
  return snapshotOf(readSourceSync(resolve(agentDir)));
}

function readSourceSync(agentDir: string): SourceSnapshot {
  const path = join(agentDir, DOCUMENT_NAME);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { revision: revisionOf(""), capabilities: defaultBuiltInCapabilities() };
    }
    throw runtimeError("unavailable", "built-in configuration is unavailable");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > DOCUMENT_MAX_BYTES || (info.mode & 0o077) !== 0 || info.nlink > 1) {
      throw runtimeError("unavailable", "built-in configuration is unavailable");
    }
    const text = readFileSync(fd, "utf8");
    const capabilities = parseDocument(text);
    if (!capabilities) {
      throw runtimeError("unavailable", "built-in configuration is unavailable");
    }
    return { revision: revisionOf(text), capabilities };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "unavailable") {
      throw error;
    }
    throw runtimeError("unavailable", "built-in configuration is unavailable");
  } finally {
    closeSync(fd);
  }
}

/**
 * Durable Pix built-in desired-enablement store (`pix-builtins.json`).
 * Canonical feature booleans only; missing file means all four enabled.
 * Writes are CAS full replacements with owner-only atomic publication.
 */
export function createPiSdkBuiltInCapabilityConfigStore(
  options: PiSdkBuiltInCapabilityConfigOptions = {},
): BuiltInCapabilityConfigStorePort {
  const configuredAgentDir = resolve(options.agentDir ?? getAgentDir());
  const canonicalAgentDir = () => secureState.canonicalizePath(configuredAgentDir);
  return {
    readConfig: async () => snapshotOf(await readSource(await canonicalAgentDir())),
    writeConfig: (input: BuiltInCapabilityConfigWrite) => withMutationQueue(configuredAgentDir, async () => {
      if (!/^[0-9a-f]{64}$/.test(input.expectedRevision)) {
        throw runtimeError("invalid_input", "built-in configuration input is invalid");
      }
      const capabilities = normalizeBuiltInCapabilityList(input.capabilities);
      if (!capabilities) {
        throw runtimeError("invalid_input", "built-in configuration input is invalid");
      }
      const agentDir = await canonicalAgentDir();
      const documentPath = join(agentDir, DOCUMENT_NAME);
      try {
        await secureState.ensurePrivateDirectory(agentDir);
      } catch {
        throw runtimeError("unavailable", "built-in configuration is unavailable");
      }
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(agentDir, {
          realpath: false,
          lockfilePath: `${documentPath}.lock`,
          retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
        });
        const current = await readSource(agentDir);
        if (current.revision !== input.expectedRevision) {
          throw runtimeError("conflict", "built-in configuration changed");
        }
        await secureState.writeStateDocument(documentPath, serializeDocument(capabilities), {
          maxBytes: DOCUMENT_MAX_BYTES,
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code === "invalid_input" || code === "conflict" || code === "unavailable") throw error;
        throw runtimeError("unavailable", "built-in configuration could not be saved");
      } finally {
        await release?.().catch(() => {});
      }
      return snapshotOf(await readSource(agentDir));
    }),
  };
}
