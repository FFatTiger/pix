import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelDiscoveryInputSchema,
  ModelDiscoveryResponseSchema,
  ModelMetadataRequestSchema,
  ModelMetadataResponseSchema,
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
        models: [{ sourceIndex: 0, id: "m1", reasoning: true }],
      }],
      availableProviders: [{ id: "openai", name: "OpenAI", methods: ["apiKey"], modelCount: 10 }],
    }).success, true);
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

  it("rejects raw API keys in responses, unknown fields, and malformed revisions", () => {
    assert.equal(ModelsConfigResponseSchema.safeParse({
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
