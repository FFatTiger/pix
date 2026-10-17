/**
 * models.dev parameter catalog: parse, match, and disk-cached fetch.
 *
 * The catalog (https://models.dev/api.json) is a public dataset shaped
 * `{ [providerId]: { models: { [modelId]: { name, reasoning, modalities,
 * limit, cost, … } } } }`. Pix uses it only to SUGGEST parameters for model
 * ids that came from provider discovery or already exist in models.json; it
 * never overrides user-entered values silently and never fabricates data:
 * a missing/failed catalog simply yields "no parameters" (null), never an
 * error and never invented numbers.
 *
 * Cost units on models.dev are USD per million tokens — the same unit Pi's
 * models.json `cost` uses — so values are copied verbatim (no conversion).
 *
 * Matching is deliberately conservative: exact id, then one normalization
 * pass (lowercase, strip `models/`, strip the `provider/` path segment).
 * No fuzzy/edit-distance matching: a near-miss must stay "no parameters".
 *
 * The cache lives at `<agentDir>/pix/models-dev-cache.json` — a pix-owned
 * namespace inside the agent config dir (the same namespace sessiond uses
 * for `~/.pi/pix/sessiond`), adjacent to the models.json it enriches, so it
 * survives Host restarts without introducing a Host-owned state concept.
 * It is public data, but is written through the local-authority secure-state
 * primitives (0700 dir, 0600 atomic document) that own that directory tree.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPosixSecureStateBackend } from "@fffattiger/pix-local-authority";
import type { ModelConfigApi, ModelMetadataFields } from "@fffattiger/pix-runtime-core";
import type { ModelsDevCatalog, ModelsDevCatalogStore, ModelsDevModelEntry } from "../models/index.js";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
/** Fetch bound: 10s, redirect-forbidden, bounded body. */
const FETCH_TIMEOUT_MS = 10_000;
/** models.dev api.json is ~6 MiB today; the cap leaves generous headroom. */
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
/** Cache freshness window. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on parsed entries so a hostile payload cannot balloon memory. */
const MAX_ENTRIES = 20_000;

const secureState = createPosixSecureStateBackend();

export type { ModelsDevCatalog, ModelsDevCatalogStore, ModelsDevModelEntry };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positiveCostValue(value: unknown): number | undefined {
  // Zero-cost is indistinguishable from "not listed" for our purpose: the
  // editor treats absent as unknown, so only positive prices are carried.
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parse one models.dev model row into the reduced entry shape. */
function parseModelEntry(provider: string, key: string, raw: Record<string, unknown>): ModelsDevModelEntry | null {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : key;
  if (!id) return null;
  const entry: ModelsDevModelEntry = { provider, id };
  if (typeof raw.name === "string" && raw.name.trim()) entry.name = raw.name.trim();
  if (typeof raw.reasoning === "boolean") entry.reasoning = raw.reasoning;
  const modalities = isRecord(raw.modalities) && Array.isArray(raw.modalities.input)
    ? raw.modalities.input
    : undefined;
  const input = modalities
    ?.filter((value): value is "text" | "image" => value === "text" || value === "image");
  if (input && input.length > 0) entry.input = input;
  const limit = isRecord(raw.limit) ? raw.limit : undefined;
  const contextWindow = positiveInt(limit?.context);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const maxTokens = positiveInt(limit?.output);
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  const costRaw = isRecord(raw.cost) ? raw.cost : undefined;
  const cost: NonNullable<ModelMetadataFields["cost"]> = {};
  const inputCost = positiveCostValue(costRaw?.input);
  if (inputCost !== undefined) cost.input = inputCost;
  const outputCost = positiveCostValue(costRaw?.output);
  if (outputCost !== undefined) cost.output = outputCost;
  const cacheRead = positiveCostValue(costRaw?.cache_read);
  if (cacheRead !== undefined) cost.cacheRead = cacheRead;
  const cacheWrite = positiveCostValue(costRaw?.cache_write);
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
  if (Object.keys(cost).length > 0) entry.cost = cost;
  return entry;
}

/**
 * Parse the api.json payload into the reduced catalog. Unknown providers,
 * models without a models map, and unknown fields are skipped silently —
 * this is a best-effort suggestion source, not a validated contract.
 */
export function parseModelsDevApiJson(payload: unknown): ModelsDevCatalog {
  if (!isRecord(payload)) return [];
  const entries: ModelsDevModelEntry[] = [];
  for (const [provider, providerRaw] of Object.entries(payload)) {
    if (!isRecord(providerRaw) || !isRecord(providerRaw.models)) continue;
    for (const [key, modelRaw] of Object.entries(providerRaw.models)) {
      if (!isRecord(modelRaw)) continue;
      const entry = parseModelEntry(provider, key, modelRaw);
      if (entry) entries.push(entry);
      if (entries.length >= MAX_ENTRIES) return entries;
    }
  }
  return entries;
}

/** Providers whose rows mirror the requested API type (first-party sources). */
function apiPreferredProviders(api: ModelConfigApi): readonly string[] {
  if (api === "anthropic-messages") return ["anthropic"];
  if (api === "google-generative-ai") return ["google"];
  if (api.startsWith("openai-")) return ["openai"];
  return [];
}

/**
 * Common first-party provider priority for ambiguous ids. Ordered list; a
 * provider not listed ranks after every listed one (ties break on provider
 * key, then id, so the winner is always deterministic).
 */
const FIRST_PARTY_PROVIDER_ORDER: readonly string[] = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "moonshotai",
  "zhipuai",
  "zai",
  "alibaba",
  "mistral",
  "meta",
];

function firstPartyRank(provider: string): number {
  const index = FIRST_PARTY_PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? FIRST_PARTY_PROVIDER_ORDER.length : index;
}

/** Deterministic winner among candidate entries for one requested id. */
function pickBestCandidate(
  candidates: readonly ModelsDevModelEntry[],
  api: ModelConfigApi,
): ModelsDevModelEntry | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const preferred = apiPreferredProviders(api);
  let best: ModelsDevModelEntry | null = null;
  let bestKey: readonly number[] | undefined;
  let bestProvider = "";
  for (const candidate of candidates) {
    const apiPreference = preferred.indexOf(candidate.provider);
    const key: readonly number[] = [apiPreference === -1 ? preferred.length : apiPreference, firstPartyRank(candidate.provider)];
    // Stable total order: (api preference, first-party rank, provider key, id).
    const beats =
      best === null ||
      cmpKeys(key, bestKey!) < 0 ||
      (cmpKeys(key, bestKey!) === 0 && (candidate.provider < bestProvider
        || (candidate.provider === bestProvider && candidate.id < best.id)));
    if (beats) {
      best = candidate;
      bestKey = key;
      bestProvider = candidate.provider;
    }
  }
  return best;
}

function cmpKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

/**
 * Normalized form for the fallback pass: lowercase, drop a leading `models/`
 * path segment (Gemini style), then drop the leading `provider/` segment
 * (router style). Only reached when no exact id matched.
 */
export function normalizedModelId(id: string): string {
  let value = id.trim().toLowerCase();
  if (value.startsWith("models/")) value = value.slice("models/".length);
  const slash = value.indexOf("/");
  if (slash >= 0) value = value.slice(slash + 1);
  return value;
}

/**
 * Find the best models.dev entry for a model id. Exact id first (across all
 * providers); only when nothing matches exactly does the normalized form get
 * one fallback pass. Returns null when neither matches — never a guess.
 */
export function matchModelsDevEntry(
  catalog: ModelsDevCatalog,
  modelId: string,
  api: ModelConfigApi,
): ModelsDevModelEntry | null {
  const requested = modelId.trim();
  if (!requested) return null;
  const exact = catalog.filter((entry) => entry.id === requested);
  if (exact.length > 0) return pickBestCandidate(exact, api);
  const normalized = normalizedModelId(requested);
  if (!normalized) return null;
  const normalizedMatches = catalog.filter((entry) => normalizedModelId(entry.id) === normalized);
  return pickBestCandidate(normalizedMatches, api);
}

/**
 * Project an entry onto editor fields. Returns null when the entry carries no
 * consumable value: a match with nothing to say is reported as "no
 * parameters", not as a source with an empty payload.
 */
export function modelsDevEntryToFields(entry: ModelsDevModelEntry): ModelMetadataFields | null {
  const fields: ModelMetadataFields = {};
  if (entry.name) fields.name = entry.name;
  if (entry.reasoning !== undefined) fields.reasoning = entry.reasoning;
  if (entry.input && entry.input.length > 0) fields.input = [...entry.input];
  if (entry.contextWindow !== undefined) fields.contextWindow = entry.contextWindow;
  if (entry.maxTokens !== undefined) fields.maxTokens = entry.maxTokens;
  if (entry.cost && Object.keys(entry.cost).length > 0) fields.cost = { ...entry.cost };
  return Object.keys(fields).length > 0 ? fields : null;
}

interface CacheDocument {
  fetchedAt: number;
  entries: ModelsDevCatalog;
}

/** Cached, failure-tolerant accessor for the models.dev dataset. */

export interface ModelsDevCatalogOptions {
  /** Agent config directory; the cache lives under `<agentDir>/pix/`. */
  agentDir: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

function isCacheDocument(value: unknown): value is CacheDocument {
  if (!isRecord(value)) return false;
  return typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt)
    && Array.isArray(value.entries);
}

export function createModelsDevCatalogStore(options: ModelsDevCatalogOptions): ModelsDevCatalogStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let canonicalDir: Promise<string> | undefined;
  let inFlight: Promise<ModelsDevCatalog> | undefined;

  const dir = () => (canonicalDir ??= secureState.canonicalizePath(options.agentDir).then((base) => join(base, "pix")));

  async function readCache(): Promise<CacheDocument | null> {
    try {
      const result = await secureState.readStateDocument(join(await dir(), "models-dev-cache.json"), {
        maxBytes: MAX_CATALOG_BYTES,
      });
      if (!("content" in result)) return null;
      const parsed: unknown = JSON.parse(result.content);
      return isCacheDocument(parsed) ? parsed : null;
    } catch {
      // Missing/corrupt/oversized cache behaves like no cache.
      return null;
    }
  }

  async function writeCache(entries: ModelsDevCatalog): Promise<void> {
    const cacheDir = await dir();
    const document: CacheDocument = { fetchedAt: now(), entries };
    try {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await secureState.ensurePrivateDirectory(cacheDir);
      await secureState.writeStateDocument(join(cacheDir, "models-dev-cache.json"), `${JSON.stringify(document)}\n`, {
        maxBytes: MAX_CATALOG_BYTES,
      });
    } catch {
      // A cache write failure must never fail the lookup.
    }
  }

  async function fetchCatalog(): Promise<ModelsDevCatalog> {
    const response = await fetchImpl(MODELS_DEV_API_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new Error("models.dev catalog too large");
    const text = await response.text();
    if (!response.ok || Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) throw new Error("models.dev catalog unavailable");
    return parseModelsDevApiJson(JSON.parse(text));
  }

  /** Single-flight refresh: concurrent callers share one network attempt. */
  const refresh = (): Promise<ModelsDevCatalog> => (inFlight ??= fetchCatalog()
    .then(async (entries) => {
      await writeCache(entries);
      return entries;
    })
    .catch(() => [] as ModelsDevCatalog)
    .finally(() => {
      inFlight = undefined;
    }));

  return {
    get: async () => {
      const cached = await readCache();
      if (cached === null) return refresh();
      if (now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries;
      // Expired: serve stale data now, refresh out-of-band. The refresh
      // result (or failure) only affects the NEXT read.
      void refresh();
      return cached.entries;
    },
  };
}
