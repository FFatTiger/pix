/**
 * Global MCP settings authority (`<agentDir>/mcp.json`) + connection probe.
 *
 * The document is Pi's own config (SDK 1.3 `builtin:mcp` reads it at session
 * start; `pi mcp add/list` writes it). Pix edits it in place:
 *
 *  - READ: missing file = empty list; malformed file fails CLOSED with
 *    `invalid_input` (never a fake empty list). Invalid ENTRIES are listed
 *    with a fixed reason, exactly like `pi mcp list` reports and skips them.
 *  - WRITE: only the targeted `mcpServers[<name>]` entry changes; every other
 *    key, server, and unknown field inside kept entries is preserved
 *    verbatim. Atomic (same-dir tmp + rename, fsynced); a NEW file is 0600,
 *    an existing file keeps its current mode. Writes are serialized through
 *    one promise chain per store instance.
 *  - SECRETS: `env`/`headers` literal values never leave this module. Only
 *    whole-value `${VAR}` references and `!command` substitutions round-trip
 *    (they contain no secret). Edits use preserve/remove/replace per key, so
 *    an untouched literal stays stored.
 *  - PROBE: McpClient + StdioTransport/StreamableHttpTransport from
 *    @earendil-works/pi-mcp (the SDK's own pinned dependency — never the
 *    SDK's non-exported MCP helpers): connect → tools/list → close. Per
 *    server 15s; `!command` values run through the shell with a 10s bound;
 *    results cached 30s keyed by the exact entry JSON. Closing a stdio
 *    transport closes stdin, then SIGTERM/SIGKILLs the whole process group
 *    (pi-mcp also tracks the group and kills it if this process dies), so no
 *    wrapper children survive.
 *
 * Product decision (cwd): the SDK resolves a RELATIVE stdio `cwd` against the
 * session directory; a probe has no session, so Pix resolves it against the
 * user's home directory (never process.cwd). `~/` in command/args/cwd expands
 * to the home directory, like the SDK.
 */
import { exec as execCallback } from "node:child_process";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import {
  invalidInputError,
  makeRuntimeError,
  type McpImportPreview,
  type McpImportPreviewEntry,
  type McpProbeStatus,
  type McpSecretValue,
  type McpServerKind,
  type McpServerSnapshot,
  type McpServerWrite,
  type McpSettingsSnapshot,
  type McpToolInfo,
} from "@fffattiger/pix-runtime-core";

const exec = promisify(execCallback);

const MCP_FILE_MAX_BYTES = 128 * 1024;
const MCP_IMPORT_MAX_BYTES = 128 * 1024;
/** Server names: letters, digits, `_`, `-` (Pi rule). `-` and `_` collide. */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MCP_NAME_MAX_LENGTH = 64;
const MCP_MAX_SERVERS = 100;
/** Whole-value `${VAR}` reference (round-trips; contains no secret). */
const ENV_REFERENCE_RE = /^\$\{([^}]{1,256})\}$/;
/** Whole-value `!command` substitution (Pi rule: command = the whole value). */
const COMMAND_VALUE_RE = /^!.+/;
const PROBE_TIMEOUT_MS = 15_000;
const COMMAND_VALUE_TIMEOUT_MS = 10_000;
const PROBE_CACHE_TTL_MS = 30_000;
const PROBE_STDERR_TAIL_LINES = 20;
const PROBE_ERROR_MAX_CHARS = 500;
const PROBE_CONCURRENCY = 4;
const MCP_CLIENT_INFO = { name: "pix", version: "1.3.0" } as const;

type SecretMutation = { mode: "preserve" } | { mode: "remove" } | { mode: "replace"; value: string };

interface ValidatedEntry {
  kind: McpServerKind;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  description?: string;
}

interface ReadDocument {
  raw: Record<string, unknown>;
  /** The mcpServers object (replaced wholesale by mutations). */
  servers: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwInvalid(message: string): never {
  throw invalidInputError(message);
}

function throwNotFound(message: string): never {
  throw makeRuntimeError("not_found", message);
}

/** Server-name identity: `-` and `_` are the same server (Pi rule). */
export function normalizeServerName(name: string): string {
  return name.replaceAll("-", "_");
}

// ---------------------------------------------------------------------------
// Entry validation (docs/mcp.md configuration rules)
// ---------------------------------------------------------------------------

/** Validate one raw entry; returns a fixed reason instead of throwing. */
export function validateMcpEntry(
  name: string,
  value: unknown,
): { valid: true; entry: ValidatedEntry } | { valid: false; reason: string } {
  if (!MCP_NAME_RE.test(name) || name.length > MCP_NAME_MAX_LENGTH) {
    return { valid: false, reason: `invalid server name "${name}" (allowed: letters, digits, _ and -)` };
  }
  if (!isRecord(value)) return { valid: false, reason: "entry must be an object" };

  let type: string | undefined;
  if (value.type !== undefined) {
    if (typeof value.type !== "string") return { valid: false, reason: "type must be a string" };
    if (value.type === "sse") {
      return { valid: false, reason: 'legacy "sse" transport is not supported; use the streamable HTTP endpoint (often /mcp)' };
    }
    if (value.type !== "stdio" && value.type !== "http" && value.type !== "streamable-http") {
      return { valid: false, reason: `unknown type "${value.type}"` };
    }
    type = value.type === "streamable-http" ? "http" : value.type;
  }

  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasCommand && hasUrl) return { valid: false, reason: "an entry cannot have both command and url" };
  const kind: McpServerKind | undefined = hasCommand ? "stdio" : hasUrl ? "http" : undefined;
  if (kind === undefined) return { valid: false, reason: "an entry needs a command (stdio) or a url (http)" };
  if (type !== undefined && type !== kind) return { valid: false, reason: `type "${value.type}" does not match the ${kind} fields` };

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { valid: false, reason: "enabled must be a boolean" };
  }
  const entry: ValidatedEntry = { kind, enabled: value.enabled !== false };

  if (kind === "stdio") {
    if (typeof value.command !== "string" || value.command.trim() === "") {
      return { valid: false, reason: "command must be a non-empty string (one executable, not a shell line)" };
    }
    entry.command = value.command;
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
        return { valid: false, reason: "args must be an array of strings" };
      }
      entry.args = value.args as string[];
    }
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== "string" || value.cwd.trim() === "") return { valid: false, reason: "cwd must be a non-empty string" };
      entry.cwd = value.cwd;
    }
    if (value.headers !== undefined || value.url !== undefined) {
      return { valid: false, reason: "an entry cannot have both command and url" };
    }
  } else {
    if (typeof value.url !== "string" || value.url.trim() === "") return { valid: false, reason: "url must be a non-empty string" };
    if (!/^https?:\/\//i.test(value.url)) return { valid: false, reason: "url must be http(s)" };
    entry.url = value.url;
    if (value.headers !== undefined) {
      const headers = validateStringRecord(value.headers, "headers");
      if (typeof headers === "string") return { valid: false, reason: headers };
      entry.headers = headers;
    }
    if (value.command !== undefined || value.args !== undefined || value.env !== undefined || value.cwd !== undefined) {
      return { valid: false, reason: "command/args/env/cwd only apply to stdio servers" };
    }
  }

  if (value.env !== undefined) {
    const env = validateStringRecord(value.env, "env");
    if (typeof env === "string") return { valid: false, reason: env };
    entry.env = env;
  }
  if (value.timeout !== undefined) {
    if (typeof value.timeout !== "number" || !Number.isSafeInteger(value.timeout) || value.timeout <= 0 || value.timeout > 86_400) {
      return { valid: false, reason: "timeout must be a positive integer (seconds)" };
    }
    entry.timeout = value.timeout;
  }
  if (value.description !== undefined) {
    if (typeof value.description !== "string") return { valid: false, reason: "description must be a string" };
    entry.description = value.description;
  }
  return { valid: true, entry };
}

function validateStringRecord(value: unknown, field: string): Record<string, string> | string {
  if (!isRecord(value)) return `${field} must be an object of string values`;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return `${field}.${key} must be a string`;
  }
  return value as Record<string, string>;
}

function validateServerNameOrThrow(name: string): void {
  if (typeof name !== "string" || !MCP_NAME_RE.test(name) || name.length > MCP_NAME_MAX_LENGTH) {
    throwInvalid(`server name must match ${MCP_NAME_RE.source} (max ${MCP_NAME_MAX_LENGTH} chars)`);
  }
}

/** Secret projection: whole-value references pass through, literals redact. */
function projectSecretValue(value: string): McpSecretValue {
  return ENV_REFERENCE_RE.test(value) || COMMAND_VALUE_RE.test(value)
    ? { redacted: false, value }
    : { redacted: true };
}

function projectSecretRecord(record: Record<string, string> | undefined): Record<string, McpSecretValue> | null {
  if (record === undefined) return null;
  const out: Record<string, McpSecretValue> = {};
  for (const [key, value] of Object.entries(record)) out[key] = projectSecretValue(value);
  return out;
}

// ---------------------------------------------------------------------------
// Document read / atomic write
// ---------------------------------------------------------------------------

async function readDocument(agentDir: string): Promise<ReadDocument> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "mcp.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, servers: {} };
    throw makeRuntimeError("unavailable", "mcp.json could not be read");
  }
  if (Buffer.byteLength(text, "utf8") > MCP_FILE_MAX_BYTES) throwInvalid("mcp.json exceeds the size bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A corrupt file is NEVER presented as an empty server list.
    throwInvalid("mcp.json is not valid JSON");
  }
  if (!isRecord(parsed)) throwInvalid("mcp.json must contain a JSON object");
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isRecord(servers)) throwInvalid("mcp.json mcpServers must be an object");
  return { raw: parsed, servers: (servers ?? {}) as Record<string, unknown> };
}

/** Serialize writes through one chain (concurrent mutations never interleave). */
function makeWriteQueue(): <T>(mutate: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (mutate) => {
    const run = tail.then(mutate, mutate);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Atomic write: same-dir exclusive tmp (mode = existing file's mode, else
 * 0600) → write+fsync → rename over the target. Everything outside the
 * mutated `mcpServers[<name>]` entry is preserved verbatim.
 */
async function writeDocument(agentDir: string, doc: ReadDocument): Promise<void> {
  const target = join(agentDir, "mcp.json");
  const payload = `${JSON.stringify({ ...doc.raw, mcpServers: doc.servers }, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MCP_FILE_MAX_BYTES) throwInvalid("mcp.json exceeds the size bound");

  let mode = 0o600;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throwInvalid("mcp.json must be a regular file");
    mode = info.mode & 0o777;
  } catch (error) {
    if (isRuntimeErrorLike(error)) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw makeRuntimeError("unavailable", "mcp.json could not be inspected");
    }
  }

  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (isRuntimeErrorLike(error)) throw error;
    throw makeRuntimeError("unavailable", "mcp.json could not be written");
  }
  // Best-effort directory fsync (durability nicety; some filesystems reject it).
  try {
    const dir = await open(dirname(target), 0o200_000);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* tolerated */
  }
}

function isRuntimeErrorLike(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && "message" in error && "retryable" in error;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface ResolvedSecrets {
  values: Record<string, string>;
  /** Literal values, masked out of any probe diagnostic text. */
  literals: string[];
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

/** Mask every literal secret value inside a probe diagnostic string. */
function sanitize(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals) {
    if (literal.length >= 4) out = out.split(literal).join("•••");
  }
  return out;
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** Resolve relative stdio cwd against the user's home (documented choice). */
function resolveProbeCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const expanded = expandHome(cwd);
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

async function runCommandValue(command: string): Promise<string> {
  try {
    const { stdout } = await exec(command, {
      timeout: COMMAND_VALUE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? truncate(error.message, 200) : "failed";
    throw new Error(`!command substitution failed: ${detail}`);
  }
}

async function resolveSecrets(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
  serverName: string,
  field: string,
): Promise<ResolvedSecrets> {
  const values: Record<string, string> = {};
  const literals: string[] = [];
  if (record === undefined) return { values, literals };
  for (const [key, raw] of Object.entries(record)) {
    const reference = ENV_REFERENCE_RE.exec(raw);
    if (reference) {
      const name = reference[1]!;
      const resolved = env[name];
      if (resolved === undefined || resolved === "") {
        throw new Error(`${serverName}: environment variable ${name} (${field}.${key}) is not set`);
      }
      values[key] = resolved;
    } else if (COMMAND_VALUE_RE.test(raw)) {
      values[key] = await runCommandValue(raw.slice(1));
    } else {
      values[key] = raw;
      literals.push(raw);
    }
  }
  return { values, literals };
}

const derivedStatus = (state: "unknown" | "disabled"): McpProbeStatus => ({
  state,
  tools: [],
  error: null,
  stderrTail: [],
  probedAt: null,
});

function raceTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

/**
 * One probe: connect → tools/list → close. Every exit path closes the client
 * (stdio: stdin close → SIGTERM → SIGKILL of the whole process group).
 */
async function probeEntry(
  name: string,
  entry: ValidatedEntry,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<McpProbeStatus> {
  if (!entry.enabled) return derivedStatus("disabled");
  const probedAt = now();
  let literals: string[] = [];
  let stderrBuffer = "";

  try {
    let transport: StdioTransport | StreamableHttpTransport;
    if (entry.kind === "stdio") {
      const resolved = await resolveSecrets(entry.env, env, name, "env");
      literals = resolved.literals;
      const stdioOptions: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stderr: "pipe";
        onStderr: (chunk: string) => void;
      } = {
        command: expandHome(entry.command!),
        stderr: "pipe",
        onStderr: (chunk) => {
          stderrBuffer = (stderrBuffer + chunk).slice(-16 * 1024);
        },
      };
      if (entry.args !== undefined) stdioOptions.args = entry.args.map(expandHome);
      const cwd = resolveProbeCwd(entry.cwd);
      if (cwd !== undefined) stdioOptions.cwd = cwd;
      if (Object.keys(resolved.values).length > 0) stdioOptions.env = resolved.values;
      transport = new StdioTransport(stdioOptions);
    } else {
      const resolved = await resolveSecrets(entry.headers, env, name, "headers");
      literals = resolved.literals;
      transport = new StreamableHttpTransport({
        url: entry.url!,
        ...(Object.keys(resolved.values).length === 0 ? {} : { headers: resolved.values }),
      });
    }

    const client = new McpClient(MCP_CLIENT_INFO);
    let tools: McpToolInfo[] = [];
    try {
      await raceTimeout(client.connect(transport), PROBE_TIMEOUT_MS);
      const listed = await raceTimeout(client.listTools(), PROBE_TIMEOUT_MS);
      tools = listed.map((tool) => ({ name: tool.name, description: truncate(tool.description ?? "", 300) }));
    } finally {
      // close() is the cleanup contract; the outer race keeps a wedged close
      // from blocking the response (the kill sequence is still issued).
      await raceTimeout(client.close().catch(() => undefined), 5_000);
    }

    return {
      state: "connected",
      tools,
      error: null,
      stderrTail: [],
      probedAt,
    };
  } catch (error) {
    const stderrTail = stderrBuffer
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .slice(-PROBE_STDERR_TAIL_LINES)
      .map((line) => truncate(sanitize(line, literals), 300));
    if (error instanceof McpAuthRequiredError || (error instanceof McpHttpError && (error.status === 401 || error.status === 403))) {
      return { state: "needs_auth", tools: [], error: null, stderrTail, probedAt };
    }
    const message = error instanceof Error ? error.message : "connection failed";
    return { state: "failed", tools: [], error: truncate(sanitize(message, literals), PROBE_ERROR_MAX_CHARS), stderrTail, probedAt };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface McpSettingsStoreOptions {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: clock for the 30s probe cache. */
  now?: () => number;
}

export interface McpSettingsStore {
  readSettings(): Promise<McpSettingsSnapshot>;
  upsertServer(input: McpServerWrite): Promise<McpSettingsSnapshot>;
  setEnabled(name: string, enabled: boolean): Promise<McpSettingsSnapshot>;
  removeServer(name: string): Promise<McpSettingsSnapshot>;
  importPreview(input: { json: string }): Promise<McpImportPreview>;
  importServers(input: { json: string }): Promise<McpSettingsSnapshot>;
  testServer(name: string, refresh: boolean): Promise<McpSettingsSnapshot>;
}

interface CacheEntry {
  status: McpProbeStatus;
  /** Cache identity: the exact raw entry JSON the probe ran against. */
  fingerprint: string;
}

/** Bounded probe parallelism (no fork storms when a page tests N servers). */
function createSemaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    while (active >= limit) {
      await new Promise<void>((release) => waiting.push(release));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createMcpSettingsStore(options: McpSettingsStoreOptions): McpSettingsStore {
  const { agentDir } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const runWrite = makeWriteQueue();
  const cache = new Map<string, CacheEntry>();
  const gate = createSemaphore(PROBE_CONCURRENCY);

  const snapshotServer = (name: string, value: unknown, status: McpProbeStatus): McpServerSnapshot => {
    const validated = validateMcpEntry(name, value);
    if (!validated.valid) {
      return {
        name, valid: false, invalidReason: validated.reason, kind: null, enabled: true,
        command: null, args: null, env: null, cwd: null, url: null, headers: null,
        timeout: null, description: null, status,
      };
    }
    const entry = validated.entry;
    return {
      name,
      valid: true,
      invalidReason: null,
      kind: entry.kind,
      enabled: entry.enabled,
      command: entry.command ?? null,
      args: entry.args ?? null,
      env: projectSecretRecord(entry.env),
      cwd: entry.cwd ?? null,
      url: entry.url ?? null,
      headers: projectSecretRecord(entry.headers),
      timeout: entry.timeout ?? null,
      description: entry.description ?? null,
      status,
    };
  };

  const cachedStatusFor = (name: string, value: unknown): McpProbeStatus => {
    const validated = validateMcpEntry(name, value);
    if (!validated.valid) return derivedStatus("unknown");
    if (!validated.entry.enabled) return derivedStatus("disabled");
    const cached = cache.get(name);
    if (cached === undefined) return derivedStatus("unknown");
    if (cached.fingerprint !== JSON.stringify(value)) return derivedStatus("unknown");
    if (now() - (cached.status.probedAt ?? 0) > PROBE_CACHE_TTL_MS) return derivedStatus("unknown");
    return cached.status;
  };

  const probeAndCache = async (name: string, value: unknown, refresh: boolean): Promise<McpProbeStatus> => {
    const validated = validateMcpEntry(name, value);
    if (!validated.valid) return derivedStatus("unknown");
    if (!validated.entry.enabled) return derivedStatus("disabled");
    const fingerprint = JSON.stringify(value);
    if (!refresh) {
      const cached = cache.get(name);
      if (
        cached !== undefined &&
        cached.fingerprint === fingerprint &&
        now() - (cached.status.probedAt ?? 0) <= PROBE_CACHE_TTL_MS
      ) {
        return cached.status;
      }
    }
    const status = await gate(() => probeEntry(name, validated.entry, env, now));
    cache.set(name, { status, fingerprint });
    return status;
  };

  const readSnapshot = async (): Promise<McpSettingsSnapshot> => {
    const doc = await readDocument(agentDir);
    return {
      servers: Object.entries(doc.servers).map(([name, value]) => snapshotServer(name, value, cachedStatusFor(name, value))),
    };
  };

  const writeSnapshotAfter = async (
    mutate: (doc: ReadDocument) => void,
    touched: readonly string[] = [],
  ): Promise<McpSettingsSnapshot> =>
    runWrite(async () => {
      const doc = await readDocument(agentDir);
      mutate(doc);
      await writeDocument(agentDir, doc);
      for (const name of touched) cache.delete(name);
      return readSnapshot();
    });

  const applySecretMutations = (
    existing: Record<string, string> | undefined,
    mutations: Record<string, SecretMutation> | undefined,
    serverName: string,
    field: string,
  ): Record<string, string> => {
    const out: Record<string, string> = { ...(existing ?? {}) };
    if (mutations === undefined) return out;
    for (const [key, mutation] of Object.entries(mutations)) {
      if (key.trim() === "") throwInvalid(`${field} keys must be non-empty`);
      if (mutation.mode === "remove") {
        delete out[key];
      } else if (mutation.mode === "preserve") {
        if (existing === undefined || !(key in existing)) {
          throwInvalid(`${serverName}: cannot preserve missing ${field} key "${key}"`);
        }
      } else {
        out[key] = mutation.value;
      }
    }
    return out;
  };

  /** Same-server conflict under the -/_ identity rule (Pi rule). */
  const assertNoIdentityConflict = (servers: Record<string, unknown>, name: string): void => {
    for (const existing of Object.keys(servers)) {
      if (existing !== name && normalizeServerName(existing) === normalizeServerName(name)) {
        throwInvalid(`server name conflicts with existing server "${existing}" (- and _ are the same server)`);
      }
    }
  };

  return {
    readSettings: readSnapshot,

    upsertServer: async (input) => {
      if (!isRecord(input)) throwInvalid("mcp server write must be an object");
      const { name } = input as { name?: unknown };
      if (typeof name !== "string") throwInvalid("mcp server name is required");
      validateServerNameOrThrow(name);
      const kind = input.kind;
      if (kind !== "stdio" && kind !== "http") throwInvalid("mcp server kind must be stdio or http");
      const command = typeof input.command === "string" ? input.command.trim() : undefined;
      const url = typeof input.url === "string" ? input.url.trim() : undefined;
      const args = input.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
        throwInvalid("args must be an array of strings");
      }
      if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim() === "")) {
        throwInvalid("cwd must be a non-empty string");
      }
      const timeout = input.timeout;
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 86_400)) {
        throwInvalid("timeout must be a positive integer (seconds)");
      }
      if (input.description !== undefined && typeof input.description !== "string") {
        throwInvalid("description must be a string");
      }
      if (kind === "stdio") {
        if (command === undefined || command === "") throwInvalid("stdio servers require a command");
        if (url !== undefined) throwInvalid("stdio servers take no url");
      } else {
        if (url === undefined || url === "") throwInvalid("http servers require a url");
        if (!/^https?:\/\//i.test(url)) throwInvalid("mcp server url must be http(s)");
        if (command !== undefined) throwInvalid("http servers take no command");
        if (args !== undefined) throwInvalid("http servers take no args");
        if (input.env !== undefined) throwInvalid("http servers take no env");
        if (input.cwd !== undefined) throwInvalid("http servers take no cwd");
      }

      return writeSnapshotAfter((doc) => {
        assertNoIdentityConflict(doc.servers, name);
        const previous = doc.servers[name];
        const previousValidated = isRecord(previous) ? validateMcpEntry(name, previous) : null;
        const previousEntry = previousValidated?.valid === true ? previousValidated.entry : null;

        const env = applySecretMutations(previousEntry?.env, input.env as Record<string, SecretMutation> | undefined, name, "env");
        const headers = applySecretMutations(previousEntry?.headers, input.headers as Record<string, SecretMutation> | undefined, name, "headers");

        const entry: Record<string, unknown> = {
          // Kind-agnostic extras survive a same-name replacement verbatim; a
          // kept `type` must agree with the new kind or the entry would be
          // invalid on the next read.
          ...pickPreservedFields(previous, kind),
          ...(kind === "stdio" ? { command } : { url }),
          ...(kind === "stdio" && Array.isArray(args) && args.length > 0 ? { args } : {}),
          ...(kind === "stdio" && Object.keys(env).length > 0 ? { env } : {}),
          ...(kind === "stdio" && typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
          ...(kind === "http" && Object.keys(headers).length > 0 ? { headers } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(typeof input.description === "string" && input.description !== "" ? { description: input.description } : {}),
        };
        if (previousEntry?.enabled === false) entry.enabled = false;
        doc.servers = { ...doc.servers, [name]: entry };
        if (Object.keys(doc.servers).length > MCP_MAX_SERVERS) {
          throwInvalid(`mcp.json cannot exceed ${MCP_MAX_SERVERS} servers`);
        }
      }, [name]);
    },

    setEnabled: async (name, enabled) => {
      validateServerNameOrThrow(name);
      return writeSnapshotAfter((doc) => {
        const existing = doc.servers[name];
        if (existing === undefined) throwNotFound(`mcp server "${name}" is not configured`);
        if (!isRecord(existing)) throwInvalid(`mcp server "${name}" entry is not an object`);
        // enabled:false is explicit; removing the field restores the default
        // (enabled), so no marker is written for "on".
        const next = { ...existing };
        delete next.enabled;
        doc.servers = { ...doc.servers, [name]: enabled ? next : { ...next, enabled: false } };
      }, [name]);
    },

    removeServer: async (name) => {
      validateServerNameOrThrow(name);
      return writeSnapshotAfter((doc) => {
        if (!(name in doc.servers)) throwNotFound(`mcp server "${name}" is not configured`);
        const servers = { ...doc.servers };
        delete servers[name];
        doc.servers = servers;
      }, [name]);
    },

    importPreview: async (input) => {
      const entries = parseImport(input);
      const doc = await readDocument(agentDir);
      return { entries: entries.map(([name, value]) => previewEntry(name, value, doc.servers)) };
    },

    importServers: async (input) => {
      const entries = parseImport(input);
      return writeSnapshotAfter((doc) => {
        for (const [name, value] of entries) {
          const preview = previewEntry(name, value, doc.servers);
          if (!preview.valid) {
            throwInvalid(`import rejected: server "${name}" is invalid (${preview.invalidReason}); nothing was written`);
          }
        }
        if (Object.keys(doc.servers).length + entries.length > MCP_MAX_SERVERS) {
          throwInvalid(`mcp.json cannot exceed ${MCP_MAX_SERVERS} servers`);
        }
        doc.servers = { ...doc.servers, ...Object.fromEntries(entries) };
      }, entries.map(([name]) => name));
    },

    testServer: async (name, refresh) => {
      validateServerNameOrThrow(name);
      const doc = await readDocument(agentDir);
      const value = doc.servers[name];
      if (value === undefined) throwNotFound(`mcp server "${name}" is not configured`);
      await probeAndCache(name, value, refresh);
      return readSnapshot();
    },
  };
}

/** Kind-agnostic extras preserved across a same-name replacement. */
function pickPreservedFields(previous: unknown, kind: McpServerKind): Record<string, unknown> {
  if (!isRecord(previous)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["exposure", "toolExposure", "oauth"]) {
    if (previous[key] !== undefined) out[key] = previous[key];
  }
  const type = previous.type;
  if (type === "stdio" && kind === "stdio") out.type = "stdio";
  else if ((type === "http" || type === "streamable-http") && kind === "http") out.type = type;
  return out;
}

/** Parse pasted JSON: `{"mcpServers":{…}}` or a direct `{name: config}` map. */
function parseImport(input: { json: string }): Array<[string, unknown]> {
  if (!isRecord(input) || typeof input.json !== "string" || input.json.trim() === "") {
    throwInvalid("import payload must carry a non-empty json string");
  }
  if (input.json.length > MCP_IMPORT_MAX_BYTES) throwInvalid("import payload exceeds the size bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch {
    throwInvalid("import payload is not valid JSON");
  }
  if (!isRecord(parsed)) throwInvalid("import payload must be a JSON object");
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const entries = Object.entries(servers);
  if (entries.length === 0) throwInvalid("import payload contains no servers");
  return entries;
}

function previewEntry(name: string, value: unknown, existing: Record<string, unknown>): McpImportPreviewEntry {
  const validated = validateMcpEntry(name, value);
  if (validated.valid) {
    for (const other of Object.keys(existing)) {
      if (other !== name && normalizeServerName(other) === normalizeServerName(name)) {
        return {
          name,
          valid: false,
          invalidReason: `conflicts with existing server "${other}" (- and _ are the same server)`,
          overwrite: false,
          kind: null,
        };
      }
    }
  }
  return {
    name,
    valid: validated.valid,
    invalidReason: validated.valid ? null : validated.reason,
    overwrite: Object.prototype.hasOwnProperty.call(existing, name),
    kind: validated.valid ? validated.entry.kind : null,
  };
}

/** Pure helpers exported for the deterministic store tests. */
export const __testing = {
  resolveProbeCwd,
  expandHome,
  sanitize,
  truncate,
};
