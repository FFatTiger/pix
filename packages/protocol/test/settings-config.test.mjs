import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SETTINGS_CONFIG_MAX_BYTES,
  SettingsConfigMutationSchema,
  SettingsConfigResponseSchema,
} from "../dist/index.js";

const revision = "a".repeat(64);

test("settings config schemas accept exact shapes and reject extras/undersized", () => {
  const response = SettingsConfigResponseSchema.parse({ revision, content: '{ "a": 1 }' });
  assert.equal(response.revision, revision);

  assert.equal(SettingsConfigResponseSchema.safeParse({ revision, content: "", extra: 1 }).success, false);
  assert.equal(SettingsConfigResponseSchema.safeParse({ revision: "xyz", content: "{}" }).success, false);

  const mutation = SettingsConfigMutationSchema.parse({ expectedRevision: revision, content: "{ // c\n}" });
  assert.equal(mutation.content.includes("// c"), true);

  assert.equal(SettingsConfigMutationSchema.safeParse({ expectedRevision: revision, content: "" }).success, false);
  assert.equal(
    SettingsConfigMutationSchema.safeParse({ expectedRevision: revision, content: "x".repeat(SETTINGS_CONFIG_MAX_BYTES + 1) }).success,
    false,
  );
  assert.equal(
    SettingsConfigMutationSchema.safeParse({ expectedRevision: revision, content: "{}", source: "ui" }).success,
    false,
  );
});
