import assert from "node:assert/strict";
import { test } from "node:test";
import {
  READ_ONLY_RUNTIME_COMMAND_TYPES as CANONICAL_READ_ONLY_COMMAND_TYPES,
  type SessionContext as CanonicalSessionContext,
  type SessionContextSettings as CanonicalSessionContextSettings,
} from "@fffattiger/pix-runtime-core";
import {
  SessionContextSchema,
  READ_ONLY_RUNTIME_COMMAND_TYPES as WIRE_READ_ONLY_COMMAND_TYPES,
  SessionContextSettingsSchema,
  type SessionContext as WireSessionContext,
  type SessionContextSettings as WireSessionContextSettings,
} from "@fffattiger/pix-protocol";

/** Compile-time parity in both directions; runtime probes below pin validation. */
const canonicalToWire = (value: CanonicalSessionContextSettings): WireSessionContextSettings => value;
const wireToCanonical = (value: WireSessionContextSettings): CanonicalSessionContextSettings => value;

const SETTINGS_PROBES: readonly CanonicalSessionContextSettings[] = [
  { model: null, thinkingLevel: "off" },
  { model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "minimal" },
  { model: { provider: "anthropic", modelId: "claude-opus-4" }, thinkingLevel: "low" },
  { model: { provider: "google", modelId: "gemini" }, thinkingLevel: "medium" },
  { model: { provider: "openrouter", modelId: "vendor/model" }, thinkingLevel: "high" },
  { model: { provider: "local", modelId: "reasoner" }, thinkingLevel: "xhigh" },
  { model: { provider: "local", modelId: "max-reasoner" }, thinkingLevel: "max" },
];

test("read-only command vocabulary is semantically identical to runtime-core", () => {
  assert.deepEqual(
    [...WIRE_READ_ONLY_COMMAND_TYPES],
    [...CANONICAL_READ_ONLY_COMMAND_TYPES],
    "protocol read-only command projection must match runtime-core",
  );
});

test("SessionContext settings wire projection is semantically identical to runtime-core", () => {
  for (const canonical of SETTINGS_PROBES) {
    const wire = canonicalToWire(canonical);
    assert.deepEqual(SessionContextSettingsSchema.parse(wire), canonical);
    assert.deepEqual(wireToCanonical(wire), canonical);
  }

  assert.equal(SessionContextSettingsSchema.safeParse({ model: null, thinkingLevel: "auto" }).success, false);
  assert.equal(SessionContextSettingsSchema.safeParse({ model: { provider: "", modelId: "x" }, thinkingLevel: "off" }).success, false);
  assert.equal(SessionContextSettingsSchema.safeParse({ model: { provider: "p", modelId: "" }, thinkingLevel: "off" }).success, false);
  assert.equal(SessionContextSettingsSchema.safeParse({ model: null, thinkingLevel: "off", sdkModel: {} }).success, false);
});

test("Protocol v2 SessionContext compatibility absence stays unknown, while current settings parse strictly", () => {
  const legacyV2 = {
    sessionId: "s1",
    entries: [],
    pageInfo: { hasMore: false },
  } satisfies WireSessionContext;
  assert.equal(SessionContextSchema.parse(legacyV2).settings, undefined);

  const current: CanonicalSessionContext = {
    sessionId: "s1",
    entries: [],
    settings: { model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high" },
    pageInfo: { hasMore: false },
  };
  const parsed = SessionContextSchema.parse(current);
  assert.deepEqual(parsed.settings, current.settings);
});

test("SessionContext contextTokens wire projection is semantically identical to runtime-core (context-usage consistency)", () => {
  // Field-level compile-time parity in both directions for the additive field.
  const canonicalToWire = (value: CanonicalSessionContext["contextTokens"]): WireSessionContext["contextTokens"] => value;

  const probes: readonly CanonicalSessionContext[] = [
    // Known numerator (latest persisted branch estimate).
    { sessionId: "s1", entries: [], settings: { model: { provider: "deepseek-official", modelId: "deepseek-v4-flash" }, thinkingLevel: "high" }, contextTokens: 263_711, pageInfo: { hasMore: false } },
    // Known-empty branch.
    { sessionId: "s1", entries: [], contextTokens: 0, pageInfo: { hasMore: false } },
    // Honest unknown (post-compaction until a valid assistant usage).
    { sessionId: "s1", entries: [], contextTokens: null, pageInfo: { hasMore: false } },
  ];
  for (const canonical of probes) {
    const wire = canonicalToWire(canonical.contextTokens);
    assert.deepEqual(SessionContextSchema.parse({ sessionId: "s1", entries: [], contextTokens: wire, pageInfo: { hasMore: false } }).contextTokens, canonical.contextTokens);
  }

  // Older same-major producer (omitted) stays unknown, never guessed.
  const legacyV2 = SessionContextSchema.parse({ sessionId: "s1", entries: [], pageInfo: { hasMore: false } });
  assert.equal(legacyV2.contextTokens, undefined);
  // Malformed numerators fail closed on the wire.
  assert.equal(SessionContextSchema.safeParse({ sessionId: "s1", entries: [], contextTokens: -1, pageInfo: { hasMore: false } }).success, false);
  assert.equal(SessionContextSchema.safeParse({ sessionId: "s1", entries: [], contextTokens: 1.5, pageInfo: { hasMore: false } }).success, false);
  assert.equal(SessionContextSchema.safeParse({ sessionId: "s1", entries: [], contextTokens: "263711", pageInfo: { hasMore: false } }).success, false);
});
