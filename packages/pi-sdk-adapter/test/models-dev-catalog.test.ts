import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CACHE_TTL_MS,
  createModelsDevCatalogStore,
  matchModelsDevEntry,
  modelsDevEntryToFields,
  normalizedModelId,
  parseModelsDevApiJson,
  type ModelsDevCatalog,
} from "../src/internal/models-dev-catalog.js";

function apiJson(providers: Record<string, unknown>): unknown {
  return providers;
}

const OPENAI_GPT = {
  id: "gpt-4o",
  name: "GPT-4o",
  reasoning: true,
  attachment: true,
  modalities: { input: ["text", "image", "video"], output: ["text"] },
  limit: { context: 128000, output: 16384 },
  cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 0 },
};

const CATALOG: ModelsDevCatalog = parseModelsDevApiJson(apiJson({
  openai: { models: { "gpt-4o": OPENAI_GPT } },
  openrouter: { models: { "gpt-4o": { id: "gpt-4o", name: "GPT-4o (router)" } } },
  togetherai: { models: { "gpt-4o": { id: "gpt-4o" } } },
  anthropic: { models: { "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" } } },
  "amazon-bedrock": { models: { "claude-haiku-4-5": { id: "claude-haiku-4-5" } } },
  google: { models: { "gemini-2.5-pro": { id: "gemini-2.5-pro" } } },
  deepinfra: { models: { "gemini-2.5-pro": { id: "gemini-2.5-pro" } } },
  mistral: { models: { "shared-model": { id: "shared-model" } } },
  meta: { models: { "shared-model": { id: "shared-model" } } },
  zeta: { models: { "router-only": { id: "router-only" } } },
  alpha: { models: { "router-only": { id: "router-only" } } },
  "not-a-model-list": { id: "openai", env: "OPENAI", npm: "@openai/sdk" },
}));

describe("models.dev catalog parsing and matching", () => {
  it("reduces api.json rows to consumable fields, dropping zero/missing and non-text/image modalities", () => {
    const catalog = parseModelsDevApiJson(apiJson({
      "prov-a": {
        models: {
          full: OPENAI_GPT,
          sparse: { id: "sparse", cost: { input: 0, output: 5 }, limit: { context: 0, output: 0 } },
          keyed: { name: "Keyed Name" },
        },
      },
    }));
    const full = catalog.find((entry) => entry.id === "gpt-4o");
    assert.ok(full);
    assert.equal(full.provider, "prov-a");
    assert.equal(full.name, "GPT-4o");
    assert.equal(full.reasoning, true);
    assert.deepEqual(full.input, ["text", "image"]);
    assert.equal(full.contextWindow, 128000);
    assert.equal(full.maxTokens, 16384);
    // Costs are USD per million tokens on models.dev — the SAME unit Pi's
    // models.json uses — so values must pass through unchanged.
    assert.deepEqual(full.cost, { input: 2.5, output: 10, cacheRead: 1.25 });
    const sparse = catalog.find((entry) => entry.id === "sparse");
    assert.ok(sparse);
    // Zero prices are dropped (unknown), positive ones survive.
    assert.deepEqual(sparse.cost, { output: 5 });
    assert.equal(sparse.contextWindow, undefined);
    assert.equal(sparse.maxTokens, undefined);
    const keyed = catalog.find((entry) => entry.id === "keyed");
    assert.ok(keyed);
    assert.equal(keyed.name, "Keyed Name");
    // Providers without a models map contribute nothing.
    assert.equal(catalog.some((entry) => entry.provider === "not-a-model-list"), false);
  });

  it("matches an exact id and resolves multiple candidates deterministically", () => {
    // Single exact candidate.
    assert.equal(matchModelsDevEntry(CATALOG, "claude-haiku-4-5", "openai-completions")?.provider, "anthropic");
    // Multiple candidates + api-type preference: google-generative-ai → google
    // outranks both the first-party list and lexicographic order.
    assert.equal(matchModelsDevEntry(CATALOG, "gemini-2.5-pro", "google-generative-ai")?.provider, "google");
    // Multiple candidates, none matching the api preference: first-party
    // provider order decides (mistral ranks above meta even though
    // "meta" sorts first lexicographically).
    assert.equal(matchModelsDevEntry(CATALOG, "shared-model", "google-generative-ai")?.provider, "mistral");
    // openai-* api prefers the openai first-party entry among duplicates.
    assert.equal(matchModelsDevEntry(CATALOG, "gpt-4o", "openai-responses")?.provider, "openai");
    // No api preference and no first-party candidate: stable lexicographic
    // provider tie-break.
    assert.equal(matchModelsDevEntry(CATALOG, "router-only", "google-generative-ai")?.provider, "alpha");
  });

  it("falls back to normalization (case, models/, provider/) but never to fuzzy matching", () => {
    assert.equal(normalizedModelId(" Models/Gemini-2.5-Pro "), "gemini-2.5-pro");
    assert.equal(normalizedModelId("OpenAI/GPT-4o"), "gpt-4o");
    assert.equal(matchModelsDevEntry(CATALOG, "GPT-4O", "openai-completions")?.provider, "openai");
    assert.equal(matchModelsDevEntry(CATALOG, "models/gemini-2.5-pro", "google-generative-ai")?.provider, "google");
    assert.equal(matchModelsDevEntry(CATALOG, "openrouter/gpt-4o", "openai-completions")?.provider, "openai");
    // Near misses stay misses.
    assert.equal(matchModelsDevEntry(CATALOG, "gpt4o", "openai-completions"), null);
    assert.equal(matchModelsDevEntry(CATALOG, "gpt-4o-mini-2024", "openai-completions"), null);
    assert.equal(matchModelsDevEntry(CATALOG, "", "openai-completions"), null);
    assert.equal(matchModelsDevEntry(CATALOG, "  ", "openai-completions"), null);
  });

  it("projects an entry to editor fields or null when it carries nothing", () => {
    const fields = modelsDevEntryToFields(CATALOG[0]!);
    assert.ok(fields);
    assert.equal(fields.name, "GPT-4o");
    assert.equal(fields.reasoning, true);
    assert.deepEqual(fields.input, ["text", "image"]);
    assert.equal(fields.contextWindow, 128000);
    assert.equal(fields.maxTokens, 16384);
    assert.deepEqual(fields.cost, { input: 2.5, output: 10, cacheRead: 1.25 });
    assert.equal(modelsDevEntryToFields({ provider: "x", id: "empty" }), null);
  });
});

/**
 * Bounded real-timer wait for background disk I/O (fsync-backed cache
 * writes) to become observable. The lifecycle decisions under test (fetch
 * counts, single-flight, stale-serving) are asserted via counters and returned
 * data; this only waits for the async fs completion itself.
 */
async function waitFor(ready: () => Promise<boolean>, message: string, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function catalogPayload(tag: string): unknown {
  return { "prov-x": { models: { [tag]: { id: tag, limit: { context: 1000 } } } } };
}

describe("models.dev disk cache", () => {
  async function tempAgentDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "pix-models-dev-"));
  }

  it("fetches once when no cache exists, then serves the fresh cache without network", async () => {
    const agentDir = await tempAgentDir();
    let fetches = 0;
    try {
      const store = createModelsDevCatalogStore({
        agentDir,
        fetchImpl: async () => {
          fetches += 1;
          return jsonResponse(catalogPayload("first"));
        },
      });
      const first = await store.get();
      assert.deepEqual(first.map((entry) => entry.id), ["first"]);
      const second = await store.get();
      assert.deepEqual(second.map((entry) => entry.id), ["first"]);
      assert.equal(fetches, 1);
      const cached = JSON.parse(await readFile(join(agentDir, "pix", "models-dev-cache.json"), "utf8"));
      assert.equal(typeof cached.fetchedAt, "number");
      assert.deepEqual(cached.entries.map((entry: { id: string }) => entry.id), ["first"]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("serves an expired cache immediately and refreshes it in the background", async () => {
    const agentDir = await tempAgentDir();
    let fetches = 0;
    let clock = 1_000_000;
    try {
      const store = createModelsDevCatalogStore({
        agentDir,
        now: () => clock,
        fetchImpl: async () => {
          fetches += 1;
          return jsonResponse(catalogPayload(fetches === 1 ? "stale" : "refreshed"));
        },
      });
      assert.deepEqual((await store.get()).map((entry) => entry.id), ["stale"]);
      clock += CACHE_TTL_MS + 1;
      // Expired read answers with the OLD data without waiting on the network.
      assert.deepEqual((await store.get()).map((entry) => entry.id), ["stale"]);
      // The background refresh rewrites the cache document exactly once.
      await waitFor(
        async () => {
          try {
            return (await readFile(join(agentDir, "pix", "models-dev-cache.json"), "utf8")).includes("refreshed");
          } catch {
            return false;
          }
        },
        "background refresh never rewrote the cache",
      );
      assert.equal(fetches, 2);
      // The refreshed cache is served by the next read, without another fetch.
      assert.deepEqual((await store.get()).map((entry) => entry.id), ["refreshed"]);
      assert.equal(fetches, 2);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps the old cache when a refresh fails, and answers empty when there is no cache", async () => {
    const agentDir = await tempAgentDir();
    const bareDir = await mkdtemp(join(tmpdir(), "pix-models-dev-bare-"));
    let clock = 1_000_000;
    let fetches = 0;
    let fail = false;
    try {
      const store = createModelsDevCatalogStore({
        agentDir,
        now: () => clock,
        fetchImpl: async () => {
          fetches += 1;
          if (fail) return new Response("upstream down", { status: 503 });
          return jsonResponse(catalogPayload("good"));
        },
      });
      assert.deepEqual((await store.get()).map((entry) => entry.id), ["good"]);
      clock += CACHE_TTL_MS + 1;
      fail = true;
      // Kick the expired read (still answers the old data immediately) and
      // wait until the failed background refresh attempt has actually run.
      assert.deepEqual((await store.get()).map((entry) => entry.id), ["good"]);
      await waitFor(async () => fetches === 2, "background refresh never attempted");
      // Stale-but-usable data survives a failed refresh.
      assert.deepEqual((await store.get()).map((entry) => entry.id), ["good"]);
      // A cacheless store with a dead upstream reports "no parameters":
      // empty catalog, never a throw, never fabricated entries.
      const bare = createModelsDevCatalogStore({
        agentDir: bareDir,
        fetchImpl: async () => new Response("down", { status: 500 }),
      });
      assert.deepEqual(await bare.get(), []);
      // The failed fetch must not have produced a cache document.
      assert.deepEqual(await readdir(bareDir), []);
      // The good cache document is the only file in the other store's dir.
      assert.deepEqual(await readdir(join(agentDir, "pix")), ["models-dev-cache.json"]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
      await rm(bareDir, { recursive: true, force: true });
    }
  });

  it("collapses concurrent cacheless reads into a single fetch", async () => {
    const agentDir = await tempAgentDir();
    let fetches = 0;
    try {
      const store = createModelsDevCatalogStore({
        agentDir,
        fetchImpl: async () => {
          fetches += 1;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return jsonResponse(catalogPayload("only"));
        },
      });
      const [a, b] = await Promise.all([store.get(), store.get()]);
      assert.deepEqual(a, b);
      assert.equal(fetches, 1);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
