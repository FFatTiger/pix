/**
 * Picker model visibility: the settings.json `enabledModels` scope, owned by
 * the adapter because pattern resolution semantics (glob/fuzzy/thinking
 * suffixes) belong to the Pi SDK model resolver — the same
 * `resolveModelScopeWithDiagnostics` call the read-only catalog uses.
 *
 * Documents and seams:
 *  - READ  `readPickerVisibility` (models-config snapshot `visibleInPicker`)
 *          and `readModelVisibilitySnapshot` (settings store
 *          `readModelVisibilityConfig`): settings.json patterns resolved
 *          against the models.json-configured catalog. No whitelist (absent
 *          key or empty array) = every configured model is visible.
 *  - WRITE `writeModelVisibility` (settings store
 *          `writeModelVisibilityConfig`): intent-based CAS mutation — the
 *          client sends per-model on/off intents, this module computes the
 *          resulting `enabledModels` entries server-side:
 *            · no whitelist + hide  → whitelist generated from every
 *              configured model's exact `provider/id` minus the hidden one;
 *            · whitelist + show    → exact `provider/id` appended;
 *            · whitelist + hide    → exact entry removed; an entry that covers
 *              more (glob or multi-match pattern) is expanded into the exact
 *              entries of the models it still covers (thinking suffix
 *              preserved) before this one is dropped; glob entries that match
 *              nothing stay untouched;
 *            · new models.json models default visible, dead exact entries are
 *              cleaned (see `syncEnabledModelsWithModelsConfig`);
 *            · a write that would leave zero visible configured models fails
 *              closed (`invalid_input`).
 *          Other settings.json fields always round-trip untouched.
 *  - HYGIENE `syncEnabledModelsWithModelsConfig` runs after every models.json
 *          write: exact entries pointing at removed models are dropped,
 *          newly-configured models are appended, glob patterns stay as-is.
 *
 * Locking: settings.json mutations take `<agentDir>/settings.json.lock` —
 * the SAME lock file the settings-config-store uses. models.json writes take
 * the models lock first and only then this settings lock (never reversed), so
 * the two lock orders cannot deadlock.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { createPosixSecureStateBackend, LocalAuthorityError } from "@fffattiger/pix-local-authority";
import { ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { makeRuntimeError, type ModelVisibilityMutation, type ModelVisibilitySnapshot } from "@fffattiger/pix-runtime-core";
import { readConfiguredProviderIds, stripJsonComments } from "./models-json.js";

const SETTINGS_MAX_BYTES = 256 * 1024;
const secureState = createPosixSecureStateBackend();

const mutationQueues = new Map<string, Promise<unknown>>();

function withMutationQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  mutationQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

function runtimeError(code: "invalid_input" | "conflict" | "unavailable", message: string) {
  return makeRuntimeError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revisionOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Canonical in-memory model key; `provider\0id` cannot collide. */
type ModelKey = string;
const keyOf = (model: { provider: string; id: string }): ModelKey => `${model.provider}\0${model.id}`;
const key = (provider: string, id: string): ModelKey => `${provider}\0${id}`;
const unkey = (value: ModelKey): { provider: string; id: string } => {
  const separator = value.indexOf("\0");
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
};
/** Wire/persisted exact-entry form `provider/id` (Pi's reference syntax). */
const printKey = (value: ModelKey): string => {
  const { provider, id } = unkey(value);
  return `${provider}/${id}`;
};

/** Thinking levels the SDK recognizes as a `:suffix` on a scope pattern. */
const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Split an optional trailing `:thinking` suffix off a scope entry. Model ids
 * may themselves contain colons (`qwen/qwen3-coder:exacto`); only a trailing
 * token that is a valid thinking level counts as a suffix, mirroring the
 * SDK's splitThinkingSuffix behavior for the entries pix writes.
 */
function splitThinkingSuffix(entry: string): { base: string; suffix: string } {
  const colon = entry.lastIndexOf(":");
  if (colon > 0 && THINKING_SUFFIXES.has(entry.slice(colon + 1))) {
    return { base: entry.slice(0, colon), suffix: entry.slice(colon) };
  }
  return { base: entry, suffix: "" };
}

/** Glob entries (`*`, `?`, `[`) keep their pattern shape on every rewrite. */
function isGlobEntry(entry: string): boolean {
  return /[*?[]/.test(splitThinkingSuffix(entry).base);
}

/** Parsed global settings.json restricted to the fields this seam consumes. */
interface SettingsSource {
  present: boolean;
  text: string;
  parsed: Record<string, unknown>;
  /** Persisted enabledModels; null when the key is absent or an empty array. */
  patterns: string[] | null;
  defaultModel: { provider: string; id: string } | null;
}

function parseSettingsSource(text: string, present: boolean): SettingsSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    throw runtimeError("invalid_input", "settings.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw runtimeError("invalid_input", "settings.json must be an object");
  }
  const enabled = parsed.enabledModels;
  if (enabled !== undefined && (!Array.isArray(enabled) || enabled.some((entry) => typeof entry !== "string" || entry.length === 0))) {
    throw runtimeError("invalid_input", "settings.json enabledModels must be an array of non-empty strings");
  }
  const provider = parsed.defaultProvider;
  const model = parsed.defaultModel;
  if (provider !== undefined && typeof provider !== "string") {
    throw runtimeError("invalid_input", "settings.json defaultProvider must be a string");
  }
  if (model !== undefined && typeof model !== "string") {
    throw runtimeError("invalid_input", "settings.json defaultModel must be a string");
  }
  const patterns = enabled === undefined ? null : (enabled as string[]);
  return {
    present,
    text,
    parsed,
    patterns: patterns === null || patterns.length === 0 ? null : [...patterns],
    defaultModel: typeof provider === "string" && typeof model === "string" && provider && model
      ? { provider, id: model }
      : null,
  };
}

async function readSettingsSource(agentDir: string): Promise<SettingsSource> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, text: "", parsed: {}, patterns: null, defaultModel: null };
    }
    throw runtimeError("unavailable", "settings.json could not be read");
  }
  return parseSettingsSource(text, true);
}

/** Offline runtime over `<agentDir>/models.json` — the catalog's exact shape. */
async function createOfflineRuntime(agentDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(agentDir, "models.json"),
  });
  if (runtime.getError()) {
    throw runtimeError("invalid_input", "model configuration is invalid");
  }
  return runtime;
}

interface CatalogScope {
  runtime: ModelRuntime;
  allowed: ReadonlySet<string>;
  /** models.json-configured models, provider-filtered, as canonical keys. */
  configuredKeys: ReadonlySet<ModelKey>;
}

async function catalogScope(agentDir: string, runtime?: ModelRuntime): Promise<CatalogScope> {
  const instance = runtime ?? await createOfflineRuntime(agentDir);
  const allowed = await readConfiguredProviderIds(agentDir);
  const configuredKeys = new Set(
    instance.getModels().filter((model) => allowed.has(model.provider)).map(keyOf),
  );
  return { runtime: instance, allowed, configuredKeys };
}

/**
 * Resolve `enabledModels` patterns against the configured catalog using the
 * SDK resolver — the exact matching semantics of the read-only catalog
 * (listModels). No patterns = every configured model is visible.
 */
async function resolveVisibleKeys(
  patterns: readonly string[] | null,
  scope: CatalogScope,
): Promise<Set<ModelKey>> {
  if (!patterns || patterns.length === 0) {
    return new Set(scope.configuredKeys);
  }
  const result = await resolveModelScopeWithDiagnostics([...patterns], scope.runtime);
  const configured = new Set(scope.configuredKeys);
  return new Set(
    result.scopedModels
      .map((entry) => keyOf(entry.model))
      .filter((value) => configured.has(value)),
  );
}

/** Configured models a single scope entry currently covers. */
async function entryMatches(entry: string, scope: CatalogScope): Promise<Set<ModelKey>> {
  return resolveVisibleKeys([entry], scope);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Picker visibility for the models-config snapshot (per-model flag). */
export async function readPickerVisibility(
  agentDir: string,
  runtime?: ModelRuntime,
): Promise<{ allVisible: boolean; visibleKeys: ReadonlySet<ModelKey> }> {
  const source = await readSettingsSource(agentDir);
  if (source.patterns === null) return { allVisible: true, visibleKeys: new Set() };
  const scope = await catalogScope(agentDir, runtime);
  return { allVisible: false, visibleKeys: await resolveVisibleKeys(source.patterns, scope) };
}

async function visibilitySnapshot(agentDir: string, source: SettingsSource): Promise<ModelVisibilitySnapshot> {
  const scope = await catalogScope(agentDir);
  const visible = await resolveVisibleKeys(source.patterns, scope);
  return {
    revision: revisionOf(source.text),
    patterns: source.patterns,
    visible: [...visible].map(unkey),
    defaultModel: source.defaultModel,
  };
}

/** Settings-store read seam (`readModelVisibilityConfig`). */
export function readModelVisibilitySnapshot(agentDir: string): Promise<ModelVisibilitySnapshot> {
  return withMutationQueue(agentDir, async () => visibilitySnapshot(agentDir, await readSettingsSource(agentDir)));
}

// ---------------------------------------------------------------------------
// Settings.json structured write (shared lock file with settings-config-store)
// ---------------------------------------------------------------------------

async function withSettingsLock<T>(agentDir: string, run: (canonicalDir: string) => Promise<T>): Promise<T> {
  // Canonicalize first (same as settings-config-store): secure-state writes
  // fail closed on symlinked paths like macOS /tmp, and the lock file must be
  // the SAME `<canonical-agentDir>/settings.json.lock` the settings store
  // uses so the two writers truly exclude each other.
  let canonicalDir: string;
  try {
    canonicalDir = await secureState.canonicalizePath(agentDir);
    await secureState.ensurePrivateDirectory(canonicalDir);
  } catch {
    throw runtimeError("unavailable", "settings configuration is unavailable");
  }
  const settingsPath = join(canonicalDir, "settings.json");
  let release: (() => Promise<void>) | undefined;
  try {
    // The lock TARGET is the settings.json path (not the agent dir): the
    // physical lock file is still the same `<agentDir>/settings.json.lock`
    // the settings-config-store uses, so the two writers exclude each other,
    // but proper-lockfile's per-target bookkeeping stays distinct from the
    // models.json lock (same-dir target) that models writes hold while they
    // run this hygiene — nested same-target locks are unsupported upstream.
    release = await lockfile.lock(settingsPath, {
      realpath: false,
      lockfilePath: `${settingsPath}.lock`,
      retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
    });
    return await run(canonicalDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw runtimeError("unavailable", "settings configuration could not be saved");
  } finally {
    await release?.().catch(() => {});
  }
}

async function writeSettingsParsed(agentDir: string, parsed: Record<string, unknown>): Promise<void> {
  const content = `${JSON.stringify(parsed, null, 2)}\n`;
  await secureState.writeStateDocument(join(agentDir, "settings.json"), content, {
    maxBytes: SETTINGS_MAX_BYTES,
  });
}

// ---------------------------------------------------------------------------
// Intent-based visibility write
// ---------------------------------------------------------------------------

function assertVisibilityMutation(input: ModelVisibilityMutation): void {
  if (!input || typeof input !== "object") {
    throw runtimeError("invalid_input", "model visibility input is invalid");
  }
  if (typeof input.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedRevision)) {
    throw runtimeError("invalid_input", "model visibility input is invalid");
  }
  if (!Array.isArray(input.changes)) {
    throw runtimeError("invalid_input", "model visibility input is invalid");
  }
  const seen = new Set<ModelKey>();
  for (const change of input.changes) {
    if (!isRecord(change)) {
      throw runtimeError("invalid_input", "model visibility input is invalid");
    }
    const { provider, id, visible } = change as Record<string, unknown>;
    if (typeof provider !== "string" || !provider.trim() || typeof id !== "string" || !id.trim()) {
      throw runtimeError("invalid_input", "model visibility input is invalid");
    }
    if (typeof visible !== "boolean") {
      throw runtimeError("invalid_input", "model visibility input is invalid");
    }
    const changeKey = key(provider, id);
    if (seen.has(changeKey)) {
      throw runtimeError("invalid_input", "model visibility input is invalid");
    }
    seen.add(changeKey);
  }
}

/**
 * Remove one model from the whitelist entries. An entry that exists solely
 * for the model (exact `provider/id`, or any entry whose configured matches
 * are only this model) is dropped; an entry covering more models is expanded
 * into the exact entries of the survivors, preserving a trailing thinking
 * suffix. Entries that do not cover the model pass through untouched.
 */
async function hideModelFromEntries(
  entries: readonly string[],
  target: ModelKey,
  scope: CatalogScope,
): Promise<string[]> {
  const next: string[] = [];
  for (const entry of entries) {
    const matches = await entryMatches(entry, scope);
    if (!matches.has(target)) {
      next.push(entry);
      continue;
    }
    const survivors = [...matches].filter((value) => value !== target);
    if (survivors.length === 0) continue; // existed only for the hidden model
    const { suffix } = splitThinkingSuffix(entry);
    for (const survivor of survivors) next.push(`${printKey(survivor)}${suffix}`);
  }
  return next;
}

/** Settings-store write seam (`writeModelVisibilityConfig`). */
export function writeModelVisibility(
  agentDir: string,
  input: ModelVisibilityMutation,
): Promise<ModelVisibilitySnapshot> {
  return withMutationQueue(agentDir, () => withSettingsLock(agentDir, async (dir) => {
    assertVisibilityMutation(input);
    const source = await readSettingsSource(dir);
    if (revisionOf(source.text) !== input.expectedRevision) {
      throw runtimeError("conflict", "settings configuration changed");
    }
    const scope = await catalogScope(dir);
    for (const change of input.changes) {
      if (!scope.configuredKeys.has(key(change.provider, change.id))) {
        throw runtimeError("invalid_input", "unknown model in visibility change");
      }
    }
    let entries: string[] | null = source.patterns;
    for (const change of input.changes) {
      const target = key(change.provider, change.id);
      if (change.visible) {
        if (entries === null) continue; // no whitelist: already visible
        if ((await resolveVisibleKeys(entries, scope)).has(target)) continue;
        entries = [...entries, printKey(target)];
        continue;
      }
      if (entries === null) {
        // First hide generates the whitelist from the full configured set.
        const remaining = [...scope.configuredKeys].filter((value) => value !== target);
        if (remaining.length === 0) {
          throw runtimeError("invalid_input", "at least one model must stay visible");
        }
        entries = remaining.map(printKey);
        continue;
      }
      entries = await hideModelFromEntries(entries, target, scope);
    }
    if (entries === null || entriesEqual(entries, source.patterns)) {
      return visibilitySnapshot(dir, source);
    }
    // An empty enabledModels array reads as "no whitelist" (all visible) in
    // Pi semantics, so it can never represent "nothing visible": while any
    // configured model exists, a write that would empty the whitelist fails.
    if (scope.configuredKeys.size > 0 && entries.length === 0) {
      throw runtimeError("invalid_input", "at least one model must stay visible");
    }
    const visible = await resolveVisibleKeys(entries, scope);
    if (scope.configuredKeys.size > 0 && visible.size === 0) {
      throw runtimeError("invalid_input", "at least one model must stay visible");
    }
    const parsed = structuredClone(source.parsed);
    parsed.enabledModels = entries;
    await writeSettingsParsed(dir, parsed);
    return visibilitySnapshot(dir, await readSettingsSource(dir));
  }));
}

function entriesEqual(entries: readonly string[], previous: readonly string[] | null): boolean {
  if (previous === null || entries.length !== previous.length) return false;
  return entries.every((entry, index) => entry === previous[index]);
}

// ---------------------------------------------------------------------------
// models.json write hygiene
// ---------------------------------------------------------------------------

/**
 * Validate up front (before a models.json write) that settings.json is
 * readable for hygiene — a malformed file fails the whole mutation instead
 * of leaving models.json saved with stale whitelist state and no error.
 */
export async function assertSettingsReadableForHygiene(agentDir: string): Promise<void> {
  await readSettingsSource(agentDir);
}

/**
 * Keep `enabledModels` consistent with a just-written models.json:
 *  - exact (non-glob) entries matching no configured model are dropped
 *    (deleted models/providers leave no dead whitelist rows);
 *  - glob pattern entries always stay as-is, even when they currently match
 *    nothing;
 *  - every configured model not covered by any entry is appended as an exact
 *    `provider/id` (newly added models default visible).
 *
 * Runs with no whitelist exactly as a no-op (all-visible stays all-visible).
 * Reads and writes settings.json under the shared settings lock; the models
 * lock (held by the caller during models.json writes) is always taken first.
 */
export function syncEnabledModelsWithModelsConfig(agentDir: string): Promise<void> {
  return withMutationQueue(agentDir, () => withSettingsLock(agentDir, async (dir) => {
    const source = await readSettingsSource(dir);
    if (source.patterns === null) return;
    const scope = await catalogScope(dir);
    const next: string[] = [];
    const covered = new Set<ModelKey>();
    for (const entry of source.patterns) {
      const matches = await entryMatches(entry, scope);
      if (matches.size === 0) {
        // Dead exact rows are cleaned; pattern (glob) rows are kept verbatim.
        if (isGlobEntry(entry)) next.push(entry);
        continue;
      }
      next.push(entry);
      for (const value of matches) covered.add(value);
    }
    for (const value of scope.configuredKeys) {
      if (!covered.has(value)) next.push(printKey(value));
    }
    if (entriesEqual(next, source.patterns)) return;
    const parsed = structuredClone(source.parsed);
    parsed.enabledModels = next;
    await writeSettingsParsed(dir, parsed);
  }));
}
