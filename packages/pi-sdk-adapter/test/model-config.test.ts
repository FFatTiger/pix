import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelsDevCatalogStore, ModelsDevModelEntry } from "../src/internal/models-dev-catalog.js";
import { createPiSdkModelsConfig } from "../src/models/index.js";

/** Offline models.dev stub: never touches the network in tests. */
function stubModelsDev(entries: ModelsDevModelEntry[]): ModelsDevCatalogStore {
  return { get: async () => entries };
}

function offlineModelsDev(): ModelsDevCatalogStore {
  return stubModelsDev([]);
}

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-"));
  const secret = "sk-secret-model-config-canary";
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "custom-old": {
        baseUrl: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        apiKey: secret,
        headers: { "X-Secret-Header": "header-secret-canary" },
        compat: { supportsDeveloperRole: false },
        models: [{
          id: "m1",
          name: "Model One",
          reasoning: true,
          contextWindow: 32000,
          maxTokens: 4096,
          headers: { "X-Model-Secret": "model-secret-canary" },
        }],
      },
    },
  }, null, 2), { mode: 0o600 });
  return { agentDir, secret };
}

describe("writable models.json config store", () => {
  it("redacts secrets, preserves hidden fields, supports rename, and fences stale revisions", async () => {
    const { agentDir, secret } = await fixture();
    try {
      const store = createPiSdkModelsConfig({ agentDir, modelsDev: offlineModelsDev() });
      const before = await store.readConfig();
      assert.equal(before.providers.length, 1);
      assert.equal(before.providers[0]?.apiKeyConfigured, true);
      assert.equal(JSON.stringify(before).includes(secret), false);
      assert.equal(JSON.stringify(before).includes("header-secret-canary"), false);
      assert.ok(before.availableProviders.some((provider) => provider.id === "anthropic"));

      const provider = before.providers[0]!;
      const result = await store.writeConfig({
        expectedRevision: before.revision,
        providers: [{
          sourceId: provider.sourceId,
          id: "custom-renamed",
          ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
          ...(provider.api === undefined ? {} : { api: provider.api }),
          apiKey: { mode: "preserve" },
          modelsDefined: true,
          models: [{ ...provider.models[0]!, name: "Renamed Model" }],
        }],
      });
      assert.equal(result.providers[0]?.id, "custom-renamed");
      assert.equal(result.providers[0]?.models[0]?.name, "Renamed Model");
      assert.equal(JSON.stringify(result).includes(secret), false);

      const persisted = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
      assert.equal(persisted.providers["custom-renamed"].apiKey, secret);
      assert.equal(persisted.providers["custom-renamed"].headers["X-Secret-Header"], "header-secret-canary");
      assert.equal(persisted.providers["custom-renamed"].models[0].headers["X-Model-Secret"], "model-secret-canary");
      assert.equal(persisted.providers["custom-renamed"].models[0].name, "Renamed Model");

      await assert.rejects(
        store.writeConfig({ expectedRevision: before.revision, providers: [] }),
        (error: unknown) => (error as { code?: string }).code === "conflict",
      );
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("discovers models through a bounded exact-endpoint request without returning the persisted key", async () => {
    const { agentDir, secret } = await fixture();
    let authorization = "";
    let redirectTargetHits = 0;
    const redirectTarget = createServer((_request, response) => {
      redirectTargetHits += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "redirected-model" }] }));
    });
    await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
    const redirectAddress = redirectTarget.address();
    assert.ok(redirectAddress && typeof redirectAddress === "object");
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      if (request.url?.startsWith("/redirect/")) {
        response.statusCode = 302;
        response.setHeader("location", `http://127.0.0.1:${redirectAddress.port}/internal`);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "z-model", name: "Zed" }, { id: "a-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const store = createPiSdkModelsConfig({ agentDir, modelsDev: offlineModelsDev() });
      const current = await store.readConfig();
      const models = await store.discoverModels({
        expectedRevision: current.revision,
        sourceId: "custom-old",
        providerId: "custom-old",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: secret,
      });
      assert.deepEqual(models, [
        { id: "a-model", metadataSource: null },
        { id: "z-model", name: "Zed", metadataSource: null },
      ]);
      assert.equal(authorization, `Bearer ${secret}`);
      assert.equal(JSON.stringify(models).includes(secret), false);

      await assert.rejects(
        store.discoverModels({
          expectedRevision: current.revision,
          sourceId: "custom-old",
          providerId: "custom-old",
          baseUrl: `http://127.0.0.1:${address.port}/redirect`,
          api: "openai-completions",
          apiKey: secret,
        }),
        (error: unknown) => (error as { code?: string }).code === "unavailable",
      );
      assert.equal(redirectTargetHits, 0);

      await assert.rejects(
        store.discoverModels({
          expectedRevision: current.revision,
          sourceId: "custom-old",
          providerId: "custom-old",
          baseUrl: "file:///etc/passwd",
          api: "openai-completions",
        }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => redirectTarget.close(() => resolve()));
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("consumes replacement keys one-way and rejects invalid composed config before publish", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-new-"));
    try {
      const store = createPiSdkModelsConfig({ agentDir });
      const empty = await store.readConfig();
      const replacement = "sk-new-secret-canary";
      const saved = await store.writeConfig({
        expectedRevision: empty.revision,
        providers: [{
          sourceId: null,
          id: "custom",
          baseUrl: "http://127.0.0.1:9000/v1",
          api: "openai-completions",
          apiKey: { mode: "replace", value: replacement },
          modelsDefined: true,
          models: [{ sourceIndex: null, id: "model", contextWindow: 1000, maxTokens: 100 }],
        }],
      });
      assert.equal(saved.providers[0]?.apiKeyConfigured, true);
      assert.equal(JSON.stringify(saved).includes(replacement), false);

      const bytes = await readFile(join(agentDir, "models.json"), "utf8");
      const current = await store.readConfig();
      await assert.rejects(
        store.writeConfig({
          expectedRevision: current.revision,
          providers: [{
            sourceId: "custom",
            id: "custom",
            api: "openai-completions",
            apiKey: { mode: "remove" },
            modelsDefined: false,
            models: [],
          }],
        }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
      assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), bytes);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("model discovery pagination and models.dev enrichment", () => {
  it("follows Anthropic has_more/last_id pages and merges the result", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-pages-"));
    const urls: string[] = [];
    const server = createServer((request, response) => {
      urls.push(request.url ?? "");
      const lastId = new URL(request.url ?? "/", "http://x").searchParams.get("last_id");
      if (!lastId) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "claude-b" }], has_more: false, last_id: "claude-b" }));
    });
    const base = await listen(server);
    try {
      const store = createPiSdkModelsConfig({ agentDir, modelsDev: offlineModelsDev() });
      const snapshot = await store.readConfig();
      const models = await store.discoverModels({
        expectedRevision: snapshot.revision,
        sourceId: null,
        providerId: "pages",
        baseUrl: base,
        api: "anthropic-messages",
      });
      assert.deepEqual(models.map((model) => model.id), ["claude-a", "claude-b"]);
      assert.equal(urls.length, 2);
      assert.match(urls[1]!, /last_id=claude-a/);
    } finally {
      await close(server);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("follows Google nextPageToken pages and strips models/ ids", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-pages-"));
    const urls: string[] = [];
    const server = createServer((request, response) => {
      urls.push(request.url ?? "");
      const pageToken = new URL(request.url ?? "/", "http://x").searchParams.get("pageToken");
      response.setHeader("content-type", "application/json");
      if (!pageToken) {
        response.end(JSON.stringify({ models: [{ name: "models/gemini-a" }], nextPageToken: "token-2" }));
        return;
      }
      response.end(JSON.stringify({ models: [{ name: "models/gemini-b" }] }));
    });
    const base = await listen(server);
    try {
      const store = createPiSdkModelsConfig({ agentDir, modelsDev: offlineModelsDev() });
      const snapshot = await store.readConfig();
      const models = await store.discoverModels({
        expectedRevision: snapshot.revision,
        sourceId: null,
        providerId: "gpages",
        baseUrl: base,
        api: "google-generative-ai",
      });
      assert.deepEqual(models.map((model) => model.id), ["gemini-a", "gemini-b"]);
      assert.equal(urls.length, 2);
      assert.match(urls[1]!, /pageToken=token-2/);
    } finally {
      await close(server);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("stops at the hard 10-page ceiling even when the source keeps offering more", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-cap-"));
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: `m${hits}` }], has_more: true, last_id: `m${hits}` }));
    });
    const base = await listen(server);
    try {
      const store = createPiSdkModelsConfig({ agentDir, modelsDev: offlineModelsDev() });
      const snapshot = await store.readConfig();
      const models = await store.discoverModels({
        expectedRevision: snapshot.revision,
        sourceId: null,
        providerId: "cap",
        baseUrl: base,
        api: "anthropic-messages",
      });
      assert.equal(hits, 10);
      assert.equal(models.length, 10);
    } finally {
      await close(server);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("enriches discovered models with matched models.dev parameters and keeps misses honest", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-meta-"));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "totally-unknown" }] }));
    });
    const base = await listen(server);
    try {
      const store = createPiSdkModelsConfig({
        agentDir,
        modelsDev: stubModelsDev([{
          provider: "openai",
          id: "gpt-4o",
          name: "GPT-4o",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 2.5, output: 10, cacheRead: 1.25 },
        }]),
      });
      const snapshot = await store.readConfig();
      const models = await store.discoverModels({
        expectedRevision: snapshot.revision,
        sourceId: null,
        providerId: "meta",
        baseUrl: `${base}/v1`,
        api: "openai-completions",
      });
      const enriched = models.find((model) => model.id === "gpt-4o");
      assert.deepEqual(enriched, {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 2.5, output: 10, cacheRead: 1.25 },
        metadataSource: "models.dev",
      });
      assert.deepEqual(models.find((model) => model.id === "totally-unknown"), {
        id: "totally-unknown",
        metadataSource: null,
      });
    } finally {
      await close(server);
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("resolves per-id metadata lookups and fails closed on invalid input", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pix-model-config-lookup-"));
    try {
      const store = createPiSdkModelsConfig({
        agentDir,
        modelsDev: stubModelsDev([
          { provider: "openai", id: "gpt-4o", contextWindow: 128000 },
          { provider: "openrouter", id: "gpt-4o", contextWindow: 1 },
        ]),
      });
      const entries = await store.resolveModelMetadata({ ids: ["gpt-4o", "missing", "gpt-4o"], api: "openai-responses" });
      // Duplicates collapse; the api-type preference picks openai over openrouter.
      assert.deepEqual(entries, [
        { id: "gpt-4o", metadata: { contextWindow: 128000 } },
        { id: "missing", metadata: null },
      ]);
      await assert.rejects(
        store.resolveModelMetadata({ ids: [], api: "openai-responses" }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
      await assert.rejects(
        store.resolveModelMetadata({ ids: Array(101).fill("m"), api: "openai-responses" }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
      await assert.rejects(
        store.resolveModelMetadata({ ids: ["  "], api: "openai-responses" }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
