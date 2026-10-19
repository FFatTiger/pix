import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelDiscoveryInputSchema,
  ModelDiscoveryResponseSchema,
  ModelMetadataRequestSchema,
  ModelMetadataResponseSchema,
  ModelThinkingLevelMapSchema,
  ModelsConfigMutationSchema,
  ModelsConfigResponseSchema,
} from "../dist/index.js";

const revision = "a".repeat(64);

describe("models.json editor wire DTO", () => {
  it("accepts credential-blind snapshots and one-way key mutations", () => {
    assert.equal(ModelsConfigResponseSchema.safeParse({
      revision,
      providers: [{
        sourceId: "custom",
        id: "custom",
        apiKeyConfigured: true,
        modelsDefined: true,
        models: [{ sourceIndex: 0, id: "m1", reasoning: true, visibleInPicker: true }],
      }],
      availableProviders: [{ id: "openai", name: "OpenAI", methods: ["apiKey"], modelCount: 10 }],
    }).success, true);
    // The response projection REQUIRES the per-model picker flag; a missing
    // flag fails closed instead of defaulting to visible.
    assert.equal(ModelsConfigResponseSchema.safeParse({
      revision,
      providers: [{
        sourceId: "custom",
        id: "custom",
        apiKeyConfigured: true,
        modelsDefined: true,
        models: [{ sourceIndex: 0, id: "m1", reasoning: true }],
      }],
      availableProviders: [],
    }).success, false);
    assert.equal(ModelsConfigMutationSchema.safeParse({
      expectedRevision: revision,
      providers: [{
        sourceId: "custom",
        id: "renamed",
        apiKey: { mode: "replace", value: "secret-input-only" },
        modelsDefined: false,
        models: [],
      }],
    }).success, true);
    // Mutations never carry the snapshot-only visibility flag.
    assert.equal(ModelsConfigMutationSchema.safeParse({
      expectedRevision: revision,
      providers: [{
        sourceId: "custom",
        id: "renamed",
        apiKey: { mode: "preserve" },
        modelsDefined: true,
        models: [{ sourceIndex: 0, id: "m1", visibleInPicker: true }],
      }],
    }).success, false);
  });

  it("validates one-way discovery inputs and credential-blind results", () => {
    assert.equal(ModelDiscoveryInputSchema.safeParse({
      expectedRevision: revision,
      sourceId: "custom",
      providerId: "custom",
      baseUrl: "http://127.0.0.1:9000/v1",
      api: "openai-completions",
      apiKey: "one-way-secret",
    }).success, true);
    // Legacy rows without metadataSource stay parseable (additive, strict).
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", name: "Model One" }] }).success, true);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({
      models: [{
        id: "m1",
        metadataSource: "models.dev",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 32768,
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      }],
    }).success, true);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", metadataSource: null }] }).success, true);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", metadataSource: "other-catalog" }] }).success, false);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", apiKey: "secret" }] }).success, false);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", contextWindow: 0 }] }).success, false);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", contextWindow: 1.5 }] }).success, false);
  });

  it("validates the models.dev metadata lookup request and response", () => {
    assert.equal(ModelMetadataRequestSchema.safeParse({ ids: ["m1", "m2"], api: "openai-completions" }).success, true);
    // Bounded id list: empty, over-limit, blank ids, and extra fields fail closed.
    assert.equal(ModelMetadataRequestSchema.safeParse({ ids: [], api: "openai-completions" }).success, false);
    assert.equal(ModelMetadataRequestSchema.safeParse({ ids: Array(101).fill("m"), api: "openai-completions" }).success, false);
    assert.equal(ModelMetadataRequestSchema.safeParse({ ids: ["  "], api: "openai-completions" }).success, false);
    assert.equal(ModelMetadataRequestSchema.safeParse({ ids: ["m1"], api: "openai-completions", extra: 1 }).success, false);

    const response = ModelMetadataResponseSchema.safeParse({
      metadata: {
        "m1": { reasoning: true, contextWindow: 65536, cost: { input: 0.5 } },
        "m2": null,
      },
    });
    assert.equal(response.success, true);
    assert.equal(ModelMetadataResponseSchema.safeParse({ metadata: { m1: { apiKey: "secret" } } }).success, false);
    assert.equal(ModelMetadataResponseSchema.safeParse({ metadata: { m1: { maxTokens: -1 } } }).success, false);
    assert.equal(ModelMetadataResponseSchema.safeParse({ metadata: null }).success, false);
  });

  it("round-trips the per-level thinking mapping, including null and custom values", () => {
    // The snapshot carries the model's complete mapping.
    const snapshot = ModelsConfigResponseSchema.parse({
      revision,
      providers: [{
        sourceId: "custom",
        id: "custom",
        apiKeyConfigured: true,
        modelsDefined: true,
        models: [{
          sourceIndex: 0,
          id: "m1",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max", off: null, high: "high" },
          visibleInPicker: true,
        }],
      }],
      availableProviders: [],
    });
    assert.deepEqual(snapshot.providers[0].models[0].thinkingLevelMap, {
      xhigh: "xhigh",
      max: "max",
      off: null,
      high: "high",
    });

    // The mutation carries the same mapping verbatim (a custom provider
    // string and an explicit `null` both survive).
    const mutation = ModelsConfigMutationSchema.parse({
      expectedRevision: revision,
      providers: [{
        sourceId: "custom",
        id: "custom",
        apiKey: { mode: "preserve" },
        modelsDefined: true,
        models: [{ sourceIndex: 0, id: "m1", thinkingLevelMap: { xhigh: "high", off: null } }],
      }],
    });
    assert.deepEqual(mutation.providers[0].models[0].thinkingLevelMap, { xhigh: "high", off: null });

    // An empty mapping is legal: it states "no level mapping" (the stored
    // field is removed), and a missing mapping stays missing.
    assert.equal(ModelsConfigMutationSchema.safeParse({
      expectedRevision: revision,
      providers: [{
        sourceId: "custom",
        id: "custom",
        apiKey: { mode: "preserve" },
        modelsDefined: true,
        models: [{ sourceIndex: 0, id: "m1", thinkingLevelMap: {} }],
      }],
    }).success, true);
    assert.equal(ModelsConfigMutationSchema.safeParse({
      expectedRevision: revision,
      providers: [{
        sourceId: "custom",
        id: "custom",
        apiKey: { mode: "preserve" },
        modelsDefined: true,
        models: [{ sourceIndex: 0, id: "m1" }],
      }],
    }).success, true);
  });

  it("fails closed on malformed thinking-level mappings", () => {
    const badMaps = [
      { ultra: "x" },          // unknown level
      { xhigh: "" },           // empty provider string
      { xhigh: 5 },            // not a string
      { xhigh: { level: "x" } },
      { xhigh: "x", off: false },
      "xhigh",
      null,
    ];
    for (const thinkingLevelMap of badMaps) {
      assert.equal(ModelThinkingLevelMapSchema.safeParse(thinkingLevelMap).success, false, JSON.stringify(thinkingLevelMap));
      assert.equal(ModelsConfigMutationSchema.safeParse({
        expectedRevision: revision,
        providers: [{
          sourceId: "custom",
          id: "custom",
          apiKey: { mode: "preserve" },
          modelsDefined: true,
          models: [{ sourceIndex: 0, id: "m1", thinkingLevelMap }],
        }],
      }).success, false, JSON.stringify(thinkingLevelMap));
    }
    // An empty mapping is a legal "no level mapping" statement; a model row
    // without the field stays valid too (the client says nothing about the
    // mapping and the stored one is kept).
    assert.equal(ModelThinkingLevelMapSchema.safeParse({}).success, true);
    assert.equal(ModelThinkingLevelMapSchema.safeParse(undefined).success, false);
  });

  it("rejects raw API keys in responses, unknown fields, and malformed revisions", () => {    assert.equal(ModelsConfigResponseSchema.safeParse({
      revision,
      providers: [{ sourceId: "p", id: "p", apiKeyConfigured: true, apiKey: "secret", modelsDefined: false, models: [] }],
      availableProviders: [],
    }).success, false);
    assert.equal(ModelsConfigMutationSchema.safeParse({ expectedRevision: "stale", providers: [] }).success, false);
    assert.equal(ModelsConfigMutationSchema.safeParse({
      expectedRevision: revision,
      providers: [{ sourceId: null, id: "p", apiKey: { mode: "replace", value: "" }, modelsDefined: false, models: [] }],
    }).success, false);
  });
});

describe("picker model visibility wire DTO", () => {
  it("accepts the canonical snapshot and intent mutation shapes", async () => {
    const { ModelVisibilityResponseSchema, ModelVisibilityMutationSchema } = await import("../dist/index.js");
    assert.equal(ModelVisibilityResponseSchema.safeParse({
      revision,
      patterns: null,
      visible: [{ provider: "custom", id: "m1" }],
      defaultModel: null,
    }).success, true);
    assert.equal(ModelVisibilityResponseSchema.safeParse({
      revision,
      patterns: ["custom/*", "other/m2:high"],
      visible: [{ provider: "custom", id: "m1" }, { provider: "other", id: "m2" }],
      defaultModel: { provider: "custom", id: "m1" },
    }).success, true);
    assert.equal(ModelVisibilityMutationSchema.safeParse({
      expectedRevision: revision,
      changes: [{ provider: "custom", id: "m1", visible: false }],
    }).success, true);
    assert.equal(ModelVisibilityMutationSchema.safeParse({ expectedRevision: revision, changes: [] }).success, true);
  });

  it("fails closed on malformed shapes", async () => {
    const { ModelVisibilityResponseSchema, ModelVisibilityMutationSchema } = await import("../dist/index.js");
    const badResponses = [
      { revision, patterns: "custom/*", visible: [], defaultModel: null },
      { revision, patterns: [], visible: "x", defaultModel: null },
      { revision, patterns: null, visible: [{ provider: "", id: "m1" }], defaultModel: null },
      { revision, patterns: null, visible: [], defaultModel: { provider: "p" } },
      { revision: "nothex", patterns: null, visible: [], defaultModel: null },
      { revision, patterns: null, visible: [], defaultModel: null, extra: 1 },
    ];
    for (const bad of badResponses) {
      assert.equal(ModelVisibilityResponseSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
    const badMutations = [
      { expectedRevision: revision },
      { expectedRevision: revision, changes: {} },
      { expectedRevision: revision, changes: [{ provider: "p", id: "m1" }] },
      { expectedRevision: revision, changes: [{ provider: "p", id: "m1", visible: "yes" }] },
      { expectedRevision: "nothex", changes: [] },
      { expectedRevision: revision, changes: [], extra: 1 },
    ];
    for (const bad of badMutations) {
      assert.equal(ModelVisibilityMutationSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});
