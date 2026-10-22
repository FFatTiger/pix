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

/**
 * Native questionnaire extension UI (typed request/response, no RPC walker).
 * Advertised by a compatible Client; accepted only by a backend whose wire
 * schemas and Host fence understand `method: "questionnaire"`. Old strict v2
 * clients that omit this token never receive questionnaire-bearing frames.
 */
export const RUNTIME_QUESTIONNAIRE_FEATURE = "runtime.questionnaire.v1" as const;
export type RuntimeQuestionnaireFeature = typeof RUNTIME_QUESTIONNAIRE_FEATURE;

/**
 * Transport-level liveness heartbeat (idle-send recovery): dedicated `ping`/
 * `pong` WS envelopes answered by the Host itself (no sessiond/Worker seam).
 * A negotiated Client keeps the connection observable: it heartbeats while
 * ready, probes liveness after the page was hidden past a threshold, and
 * refuses to submit through a connection whose freshness it cannot prove
 * (waiting for a reconnect instead of writing into a half-open socket).
 * Old strict v2 peers that never acknowledge this token keep the exact
 * pre-liveness behavior (no ping is ever sent to them).
 */
export const RUNTIME_LIVENESS_FEATURE = "runtime.liveness.v1" as const;
export type RuntimeLivenessFeature = typeof RUNTIME_LIVENESS_FEATURE;

/**
 * Assistant presence projection (always-on Pixie residency). The sessiond
 * running watch extends its revisioned state with the assistant-residency
 * projection (`assistant` on `RuntimeRunningState`), and the Host re-exposes
 * it to browsers as dedicated `assistant_state` frames. Advertised by a
 * compatible Client; accepted only while the sessiond hello carries the same
 * token, so old strict v2 clients never receive frames their schema does not
 * know and clients of a residency-less sessiond degrade to no presence (the
 * sidebar dot simply stays hidden).
 */
export const RUNTIME_ASSISTANT_PRESENCE_FEATURE = "runtime.assistant-presence.v1" as const;
export type RuntimeAssistantPresenceFeature = typeof RUNTIME_ASSISTANT_PRESENCE_FEATURE;

/**
 * Page-attention reporting (per-device Web Push suppression). A negotiated
 * Client sends the tiny fire-and-forget `visibility` frame on connect and on
 * every visibilitychange/focus/blur, carrying `attended` (visible AND
 * focused) and the optional SHA-256 hex of this browser's push endpoint; the
 * Host answers it itself (no sessiond/Worker seam) and keeps only an
 * in-memory per-connection view. A connection that never reports — or dies —
 * is NOT attended, so a disconnected client can never suppress
 * notifications, and only the endpoint(s) on an attended device are skipped.
 * Old strict v2 peers that omit this token keep the exact pre-visibility
 * behavior (the frame is rejected without negotiation).
 */
export const RUNTIME_VISIBILITY_FEATURE = "runtime.visibility.v1" as const;
export type RuntimeVisibilityFeature = typeof RUNTIME_VISIBILITY_FEATURE;
