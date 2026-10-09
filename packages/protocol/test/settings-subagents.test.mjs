import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SubagentAgentOverrideSchema,
  SubagentSettingsSchema,
  SubagentSettingsMutationSchema,
  SubagentSettingsResponseSchema,
} from "../dist/settings-config.js";

const revision = "a".repeat(64);
const settings = { defaultModel: null, fallbackModel: null, agentOverrides: [] };

test("subagent wire DTOs accept required null fields and trim custom models", () => {
  assert.deepEqual(SubagentSettingsResponseSchema.parse({ revision, settings }), { revision, settings });
  assert.deepEqual(SubagentSettingsMutationSchema.parse({ expectedRevision: revision, settings }), {
    expectedRevision: revision, settings,
  });
  assert.deepEqual(SubagentAgentOverrideSchema.parse({
    name: " Custom Role ", model: "  fuzzy model  ", fallbackModel: " custom/id ", thinking: "max",
  }), { name: " Custom Role ", model: "fuzzy model", fallbackModel: "custom/id", thinking: "max" });
});

test("subagent wire envelopes require exact fields and a lowercase SHA-256 revision", () => {
  for (const [schema, key] of [
    [SubagentSettingsResponseSchema, "revision"],
    [SubagentSettingsMutationSchema, "expectedRevision"],
  ]) {
    for (const value of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), null, 1]) {
      assert.equal(schema.safeParse({ [key]: value, settings }).success, false);
    }
    for (const input of [{ settings }, { [key]: revision }, { [key]: revision, settings, extra: true }]) {
      assert.equal(schema.safeParse(input).success, false);
    }
  }
});

test("subagent wire settings reject extra fields, missing nulls and duplicate roles", () => {
  const row = { name: "reviewer", model: null, fallbackModel: null, thinking: null };
  for (const input of [
    { ...settings, cwd: "/workspace" },
    { ...settings, defaultModel: " " },
    { ...settings, agentOverrides: [{ ...row, thinking: "auto" }] },
    { ...settings, agentOverrides: [{ ...row, name: " " }] },
    { ...settings, agentOverrides: [{ ...row, nativeMetadata: true }] },
    { ...settings, agentOverrides: [row, row] },
  ]) assert.equal(SubagentSettingsSchema.safeParse(input).success, false);
  for (const key of Object.keys(settings)) {
    const input = { ...settings };
    delete input[key];
    assert.equal(SubagentSettingsSchema.safeParse(input).success, false);
  }
  for (const key of Object.keys(row)) {
    const input = { ...row };
    delete input[key];
    assert.equal(SubagentAgentOverrideSchema.safeParse(input).success, false);
  }
});
