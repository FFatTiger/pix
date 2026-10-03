/**
 * Cross-package built-in capability contract — Protocol wire projection vs
 * the runtime-core canonical vocabulary. Protocol cannot import runtime-core;
 * these tests pin ID lists and snapshot/write shapes by semantic equality.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_CAPABILITY_IDS as CANONICAL_IDS,
  defaultBuiltInCapabilities,
  normalizeBuiltInCapabilityList,
  type BuiltInCapabilityConfigSnapshot,
  type BuiltInCapabilityConfigWrite,
  type BuiltInCapabilityState,
} from "@fffattiger/pix-runtime-core";
import {
  BUILT_IN_CAPABILITY_IDS as WIRE_IDS,
  BuiltInCapabilityConfigMutationSchema,
  BuiltInCapabilityConfigResponseSchema,
  type BuiltInCapabilityConfigMutation,
  type BuiltInCapabilityConfigResponse,
  type BuiltInCapabilityState as WireBuiltInCapabilityState,
} from "@fffattiger/pix-protocol";

const revision = "a".repeat(64);

test("protocol built-in IDs are semantically identical to runtime-core", () => {
  assert.deepEqual([...WIRE_IDS], [...CANONICAL_IDS]);
});

test("protocol snapshot/write DTOs accept the canonical semantic shapes", () => {
  const capabilities = defaultBuiltInCapabilities();
  const snapshot: BuiltInCapabilityConfigSnapshot = { revision, capabilities };
  const write: BuiltInCapabilityConfigWrite = { expectedRevision: revision, capabilities };

  const response: BuiltInCapabilityConfigResponse = BuiltInCapabilityConfigResponseSchema.parse(snapshot);
  const mutation: BuiltInCapabilityConfigMutation = BuiltInCapabilityConfigMutationSchema.parse(write);
  assert.deepEqual(response.capabilities, capabilities);
  assert.deepEqual(mutation.capabilities, capabilities);

  const shuffled: BuiltInCapabilityState[] = [
    { id: "side_chat", enabled: false },
    { id: "todo", enabled: true },
    { id: "subagents", enabled: false },
    { id: "ask_user_question", enabled: true },
  ];
  assert.equal(BuiltInCapabilityConfigMutationSchema.safeParse({
    expectedRevision: revision,
    capabilities: shuffled,
  }).success, true);
  const canonical = normalizeBuiltInCapabilityList(shuffled);
  assert.ok(canonical);
  const wire: WireBuiltInCapabilityState[] = canonical;
  assert.deepEqual(wire, canonical);
});

test("protocol schemas reject duplicate/missing/unknown IDs and extras like runtime-core", () => {
  const capabilities = defaultBuiltInCapabilities();
  assert.equal(BuiltInCapabilityConfigResponseSchema.safeParse({
    revision,
    capabilities,
    extra: true,
  }).success, false);
  assert.equal(BuiltInCapabilityConfigMutationSchema.safeParse({
    expectedRevision: "stale",
    capabilities,
  }).success, false);
  assert.equal(BuiltInCapabilityConfigMutationSchema.safeParse({
    expectedRevision: revision,
    capabilities: capabilities.slice(0, 3),
  }).success, false);
  assert.equal(BuiltInCapabilityConfigMutationSchema.safeParse({
    expectedRevision: revision,
    capabilities: [
      ...capabilities.slice(0, 3),
      { id: "plugins", enabled: true },
    ],
  }).success, false);
  assert.equal(BuiltInCapabilityConfigMutationSchema.safeParse({
    expectedRevision: revision,
    capabilities: [
      { id: "subagents", enabled: true },
      { id: "todo", enabled: true },
      { id: "ask_user_question", enabled: true },
      { id: "subagents", enabled: false },
    ],
  }).success, false);
});
