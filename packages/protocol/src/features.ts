/**
 * Negotiated client feature tokens (Protocol v2 additive).
 *
 * Features are OPTIONAL capabilities the CLIENT advertises in the handshake
 * request `features` array. The Host echoes the accepted subset in the
 * handshake response `acceptedFeatures` ONLY when the backing seam is wired
 * and verified — a feature that is not accepted is never negotiated, so old
 * strict v2 clients never receive frames their schema does not know.
 *
 * These are NOT Host capability tokens (`HostCapabilitySchema`) and NOT runtime
 * capability tokens (`RuntimeCapabilitySet`): they are wire-feature
 * negotiation, evaluated per handshake.
 */

/** Global live/running watch: revisioned running_state projection. */
export const RUNTIME_RUNNING_WATCH_FEATURE = "runtime.running-watch.v1" as const;
export type RuntimeRunningWatchFeature = typeof RUNTIME_RUNNING_WATCH_FEATURE;

/**
 * Independent bounded read RPC (Phase 2B): dedicated `read`/`read_result`
 * browser envelopes + `runtime.read` sessiond RPC + `worker.read` IPC,
 * correlated by `(sessionId, epoch, requestId)` — never the mutation commandId
 * ledger. Peers that negotiate this token use the independent read envelopes;
 * old v2 peers without it keep the explicit finite legacy command-envelope
 * shim (see docs/lifecycle-repair-plan.md Phase 2B; removal condition: Protocol
 * v3 minimum plus the Phase 7 build contract).
 */
export const RUNTIME_READ_RPC_FEATURE = "runtime.read-rpc.v1" as const;
export type RuntimeReadRpcFeature = typeof RUNTIME_READ_RPC_FEATURE;

/**
 * Atomic prompt admission (Phase 3): dedicated submit/result/status envelopes,
 * sessiond-owned activation/settings/prompt ordering, and Worker quick
 * admission. The Protocol-v2 legacy settings+prompt shim is removed only once
 * Protocol v3 is minimum AND Phase 7 rejects reusable daemon/Worker builds
 * without this feature.
 */
export const RUNTIME_SUBMIT_TURN_FEATURE = "runtime.submit-turn.v1" as const;
export type RuntimeSubmitTurnFeature = typeof RUNTIME_SUBMIT_TURN_FEATURE;

/**
 * Safe idle whole-epoch rollover (Phase 5B): capacity boundaries rotate the
 * ENTIRE epoch instead of evicting per-ID entries, and the triggering request
 * is proven not-admitted and returns a typed `epoch_changed` failure after a
 * successful rotation. The Client advertises this token so the Host (and then
 * sessiond) require an exact `epoch` on command/interrupt frames; sessiond
 * never advertises the capability until the rollover seam is wired. Removal
 * condition: Protocol v3 minimum plus the Phase 7 build contract (same finite
 * shim window as the other additive v2 features).
 */
export const RUNTIME_EPOCH_ROLLOVER_FEATURE = "runtime.epoch-rollover.v1" as const;
export type RuntimeEpochRolloverFeature = typeof RUNTIME_EPOCH_ROLLOVER_FEATURE;

/** Browser-to-Host attach mode that observes only an already-active runtime. */
export const RUNTIME_OBSERVE_EXISTING_FEATURE = "runtime.observe-existing.v1" as const;
export type RuntimeObserveExistingFeature = typeof RUNTIME_OBSERVE_EXISTING_FEATURE;

/** Browser-to-Host explicit activation request; never implies prompt dispatch. */
export const RUNTIME_EXPLICIT_ACTIVATE_FEATURE = "runtime.explicit-activate.v1" as const;
export type RuntimeExplicitActivateFeature = typeof RUNTIME_EXPLICIT_ACTIVATE_FEATURE;
