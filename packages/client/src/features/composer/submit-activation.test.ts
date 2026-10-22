/**
 * Send-time activation capture (submit_turn.activationOverrides.model) — pure
 * negotiation/capability rules. The displayed model is carried atomically with
 * the submit; missing known models never fall back arbitrarily; a known
 * immutable live model needs no redundant unsupported mutation; the finite
 * legacy v2 shim keeps its staged-only semantics.
 */
import { describe, expect, it } from "vitest";
import { captureSubmitModel } from "./submit-activation";

const MODEL_A = { provider: "openai", modelId: "gpt-4o" };
const MODEL_B = { provider: "anthropic", modelId: "claude" };

function input(overrides: Partial<Parameters<typeof captureSubmitModel>[0]> = {}) {
  return {
    displayedModel: MODEL_A,
    live: false,
    modelSetSupported: false,
    authorityModel: null,
    ...overrides,
  };
}

describe("captureSubmitModel", () => {
  it("carries an unchanged attached model when model.set is available to fence external updates", () => {
    expect(captureSubmitModel(input({ live: true, modelSetSupported: true, authorityModel: MODEL_A }))).toEqual(MODEL_A);
  });

  it("keeps detached history and new-session defaults for activation", () => {
    expect(captureSubmitModel(input({ displayedModel: MODEL_A }))).toEqual(MODEL_A);
    expect(captureSubmitModel(input({ displayedModel: MODEL_B }))).toEqual(MODEL_B);
  });

  it("carries an explicit change on a live session", () => {
    expect(captureSubmitModel(input({ live: true, authorityModel: MODEL_A, displayedModel: MODEL_B }))).toEqual(MODEL_B);
  });

  it("a MISSING known model is never replaced by an arbitrary fallback", () => {
    expect(captureSubmitModel(input({ displayedModel: null }))).toBeNull();
  });

  it("a live immutable model equal to the displayed model needs no redundant unsupported mutation", () => {
    expect(captureSubmitModel(input({ live: true, modelSetSupported: false, authorityModel: MODEL_A }))).toBeNull();
  });

  it("an explicit change on a live runtime without model.set is still carried (fail closed at the runtime)", () => {
    // The displayed choice differs from the immutable live model: carrying it
    // lets the runtime reject the unsupported mutation honestly instead of
    // silently running a model the user never saw.
    expect(captureSubmitModel(input({ live: true, authorityModel: MODEL_B, displayedModel: MODEL_A }))).toEqual(MODEL_A);
  });

  it("a live runtime without model.set and UNKNOWN authority carries the displayed model", () => {
    expect(captureSubmitModel(input({ live: true, authorityModel: null }))).toEqual(MODEL_A);
  });
});

