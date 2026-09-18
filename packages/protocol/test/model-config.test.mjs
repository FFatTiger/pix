import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelDiscoveryInputSchema,
  ModelDiscoveryResponseSchema,
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
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", name: "Model One" }] }).success, true);
    assert.equal(ModelDiscoveryResponseSchema.safeParse({ models: [{ id: "m1", apiKey: "secret" }] }).success, false);
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
