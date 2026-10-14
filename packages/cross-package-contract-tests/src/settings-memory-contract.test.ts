import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEMORY_PROVIDERS,
  effectiveMemoryProvider,
  normalizeMemoryProviderValue,
  type MemoryProviderMutation,
  type MemorySettingsSnapshot,
} from "@fffattiger/pix-runtime-core";
import {
  MEMORY_PROVIDERS as WIRE_MEMORY_PROVIDERS,
  MemoryProviderMutationSchema,
  MemorySettingsResponseSchema,
  type MemoryProviderMutation as WireMutation,
  type MemorySettingsResponse,
} from "@fffattiger/pix-protocol/memory-settings";

const revision = "a".repeat(64);
const loreNotConfigured = { configured: false, baseUrl: null, source: "none", tokenConfigured: false } as const;
const loreConfigured = {
  configured: true,
  baseUrl: "https://api.loremem.com",
  source: "config",
  tokenConfigured: true,
} as const;

test("memory provider vocabulary is identical in runtime-core and protocol", () => {
  assert.deepEqual([...MEMORY_PROVIDERS], [...WIRE_MEMORY_PROVIDERS]);
  assert.deepEqual([...MEMORY_PROVIDERS], ["local", "lore", "off"]);
});

test("memory snapshot and mutation envelopes round-trip through the wire schema", () => {
  const snapshot: MemorySettingsSnapshot = {
    revision,
    provider: "lore",
    providerExplicit: true,
    lore: loreConfigured,
  };
  const mutation: MemoryProviderMutation = { expectedRevision: revision, provider: "off" };
  const response: MemorySettingsResponse = MemorySettingsResponseSchema.parse(snapshot);
  const wireMutation: WireMutation = MemoryProviderMutationSchema.parse(mutation);
  assert.deepEqual(response, snapshot);
  assert.deepEqual(wireMutation, mutation);

  // The default migration projection round-trips too.
  const migrated: MemorySettingsSnapshot = {
    revision,
    provider: effectiveMemoryProvider(undefined, true),
    providerExplicit: false,
    lore: loreNotConfigured,
  };
  assert.equal(migrated.provider, "lore");
  assert.deepEqual(MemorySettingsResponseSchema.parse(migrated), migrated);
});

test("wire rejects unknown providers and extra fields; canonical rejects the same values", () => {
  for (const bad of ["both", "LOCAL", 1, null, {}]) {
    const canonical = normalizeMemoryProviderValue(bad);
    assert.equal(canonical, null, JSON.stringify(bad));
    const provider = MemoryProviderMutationSchema.safeParse({ expectedRevision: revision, provider: bad });
    assert.equal(provider.success, false, JSON.stringify(bad));
  }
  // Extra fields never pass the strict wire objects.
  assert.equal(
    MemorySettingsResponseSchema.safeParse({ revision, provider: "local", providerExplicit: false, lore: loreNotConfigured, extra: 1 }).success,
    false,
  );
  assert.equal(
    MemoryProviderMutationSchema.safeParse({ expectedRevision: revision, provider: "local", providerExplicit: true }).success,
    false,
  );
});

test("the response never carries a token field", () => {
  const parsed = MemorySettingsResponseSchema.safeParse({
    revision,
    provider: "lore",
    providerExplicit: true,
    lore: { ...loreConfigured, apiToken: "lm_secret" },
  });
  assert.equal(parsed.success, false, "the lore projection must be strict: no apiToken can ride the wire");
});
