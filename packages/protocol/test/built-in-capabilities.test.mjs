import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BUILT_IN_CAPABILITY_IDS,
  BuiltInCapabilityConfigMutationSchema,
  BuiltInCapabilityConfigResponseSchema,
  BuiltInCapabilityIdSchema,
} from "../dist/index.js";

const revision = "a".repeat(64);
const capabilities = [
  { id: "subagents", enabled: true },
  { id: "todo", enabled: false },
  { id: "ask_user_question", enabled: true },
  { id: "side_chat", enabled: false },
];

test("built-in capability schemas accept exact shapes and reject extras/unknown IDs", () => {
  assert.deepEqual([...BUILT_IN_CAPABILITY_IDS], [
    "subagents",
    "todo",
    "ask_user_question",
    "side_chat",
  ]);
  for (const id of BUILT_IN_CAPABILITY_IDS) {
    assert.equal(BuiltInCapabilityIdSchema.parse(id), id);
  }
  assert.equal(BuiltInCapabilityIdSchema.safeParse("plugins").success, false);
  assert.equal(BuiltInCapabilityIdSchema.safeParse("@mariozechner/pi-coding-agent").success, false);

  const response = BuiltInCapabilityConfigResponseSchema.parse({ revision, capabilities });
  assert.deepEqual(response.capabilities, capabilities);

  assert.equal(
    BuiltInCapabilityConfigResponseSchema.safeParse({ revision, capabilities, extra: 1 }).success,
    false,
  );
  assert.equal(
    BuiltInCapabilityConfigResponseSchema.safeParse({ revision: "xyz", capabilities }).success,
    false,
  );

  const mutation = BuiltInCapabilityConfigMutationSchema.parse({
    expectedRevision: revision,
    capabilities: [
      { id: "side_chat", enabled: true },
      { id: "todo", enabled: true },
      { id: "subagents", enabled: false },
      { id: "ask_user_question", enabled: false },
    ],
  });
  assert.equal(mutation.capabilities.length, 4);

  assert.equal(
    BuiltInCapabilityConfigMutationSchema.safeParse({ expectedRevision: revision, capabilities: capabilities.slice(0, 3) }).success,
    false,
  );
  assert.equal(
    BuiltInCapabilityConfigMutationSchema.safeParse({
      expectedRevision: revision,
      capabilities: [...capabilities.slice(0, 3), { id: "plugins", enabled: true }],
    }).success,
    false,
  );
  assert.equal(
    BuiltInCapabilityConfigMutationSchema.safeParse({
      expectedRevision: revision,
      capabilities: [
        { id: "subagents", enabled: true },
        { id: "todo", enabled: true },
        { id: "ask_user_question", enabled: true },
        { id: "subagents", enabled: false },
      ],
    }).success,
    false,
  );
  assert.equal(
    BuiltInCapabilityConfigMutationSchema.safeParse({
      expectedRevision: revision,
      capabilities: [{ ...capabilities[0], extra: true }, ...capabilities.slice(1)],
    }).success,
    false,
  );
});
