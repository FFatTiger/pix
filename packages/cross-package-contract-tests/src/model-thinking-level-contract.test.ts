/**
 * Cross-package thinking-level contract — the runtime-core canonical
 * `MODEL_THINKING_LEVELS` vocabulary vs the Protocol wire projection of a
 * model's per-level thinking mapping (models.json `thinkingLevelMap`).
 *
 * Protocol cannot import runtime-core, so the two sides declare the same
 * vocabulary independently; this test proves they stay in step and that every
 * canonical mapping shape survives the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_LEVELS, type ModelThinkingLevelMap } from "@fffattiger/pix-runtime-core";
import { ModelThinkingLevelMapSchema, ThinkingLevelSchema } from "@fffattiger/pix-protocol";

test("the protocol thinking-level vocabulary matches the runtime-core canonical list", () => {
  assert.deepEqual([...ThinkingLevelSchema.options], [...THINKING_LEVELS]);
});

test("the protocol mapping schema round-trips every canonical mapping shape", () => {
  const maps: ModelThinkingLevelMap[] = [
    {},
    { xhigh: "xhigh" },
    { max: "max" },
    { xhigh: "high", off: null },
    {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  ];
  for (const map of maps) {
    assert.deepEqual(ModelThinkingLevelMapSchema.parse(map), map);
  }
  // A level outside the canonical vocabulary fails closed.
  assert.equal(ModelThinkingLevelMapSchema.safeParse({ ultra: "ultra" }).success, false);
});
