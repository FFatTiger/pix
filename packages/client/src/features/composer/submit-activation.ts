/**
 * Pure send-time activation capture for the Composer submit transaction.
 *
 * Invariant: the model displayed IMMEDIATELY BEFORE Send is the model the
 * turn must run with. It is carried on the SAME atomic
 * `submit_turn.activationOverrides.model` — never a side-channel `set_model`
 * followed by the prompt — and its sources are exactly the display's sources:
 * an explicit staged choice, the detached branch-resolved history default, the
 * home catalog default, or the known live authority baseline.
 *
 * Capability rules (fail closed, no arbitrary fallback):
 *  - a MISSING known model is never replaced by a catalog guess — nothing is
 *    carried (`null`);
 *  - a live runtime without `runtime.model.set` whose known immutable live
 *    model already IS the displayed model needs no redundant unsupported
 *    mutation — nothing is carried (the runtime keeps exactly that model);
 *  - an explicit change on a runtime that cannot apply it is still carried:
 *    the runtime rejects the unsupported mutation and the send fails closed
 *    (draft restored, staged intent preserved) instead of silently running a
 *    model the user never saw;
 *  - the finite legacy Protocol-v2 shim (no negotiated
 *    `runtime.submit-turn.v1`) keeps its documented staged-only semantics —
 *    only an explicit staged choice rides the legacy set_model→prompt chain.
 */
import type { StagedModelRef } from "./session-staging-store.js";

export interface SubmitModelCaptureInput {
  /** The model the composer displays at the instant of the send. */
  readonly displayedModel: StagedModelRef | null;
  /** True when `runtime.submit-turn.v1` was negotiated on this connection. */
  readonly negotiatedSubmitTurn: boolean;
  /** The explicit staged choice (legacy shim carries exactly this). */
  readonly stagedModel: StagedModelRef | null;
  /** True when the selected session is the attached live runtime. */
  readonly live: boolean;
  /** Whether the live runtime advertises `runtime.model.set`. */
  readonly modelSetSupported: boolean;
  /** The live runtime's known model (`state.model`), null while unknown. */
  readonly authorityModel: StagedModelRef | null;
}

/**
 * Resolve the model to carry on the atomic submit. Pure: same input → same
 * output, no store/session access (deterministically testable).
 */
export function captureSubmitModel(input: SubmitModelCaptureInput): StagedModelRef | null {
  if (!input.negotiatedSubmitTurn) return input.stagedModel;
  const displayed = input.displayedModel;
  if (displayed === null) return null;
  if (
    input.live
    && !input.modelSetSupported
    && input.authorityModel !== null
    && displayed.provider === input.authorityModel.provider
    && displayed.modelId === input.authorityModel.modelId
  ) {
    // The known immutable live model already equals the displayed model;
    // requesting the same value through an unsupported mutation is redundant.
    return null;
  }
  return displayed;
}
