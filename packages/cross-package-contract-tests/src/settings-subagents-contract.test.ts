import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSubagentSettings,
  THINKING_LEVELS,
  type SubagentSettings,
  type SubagentSettingsMutation,
  type SubagentSettingsSnapshot,
} from "@fffattiger/pix-runtime-core";
import { ThinkingLevelSchema } from "@fffattiger/pix-protocol";
import {
  SubagentSettingsSchema,
  SubagentSettingsMutationSchema,
  SubagentSettingsResponseSchema,
  type SubagentSettingsWire,
  type SubagentSettingsMutation as WireMutation,
  type SubagentSettingsResponse,
} from "@fffattiger/pix-protocol/settings-config";

const revision = "a".repeat(64);
const inherited: SubagentSettings = { defaultModel: null, fallbackModel: null, agentOverrides: [] };
const role = { name: "reviewer", model: null, fallbackModel: null, thinking: null };

function assertParity(input: unknown, expected: SubagentSettings | null): void {
  const canonical = normalizeSubagentSettings(input);
  const wire = SubagentSettingsSchema.safeParse(input);
  assert.deepEqual(canonical, expected, JSON.stringify(input));
  assert.equal(wire.success, canonical !== null, JSON.stringify(input));
  if (wire.success) assert.deepEqual(wire.data, canonical);
  const response = SubagentSettingsResponseSchema.safeParse({ revision, settings: input });
  const mutation = SubagentSettingsMutationSchema.safeParse({ expectedRevision: revision, settings: input });
  assert.equal(response.success, wire.success);
  assert.equal(mutation.success, wire.success);
  if (response.success) assert.deepEqual(response.data.settings, canonical);
  if (mutation.success) assert.deepEqual(mutation.data.settings, canonical);
}

test("subagent canonical and wire DTOs share nullable inheritance and envelope shapes", () => {
  const snapshot: SubagentSettingsSnapshot = { revision, settings: inherited };
  const mutation: SubagentSettingsMutation = { expectedRevision: revision, settings: inherited };
  const response: SubagentSettingsResponse = SubagentSettingsResponseSchema.parse(snapshot);
  const wireMutation: WireMutation = SubagentSettingsMutationSchema.parse(mutation);
  const wireSettings: SubagentSettingsWire = response.settings;
  const canonicalSettings: SubagentSettings = wireSettings;
  assert.deepEqual(response, snapshot);
  assert.deepEqual(wireMutation, mutation);
  assert.deepEqual(canonicalSettings, inherited);
  assertParity(inherited, inherited);
  assertParity({ ...inherited, agentOverrides: [role] }, { ...inherited, agentOverrides: [role] });
});

test("subagent settings preserve exact role case and spaces, unknown names and prototype-like data", () => {
  const names = ["reviewer", "Reviewer", " reviewer ", "Code Reviewer", "unknown custom role", "__proto__", "constructor", "toString"];
  const input = {
    defaultModel: "  custom/provider/model:v1  ",
    fallbackModel: " fuzzy model ",
    agentOverrides: names.map((name) => ({ ...role, name, model: "  any model  ", fallbackModel: " custom/fallback " })),
  };
  const original = structuredClone(input);
  const prototypeKeys = Reflect.ownKeys(Object.prototype);
  assertParity(input, {
    defaultModel: "custom/provider/model:v1",
    fallbackModel: "fuzzy model",
    agentOverrides: names.map((name) => ({ ...role, name, model: "any model", fallbackModel: "custom/fallback" })),
  });
  assert.deepEqual(input, original);
  assert.deepEqual(Reflect.ownKeys(Object.prototype), prototypeKeys);
});

test("all seven thinking levels have identical canonical and wire semantics", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(ThinkingLevelSchema.options, THINKING_LEVELS);
  for (const thinking of [...THINKING_LEVELS, null]) {
    const input = { ...inherited, agentOverrides: [{ ...role, thinking }] };
    assertParity(input, input);
  }
});

test("subagent model strings and row counts have no invented bounds", () => {
  const input = {
    defaultModel: "m".repeat(10_000),
    fallbackModel: null,
    agentOverrides: Array.from({ length: 1_001 }, (_, index) => ({ ...role, name: `custom ${index}` })),
  };
  assertParity(input, input);
});

test("subagent normalizer and schemas reject malformed roots, arrays and duplicate exact roles", () => {
  for (const input of [
    undefined, null, [], "settings", 1, false, {},
    { ...inherited, extra: true },
    { ...inherited, cwd: "/workspace" },
    { ...inherited, agentOverrides: null },
    { ...inherited, agentOverrides: {} },
    { ...inherited, agentOverrides: "reviewer" },
    ...[null, [], "reviewer", 1, {}, { ...role, extra: true }].map((row) => ({ ...inherited, agentOverrides: [row] })),
    { ...inherited, agentOverrides: [role, { ...role, model: "other" }] },
    JSON.parse('{"defaultModel":null,"fallbackModel":null,"agentOverrides":[],"__proto__":{"polluted":true}}'),
    { ...inherited, agentOverrides: [JSON.parse('{"name":"reviewer","model":null,"fallbackModel":null,"thinking":null,"__proto__":{}}')] },
  ]) assertParity(input, null);
});

test("subagent normalizer and schemas require every field and reject invalid field types", () => {
  for (const key of Object.keys(inherited)) {
    const missing: Record<string, unknown> = { ...inherited };
    delete missing[key];
    assertParity(missing, null);
    assertParity({ ...inherited, [key]: undefined }, null);
  }
  for (const key of Object.keys(role)) {
    const missing: Record<string, unknown> = { ...role };
    delete missing[key];
    assertParity({ ...inherited, agentOverrides: [missing] }, null);
    assertParity({ ...inherited, agentOverrides: [{ ...role, [key]: undefined }] }, null);
  }
  for (const value of ["", " \n\t", 1, false, {}, [], undefined]) {
    for (const key of ["defaultModel", "fallbackModel"]) assertParity({ ...inherited, [key]: value }, null);
    for (const key of ["name", "model", "fallbackModel"]) {
      assertParity({ ...inherited, agentOverrides: [{ ...role, [key]: value }] }, null);
    }
  }
  assertParity({ ...inherited, agentOverrides: [{ ...role, name: null }] }, null);
  for (const thinking of ["", "auto", "HIGH", " high ", 1, false, {}, [], undefined]) {
    assertParity({ ...inherited, agentOverrides: [{ ...role, thinking }] }, null);
  }
});
