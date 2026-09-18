import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeStateChangedContext as CanonicalContext } from "@fffattiger/pix-runtime-core";
import {
  RuntimeStateChangedContextSchema,
  RuntimeStateChangedEventDataSchema,
  type RuntimeStateChangedContext as WireContext,
} from "@fffattiger/pix-protocol";

// ---------------------------------------------------------------------------
// Context-usage consistency — cross-package parity for the atomic
// `runtime_state_changed` context payload. The canonical shape lives in
// Runtime Core (product semantics); the wire mirror lives in Protocol (zod).
// The two must never drift: identical fields, identical null semantics, and
// the wire gate rejects anything the canonical type cannot express.
// ---------------------------------------------------------------------------

/** Field-level compile-time parity (canonical field ⊆ wire field). */
const canonicalModelToWire = (value: CanonicalContext["model"]): WireContext["model"] => value;
const canonicalUsageToWire = (value: CanonicalContext["contextUsage"]): WireContext["contextUsage"] => value;

const PROBES: readonly CanonicalContext[] = [
  // Coherent live projection: model + committed leaf + fresh usage together.
  {
    model: { provider: "deepseek-official", id: "deepseek-v4-flash" },
    leafId: "entry-7",
    contextUsage: { percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711 },
  },
  // Usage without optional window/tokens detail.
  {
    model: { provider: "acme-gpt", id: "gpt-6-astra" },
    leafId: "leaf-1",
    contextUsage: { percent: 79.6358 },
  },
  // Honest unknown everywhere: clears stale projections.
  { model: null, leafId: null, contextUsage: null },
  // Model known, usage unknown (post-compaction / missing window).
  { model: { provider: "p", id: "m" }, leafId: "entry-2", contextUsage: null },
];

test("runtime_state_changed context payload wire mirror is semantically identical to runtime-core", () => {
  for (const canonical of PROBES) {
    const wire = {
      model: canonicalModelToWire(canonical.model),
      leafId: canonical.leafId,
      contextUsage: canonicalUsageToWire(canonical.contextUsage),
    };
    assert.deepEqual(RuntimeStateChangedContextSchema.parse(wire), canonical);
  }
});

test("the full event frame accepts signal-only AND payload forms; malformed payloads fail closed", () => {
  assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
    type: "runtime_state_changed",
    sessionId: "s-1",
  }).success, true);
  assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
    type: "runtime_state_changed",
    sessionId: "s-1",
    context: { model: null, leafId: null, contextUsage: null },
  }).success, true);
  // Missing required payload field (Protocol v3 required-field floor note):
  // strict schemas reject today instead of permissively defaulting.
  assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
    type: "runtime_state_changed",
    sessionId: "s-1",
    context: { model: null, leafId: null },
  }).success, false);
  // Unknown extra payload fields never cross the wire gate.
  assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
    type: "runtime_state_changed",
    sessionId: "s-1",
    context: { model: null, leafId: null, contextUsage: null, extra: 1 },
  }).success, false);
  // Malformed nested usage fails closed.
  assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
    type: "runtime_state_changed",
    sessionId: "s-1",
    context: { model: null, leafId: "x", contextUsage: { percent: "26" } },
  }).success, false);
});
