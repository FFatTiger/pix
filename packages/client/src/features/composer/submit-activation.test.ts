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
    negotiatedSubmitTurn: true,
    stagedModel: null,
    live: false,
    modelSetSupported: false,
    authorityModel: null,
    ...overrides,
  };
}

describe("captureSubmitModel — negotiated runtime.submit-turn.v1", () => {
  it("carries the displayed model from every display source (staged / detached history / home default / live baseline)", () => {
    // Detached history default.
    expect(captureSubmitModel(input({ displayedModel: MODEL_A }))).toEqual(MODEL_A);
    // Home catalog default.
    expect(captureSubmitModel(input({ displayedModel: MODEL_B }))).toEqual(MODEL_B);
    // Known live authority baseline with model.set available.
    expect(captureSubmitModel(input({ live: true, modelSetSupported: true, authorityModel: MODEL_A }))).toEqual(MODEL_A);
    // Explicit staged choice while live.
    expect(captureSubmitModel(input({ live: true, modelSetSupported: true, stagedModel: MODEL_B, authorityModel: MODEL_A, displayedModel: MODEL_B }))).toEqual(MODEL_B);
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
    expect(captureSubmitModel(input({ live: true, modelSetSupported: false, authorityModel: MODEL_B, displayedModel: MODEL_A }))).toEqual(MODEL_A);
  });

  it("a live runtime without model.set and UNKNOWN authority carries the displayed model", () => {
    expect(captureSubmitModel(input({ live: true, modelSetSupported: false, authorityModel: null }))).toEqual(MODEL_A);
  });
});

describe("captureSubmitModel — finite legacy v2 shim (no negotiated submit-turn)", () => {
  it("keeps staged-only semantics: the legacy set_model→prompt chain never carries a display baseline", () => {
    expect(captureSubmitModel(input({ negotiatedSubmitTurn: false, stagedModel: null, displayedModel: MODEL_A }))).toBeNull();
    expect(captureSubmitModel(input({ negotiatedSubmitTurn: false, stagedModel: MODEL_B, displayedModel: MODEL_A }))).toEqual(MODEL_B);
  });
});
