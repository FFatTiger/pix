/**
 * Cross-package picker model-visibility contract — Protocol wire projection
 * vs the runtime-core canonical ModelVisibilitySnapshot/Mutation shapes.
 * Protocol cannot import runtime-core; these tests pin the intent semantics
 * (exact provider/id + desired boolean, CAS revision fence) by semantic
 * equality, and the models-config snapshot's per-model visibility flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ModelVisibilityMutation,
  ModelVisibilitySnapshot,
} from "@fffattiger/pix-runtime-core";
import {
  ModelVisibilityMutationSchema,
  ModelVisibilityResponseSchema,
  ModelsConfigResponseSchema,
  type ModelVisibilityMutation as WireMutation,
  type ModelVisibilityResponse as WireResponse,
} from "@fffattiger/pix-protocol";

const revision = "a".repeat(64);

test("protocol model-visibility DTOs accept every canonical snapshot/mutation shape", () => {
  const snapshots: ModelVisibilitySnapshot[] = [
    { revision, patterns: null, visible: [], defaultModel: null },
    { revision, patterns: [], visible: [{ provider: "acme", id: "m1" }], defaultModel: { provider: "acme", id: "m1" } },
    { revision, patterns: ["acme/*", "other/m2:high"], visible: [{ provider: "acme", id: "m1" }], defaultModel: null },
  ];
  for (const snapshot of snapshots) {
    const response: WireResponse = ModelVisibilityResponseSchema.parse(snapshot);
    assert.deepEqual(response, snapshot);
  }
  const mutations: ModelVisibilityMutation[] = [
    { expectedRevision: revision, changes: [] },
    { expectedRevision: revision, changes: [{ provider: "acme", id: "m1", visible: false }] },
    {
      expectedRevision: revision,
      changes: [
        { provider: "acme", id: "m1", visible: false },
        { provider: "other", id: "m2", visible: true },
      ],
    },
  ];
  for (const mutation of mutations) {
    const wire: WireMutation = ModelVisibilityMutationSchema.parse(mutation);
    assert.deepEqual(wire, mutation);
  }
});

test("protocol model-visibility schemas fail closed on malformed shapes", () => {
  const badResponses = [
    { revision, patterns: "acme/*", visible: [], defaultModel: null },
    { revision, patterns: null, visible: [{ provider: "acme" }], defaultModel: null },
    { revision, patterns: null, visible: [], defaultModel: { id: "m1" } },
    { revision, patterns: null, visible: [], defaultModel: { provider: "p", id: "" } },
    { revision: "xyz", patterns: null, visible: [], defaultModel: null },
  ];
  for (const bad of badResponses) {
    assert.equal(ModelVisibilityResponseSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const badMutations = [
    { expectedRevision: revision, changes: [{ provider: "acme", id: "m1", visible: null }] },
    { expectedRevision: revision, changes: [{ provider: "", id: "m1", visible: true }] },
    { expectedRevision: revision, changes: [{}] },
  ];
  for (const bad of badMutations) {
    assert.equal(ModelVisibilityMutationSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("models-config response requires the snapshot-only visibleInPicker flag; mutations never carry it", () => {
  const model = { sourceIndex: 0, id: "m1", visibleInPicker: false };
  assert.equal(ModelsConfigResponseSchema.safeParse({
    revision,
    providers: [{ sourceId: "acme", id: "acme", apiKeyConfigured: false, modelsDefined: true, models: [model] }],
    availableProviders: [],
  }).success, true);
  assert.equal(ModelsConfigResponseSchema.safeParse({
    revision,
    providers: [{ sourceId: "acme", id: "acme", apiKeyConfigured: false, modelsDefined: true, models: [{ sourceIndex: 0, id: "m1" }] }],
    availableProviders: [],
  }).success, false);
});
