import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSubagentSettings, THINKING_LEVELS, type SubagentSettings } from "./index.js";

const inherited: SubagentSettings = { defaultModel: null, fallbackModel: null, agentOverrides: [] };
const role = { name: " Code Reviewer ", model: null, fallbackModel: null, thinking: null };

test("subagent settings preserve inheritance, exact roles and canonical thinking levels", () => {
  assert.deepEqual(normalizeSubagentSettings(inherited), inherited);
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const thinking of THINKING_LEVELS) {
    const input = { ...inherited, agentOverrides: [{ ...role, thinking }] };
    assert.deepEqual(normalizeSubagentSettings(input), input);
  }
});

test("subagent settings trim model strings without mutating input or role names", () => {
  const input = Object.freeze({
    defaultModel: "  custom/model:latest  ",
    fallbackModel: "  fuzzy model  ",
    agentOverrides: Object.freeze([Object.freeze({ ...role, model: "  another/model  " })]),
  });
  assert.deepEqual(normalizeSubagentSettings(input), {
    defaultModel: "custom/model:latest",
    fallbackModel: "fuzzy model",
    agentOverrides: [{ ...role, model: "another/model" }],
  });
});

test("subagent settings fail closed on malformed DTOs and duplicate exact names", () => {
  for (const value of [
    null, [], "settings", {},
    { ...inherited, extra: true },
    { ...inherited, defaultModel: " " },
    { ...inherited, fallbackModel: false },
    { ...inherited, agentOverrides: {} },
    { ...inherited, agentOverrides: [null] },
    { ...inherited, agentOverrides: [{ ...role, name: " " }] },
    { ...inherited, agentOverrides: [{ ...role, model: 1 }] },
    { ...inherited, agentOverrides: [{ ...role, thinking: "auto" }] },
    { ...inherited, agentOverrides: [{ ...role, extra: true }] },
    { ...inherited, agentOverrides: [role, role] },
  ]) assert.equal(normalizeSubagentSettings(value), null, JSON.stringify(value));
  for (const key of Object.keys(inherited)) {
    const value = { ...inherited } as Record<string, unknown>;
    delete value[key];
    assert.equal(normalizeSubagentSettings(value), null, key);
  }
  for (const key of Object.keys(role)) {
    const value = { ...role } as Record<string, unknown>;
    delete value[key];
    assert.equal(normalizeSubagentSettings({ ...inherited, agentOverrides: [value] }), null, key);
  }
});
