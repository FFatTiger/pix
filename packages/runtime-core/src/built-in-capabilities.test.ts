import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_CAPABILITY_IDS,
  defaultBuiltInCapabilities,
  isBuiltInCapabilityId,
  normalizeBuiltInCapabilityList,
} from "./built-in-capabilities.js";

test("built-in vocabulary is exactly the four canonical feature IDs", () => {
  assert.deepEqual([...BUILT_IN_CAPABILITY_IDS], [
    "subagents",
    "todo",
    "ask_user_question",
    "side_chat",
  ]);
  assert.equal(isBuiltInCapabilityId("subagents"), true);
  assert.equal(isBuiltInCapabilityId("todo"), true);
  assert.equal(isBuiltInCapabilityId("ask_user_question"), true);
  assert.equal(isBuiltInCapabilityId("side_chat"), true);
  assert.equal(isBuiltInCapabilityId("plugins"), false);
  assert.equal(isBuiltInCapabilityId("@mariozechner/pi-coding-agent"), false);
  assert.equal(isBuiltInCapabilityId(""), false);
});

test("missing durable config means all four enabled in canonical order", () => {
  assert.deepEqual(defaultBuiltInCapabilities(), [
    { id: "subagents", enabled: true },
    { id: "todo", enabled: true },
    { id: "ask_user_question", enabled: true },
    { id: "side_chat", enabled: true },
  ]);
});

test("normalizeBuiltInCapabilityList accepts a permutation and returns canonical order", () => {
  const normalized = normalizeBuiltInCapabilityList([
    { id: "side_chat", enabled: false },
    { id: "todo", enabled: true },
    { id: "subagents", enabled: false },
    { id: "ask_user_question", enabled: true },
  ]);
  assert.deepEqual(normalized, [
    { id: "subagents", enabled: false },
    { id: "todo", enabled: true },
    { id: "ask_user_question", enabled: true },
    { id: "side_chat", enabled: false },
  ]);
});

test("normalizeBuiltInCapabilityList rejects duplicate, missing, unknown, and malformed rows", () => {
  const valid = defaultBuiltInCapabilities();
  assert.equal(normalizeBuiltInCapabilityList(null), null);
  assert.equal(normalizeBuiltInCapabilityList({}), null);
  assert.equal(normalizeBuiltInCapabilityList(valid.slice(0, 3)), null);
  assert.equal(
    normalizeBuiltInCapabilityList([...valid, { id: "subagents", enabled: false }]),
    null,
  );
  assert.equal(
    normalizeBuiltInCapabilityList([
      { id: "subagents", enabled: true },
      { id: "todo", enabled: true },
      { id: "ask_user_question", enabled: true },
      { id: "plugins", enabled: true },
    ]),
    null,
  );
  assert.equal(
    normalizeBuiltInCapabilityList([
      { id: "subagents", enabled: true },
      { id: "todo", enabled: true },
      { id: "ask_user_question", enabled: true },
      { id: "side_chat", enabled: true },
      { id: "side_chat", enabled: false },
    ].slice(0, 4).concat([{ id: "subagents", enabled: false }])),
    null,
  );
  assert.equal(
    normalizeBuiltInCapabilityList([
      { id: "subagents", enabled: true },
      { id: "todo", enabled: true },
      { id: "ask_user_question", enabled: true },
      { id: "subagents", enabled: false },
    ]),
    null,
  );
  assert.equal(
    normalizeBuiltInCapabilityList([
      { id: "subagents", enabled: true, extra: true },
      { id: "todo", enabled: true },
      { id: "ask_user_question", enabled: true },
      { id: "side_chat", enabled: true },
    ]),
    null,
  );
  assert.equal(
    normalizeBuiltInCapabilityList([
      { id: "subagents", enabled: "yes" },
      { id: "todo", enabled: true },
      { id: "ask_user_question", enabled: true },
      { id: "side_chat", enabled: true },
    ]),
    null,
  );
});
