/**
 * SessionController — exact-session runtime state and business logic.
 *
 * Binds once to the stable {@link RuntimeConnection}; it does not own or handle
 * the low-level socket. It retains controller/business state only:
 *  - the projection {@link RuntimeSnapshot} (reduced through the SHARED Protocol
 *    `reduceRuntimeEventData`, identical semantics to the sessiond authority);
 *  - the resume cursor (sessionId / epoch / lastEventId) and per-generation
 *    attach gating ("no event applies before this generation's first snapshot");
 *  - open/attach/detach/stop + prompt/abort/getSnapshot logical operations,
 *    while RuntimeConnection owns envelope attempts and strict frame routing;
 *  - the reactive {@link ControllerView} exposed to React via useSyncExternalStore
 *    (realtime state NEVER goes through TanStack Query).
 *
 * Pending-state ownership invariants (verifier fixes):
 *  - The logical attach is a SINGLE stable deferred that survives reconnect
 *    (HIGH-2): resume re-uses the same deferred, so create/open promises always
 *    settle. An attach FAILURE clears awaiting + resets to `ready` so a second
 *    open proceeds immediately (HIGH-1).
 *  - D2-P4 dual-slot: steer/follow_up run in {@link QueuedTurnPending}, an
 *    INDEPENDENT slot from the ordinary prompt slot, so a long-running prompt
 *    never blocks steering/following-up. At most ONE queued turn in flight
 *    (second → session_busy); cleared on send-failure / stop / dispose /
 *    epoch_changed, retained across observation release/lease transfer, and
 *    resent with the SAME commandId only after a later exact lease/resync
 *    on snapshot/gap. clear_queue uses typed interrupt admission (never
 *    coalesces with abort; different interrupt type → session_busy).
 *  - Every pending lane is SESSION-BOUND and independently retained across an
 *    observation detach/lease transfer. Exact correlated results/status may
 *    settle it while detached; transport-loss retry waits until this exact
 *    controller reacquires the lease. resyncAfterAttach re-sends a pending lane
 *    ONLY when its own sessionId
 *    matches the newly attached session AND the prior epoch identity survived
 *    (captured BEFORE applySnapshot overwrites it) — fail closed on any
 *    mismatch, never resend across sessions.
 *  - D2-P8 extension-UI slot: the reply to a pending extension request runs in
 *    {@link ExtensionUiPending}, a THIRD independent single-in-flight slot. The
 *    ordinary prompt that triggered the UI stays `pendingCommand`, so
 *    `sendCommand` would return `session_busy` — the dedicated slot is what lets
 *    a reply travel while the prompt is still pending. At most ONE extension
 *    reply in flight per controller (second → session_busy); cleared on send-failure /
 *    stop / dispose / epoch_changed / capability
 *    loss, resent with the SAME commandId on same-epoch snapshot/gap.
 *  - One-shot envelope requests (getSnapshot/detach/stop) are REJECTED on
 *    transport loss so they never leak across a generation (MEDIUM-3); create /
 *    command / interrupt / attach are retried on reconnect.
 *  - stop() is honest: abort-first (HOL, bounded), then wait until sendable
 *    (bounded), send stop and AWAIT the ack (bounded); sessionStopped is set
 *    ONLY on confirmed ack, otherwise it rejects and keeps resume eligibility
 *    (MEDIUM-5). Concurrent stops merge into one promise/one frame (LOW). A
 *    pending prompt is always settled on stop (MEDIUM-4).
 *  - Concurrent create is rejected as busy (both promises settle) (MEDIUM-6).
 */
import {
  MAX_SIDE_CHAT_MESSAGE_CHARS,
  reduceRuntimeEventData,
  RUNTIME_EPOCH_ROLLOVER_FEATURE,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  RUNTIME_READ_RPC_FEATURE,
  RUNTIME_SUBMIT_TURN_FEATURE,
  type BrowserRuntimeAttachParams,
  type CorrelatedRuntimeCommandResult,
  type ExtensionUiInteractiveMethod,
  type ExtensionUiRequest,
  type QuestionnaireAnswer,
  type ImageAttachment,
  type ProtocolError,
  type RuntimeCapability,
  type RuntimeCapabilitySet,
  type RuntimeCommand,
  type RuntimeCommandOutcome,
  type RuntimeCreateResult,
  type RuntimeEventData,
  type RuntimeInterrupt,
  type RuntimeReadOutcome,
  type RuntimeReadType,
  type SessionEntry,
  type RuntimeSnapshot,
  type RuntimeState,
  type SessionStats,
  type SlashCommandInfo,
  type StreamingAgentMessage,
  type SubmitTurnAdmission,
  type SubmitTurnRequest,
  type ThinkingLevel,
  type ToolInfo,
  type WsClientMessage,
  type WsEventMessage,
  type WsHostMessage,
  type WsInterruptMessage,
  type WsResponseMessage,
  type WsSnapshotMessage,
  type WsTurnStatusMessage,
} from "@fffattiger/pix-protocol";
import type { NegotiatedHost } from "./socket.js";
import {
  RuntimeConnection,
  type RuntimeAttemptHandle,
  type RuntimeControllerBinding,
  type RuntimeControllerPort,
} from "./runtime-connection.js";
import { type ConnectionState } from "./lifecycle.js";
import { SendOutboxStore, type OutboxEntry } from "./send-outbox-store.js";
import {
  createDefaultIdFactory,
  decideCommandRetry,
  decideEvent,
  type EventApplyDecision,
  type IdFactory,
} from "./correlation.js";

/**
 * Phase 5A authority identity binding for one speculative user entry. Bound
 * the moment a negotiated submit-turn owns the bubble (`operationId`), then
 * refined from authoritative turn-status pushes (`turnId` / `userEntryId` /
 * `finalLeafId`). Once `userEntryId`/`finalLeafId` is known, the bubble is
 * removed from the committed view BY EXACT IDENTITY ONLY — never by text or
 * FIFO (a different operation's committed entry can never consume it).
 */
export interface OptimisticTurnIdentity {
  /** Client-minted at-most-once submit-turn operation id. */
  readonly operationId: string;
  /** Authority turn id once admitted (null before admission/duplicate). */
  readonly turnId: string | null;
  /** Authority entryId of the committed user entry (null until the authority reports it). */
  readonly userEntryId: string | null;
  /** Authority leaf after turn terminal (null until terminal). */
  readonly finalLeafId: string | null;
}

export interface OptimisticSessionEntry {
  readonly sessionId: string;
  readonly entry: SessionEntry;
  /** Authority leaf that preceded this prompt, when known. */
  readonly baseEntryId?: string | null | undefined;
  /** Phase 5A authority identity (negotiated submit-turn path only). */
  readonly identity?: OptimisticTurnIdentity | undefined;
}

/**
 * LC-02 presentation provenance: the Registry's presentation target key + the
 * monotonic revision captured at SEND/ACTION START. A late admission,
 * activation or attach result may request foreground observation ONLY while
 * this token still matches the Registry's current presentation (same key AND
 * same revision — a route change or an authorization change bumps the
 * revision). Callback arrival order is never treated as newer user intent.
 */
export interface PresentationProvenance {
  /** Presentation target key at capture time (null before any declaration). */
  readonly key: string | null;
  /** Monotonic presentation revision at capture time. */
  readonly revision: number;
}

/** Context the controller passes to the registry-owned observation seam. */
export interface ObservationRequestContext {
  /** `post-admission`: after an accepted atomic submit (existing-only). `activation`: the finite legacy v2 send chain. */
  readonly intent: "post-admission" | "activation";
  /** Provenance captured at send start; null when no capture hook is wired. */
  readonly provenance: PresentationProvenance | null;
}

/** Reactive view consumed by React via useSyncExternalStore (immutable per change). */
export interface ControllerView {
  readonly connection: ConnectionState;
  readonly host: NegotiatedHost | null;
  readonly attached: boolean;
  readonly sessionStopped: boolean;
  readonly sessionId: string | null;
  readonly epoch: string | null;
  readonly snapshot: RuntimeSnapshot | null;
  readonly streaming: boolean;
  readonly streamingPartial: StreamingAgentMessage | null;
  /**
   * True while a prompt transaction (activation + dispatch) is in flight. Lets
   * the UI treat an in-progress send — including the activation of a read-only
   * selected session — as BUSY (never idle), and never as a fresh idle input.
   */
  readonly promptPending: boolean;
  /** Session currently owned by the UI-first running transaction layer. */
  readonly optimisticRunningSessionId: string | null;
  /** Authoritative global busy-session ids from sessiond. */
  readonly runningSessionIds: readonly string[];
  /** All sessions with a LIVE worker process (busy or idle) from sessiond. */
  readonly liveSessionIds: readonly string[];
  /**
   * True only after this socket generation received an authoritative global
   * liveness baseline. Until then an empty set means "unknown", never "every
   * historical session is dead".
   */
  readonly liveSessionStateKnown: boolean;
  /**
   * Attach lifecycle generation (explicit refresh signal for UI reads like
   * runtime stats/tools). Increments on a FRESH attach (incl. session switch),
   * a rebase (gap / epoch_changed reconnect) and on detach/stop — NOT on
   * same-epoch replay — so command-driven refreshes key on it instead of on the
   * whole reactive view (which changes on every stream event).
   */
  readonly attachGeneration: number;
  /**
   * History-layer generation (Protocol v2). Increments on a fresh attach,
   * epoch/branch/count rebase, detach, session switch or stop. The transcript
   * hook keys its infinite query on this value so any anchor change
   * invalidates/refetches history.
   */
  readonly historyGeneration: number;
  /**
   * Anchor leaf for the live history layer: `snapshot.state.leafId` at the
   * last fresh attach/rebase. Null when the session has no committed entries.
   * The transcript hook pins this anchor (via the resolved page leaf) for all
   * older-page requests so later appends cannot shift pagination.
   */
  readonly historyAnchorLeafId: string | null;
  /**
   * Authoritative-settings eligibility for the admission→observation gap:
   * true while this exact controller's snapshot is the ACCEPTED admission's
   * authoritative snapshot (installed before the submit promise resolved) and
   * no history-layer transition (fresh attach / rebase / detach / stop /
   * session switch) or later presentation reselect has superseded it. The
   * Composer may surface the snapshot's model/thinking from this view even
   * before the observation attach completes; it must NOT treat it as attached
   * or running state. False for legacy (non-submit-turn) sends.
   */
  readonly hasAdmittedSnapshot: boolean;
  /**
   * The attachment was lost to the transport (not a detach, stop or switch)
   * and this controller is reconnecting to the same session at the same
   * cursor. The last admitted state stays presentable — transcript, model,
   * capabilities — and queued sends wait for the re-attach instead of failing.
   */
  readonly resuming: boolean;
  /**
   * This exact controller was installed from the Browser's identity-only create
   * path, whose initial thinking intent is necessarily automatic (explicit
   * concrete thinking travels later in submitTurn activation overrides).
   * Existing/cold-open controllers are false — `thinkingLevelPinned:false` is
   * not durable across adapter reopen and cannot by itself prove auto intent.
   */
  readonly createdWithAutoThinking: boolean;
  /**
   * Committed live SessionEntries accumulated since the last fresh attach/
   * rebase, keyed by persisted entryId: completed message_end events and
   * terminal bash completions. Persisted pages merge with these by entryId
   * (never by content/timestamp/array overlap).
   */
  readonly liveEntries: readonly SessionEntry[];
  /** Session-scoped speculative user entries, separate from authority state. */
  readonly optimisticEntries: readonly OptimisticSessionEntry[];
  readonly error: ProtocolError | null;
  readonly fatal: boolean;
  readonly canAgent: boolean;
  /**
   * True while a queued turn (steer / follow_up) is in flight in the D2-P4
   * dual-slot. The ordinary prompt slot ({@link pendingCommand}) is NOT
   * blocked by a running prompt, but only ONE queued turn may be in flight
   * at a time. Used by the Composer to disable Send/Steer during the
   * pending queued-turn window.
   */
  readonly queuedTurnPending: boolean;
  /**
   * True while an extension-UI reply is in flight in the D2-P8 dedicated
   * single-in-flight slot. The first operable extension request uses this to
   * show `aria-busy` and disable its controls until the reply settles (the
   * second reply is `session_busy` at the store regardless).
   */
  readonly extensionUiReplyPending: boolean;
  /**
   * Authoritative runtime capability set from the latest snapshot
   * ({@link RuntimeCapabilitySet}), or null before the first attach snapshot.
   * This is the runtime capability authority — never inferred from the Host
   * `agent` capability ({@link canAgent}).
   */
  readonly capabilities: RuntimeCapabilitySet | null;
  /**
   * Phase 3: true while the single atomic prompt turn is active (admission in
   * flight, accepted, or uncertain) — independent of the ordinary command slot.
   */
  readonly turnActive: boolean;
  /** Phase 3: current turn delivery state (null when no turn is active). */
  readonly turnDelivery: TurnDelivery | null;
  /** Phase 3: whether the atomic submit-turn seam was negotiated. */
  readonly submitTurnEnabled: boolean;
}

const INITIAL_VIEW: ControllerView = {
  connection: "idle",
  host: null,
  attached: false,
  sessionStopped: false,
  sessionId: null,
  epoch: null,
  snapshot: null,
  streaming: false,
  streamingPartial: null,
  promptPending: false,
  optimisticRunningSessionId: null,
  runningSessionIds: [],
  liveSessionIds: [],
  liveSessionStateKnown: false,
  attachGeneration: 0,
  historyGeneration: 0,
  historyAnchorLeafId: null,
  hasAdmittedSnapshot: false,
  resuming: false,
  createdWithAutoThinking: false,
  liveEntries: [],
  optimisticEntries: [],
  error: null,
  fatal: false,
  canAgent: false,
  queuedTurnPending: false,
  extensionUiReplyPending: false,
  capabilities: null,
  turnActive: false,
  turnDelivery: null,
  submitTurnEnabled: false,
};

/**
 * A `RuntimeCommand` with its transport `commandId` removed, preserving each
 * variant's own discriminant fields (distributive Omit — a plain
 * `Omit<RuntimeCommand, "commandId">` collapses the union). Used by the D2-P1
 * typed command helpers which mint the commandId internally.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RuntimeCommandWithoutId = DistributiveOmit<RuntimeCommand, "commandId">;
type SideChatCommandWithoutId = Extract<RuntimeCommandWithoutId, {
  type: "side_chat_start" | "side_chat_send" | "side_chat_reset" | "side_chat_set_model";
}>;

/** Interactive extension request methods — the only ones that produce a response. */
const INTERACTIVE_EXTENSION_METHODS: ReadonlySet<string> = new Set([
  "select", "confirm", "input", "editor", "questionnaire",
]);

function isInteractiveExtensionMethod(method: ExtensionUiRequest["method"]): method is ExtensionUiInteractiveMethod {
  return INTERACTIVE_EXTENSION_METHODS.has(method);
}

/**
 * Validate a reply against the request method (mirrors the Protocol response
 * union). Returns a fixed incompatibility description or null when compatible.
 * `cancelled` is valid for every interactive method; selected/confirmed/value
 * are method-bound. NEVER trims/coerces the reply payload.
 */
function extensionReplyIncompatibility(method: ExtensionUiInteractiveMethod, reply: ExtensionUiReply): string | null {
  switch (reply.responseKind) {
    case "cancelled": return null;
    case "selected": return method === "select" ? null : "selected reply is only valid for a select request";
    case "confirmed": return method === "confirm" ? null : "confirmed reply is only valid for a confirm request";
    case "value":
      return method === "input" || method === "editor"
        ? null
        : "value reply is only valid for an input/editor request";
    case "questionnaire":
      return method === "questionnaire" ? null : "questionnaire reply is only valid for a questionnaire request";
  }
}

export interface SessionControllerOptions {
  readonly id?: IdFactory;
  /** Registry-owned create authority, installed synchronously with binding. */
  readonly initialAuthority?: RuntimeCreateResult;
  /** Coordinator-owned observation transition after exact turn admission. */
  readonly requestObservation?: (sessionId: string, context: ObservationRequestContext) => Promise<void>;
  /** Registry presentation token captured at send/action start (LC-02). */
  readonly capturePresentationProvenance?: () => PresentationProvenance | null;
  /** One-shot create-start token for the FIRST submit of a newly created controller. */
  readonly consumeCreatedSubmitProvenance?: () => PresentationProvenance | null;
  /**
   * Registry-owned presentation-currency check (pure read) for the admitted
   * snapshot eligibility view: the accepted admission's provenance stays
   * current only while the SAME presentation (or its promoted create target)
   * is still declared — a later reselect must not surface the retained
   * snapshot during history browsing.
   */
  readonly isPresentationCurrent?: (provenance: PresentationProvenance) => boolean;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Bounded wait for the abort interrupt result before a forced stop (HOL rule). */
  readonly abortTimeoutMs?: number;
  /** Bounded wait for the socket to become sendable before issuing stop. */
  readonly stopSendTimeoutMs?: number;
  /** Bounded wait for the stop ack response. */
  readonly stopAckTimeoutMs?: number;
  /** Bounded wait for the detach ack response (single-flight detach envelope). */
  readonly detachAckTimeoutMs?: number;
  /** Bounded lifetime for a side-chat command admission. */
  readonly sideChatCommandTimeoutMs?: number;
  /**
   * Durable send outbox (the ONE owner of un-delivered sends). Injected by the
   * provider so tests can supply a deterministic store; absent means a fresh
   * in-memory outbox for this controller.
   */
  readonly outbox?: SendOutboxStore;
}

/** Per-attempt transport ownership for a logical attach. */
interface AttachAttempt {
  readonly handle: RuntimeAttemptHandle;
  readonly sessionId: string;
  readonly mode: "fresh" | "resume";
  /** existing = observation-only attachMode; legacy = v2 activating attach (finite shim). */
  readonly intent: AttachIntent;
}

export type AttachIntent = "legacy" | "existing";

/** Stable, logical attach deferred — survives reconnect handoff (HIGH-2). */
interface AttachDeferred {
  readonly sessionId: string;
  resolve(): void;
  reject(error: unknown): void;
  promise: Promise<void>;
}

interface CommandPending {
  readonly commandId: string;
  attempt: RuntimeAttemptHandle | null;
  wireSeen: boolean;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** Independent bounded command lane for the side-chat mutations. */
interface SideChatCommandPending {
  readonly commandId: string;
  attempt: RuntimeAttemptHandle | null;
  wireSeen: boolean;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  readonly type: "side_chat_start" | "side_chat_send" | "side_chat_reset" | "side_chat_set_model";
  readonly promise: Promise<unknown>;
  timer: unknown | null;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * A real prompt transaction (activation + dispatch). Single-flight: at most ONE
 * exists at a time, so concurrent submits are rejected deterministically and a
 * second submit can never touch the first's speculative state. `phase` is
 * explicit: `activating` (no prompt command on the wire yet — a failure here is
 * PROVEN non-delivery regardless of retryable metadata) vs `dispatching` (the
 * prompt command is on the wire — a failure here may be uncertain delivery).
 */
interface PromptTransaction {
  readonly optimisticId: string;
  readonly sessionId: string;
  /** Send identity that owns this bubble (see the send outbox). */
  readonly operationId: string;
  phase: "activating" | "dispatching";
}

/**
 * Optional staged activation settings applied by {@link SessionController.sendPromptToSession}
 * AFTER `transitionTo(B)` succeeds and BEFORE the prompt command is dispatched.
 * This is the ONLY transport for per-session staged model/thinking choices made
 * while the selected session is detached (read-only history): a detached Composer
 * selection never issues a runtime command on its own — it stages the value here
 * and the single send transaction applies it in deterministic order (model first,
 * then thinking level), awaiting each, so there is no parallel component-side
 * activation/control race. Any failure applying a staged setting is PRE-PROMPT
 * (no prompt command has been dispatched): proven non-delivery, tagged
 * `phase: "activation"`, optimistic bubble cleared.
 */
export interface PromptActivationSettings {
  readonly model?: { readonly provider: string; readonly modelId: string } | null;
  readonly thinkingLevel?: ThinkingLevel | null;
  /**
   * Delivery preference while the Agent is running. It rides the SAME send:
   * the composer states the user's preference from the「运行中按 Enter」
   * setting and never decides whether the Agent is busy.
   */
  readonly whenBusy?: "steer" | "follow_up";
}

/**
 * D2-P4 dual-slot queued turn (steer / follow_up only). Independent of
 * {@link CommandPending} so a long-running prompt never blocks steering or
 * following-up. At most ONE queued turn in flight; the second is
 * `session_busy`. commandId is stable across same-epoch resends so the
 * runtime dedups by (sessionId, commandId).
 */
interface QueuedTurnPending {
  readonly commandId: string;
  attempt: RuntimeAttemptHandle | null;
  wireSeen: boolean;
  wireAttempts: number;
  /** Backoff timer for an uncertain-outcome reconciliation re-send. */
  reconcileTimer: unknown | null;
  /** ONE re-send budget (same bound as the prompt lane). */
  resendCount: number;
  /** ONE deadline, armed at the first re-send and cleared on any settle. */
  resendDeadline: number | null;
  /** The single deadline timer: settles an unresolved queued turn when it
   *  passes, so a re-send waiting for a reconnect that never comes cannot lock
   *  the queue lane forever. */
  resendTimer: unknown | null;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  readonly type: "steer" | "follow_up";
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * D2-P8 extension-UI reply slot. A THIRD single-in-flight slot, independent of
 * {@link CommandPending} and {@link QueuedTurnPending}: the prompt that
 * triggered the UI stays `pendingCommand` (so `sendCommand` is busy), and the
 * reply must still travel. At most ONE extension reply in flight; the second is
 * `session_busy`. commandId is stable across same-epoch resends so the runtime
 * dedups by (sessionId, commandId). Only the final response command is sent.
 */
interface ExtensionUiPending {
  readonly commandId: string;
  attempt: RuntimeAttemptHandle | null;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  readonly requestId: string;
  readonly method: ExtensionUiInteractiveMethod;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * D2-P8 final-response payload bound to an authoritative pending request. The
 * store mints the commandId and binds `id`/`method` from the request; it NEVER
 * trims/coerces the value. `cancelled` is the only reply valid for every
 * interactive method.
 */
export type ExtensionUiReply =
  | { responseKind: "selected"; selected: string }
  | { responseKind: "confirmed"; confirmed: boolean }
  | { responseKind: "value"; value: string }
  | { responseKind: "questionnaire"; answers: readonly QuestionnaireAnswer[] }
  | { responseKind: "cancelled"; cancelled: true };

interface InterruptPending {
  readonly commandId: string;
  attempt: RuntimeAttemptHandle | null;
  readonly sessionId: string;
  readonly message: WsInterruptMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * One pending lane that survives a transport loss and must be decided at every
 * attach boundary (same-epoch resend vs. lost-identity settle) and at a session
 * switch. Lanes differ only in how their slot is read, re-sent and settled —
 * never in the decision rule — so both {@link resyncAfterAttach} and the
 * session-switch cleanup in {@link startAttach} drive the SAME table.
 */
interface PendingLane {
  readonly name: string;
  /** The lane's pending slot, or null when it is idle. */
  pending(): { readonly sessionId: string } | null;
  /**
   * Re-send the pending frame with the SAME at-most-once id. Absent for a pure
   * query lane (bounded reads): those are re-issued by their caller and never
   * resent, so the attach resync does not touch them.
   */
  resend?(): void;
  /** Settle the slot exactly once for an outcome that must not be re-sent. */
  settle(error: ProtocolError): void;
  /** Surface the resync settle error in the controller view. */
  readonly reportsError: boolean;
  /**
   * Settled when an attach for a DIFFERENT session starts: `always`, or only on
   * a fresh (non-resume) attach.
   */
  readonly switchSettle: "always" | "fresh-only";
  /** The current attempt is authoritative — nothing to re-sync for this lane. */
  readonly skipResync?: () => boolean;
  /**
   * Lane-specific resync settle error. Interrupts are a control channel: after
   * an epoch rollover the old worker is gone, so nothing is ambiguous and the
   * interrupt is simply moot — it is settled with its own copy and never
   * surfaced as a user-visible error (unlike a data lane whose effect may have
   * landed).
   */
  readonly resyncError?: ProtocolError;
}

/**
 * Phase 2B independent read slot. Reads travel on a DEDICATED bounded lane
 * (browser `read` envelope, negotiated `runtime.read-rpc.v1`) and are
 * correlated by (sessionId, epoch, requestId, generation, read type) — never
 * the mutation commandId ledger. Each pending read settles EXACTLY ONCE on
 * result / detach / switch / stop / dispose / epoch change / transport loss;
 * no automatic resend after reconnect.
 */
interface ReadPending {
  readonly requestId: string;
  readonly sessionId: string;
  readonly epoch: string;
  attempt: RuntimeAttemptHandle | null;
  readonly readType: RuntimeReadType;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Phase 3 atomic turn delivery state (see {@link TurnPending}):
 *  - `in_flight`: the logical turn is active (waiting for sendability or on the
 *    wire) and admission has not yet been received;
 *  - `accepted`: the authority admitted the turn (settings + prompt atomically);
 *  - `not_delivered`: the authority definitively did NOT admit the turn — the
 *    optimistic bubble is removed and the draft restored;
 *  - `uncertain`: admission failed after possible dispatch (timeout / transport /
 *    epoch change after possible delivery) — the bubble + staging are retained.
 */
export type TurnDelivery = "not_delivered" | "in_flight" | "accepted" | "uncertain";
/**
 * Phase 3 send-tracking slot. It no longer represents an ATTEMPT (the outbox
 * owns delivery): once the authority accepts a message there is nothing left to
 * guess, so this only follows the accepted turn until terminal. Never shares
 * {@link CommandPending} (a long accepted turn must NOT occupy the ordinary
 * mutation command slot). Correlated strictly by (sessionId, operationId,
 * turnId, status revision).
 */
interface TurnPending {
  readonly operationId: string;
  readonly sessionId: string;
  /** LC-02 presentation provenance captured at send start (see {@link PresentationProvenance}). */
  provenance: PresentationProvenance | null;
  /** Authority epoch of the accepted admission. */
  epoch: string | null;
  turnId: string | null;
  statusRevision: number;
  /** Authority identities that consume the optimistic bubble by exact id. */
  userEntryId: string | null;
  finalLeafId: string | null;
  /** The speculative bubble this accepted turn owns (null once committed). */
  optimisticId: string | null;
  attempt: RuntimeAttemptHandle | null;
  terminal: boolean;
}

/** Terminal turn signal published to the UI for committed/terminal catalog refresh. */
export interface ControllerEvictionProtection {
  readonly attached: boolean;
  readonly attachIntent: boolean;
  readonly pendingCommand: boolean;
  readonly pendingSideChatCommand: boolean;
  readonly pendingRead: boolean;
  readonly pendingInterrupt: boolean;
  readonly pendingQueuedTurn: boolean;
  readonly pendingExtensionResponse: boolean;
  readonly optimisticTransaction: boolean;
  readonly optimisticEntries: boolean;
  readonly runningOverlay: boolean;
  readonly stagedActivation: boolean;
  readonly stoppingTransition: boolean;
  /** LC-02: an explicit activate→observe transaction is in flight. */
  readonly explicitActivation: boolean;
  readonly quiescent: boolean;
}

export interface TurnTerminalInfo {
  readonly sessionId: string;
  readonly operationId: string;
  readonly turnId: string;
  readonly state: "completed" | "failed";
  /** Pi 1.0 backend receipt: "handled" consumed the input (no assistant
   * reply / user entry owed), "queued" parked it, "started" ran a turn. */
  readonly disposition?: "started" | "handled" | "queued";
  readonly error?: ProtocolError;
  readonly userEntryId?: string;
}


/** Command-lane error codes whose outcome is UNRESOLVED (the Host/sessiond RPC
 * failed after possible dispatch): a steer / follow_up answering with one of
 * these may already be queued server-side, so it is NEVER a proven
 * non-delivery — reconcile by re-sending the same commandId instead. */
const QUEUED_TURN_UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  "timeout",
  "unavailable",
  "worker_unavailable",
]);

/** Bounded wait for a usable transport on ONE connection attempt. */
const OUTBOX_WIRE_WAIT_MS = 20_000;
/**
 * The ONLY send rejections that are final. A send the authority refuses for any
 * other reason stays in the outbox and is resent with the same operationId, so
 * the user never sees an error for a message that is still on its way.
 */
function isFinalSendRejection(error: ProtocolError): boolean {
  return error.code === "invalid_input" || error.code === "not_found";
}

const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_DETACH_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_SIDE_CHAT_COMMAND_TIMEOUT_MS = 10_000;
/** How long a steer / follow-up sent during transport recovery waits for the re-attach. */
const QUEUED_TURN_RESUME_TIMEOUT_MS = 20_000;
/** One silent recover-and-resend after a non-user send failure. Never loops.
 *  The pre-wire send gate shares this SAME budget: a wake-from-hidden recovery
 *  (probe + connect + handshake + re-attach) routinely outlives a short gate,
 *  and giving each stage its own budget would turn an honest slow recovery into
 *  a false "message not sent". */
const SUBMIT_RECOVERY_BUDGET_MS = 30_000;
/**
 * ONE re-send budget for a logical send, shared by every resend shape:
 * transport recovery → stale-attached fence drop → authority revision repair →
 * uncertain reconciliation. That chain is the longest reachable one, so three
 * resends is the honest maximum; a pending that exhausts it settles by what the
 * wire actually proved (`wireSeen`), never by another retry.
 */
const SUBMIT_MAX_RESENDS = 3;
/** Backoff before a queued-turn reconciliation re-send (bounded by the same budget). */
const QUEUED_TURN_RECONCILE_DELAY_MS = 1_000;
/** Bounded lifecycle/attach send gate (create/open through the shared transport gate). */
const LIFECYCLE_GATE_TIMEOUT_MS = 30_000;
/** Browser-side bound below Host/sessiond limits; read floods fail closed locally. */
const MAX_PENDING_READS = 16;
export class SessionController implements RuntimeControllerPort {
  private readonly runtimeConnection: RuntimeConnection;
  private readonly binding: RuntimeControllerBinding;
  private readonly id: IdFactory;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly abortTimeoutMs: number;
  private readonly stopSendTimeoutMs: number;
  private readonly stopAckTimeoutMs: number;
  private readonly detachAckTimeoutMs: number;
  private readonly sideChatCommandTimeoutMs: number;
  private readonly requestObservation: (sessionId: string, context: ObservationRequestContext) => Promise<void>;
  private readonly capturePresentationProvenance: (() => PresentationProvenance | null) | null;
  private readonly consumeCreatedSubmitProvenance: (() => PresentationProvenance | null) | null;
  private readonly isPresentationCurrent: ((provenance: PresentationProvenance) => boolean) | null;
  /** Single-flight explicit activation (activate → observe) guard. */
  private explicitActivationPending = false;

  // reactive state
  private connection: ConnectionState = "idle";
  private attached = false;
  private sessionStopped = false;

  private epoch: string | null = null;
  private lastEventId = 0;
  /** False for the finite old-daemon create result that omitted lastEventId. */
  private authorityCursorKnown = false;
  private snapshot: RuntimeSnapshot | null = null;
  /**
   * Authoritative-settings eligibility (admitted snapshot): the history-layer
   * generation at the accepted admission that installed this controller's
   * snapshot, plus that submission's send-start provenance. Valid only while
   * the generation is unchanged (fresh attach / rebase / detach / stop /
   * session switch all advance it) AND the provenance is still the current
   * presentation (a later reselect must browse history, not the retained
   * snapshot). Null when no admitted snapshot is currently eligible. The
   * controller owns this flag — there is no second model cache.
   */
  private admittedSnapshot: {
    historyGeneration: number;
    provenance: PresentationProvenance | null;
    operationId: string;
    epoch: string;
    terminalWithoutFinalLeaf: boolean;
  } | null = null;
  /** Latest authoritative head for an attached submit fence; independent of the replay cursor. */
  private attachedFenceRevision: number | null = null;
  /** History-layer state (Protocol v2): generation + anchor + committed live entries. */
  private historyGeneration = 0;
  private historyAnchorLeafId: string | null = null;
  /** Browser-local creation fact; never inferred for a cold-open session. */
  private createdWithAutoThinking = false;
  private liveEntries: SessionEntry[] = [];
  /**
   * Phase 5A deferred leaf-fence rebase: the leaf a committed `session_changed`
   * reported while the exact turn was still active/streaming. Applied (or
   * superseded by a rebase snapshot / teardown) once the turn reaches terminal.
   * Optimistic entries survive the rebase (transaction-owned).
   */
  private pendingLeafRebase: string | null = null;
  /**
   * Attach lifecycle generation (see {@link ControllerView.attachGeneration}).
   * Incremented only on attach boundaries (fresh attach / detach / stop).
   */
  private attachGeneration = 0;
  /**
   * Speculative (optimistic) running overlay for a sent prompt — SEPARATE from
   * the authoritative {@link snapshot}. Set while a prompt transaction is in
   * flight, retained across transport acceptance and target-session attach,
   * then cleared when authoritative events/snapshots take ownership or a
   * definite/uncertain failure settles the UI transaction. The view's
   * `snapshot` is a projection that overlays this flag; the authoritative
   * snapshot is NEVER mutated for optimism.
   */
  private optimisticPromptRunning = false;
  private optimisticPromptSessionId: string | null = null;
  /**
   * Single-flight prompt transaction (activation + dispatch). At most ONE in
   * flight; a concurrent sendPrompt/sendPromptToSession is rejected with
   * `session_busy` BEFORE touching any speculative state, so it can never
   * clear/corrupt the active transaction's overlay or bubble. `phase` is the
   * explicit activation vs dispatch boundary (see {@link PromptTransaction}).
   */
  private promptTransaction: PromptTransaction | null = null;
  /**
   * Optimistic UI layer (Apple-style instant feedback): a sent prompt is
   * appended here IMMEDIATELY (own `optimistic:<n>` id) and consumed FIFO by
   * the first real user `message_end`. Retryable failures keep the entry (the
   * turn usually IS running behind a transport timeout); a definite failure
   * removes it. Rebase/detach clears it with the rest of the live layer.
   */
  private optimisticUserEntries: OptimisticSessionEntry[] = [];
  private optimisticSeq = 0;
  private error: ProtocolError | null = null;
  private fatal = false;

  // attach / cursor gating
  private intendedSession: { sessionId: string; intent: AttachIntent } | null = null;
  private attach: AttachDeferred | null = null;
  private attachAttempt: AttachAttempt | null = null;
  private attachGen: number | null = null;
  /** Identity of the current observation; a later attach of the same session mints a new one. */
  private observationId = 0;
  /** Last observation identity that already completed local release. */
  private releasedObservationId: number | null = null;

  // logical pending operations (transport attempts live in RuntimeConnection)
  private pendingCommand: CommandPending | null = null;
  /** Side chat remains operable while the main turn/ordinary command lane is occupied. */
  private pendingSideChatCommand: SideChatCommandPending | null = null;
  /** D2-P4 dual-slot: at most ONE queued turn (steer/follow_up) in flight, independent of prompt. */
  private pendingQueuedTurn: QueuedTurnPending | null = null;
  /** D2-P8 extension-UI reply slot: at most ONE final response in flight, independent of prompt + queued turn. */
  private pendingExtensionUiCommand: ExtensionUiPending | null = null;
  private pendingInterrupt: InterruptPending | null = null;
  /** At most ONE interrupt in flight (well under H1's 16-interrupt cap). */
  private pendingInterruptPromise: Promise<unknown> | null = null;
  /** Phase 2B dedicated bounded read slots keyed by requestId. */
  private readonly pendingReads = new Map<string, ReadPending>();
  /** Phase 3 single PendingTurn slot (never shares {@link pendingCommand}). */
  private pendingTurn: TurnPending | null = null;
  /** Phase 3 terminal-turn listeners (committed/terminal catalog refresh). */
  private readonly turnTerminalListeners = new Set<(terminal: TurnTerminalInfo) => void>();
  /** At most ONE stop in flight (LOW: concurrent stops merge into one frame). */
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  /** At most ONE detach in flight per source session (single-flight coalescing). */
  private detachPromise: Promise<void> | null = null;
  private detachSessionId: string | null = null;

  private readonly listeners = new Set<() => void>();
  private view: ControllerView = INITIAL_VIEW;
  /**
   * The ONE owner of un-delivered sends (see `send-outbox-store.ts`). A send is
   * appended here BEFORE anything touches the wire and removed only when the
   * authority accepted it (or proved it never will). Persisted, so a page killed
   * mid-send resumes delivering the same `operationId` on reload.
   */
  private readonly outbox: SendOutboxStore;
  /** Transport subscription that drives redelivery on every reconnect. */
  private readonly outboxUnsubscribe: () => void;
  /** The outbox entry currently being delivered (at most one, in order). */
  private delivering: OutboxEntry | null = null;

  constructor(readonly sessionId: string, runtimeConnection: RuntimeConnection, options: SessionControllerOptions = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("SessionController sessionId must be non-empty");
    Object.defineProperty(this, "sessionId", { value: sessionId, enumerable: true, writable: false, configurable: false });
    this.runtimeConnection = runtimeConnection;
    this.binding = runtimeConnection.registerController(sessionId, this);
    this.id = options.id ?? createDefaultIdFactory();
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.stopSendTimeoutMs = options.stopSendTimeoutMs ?? DEFAULT_STOP_SEND_TIMEOUT_MS;
    this.stopAckTimeoutMs = options.stopAckTimeoutMs ?? DEFAULT_STOP_ACK_TIMEOUT_MS;
    this.detachAckTimeoutMs = options.detachAckTimeoutMs ?? DEFAULT_DETACH_ACK_TIMEOUT_MS;
    this.sideChatCommandTimeoutMs = options.sideChatCommandTimeoutMs ?? DEFAULT_SIDE_CHAT_COMMAND_TIMEOUT_MS;
    this.requestObservation = options.requestObservation ?? ((_sessionId: string, _context: ObservationRequestContext) => Promise.reject({ code: "unavailable", message: "no attachment coordinator", retryable: false } satisfies ProtocolError));
    this.capturePresentationProvenance = options.capturePresentationProvenance ?? null;
    this.consumeCreatedSubmitProvenance = options.consumeCreatedSubmitProvenance ?? null;
    this.isPresentationCurrent = options.isPresentationCurrent ?? null;
    this.outbox = options.outbox ?? new SendOutboxStore(undefined);
    this.outbox.load();
    this.outboxUnsubscribe = runtimeConnection.subscribe(() => this.onTransportForOutbox());
    if (options.initialAuthority !== undefined) this.installCreatedAuthority(options.initialAuthority);
    // A reloaded page resumes its persisted sends for THIS session.
    this.scheduleOutboxDrain();
    this.notify();
  }

  // --- public transport --------------------------------------------------

  private installCreatedAuthority(result: RuntimeCreateResult): void {
    if (result.sessionId !== this.sessionId) throw new Error("created authority session mismatch");
    // RuntimeConnection.createSession is identity-only: no concrete thinking
    // level is accepted on that API. Therefore this controller knows the
    // creation-time UI intent was auto; a concrete first-turn override will be
    // reflected by the authoritative snapshot's thinkingLevelPinned:true.
    this.createdWithAutoThinking = true;
    this.epoch = result.epoch;
    this.lastEventId = result.lastEventId ?? 0;
    this.authorityCursorKnown = result.lastEventId !== undefined;
    this.snapshot = result.snapshot === undefined ? null : structuredClone(result.snapshot);
  }

  /** Fail-closed create collision merge: exact identity + epoch + monotonic authority only. */
  adoptCreatedAuthority(result: RuntimeCreateResult): boolean {
    if (result.sessionId !== this.sessionId) return false;
    if (this.epoch !== null && this.epoch !== result.epoch) return false;
    if (this.authorityCursorKnown && result.lastEventId !== undefined && result.lastEventId < this.lastEventId) return false;
    if (this.attached || this.hasAttachIntent || !this.evictionProtection.quiescent) return false;
    this.installCreatedAuthority(result);
    this.notify();
    return true;
  }

  connect(): void { this.runtimeConnection.connect(); }

  /** Idempotent controller-local teardown. NEVER runtime.stop and NEVER closes the shared connection. */
  dispose(): void {
    const error: ProtocolError = { code: "unavailable", message: "runtime controller disposed", retryable: false };
    this.outboxUnsubscribe();
    // Pending sends STAY in the outbox: disposal must never drop the user's
    // message. Only the in-flight attempt is abandoned (it is retried later).
    this.delivering = null;
    this.failAllPending(error);
    this.binding.unbind();
    this.connection = "stopped";
    this.attached = false;
    this.notify();
  }

  // --- public lifecycle --------------------------------------------------

  /**
   * Open this exact session with a FRESH attach.
   *
   * FINITE Protocol-v2 compatibility shim (LC-02): this is the legacy
   * activating attach — the Browser cannot prove `existing_only`, so the Host
   * may cold-activate a missing Worker. Production observation callers use
   * {@link observeExisting}; production cold-explicit callers go through the
   * Registry's activate→observe path; ordinary sends stay atomic via
   * `submitTurn`.
   * Removal condition: Protocol v3 first becomes the minimum supported
   * version AND every remaining caller is migrated to the negotiated
   * observe/activate seams (tracked in the migration ledger).
   */
  openSession(sessionId: string = this.sessionId): Promise<void> {
    if (sessionId !== this.sessionId) return Promise.reject(this.identityMismatchError(sessionId));
    const wasStopped = this.sessionStopped;
    this.sessionStopped = false;
    this.ensureConnecting();
    // Identity-scoped single-flight: an attach to the SAME session is already in
    // flight (for example, a send activation and another explicit runtime action
    // can ask concurrently) — reuse its deferred WITHOUT sending a duplicate
    // attach frame (the server would only answer the tracked attempt).
    if (this.attachAttempt && this.attachAttempt.sessionId === sessionId && this.attach) {
      return this.attach.promise;
    }
    return new Promise<void>((resolve, reject) => {
      // Lifecycle gate (identity-scoped, single-flight): when the socket is
      // already sendable — incl. an in-flight attach to another session — go
      // straight to startAttach, which SUPERSEDES the pending attach so rapid
      // A→B→C switching never blocks behind a strictly-`ready` wait and the
      // superseded open's promise settles exactly once (never hangs).
      this.whenReadyForLifecycle().then(
        () => { void this.startAttach(sessionId, !wasStopped && this.authorityCursorKnown && this.epoch !== null ? "resume" : "fresh", "legacy").then(resolve, reject); },
        (error) => reject(error),
      );
    });
  }

  /**
   * LC-02 observation-only attach over the SAME single lease/deferred/generation
   * machine as {@link openSession}. Requires the negotiated
   * `runtime.observe-existing.v1` feature and sends `attachMode:
   * "existing_only"` on EVERY attempt — fresh, resume and reconnect resend —
   * so the Host can never cold-activate a missing Worker for this path. There
   * is NO activating fallback: a missing feature or a failed observation
   * rejects with a structured error (never an empty success, never a legacy
   * attach). A stopped session is not resurrected — `sessionStopped` stays
   * truthful and the Host's existing-only rejection surfaces honestly.
   */
  observeExisting(): Promise<void> {
    const sessionId = this.sessionId;
    if (!this.runtimeConnection.hasFeature(RUNTIME_OBSERVE_EXISTING_FEATURE)) {
      return Promise.reject({
        code: "unsupported_capability",
        message: "observation of an existing runtime is unavailable",
        retryable: false,
      } satisfies ProtocolError);
    }
    if (this.attached) return Promise.resolve();
    this.ensureConnecting();
    if (this.attachAttempt && this.attachAttempt.sessionId === sessionId && this.attach) {
      return this.attach.promise;
    }
    return new Promise<void>((resolve, reject) => {
      this.whenReadyForLifecycle().then(
        () => { void this.startAttach(sessionId, this.authorityCursorKnown && this.epoch !== null ? "resume" : "fresh", "existing").then(resolve, reject); },
        (error) => reject(error),
      );
    });
  }

  /**
   * LC-02 explicit cold activation → observation, for ALREADY-LISTED explicit
   * non-prompt actions only (cold Compact). Wire path: the negotiated Browser
   * `activate` envelope (`runtime.explicit-activate.v1`, Host independently
   * re-authorizes the exact session) → exact `RuntimeActivateResult` identity
   * → {@link observeExisting}. It NEVER sends a prompt, never auto-retries the
   * activation after a disconnect, and its result/state is used only for this
   * exact target (no cross-session projection). Ordinary submits stay atomic
   * via `submitTurn` and MUST NOT route through here. Single-flight per
   * controller: a concurrent explicit activation is a fixed `session_busy`.
   * Registry owns the split: {@link activate} then recheck, then observe.
   */
  activate(): Promise<void> {
    const sessionId = this.sessionId;
    if (this.attached) return Promise.resolve();
    if (this.explicitActivationPending) {
      return Promise.reject({
        code: "session_busy",
        message: "an explicit activation is already in progress",
        retryable: false,
      } satisfies ProtocolError);
    }
    if (!this.runtimeConnection.hasFeature(RUNTIME_EXPLICIT_ACTIVATE_FEATURE)) {
      return Promise.reject({
        code: "unsupported_capability",
        message: "explicit runtime activation is unavailable",
        retryable: false,
      } satisfies ProtocolError);
    }
    this.explicitActivationPending = true;
    return this.runtimeConnection.activateSession(sessionId)
      .then(() => undefined)
      .finally(() => { this.explicitActivationPending = false; });
  }

  /**
   * LC-02 coherent provenance transfer: when the Registry promotes the
   * initiating draft/home presentation key to this session's created identity
   * (first-send promotion, still under the captured revision), the in-flight
   * atomic turn's provenance moves with it — the admission that follows may
   * then legally take foreground observation for the created session. Exact
   * old-token match only; any other value is left untouched (a stale or
   * foreign token is never rewritten into newer intent).
   */
  transferPresentationProvenance(from: PresentationProvenance, to: PresentationProvenance): void {
    const pending = this.pendingTurn;
    if (pending === null || pending.provenance === null) return;
    if (pending.provenance.key !== from.key || pending.provenance.revision !== from.revision) return;
    pending.provenance = to;
  }

  /** Release Browser observation only; retain all exact-session state and lanes. */
  detach(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return Promise.resolve();
    // Single-flight per source session: the shell's fail-closed selection
    // detach and a send-time transition can both ask for the SAME session while
    // the first is in flight — coalesce into one wire frame / one promise (no
    // duplicate detach frames, no duplicate teardown).
    if (this.detachPromise && this.detachSessionId === sessionId) return this.detachPromise;
    this.detachSessionId = sessionId;
    const observationId = this.observationId;
    // F2: the detach ack is BOUNDED (configurable/default, consistent with the
    // stop/abort ack option patterns). On timeout the detach rejects — the
    // transitionTo activation rejects as proven non-delivery (phase:
    // "activation", transaction/bubble cleared), the store stays attached to
    // the source session (coherent attach state — nothing torn down without a
    // confirmed ack), and the single-flight fields are freed so a later retry
    // works.
    this.detachPromise = this.sendEnvelope(
      { type: "detach", id: this.id(), payload: { sessionId } },
      this.detachAckTimeoutMs,
    ).then(() => {
      this.finishLocalObservationRelease(observationId);
    }).finally(() => {
      this.detachPromise = null;
      this.detachSessionId = null;
    });
    return this.detachPromise;
  }

  /**
   * Authoritative stop. Honest semantics (MEDIUM-4/5, LOW):
   *  1. HOL: if a prompt is running, FIRST abort and await the interrupt result
   *     (bounded) — H1 stop head-of-lines behind a long command.
   *  2. Settle the pending prompt promise exactly once (MEDIUM-4).
   *  3. Wait until the socket is sendable (bounded); send stop and AWAIT the ack
   *     (bounded). Only on confirmed ack do we mark sessionStopped; on any failure
   *     we reject and KEEP resume eligibility (intendedSession untouched).
   * Concurrent stops merge into a single promise / single stop frame (LOW).
   */
  stop(reason?: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.runStop(reason).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async runStop(reason?: string): Promise<void> {
    this.stopping = true;
    try {
      if (this.attached && this.isPromptRunning()) {
        await this.boundedAbort();
      }
      // MEDIUM-4: settle the in-flight prompt promise exactly once.
      this.settlePendingCommand({ code: "interrupted", message: "session stopped", retryable: false });
      this.settlePendingSideChatCommand({ code: "interrupted", message: "session stopped", retryable: false });
      // Phase 2B: pending reads are invalidated by stop — settle each exactly once.
      this.settleAllPendingReads({ code: "interrupted", message: "session stopped", retryable: false });
      // Phase 3: a pending turn is invalidated by stop — settle exactly once.
      this.settleTurn({ code: "interrupted", message: "session stopped", retryable: false });
      // D2-P4: settle any in-flight queued turn exactly once (stop invalidates it).
      this.settlePendingQueuedTurn({ code: "interrupted", message: "session stopped", retryable: false });
      // D2-P8: stop invalidates an in-flight extension reply exactly once.
      this.settlePendingExtensionUi({ code: "interrupted", message: "session stopped", retryable: false });
      const sessionId = this.sessionId;
      if (!sessionId) return;
      // MEDIUM-5: honest stop — wait until sendable (bounded), then send + await ack (bounded).
      try {
        await this.whenSendable(this.stopSendTimeoutMs);
        await this.sendEnvelope(
          { type: "stop", id: this.id(), payload: { sessionId, ...(reason === undefined ? {} : { reason }) } },
          this.stopAckTimeoutMs,
        );
      } catch (error) {
        // Could not confirm stop: do NOT mark stopped; keep resume eligibility.
        this.notify();
        throw error;
      }
      this.attached = false;
      this.sessionStopped = true;
      this.intendedSession = null;
      // A confirmed stop closes created submit-fence authority. Retained
      // snapshot/cursor state is local only and is never used to resurrect it.
      // Protocol v2: stop clears the history layer.
      this.clearHistoryLayer();
      this.rejectAttach({ code: "interrupted", message: "stopped", retryable: false });
      this.notify();
    } finally {
      this.stopping = false;
    }
  }

  /** Await an abort interrupt result, but never longer than {@link abortTimeoutMs}. */
  private boundedAbort(): Promise<void> {
    return new Promise<void>((continueStop) => {
      let done = false;
      const handle = this.setTimeoutFn(() => {
        if (done) return;
        done = true;
        continueStop();
      }, this.abortTimeoutMs);
      this.abort().then(
        () => { if (done) return; done = true; this.clearTimeoutFn(handle); continueStop(); },
        () => { if (done) return; done = true; this.clearTimeoutFn(handle); continueStop(); },
      );
    });
  }

  /** Read-only snapshot refresh; replaces projection state WITHOUT advancing the cursor. */
  fetchSnapshot(): Promise<RuntimeSnapshot | null> {
    const sessionId = this.sessionId;
    if (!sessionId) return Promise.resolve(this.snapshot);
    return this.sendEnvelope({ type: "getSnapshot", id: this.id(), payload: { sessionId } }).then((result) => {
      const snap = result as RuntimeSnapshot;
      // Replace projection state only; epoch/lastEventId/sessionId cursor unchanged.
      this.snapshot = structuredClone(snap);
      // A fresh authoritative snapshot is truthful: drop the speculative
      // running overlay (if the turn is genuinely in-flight the snapshot's own
      // state already reports isPromptRunning/isStreaming).
      if (this.optimisticPromptRunning) {
        this.optimisticPromptRunning = false;
        this.optimisticPromptSessionId = null;
      }
      this.settleExtensionUiOnCapabilityLoss();
      this.settleSideChatOnCapabilityLoss();
      this.notify();
      return this.snapshot;
    });
  }

  /**
   * The authoritative runtime capability set from the latest attach snapshot
   * ({@link RuntimeCapabilitySet}). Returns null whenever the store is not
   * attached (detach / stop / reconnect), so a stale capability set is never
   * exposed across an attach boundary. This is the runtime capability
   * authority — never derived from the Host `agent` capability.
   */
  runtimeCapabilities(): RuntimeCapabilitySet | null {
    return this.attached ? (this.snapshot?.capabilities ?? null) : null;
  }

  /** True when the current runtime advertises `capability` (false before attach). */
  hasRuntimeCapability(capability: RuntimeCapability): boolean {
    return this.runtimeCapabilities()?.capabilities.includes(capability) === true;
  }

  /**
   * Phase 5B: when `runtime.epoch-rollover.v1` is negotiated, every command /
   * interrupt frame carries the exact controller epoch so sessiond can fence
   * post-rollover admissions. Same-epoch resends keep the SAME message/epoch.
   * When the feature is negotiated but the controller is detached (epoch
   * null), the existing admission guards reject before this frame is built.
   */
  private withEpoch<P extends { sessionId: string }>(payload: P): P & { epoch: string } {
    if (!this.runtimeConnection.hasFeature(RUNTIME_EPOCH_ROLLOVER_FEATURE) || this.epoch === null) {
      return payload as P & { epoch: string };
    }
    return { ...payload, epoch: this.epoch };
  }

  /**
   * Send an arbitrary runtime command, reusing the at-most-once command
   * correlation / epoch rules shared with {@link sendPrompt}. The caller owns
   * the full {@link RuntimeCommand} (including a freshly-minted commandId) and
   * capability gating (see {@link hasRuntimeCapability}); an unsupported
   * command resolves to a correlated `unsupported_capability` result rather
   * than throwing.
   */
  sendCommand(command: RuntimeCommand): Promise<unknown> {
    const preDispatchError = (error: ProtocolError) => command.type === "prompt" ? this.activationFailure(error) : error;
    if (!this.attached || !this.sessionId) {
      return Promise.reject(preDispatchError(this.notAttachedError()));
    }
    // Phase 3: while the atomic prompt turn is active (in_flight / accepted /
    // uncertain, not yet terminal) conflicting ordinary MUTATION commands
    // reject `session_busy`. Reads (read lane), steer/follow_up (queued-turn
    // slot), extension UI (dedicated slots) and abort (interrupt path) are
    // deliberately NOT blocked — they stay independent of the turn. The same
    // independence applies to switch_queued_delivery: queue surgery on a
    // turn that is STREAMING is exactly when the user toggles a queued
    // message's type, so it must never wait behind the turn (the runtime's
    // revision fence fails it closed if the queue changed).
    if (
      this.pendingTurn && !this.pendingTurn.terminal && command.type !== "switch_queued_delivery"
    ) {
      return Promise.reject(preDispatchError({
        code: "session_busy",
        message: "a prompt turn is already active",
        retryable: false,
      } satisfies ProtocolError));
    }
    // Once a prompt transaction owns user intent, automatic metadata reads may
    // not enter the ordinary slot — even from a preempted read's promise
    // continuation before React has committed its effect cleanup. This makes
    // prompt priority independent of browser microtask/React scheduling.
    if (
      this.promptTransaction
      && (command.type === "get_session_stats" || command.type === "get_tools" || command.type === "get_commands")
    ) {
      return Promise.reject({
        code: "interrupted",
        message: "superseded by prompt",
        retryable: false,
      } satisfies ProtocolError);
    }
    if (this.pendingCommand) {
      return Promise.reject(preDispatchError({
        code: "session_busy",
        message: "a runtime command is already in progress",
        retryable: false,
      } satisfies ProtocolError));
    }
    const sessionId = this.sessionId;
    const message: WsClientMessage = { type: "command", id: this.id(), payload: this.withEpoch({ sessionId, command }) };
    return new Promise((resolve, reject) => {
      const pending: CommandPending = { commandId: command.commandId, attempt: null, wireSeen: false, sessionId, command: message, resolve, reject };
      this.pendingCommand = pending;
      this.sendCommandAttempt(pending);
    });
  }

  /**
   * D2-P4 dual-slot queued turn send (steer / follow_up). Independent of the
   * ordinary {@link sendCommand} single slot so a running prompt never blocks
   * it. At most ONE queued turn in flight; the second is `session_busy` (and
   * NEVER overwrites the first waiter). commandId is stable across same-epoch
   * resends; the runtime dedups by (sessionId, commandId). Message is strictly
   * trimmed and must be non-empty.
   */
  private sendQueuedTurn(type: "steer" | "follow_up", message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return Promise.reject(this.activationFailure({
        code: "invalid_input",
        message: "message cannot be empty",
        retryable: false,
      } satisfies ProtocolError));
    }
    if (!this.sessionId || (!this.attached && !this.resuming)) {
      return Promise.reject(this.activationFailure(this.notAttachedError()));
    }
    if (this.pendingQueuedTurn) {
      return Promise.reject(this.activationFailure({
        code: "session_busy",
        message: "a queued turn is already in progress",
        retryable: false,
      } satisfies ProtocolError));
    }
    // NO optimistic transcript bubble: a queued turn surfaces ONLY in the
    // status capsule (via queue_update) and enters the transcript when the
    // runtime actually delivers it (its user message_end lands as a live
    // entry). The RUNNING indicator is not touched either: a queued turn by
    // definition rides an already-running turn.
    const commandId = this.id();
    const imagePayload = images === undefined || images.length === 0 ? {} : { images: [...images] as ImageAttachment[] };
    const command: RuntimeCommand = type === "steer"
      ? { commandId, type: "steer", message: trimmed, ...imagePayload }
      : { commandId, type: "follow_up", message: trimmed, ...imagePayload };
    const sessionId = this.sessionId;
    const wsMessage: WsClientMessage = { type: "command", id: this.id(), payload: this.withEpoch({ sessionId, command }) };
    return new Promise((resolve, reject) => {
      const pending: QueuedTurnPending = { commandId: command.commandId, attempt: null, wireSeen: false, wireAttempts: 0, reconcileTimer: null, resendCount: 0, resendDeadline: null, resendTimer: null, sessionId, command: wsMessage, type, resolve, reject };
      this.pendingQueuedTurn = pending;
      this.notify();
      if (this.attached) this.sendQueuedTurnAttempt(pending);
      else this.sendQueuedTurnAfterResume(pending);
    });
  }

  /** Append the optimistic user bubble (bounded) and return its local id. */
  private appendOptimisticUserEntry(sessionId: string, message: string): string {
    const optimisticId = `optimistic:${(this.optimisticSeq += 1)}`;
    this.optimisticUserEntries = [
      ...this.optimisticUserEntries.slice(-4),
      {
        sessionId,
        // The send instant is this bubble's own timestamp until the authority
        // dates the committed entry. Without it the UI cannot tell which turn
        // a delegation/todo belongs to and the status capsule went blank on
        // every send.
        entry: { entryId: optimisticId, message: { role: "user", content: message, timestamp: Date.now() } },
        ...(sessionId === this.sessionId
          ? { baseEntryId: this.liveEntries.at(-1)?.entryId ?? this.historyAnchorLeafId ?? this.snapshot?.state.leafId ?? null }
          : {}),
      },
    ];
    return optimisticId;
  }

  /**
   * Phase 5A: bind the optimistic bubble owned by `optimisticId` to a
   * submit-turn authority identity (immutable replace; unknown ids no-op so a
   * superseded transaction can never corrupt the active one's binding).
   */
  private bindOptimisticIdentity(optimisticId: string, identity: OptimisticTurnIdentity): void {
    this.optimisticUserEntries = this.optimisticUserEntries.map((candidate) =>
      candidate.entry.entryId === optimisticId && candidate.identity === undefined
        ? { ...candidate, identity }
        : candidate,
    );
  }

  /**
   * Phase 5A: refine an existing identity binding (turn/user-entry/final-leaf)
   * from an authoritative push. Never un-binds and never touches another
   * entry's identity; once set, a field is never overwritten (first authority
   * answer wins — same-epoch status order only).
   */
  private updateOptimisticIdentity(
    optimisticId: string,
    patch: { turnId?: string; userEntryId?: string; finalLeafId?: string },
  ): void {
    this.optimisticUserEntries = this.optimisticUserEntries.map((candidate) => {
      if (candidate.entry.entryId !== optimisticId || candidate.identity === undefined) return candidate;
      const identity = candidate.identity;
      return {
        ...candidate,
        identity: {
          ...identity,
          turnId: identity.turnId === null && patch.turnId !== undefined ? patch.turnId : identity.turnId,
          userEntryId: identity.userEntryId === null && patch.userEntryId !== undefined ? patch.userEntryId : identity.userEntryId,
          finalLeafId: identity.finalLeafId === null && patch.finalLeafId !== undefined ? patch.finalLeafId : identity.finalLeafId,
        },
      };
    });
  }

  /**
   * Begin a single-flight prompt transaction: reject (return null) if a prompt
   * transaction is already active — WITHOUT touching the active transaction's
   * speculative state, so a concurrent submit can never clear/corrupt its
   * overlay or bubble. A CROSS-SESSION send (target differs from the active
   * transaction's session) supersedes the old session's transaction: the
   * transition/attach that follows settles the old session's pending command
   * as a proven `session switched` interruption, so keeping the old transaction
   * would spuriously block the new session's send with `session_busy`.
   * Same-session concurrency stays `session_busy`. Otherwise append the
   * optimistic bubble, set the speculative running overlay and return the
   * transaction (phase "activating").
   */
  private beginPromptTransaction(sessionId: string, message: string, operationId: string): PromptTransaction | null {
    if (this.promptTransaction && this.promptTransaction.sessionId !== sessionId) {
      // Supersede the old session's transaction (owner-scoped; its dispatch
      // promise, if still pending, no-ops when it later settles because this is
      // no longer the active transaction). Matches the pre-4A.0 create→attach
      // session-switch cleanup now that create is identity-only.
      this.settlePromptTransaction(this.promptTransaction, { removeBubble: true });
    }
    if (this.promptTransaction) return null;
    // User intent outranks Composer's automatic attach-time metadata reads.
    // Those reads share the ordinary command slot but are disposable and
    // identity-correlated; rejecting their waiter makes any late response a
    // harmless unmatched frame. Real user/control commands (model, tools write,
    // bash, compact, …) remain non-preemptible and correctly yield session_busy.
    if (this.pendingCommand?.command.type === "command") {
      const pendingType = this.pendingCommand.command.payload.command.type;
      if (pendingType === "get_session_stats" || pendingType === "get_tools" || pendingType === "get_commands") {
        this.settlePendingCommand({ code: "interrupted", message: "superseded by prompt", retryable: false });
      }
    }
    const optimisticId = this.appendOptimisticUserEntry(sessionId, message);
    this.promptTransaction = { optimisticId, sessionId, operationId, phase: "activating" };
    this.bindOptimisticIdentity(optimisticId, { operationId, turnId: null, userEntryId: null, finalLeafId: null });
    if (!this.optimisticPromptRunning) this.optimisticPromptRunning = true;
    this.optimisticPromptSessionId = sessionId;
    this.notify();
    return this.promptTransaction;
  }

  /**
   * Settle a prompt transaction (owner identity-scoped): release the
   * single-flight slot, optionally remove the optimistic bubble, and clear the
   * speculative running overlay — the authoritative projection/events take over
   * from here. Never touches another transaction.
   */
  private settlePromptTransaction(tx: PromptTransaction, options: { removeBubble: boolean; clearRunning?: boolean }): void {
    if (this.promptTransaction !== tx) return;
    this.promptTransaction = null;
    if (options.removeBubble) {
      this.optimisticUserEntries = this.optimisticUserEntries.filter(
        (candidate) => candidate.entry.entryId !== tx.optimisticId,
      );
    }
    if (options.clearRunning !== false && this.optimisticPromptRunning) {
      this.optimisticPromptRunning = false;
      this.optimisticPromptSessionId = null;
    }
    this.notify();
  }

  /**
   * Tag an UNRESOLVED-delivery rejection on a control path that cannot retry
   * itself (steer / follow-up): the caller must never treat it as proven
   * non-delivery.
   */
  private uncertainTagged(error: ProtocolError): ProtocolError & { readonly phase: "uncertain" } {
    return { ...error, phase: "uncertain" as const };
  }

  /**
   * Tag a proven pre-dispatch activation failure without losing canonical error
   * fields. Raw Error properties are non-enumerable, so object spread would
   * otherwise collapse them to `{ phase }`; malformed/raw causes are projected
   * to fixed sanitized fallback fields.
   */
  private activationFailure(cause: unknown): ProtocolError & { readonly phase: "activation" } {    if (cause !== null && typeof cause === "object") {
      const candidate = cause as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
      if (typeof candidate.code === "string" && typeof candidate.message === "string" && typeof candidate.retryable === "boolean") {
        return {
          code: candidate.code as ProtocolError["code"],
          message: candidate.message,
          retryable: candidate.retryable,
          ...(candidate.details === undefined ? {} : { details: candidate.details }),
          phase: "activation",
        };
      }
    }
    // A raw throw (socket.send on a half-open WebSocket) is transport loss.
    // Collapsing it to retryable:false makes the composer show the generic
    // "not sent" copy for a failure the transport is about to recover.
    return {
      code: "unavailable",
      message: "session activation failed",
      retryable: true,
      phase: "activation",
    };
  }

  /**
   * Phase 3 atomic prompt admission (negotiated `runtime.submit-turn.v1`).
   *
   * One PendingTurn per connection. The authority (sessiond) validates the
   * identity, activates the target session if needed, applies any activation
   * overrides, and admits the prompt atomically — the caller never chains
   * activation + settings + prompt commands itself. The returned promise
   * resolves on ACCEPTED admission (quick; full execution arrives via events /
   * snapshot / {@link subscribeTurnTerminal}); it REJECTS on `not_delivered`
   * (proven non-delivery — optimistic bubble removed, draft restored, staged
   * settings preserved) or `uncertain` (may have been delivered — bubble +
   * staging retained, never overwrites a newer draft).
   *
   * Identity rules:
   *  - the client mints a stable `operationId`; the same operation+payload are
   *    resent on same-epoch reconnect with a fresh transport envelope, and a
   *    changed epoch after possible delivery is NEVER resent;
   *  - the epoch fence is resolved by priority: explicit caller fence
   *    (input.expectedEpoch/expectedRevision), then the currently attached live
   *    session, then the EXACT created-session seed (Phase 4A.0). A revision
   *    without an epoch is rejected before any speculative state is touched.
   *    A cross-session submit without a seed lets sessiond cold-activate an
   *    inactive target (or reject live targets with an explicit fence error);
   *  - a long accepted turn never occupies {@link pendingCommand}: reads / steer /
   *    extension / abort stay independent, and conflicting ordinary mutation
   *    commands reject `session_busy` while the turn is active.
   */
  /** LC-02: presentation provenance captured at SEND/ACTION START. */
  private captureProvenance(): PresentationProvenance | null {
    return this.consumeCreatedSubmitProvenance?.() ?? this.capturePresentationProvenance?.() ?? null;
  }

  /**
   * Admitted-snapshot eligibility (pure derivation over owner state — no
   * second model cache): the accepted admission's snapshot is eligible only
   * while (a) the history-layer generation is unchanged since it was installed
   * (a fresh attach / rebase, an actual detach, a stop or a session switch all
   * invalidate it) and (b) the submission's send-start presentation is still
   * current (registry-owned check incl. promoted-create handling). A null
   * provenance has no presentation to gate and stays generation-fenced only.
   */
  private computeAdmittedSnapshotEligible(): boolean {
    const admitted = this.admittedSnapshot;
    if (admitted === null) return false;
    if (admitted.historyGeneration !== this.historyGeneration) return false;
    if (admitted.provenance === null) return true;
    return this.isPresentationCurrent?.(admitted.provenance) ?? false;
  }

  /** A terminal no-leaf bridge waits only for this exact observation outcome. */
  private observationAttachInFlight(): boolean {
    return this.attach !== null || this.attachAttempt !== null || this.connection === "attaching";
  }

  /**
   * Expire a terminal bridge after observation has definitively not claimed it.
   * The operation+epoch fence prevents an old terminal from touching a newer
   * admission; rebasing the existing anchor advances history for the detached
   * transcript without inventing a model or leaf.
   */
  private expireTerminalAdmitted(operationId: string, epoch: string): void {
    const admitted = this.admittedSnapshot;
    if (
      admitted === null
      || !admitted.terminalWithoutFinalLeaf
      || admitted.operationId !== operationId
      || admitted.epoch !== epoch
      || this.observationAttachInFlight()
      || this.pendingLeafRebase !== null
    ) return;
    this.rebaseHistoryLayerTo(this.historyAnchorLeafId);
  }

  private expireTerminalAdmittedIfSettled(): void {
    const admitted = this.admittedSnapshot;
    if (admitted === null || !admitted.terminalWithoutFinalLeaf || this.observationAttachInFlight()) return;
    this.rebaseHistoryLayerTo(this.historyAnchorLeafId);
  }

  /** Reconnect/fatal invalidation must never leave the admission bridge eligible. */
  private invalidateAdmittedSnapshot(): void {
    this.admittedSnapshot = null;
  }

  /**
   * Reconcile the presentation-gated admitted-settings eligibility after the
   * registry changes the current route. This is a notification seam only; the
   * controller remains the sole owner of the admitted snapshot marker.
   */
  refreshPresentationEligibility(): void {
    if (this.admittedSnapshot === null || this.computeAdmittedSnapshotEligible()) return;
    this.admittedSnapshot = null;
    this.notify();
  }

  /**
   * Send one user message. UNCONDITIONAL and idempotent: it always succeeds
   * locally (the message appears immediately) and the outbox guarantees exactly
   * one delivery. The returned promise settles only when the authority accepted
   * the message, or proved it never will (`invalid_input` / `not_found`) — the
   * two cases where the composer restores the draft.
   *
   * There is deliberately NO busy check, NO epoch fence, NO retry budget and NO
   * "unconfirmed" state: those were the guesses that produced six rounds of
   * false "message not sent".
   */
  submitTurn(input: {
    sessionId: string;
    prompt: string;
    images?: readonly ImageAttachment[];
    activationOverrides?: {
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: ThinkingLevel | null;
    };
    /** Queue policy chosen by the user while the Agent is running. */
    whenBusy?: "steer" | "follow_up";
    /**
     * Legacy fence hints kept in the signature for existing callers (and cached
     * clients on the wire). Ignored here AND at the authority: an epoch guess
     * must never decide whether a message is sent.
     */
    expectedEpoch?: string;
    expectedRevision?: number;
  }): Promise<unknown> {
    const sessionId = input.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return Promise.reject(this.activationFailure({
        code: "invalid_input",
        message: "no session selected",
        retryable: false,
      } satisfies ProtocolError));
    }
    if (sessionId !== this.sessionId) return Promise.reject(this.activationFailure(this.identityMismatchError(sessionId)));
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      return Promise.reject(this.activationFailure({
        code: "invalid_input",
        message: "prompt must be non-empty",
        retryable: false,
      } satisfies ProtocolError));
    }
    return this.enqueueSend({
      sessionId,
      prompt: input.prompt,
      ...(input.images === undefined ? {} : { images: input.images }),
      ...(input.activationOverrides === undefined ? {} : { activationOverrides: input.activationOverrides }),
      whenBusy: input.whenBusy ?? "follow_up",
    });
  }

  // --- send outbox -------------------------------------------------------

  /**
   * Enqueue one send intent, show its bubble immediately, and hand delivery to
   * the outbox. The returned promise resolves on acceptance and rejects ONLY on
   * a proven-final rejection (`invalid_input` / `not_found`).
   *
   * A second send while one is still being delivered is not an error: it is
   * appended and delivered next, in order.
   */
  private enqueueSend(input: {
    sessionId: string;
    prompt: string;
    images?: readonly ImageAttachment[];
    activationOverrides?: {
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: ThinkingLevel | null;
    };
    whenBusy: "steer" | "follow_up";
  }): Promise<unknown> {
    const overrides = input.activationOverrides;
    const model = overrides?.model;
    const thinkingLevel = overrides?.thinkingLevel;
    const activationOverrides = (model === undefined || model === null) && (thinkingLevel === undefined || thinkingLevel === null)
      ? undefined
      : {
          ...(model === undefined || model === null ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
          ...(thinkingLevel === undefined || thinkingLevel === null ? {} : { thinkingLevel }),
        };
    const entry = this.outbox.enqueue({
      operationId: `op:${this.id()}`,
      sessionId: input.sessionId,
      prompt: input.prompt,
      ...(input.images === undefined || input.images.length === 0 ? {} : { images: [...input.images] }),
      ...(activationOverrides === undefined ? {} : { activationOverrides }),
      whenBusy: input.whenBusy,
    });
    // The bubble is the send receipt: it exists before anything touches the
    // wire, so the user never waits to see their own message.
    this.beginPromptTransaction(input.sessionId, input.prompt, entry.operationId);
    const settled = new Promise<unknown>((resolve, reject) => {
      this.outboxSettlements.set(entry.operationId, { resolve, reject });
    });
    this.notify();
    this.scheduleOutboxDrain();
    return settled;
  }

  /** Promise settle hooks for queued sends, keyed by operationId. */
  private readonly outboxSettlements = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();

  /**
   * Deliver the oldest un-delivered send of this session, in order. Exactly one
   * delivery is in flight; a failure never settles a send, it only schedules the
   * next attempt on the next transport change (or a bounded backoff).
   */
  private scheduleOutboxDrain(): void {
    if (this.delivering !== null) return;
    const entry = this.outbox.listFor(this.sessionId)[0];
    if (entry === undefined) return;
    this.delivering = entry;
    this.startOutboxDelivery(entry);
  }

  private startOutboxDelivery(entry: OutboxEntry): void {
    if (this.delivering?.operationId !== entry.operationId) return;
    let settled = false;
    void this.waitForOutboxWire().then(
      () => {
        if (settled) return;
        settled = true;
        if (this.delivering?.operationId !== entry.operationId) return;
        if (!this.runtimeConnection.hasFeature(RUNTIME_SUBMIT_TURN_FEATURE)) {
          // No atomic submit seam: the finite legacy prompt command still sends
          // through the SAME outbox (identity, ordering, retry unchanged).
          this.sendLegacyOutboxEntry(entry);
          return;
        }
        this.sendOutboxEntry(entry);
      },
      () => {
        // The transport is not usable right now. Nothing is lost: the entry
        // stays queued and the next usability event retries it.
        settled = true;
        if (this.delivering?.operationId !== entry.operationId) return;
        this.delivering = null;
      },
    );
  }

  /**
   * Bounded wait for a usable transport. The bound belongs to ONE connection
   * attempt, not to the message: a timed-out wait keeps the message queued.
   */
  private waitForOutboxWire(): Promise<void> {
    return (async () => {
      if (this.runtimeConnection.connectionState === "idle") this.runtimeConnection.connect();
      await this.whenSendable(OUTBOX_WIRE_WAIT_MS);
    })();
  }
  private sendOutboxEntry(entry: OutboxEntry): void {
    const request: SubmitTurnRequest = {
      sessionId: entry.sessionId,
      prompt: entry.prompt,
      ...(entry.images === undefined ? {} : { images: [...entry.images] as ImageAttachment[] }),
      ...(entry.activationOverrides === undefined ? {} : { activationOverrides: entry.activationOverrides }),
      operationId: entry.operationId,
      whenBusy: entry.whenBusy,
    };
    // A send restored from storage after a reload has no live transaction yet:
    // re-open one so its bubble is visible again (it was on screen before the
    // page died, and it must stay until the authority commits it).
    this.ensureOutboxTransaction(entry);
    if (this.promptTransaction !== null) this.promptTransaction.phase = "dispatching";
    this.binding.sendAttempt({
      buildMessage: (id) => ({ type: "submit_turn", id, payload: request }),
      expectation: { kind: "submit_turn", sessionId: entry.sessionId, operationId: entry.operationId },
      disconnectPolicy: "logical_retry",
      onSent: () => undefined,
      onFrame: (frame) => {
        if (frame.type !== "submit_turn_result" || this.delivering?.operationId !== entry.operationId) return;
        this.handleOutboxAdmission(entry, frame.payload);
      },
      onSendFailure: () => {
        // The authority may or may not have received it. Both outcomes are safe
        // because the resend carries the SAME operationId and the authority
        // dedupes on its durable receipt — so nothing surfaces to the user.
        if (this.delivering?.operationId !== entry.operationId) return;
        this.retryOutboxOnNextConnection();
      },
      onDisconnect: () => {
        if (this.delivering?.operationId !== entry.operationId) return;
        this.delivering = null;
        // Reconnecting re-triggers the drain from the transport subscription.
      },
    });
  }

  /**
   * Settle one admission frame for the in-flight send.
   *
   * accepted / duplicate → delivered (possibly queued behind the running turn):
   * leave the outbox and follow the turn to terminal. `invalid_input` /
   * `not_found` → the ONLY proven-final outcomes, so give up and let the
   * composer restore the draft. Anything else stays silent and is resent with
   * the same operationId.
   */
  private handleOutboxAdmission(entry: OutboxEntry, admission: SubmitTurnAdmission): void {
    if (admission.status === "accepted" || admission.status === "duplicate") {
      this.outbox.dequeue(entry.operationId);
      this.delivering = null;
      const settlement = this.outboxSettlements.get(entry.operationId);
      this.outboxSettlements.delete(entry.operationId);
      settlement?.resolve(undefined);
      // Capture the bubble identity BEFORE the transaction is released (the
      // accepted turn keeps owning it until the authority commits the entry).
      const optimisticId = this.promptTransaction?.operationId === entry.operationId
        ? this.promptTransaction.optimisticId
        : null;
      if (this.promptTransaction !== null && this.promptTransaction.operationId === entry.operationId) {
        this.settlePromptTransaction(this.promptTransaction, { removeBubble: false, clearRunning: false });
      }
      this.adoptSentTurn(entry, admission, optimisticId);
      this.notify();
      this.scheduleOutboxDrain();
      return;
    }
    if (!isFinalSendRejection(admission.error)) {
      this.retryOutboxOnNextConnection();
      return;
    }
    // Proven final: this message will never be accepted.
    this.outbox.discard(entry.operationId);
    this.delivering = null;
    this.removeOptimisticForOperation(entry.operationId);
    if (this.promptTransaction !== null && this.promptTransaction.operationId === entry.operationId) {
      this.settlePromptTransaction(this.promptTransaction, { removeBubble: true });
    }
    const settlement = this.outboxSettlements.get(entry.operationId);
    this.outboxSettlements.delete(entry.operationId);
    settlement?.reject(this.activationFailure(admission.error));
    this.notify();
    this.scheduleOutboxDrain();
  }

  /**
   * A transient failure keeps the send queued and makes the next CONNECTION
   * event deliver it. There is no backoff timer and no retry counter: a timer
   * would either spin forever on a dead link or keep a headless test process
   * alive, and a counter would eventually give up on the user's message. When
   * the failure happened on a connection that still looks healthy (a retryable
   * authority answer), the transport is reset so a real connection attempt
   * follows and drives the retry.
   */
  private retryOutboxOnNextConnection(): void {
    this.delivering = null;
    const state = this.runtimeConnection.connectionState;
    if (state === "idle") {
      this.runtimeConnection.connect();
      return;
    }
    if (state === "ready" || state === "handshaking" || state === "attaching" || state === "attached") {
      // The answer came over a socket that still looks healthy, so no connection
      // event will follow on its own: reset the transport so ONE real attempt
      // does, and let that attempt drive the retry.
      this.runtimeConnection.recoverTransport("send outbox retry");
      return;
    }
    // Any other state is already reconnecting/unavailable; its transition back
    // to a usable connection is the retry trigger (`onTransportForOutbox`).
    // Nothing is armed here: with no transition there is nothing to recover from.
  }

  /** Transport changes are the retry trigger — never a busy poll. */
  private onTransportForOutbox(): void {
    if (this.delivering !== null) return;
    this.scheduleOutboxDrain();
  }

  /** Remove the speculative bubble owned by one operation (identity-only). */
  private removeOptimisticForOperation(operationId: string): void {
    this.optimisticUserEntries = this.optimisticUserEntries.filter(
      (candidate) => candidate.identity?.operationId !== operationId,
    );
  }

  /**
   * Make sure the send has its bubble/transaction, re-creating it for an entry
   * restored from storage after a reload. Idempotent for the live case.
   */
  private ensureOutboxTransaction(entry: OutboxEntry): void {
    if (this.promptTransaction?.operationId === entry.operationId) return;
    if (this.promptTransaction !== null) return;
    if (this.optimisticUserEntries.some((candidate) => candidate.identity?.operationId === entry.operationId)) return;
    this.beginPromptTransaction(entry.sessionId, entry.prompt, entry.operationId);
  }

  /**
   * FINITE Protocol-v2 shim: a daemon without the atomic submit seam sends
   * through the ordinary prompt command. Identity, ordering and retry are still
   * the outbox's, so the user-visible contract does not change. Removal
   * condition: Protocol v3 minimum (same window as `runtime.submit-turn.v1`).
   */
  private sendLegacyOutboxEntry(entry: OutboxEntry): void {
    const finish = (): void => {
      this.delivering = null;
      this.scheduleOutboxDrain();
    };
    const tx = this.promptTransaction?.operationId === entry.operationId
      ? this.promptTransaction
      : this.beginPromptTransaction(entry.sessionId, entry.prompt, entry.operationId);
    if (tx === null) { finish(); return; }
    tx.phase = "dispatching";
    const commandId = this.id();
    const command: RuntimeCommand = {
      commandId,
      type: "prompt",
      message: entry.prompt,
      ...(entry.images === undefined ? {} : { images: [...entry.images] as ImageAttachment[] }),
    };
    this.binding.sendAttempt({
      buildMessage: (id) => ({ type: "command", id, payload: this.withEpoch({ sessionId: entry.sessionId, command }) }),
      expectation: { kind: "command", sessionId: entry.sessionId, commandId, resultType: "prompt" },
      disconnectPolicy: "logical_retry",
      onSent: () => undefined,
      onFrame: (frame) => {
        if (frame.type !== "response" || frame.id !== commandId) return;
        const payload = frame.payload;
        if (payload.ok) {
          this.outbox.dequeue(entry.operationId);
          const settlement = this.outboxSettlements.get(entry.operationId);
          this.outboxSettlements.delete(entry.operationId);
          settlement?.resolve(payload.result);
          this.settlePromptTransaction(tx, { removeBubble: false, clearRunning: false });
          finish();
          return;
        }
        if (isFinalSendRejection(payload.error)) {
          this.outbox.discard(entry.operationId);
          this.removeOptimisticForOperation(entry.operationId);
          this.settlePromptTransaction(tx, { removeBubble: true });
          const settlement = this.outboxSettlements.get(entry.operationId);
          this.outboxSettlements.delete(entry.operationId);
          settlement?.reject(this.activationFailure(payload.error));
          finish();
          this.notify();
          return;
        }
        finish();
        this.retryOutboxOnNextConnection();
      },
      onSendFailure: () => { finish(); this.retryOutboxOnNextConnection(); },
      onDisconnect: () => { finish(); },
    });
  }

  /** Subscribe to terminal turn status (committed/terminal catalog refresh). */
  subscribeTurnTerminal(listener: (terminal: TurnTerminalInfo) => void): () => void {
    this.turnTerminalListeners.add(listener);
    return () => { this.turnTerminalListeners.delete(listener); };
  }

  /**
   * Send a prompt (ordinary command) with optional images. Requires the runtime
   * already attached to the target session (activation is
   * {@link sendPromptToSession}'s job). Delivery, ordering and retry belong to
   * the outbox, so this never fails for a transient reason.
   */
  sendPrompt(message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(this.activationFailure(this.notAttachedError()));
    return this.submitTurn({
      sessionId: this.sessionId,
      prompt: message,
      ...(images === undefined ? {} : { images }),
    });
  }

  /**
   * Activation-then-send: ONE entry point for sending into an exact session.
   * The admission itself is the activation intent on the negotiated seam (the
   * authority starts the Worker when needed and A→B never detaches A before B
   * is accepted). NEVER creates a session.
   */
  sendPromptToSession(
    sessionId: string,
    message: string,
    images?: readonly ImageAttachment[],
    activationSettings?: PromptActivationSettings,
  ): Promise<unknown> {
    if (!sessionId) {
      return Promise.reject(this.activationFailure({
        code: "invalid_input",
        message: "no session selected",
        retryable: false,
      } satisfies ProtocolError));
    }
    if (sessionId !== this.sessionId) return Promise.reject(this.activationFailure(this.identityMismatchError(sessionId)));
    return this.submitTurn({
      sessionId,
      prompt: message,
      ...(images === undefined ? {} : { images }),
      ...(activationSettings?.whenBusy === undefined ? {} : { whenBusy: activationSettings.whenBusy }),
      activationOverrides: {
        ...(activationSettings?.model === undefined || activationSettings.model === null ? {} : { model: activationSettings.model }),
        ...(activationSettings?.thinkingLevel === undefined || activationSettings.thinkingLevel === null ? {} : { thinkingLevel: activationSettings.thinkingLevel }),
      },
    });
  }

  // --- D2-P8 extension-UI final response -------------------------------------
  //
  // `respondExtensionUi` is the ONLY Client transport for the FINAL response to
  // a pending extension request. It uses the dedicated single-in-flight
  // {@link pendingExtensionUiCommand} slot (NOT {@link sendCommand}), because the
  // prompt that triggered the UI is still the pending ordinary command —
  // `sendCommand` would be `session_busy`. It builds the exact
  // `extension_ui_response` command, mints the commandId, binds `id`/`method`
  // from the authoritative pending request and unwraps the correlated ack. It
  // never trims/coerces the reply, and validates attached +
  // `runtime.extension_ui` + request method/reply compatibility before any send.

  /**
   * Send the final response to a pending interactive extension request.
   * `request` must be the authoritative pending request from the snapshot; the
   * command carries that exact `id`/`method`. `reply` shape must be compatible
   * with the request method (see {@link ExtensionUiReply}). Resolves once the
   * runtime acks the correlated `extension_ui_response`; rejects with the
   * structured ProtocolError on any failure (busy / wrong method / not_found /
   * transport / epoch change).
   */
  respondExtensionUi(request: ExtensionUiRequest, reply: ExtensionUiReply): Promise<void> {
    if (!this.attached || !this.sessionId) {
      return Promise.reject(this.notAttachedError());
    }
    if (!this.hasRuntimeCapability("runtime.extension_ui")) {
      return Promise.reject({
        code: "unsupported_capability",
        message: "runtime does not support extension UI",
        retryable: false,
      } satisfies ProtocolError);
    }
    const method = request.method;
    if (!isInteractiveExtensionMethod(method)) {
      return Promise.reject({
        code: "invalid_input",
        message: "a non-interactive extension request cannot be answered",
        retryable: false,
      } satisfies ProtocolError);
    }
    const incompatibility = extensionReplyIncompatibility(method, reply);
    if (incompatibility !== null) {
      return Promise.reject({
        code: "invalid_input",
        message: incompatibility,
        retryable: false,
      } satisfies ProtocolError);
    }
    if (this.pendingExtensionUiCommand) {
      return Promise.reject({
        code: "session_busy",
        message: "an extension UI response is already in progress",
        retryable: false,
      } satisfies ProtocolError);
    }
    const sessionId = this.sessionId;
    const commandId = this.id();
    // Compatibility is validated above (extensionReplyIncompatibility); the
    // spread union is narrowed by `responseKind`, matching one of the Protocol
    // `extension_ui_response` members (the outer union needs the explicit cast,
    // same as runTypedCommand). No payload coercion/trim.
    const command = {
      commandId,
      type: "extension_ui_response",
      id: request.id,
      method,
      ...reply,
    } as RuntimeCommand;
    const wsMessage: WsClientMessage = { type: "command", id: this.id(), payload: this.withEpoch({ sessionId, command }) };
    return new Promise<void>((resolve, reject) => {
      const pending: ExtensionUiPending = {
        commandId,
        attempt: null,
        sessionId,
        command: wsMessage,
        requestId: request.id,
        method,
        resolve: () => resolve(),
        reject,
      };
      this.pendingExtensionUiCommand = pending;
      this.notify();
      this.sendExtensionUiAttempt(pending);
    });
  }

  // --- D2-P4 queued-turn / queue-control API ---------------------------------
  //
  // steer / follow_up use the INDEPENDENT dual-slot {@link pendingQueuedTurn}
  // so a long-running prompt never blocks them (unlike {@link sendCommand},
  // which is `session_busy` while a prompt is in flight). A queued turn is
  // still a `RuntimeCommand` on the ordinary command envelope and the runtime
  // answers with a correlated result, so an unsupported capability resolves
  // honestly as `unsupported_capability` (the UI gates by capability).
  // clear_queue is an INTERRUPT (independent non-queued control path) with
  // typed admission: at most one interrupt type in flight — a different type
  // returns `session_busy`, the same type coalesces like abort.

  /**
   * Queue a steering message. Requires `runtime.steer` at the runtime.
   * Message is strictly trimmed and must be non-empty (`invalid_input`
   * otherwise). Images pass through but this UI only sends text.
   */
  steer(message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    return this.sendQueuedTurn("steer", message, images);
  }

  /**
   * Queue a follow-up message. Requires `runtime.follow_up` at the runtime.
   * Message is strictly trimmed and must be non-empty (`invalid_input`
   * otherwise). Images pass through but this UI only sends text.
   */
  followUp(message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    return this.sendQueuedTurn("follow_up", message, images);
  }

  /**
   * Clear the runtime's queued steering/follow-up turns via the independent
   * clear_queue interrupt. Requires `runtime.queue` at the runtime. Never
   * coalesces with a pending abort — typed interrupt admission returns
   * `session_busy` when a DIFFERENT interrupt type is already in flight.
   */
  clearQueue(): Promise<unknown> {
    return this.sendInterrupt({ type: "clear_queue" });
  }

  /**
   * Switch one queued message between the steering and follow-up queues via
   * the explicit `switch_queued_delivery` runtime command (requires
   * `runtime.queue`). The address is a revision fence — (list, index, exact
   * text) of the entry the caller saw; the runtime fails closed (`conflict` /
   * `not_found`) when the queue changed underneath or the entry is already
   * being delivered. Uses the ordinary single command slot: quick queue
   * surgery, independent of the steer/follow-up queued-turn slot.
   */
  switchQueuedDelivery(address: { list: "steering" | "followUp"; index: number; message: string }): Promise<void> {
    const message = address.message.trim();
    if (message.length === 0) {
      return Promise.reject({
        code: "invalid_input",
        message: "message cannot be empty",
        retryable: false,
      } satisfies ProtocolError);
    }
    if (!Number.isInteger(address.index) || address.index < 0) {
      return Promise.reject({
        code: "invalid_input",
        message: "queue index must be a non-negative integer",
        retryable: false,
      } satisfies ProtocolError);
    }
    return this.runTypedCommand(
      { type: "switch_queued_delivery", list: address.list, index: address.index, message },
      (outcome) => {
        if (outcome.type !== "switch_queued_delivery") throw new Error("unexpected switch_queued_delivery result");
      },
    );
  }

  // --- D2-P1 typed runtime command helpers -----------------------------------
  //
  // Each helper mints its own commandId, reuses the single-inflight
  // {@link sendCommand} correlation (honest `session_busy` on concurrency) and
  // unwraps the correlated result: an `ok:false` outcome rejects with its
  // ProtocolError (including a capability-gated `unsupported_capability`), a
  // success returns only the command's payload. Callers gate by capability via
  // {@link hasRuntimeCapability} (the UI does this); the helpers themselves
  // stay honest and let the runtime answer.

  /**
   * Query the current canonical runtime state. Phase 2B: when attached, the
   * state is derived from the authoritative projection CLONE and NO read frame
   * is sent. When not attached (or no snapshot), the negotiated read RPC is
   * used; without the feature the finite legacy command-envelope shim applies.
   */
  getState(): Promise<RuntimeState> {
    if (this.attached && this.snapshot !== null) {
      return Promise.resolve(structuredClone(this.snapshot.state));
    }
    if (this.runtimeConnection.hasFeature(RUNTIME_READ_RPC_FEATURE)) return this.runTypedRead({ type: "get_state" }, (outcome) => {
      if (outcome.type !== "get_state") throw new Error("unexpected get_state result");
      return outcome.state;
    });
    return this.runTypedCommand({ type: "get_state" }, (outcome) => {
      if (outcome.type !== "get_state") throw new Error("unexpected get_state result");
      return outcome.state;
    });
  }

  /** List the runtime's slash commands. Always available. */
  getCommands(): Promise<readonly SlashCommandInfo[]> {
    if (this.runtimeConnection.hasFeature(RUNTIME_READ_RPC_FEATURE)) return this.runTypedRead({ type: "get_commands" }, (outcome) => {
      if (outcome.type !== "get_commands") throw new Error("unexpected get_commands result");
      return outcome.commands;
    });
    return this.runTypedCommand({ type: "get_commands" }, (outcome) => {
      if (outcome.type !== "get_commands") throw new Error("unexpected get_commands result");
      return outcome.commands;
    });
  }

  /**
   * @deprecated Legacy compatibility — there is NO production caller (the UI
   * derives the last assistant text from the shared projection). When the read
   * RPC is negotiated it uses the dedicated read envelope; otherwise the finite
   * legacy command-envelope shim.
   */
  getLastAssistantText(): Promise<string> {
    if (this.runtimeConnection.hasFeature(RUNTIME_READ_RPC_FEATURE)) return this.runTypedRead({ type: "get_last_assistant_text" }, (outcome) => {
      if (outcome.type !== "get_last_assistant_text") throw new Error("unexpected get_last_assistant_text result");
      return outcome.text;
    });
    return this.runTypedCommand({ type: "get_last_assistant_text" }, (outcome) => {
      if (outcome.type !== "get_last_assistant_text") throw new Error("unexpected get_last_assistant_text result");
      return outcome.text;
    });
  }

  /** Session statistics. Requires the `runtime.stats` capability. */
  getSessionStats(): Promise<SessionStats> {
    if (this.runtimeConnection.hasFeature(RUNTIME_READ_RPC_FEATURE)) return this.runTypedRead({ type: "get_session_stats" }, (outcome) => {
      if (outcome.type !== "get_session_stats") throw new Error("unexpected get_session_stats result");
      return outcome.stats;
    });
    return this.runTypedCommand({ type: "get_session_stats" }, (outcome) => {
      if (outcome.type !== "get_session_stats") throw new Error("unexpected get_session_stats result");
      return outcome.stats;
    });
  }

  /**
   * Rename the session. Requires the `runtime.session.rename` capability.
   * Resolves once the runtime confirms the command; callers refresh the
   * snapshot (fetchSnapshot) to see the new sessionName. This helper NEVER
   * writes to a history/catalog projection — persistence is the runtime's job.
   */
  setSessionName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return Promise.reject({
        code: "invalid_input",
        message: "session name cannot be empty",
        retryable: false,
      } satisfies ProtocolError);
    }
    return this.runTypedCommand({ type: "set_session_name", name: trimmed }, (outcome) => {
      if (outcome.type !== "set_session_name") throw new Error("unexpected set_session_name result");
    });
  }

  /**
   * Set the session thinking level. Requires the `runtime.thinking.set`
   * capability. Resolves once the runtime confirms the command; callers
   * refresh the snapshot (fetchSnapshot) to see the new thinkingLevel and
   * thinkingLevelPinned. Level is typed from Protocol {@link ThinkingLevel}
   * — never a free-form string.
   */
  setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return this.runTypedCommand({ type: "set_thinking_level", level }, (outcome) => {
      if (outcome.type !== "set_thinking_level") throw new Error("unexpected set_thinking_level result");
    });
  }

  /**
   * Switch the session model. Requires the `runtime.model.set` capability.
   * Resolves once the runtime confirms the command; callers refresh the
   * snapshot (fetchSnapshot) to see the authoritative new `model` (and the
   * re-clamped thinkingLevel / thinkingLevelPinned, since the adapter
   * reapplies pinned thinking after a model change). `provider`/`modelId`
   * must both be non-empty — the store never sends a blank model selector.
   */
  setModel(provider: string, modelId: string): Promise<void> {
    if (typeof provider !== "string" || provider.trim().length === 0 || typeof modelId !== "string" || modelId.trim().length === 0) {
      return Promise.reject({
        code: "invalid_input",
        message: "model provider and modelId must be non-empty",
        retryable: false,
      } satisfies ProtocolError);
    }
    return this.runTypedCommand({ type: "set_model", provider, modelId }, (outcome) => {
      if (outcome.type !== "set_model") throw new Error("unexpected set_model result");
    });
  }

  // --- D2-P6 tools + reload runtime control ------------------------------
  //
  // `getTools` is a QUERY: it resolves from the correlated result payload and
  // NEVER triggers a sessiond authority snapshot refresh (same as get_state /
  // get_commands). `setTools` and `reload` are typed helpers on the ordinary
  // single-inflight {@link sendCommand} slot; their success is authority-
  // finalized by sessiond (bounded worker.getSnapshot refresh converges
  // state.tools / systemPrompt / capabilities BEFORE the terminal result is
  // released/cached), so the helpers trust the runtime's authoritative answer
  // and make NO optimistic state writes. Callers gate by capability
  // (`runtime.tools.read` / `runtime.tools.write` / `runtime.reload`) via
  // {@link hasRuntimeCapability}; the helpers stay honest and let the runtime
  // answer `unsupported_capability` if a caller does not gate.

  /**
   * Query the runtime's current tool list with active flags. Requires
   * `runtime.tools.read` at the runtime. Phase 2B: when attached, the tool list
   * is derived from the authoritative projection CLONE and NO read frame is
   * sent; missing projection data FAILS CLOSED (never a `[]` fallback). When
   * not attached, the negotiated read RPC is used; without the feature the
   * finite legacy command-envelope shim applies.
   */
  getTools(): Promise<readonly ToolInfo[]> {
    if (this.attached && this.snapshot !== null) {
      const tools = this.snapshot.state.tools;
      if (tools !== undefined) return Promise.resolve(structuredClone([...tools]));
      if (this.runtimeConnection.hasFeature(RUNTIME_READ_RPC_FEATURE)) {
        return Promise.reject({
          code: "unavailable",
          message: "tools are not available in the session snapshot",
          retryable: true,
        } satisfies ProtocolError);
      }
      // Protocol-v2 peers without the dedicated read feature may still have
      // older snapshots that omit tools; use the explicit legacy command shim
      // rather than fabricating an empty list.
    }
    if (this.runtimeConnection.hasFeature(RUNTIME_READ_RPC_FEATURE)) return this.runTypedRead({ type: "get_tools" }, (outcome) => {
      if (outcome.type !== "get_tools") throw new Error("unexpected get_tools result");
      return outcome.tools;
    });
    return this.runTypedCommand({ type: "get_tools" }, (outcome) => {
      if (outcome.type !== "get_tools") throw new Error("unexpected get_tools result");
      return outcome.tools;
    });
  }

  /**
   * Set the runtime's active tools. Requires `runtime.tools.write` at the
   * runtime. Names are strictly trimmed and de-duplicated (order preserved);
   * an all-blank name is `invalid_input` before any command is sent (consistent
   * with the Protocol `set_tools` schema which requires each name to contain a
   * non-whitespace character). `options.includeExtensionTools` passes the
   * existing wire option through verbatim (default true; the global tools
   * preference applier uses false so the exact list is applied as-is). Resolves
   * only once sessiond's authoritative snapshot refresh has converged
   * `state.tools` and the related systemPrompt; the store makes no optimistic
   * writes.
   */
  setTools(names: readonly string[], options?: { includeExtensionTools?: boolean }): Promise<void> {
    const trimmed: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (name.length === 0) {
        return Promise.reject({
          code: "invalid_input",
          message: "tool names must be non-empty",
          retryable: false,
        } satisfies ProtocolError);
      }
      if (!seen.has(name)) { seen.add(name); trimmed.push(name); }
    }
    return this.runTypedCommand({
      type: "set_tools",
      toolNames: trimmed,
      ...(options?.includeExtensionTools === undefined ? {} : { includeExtensionTools: options.includeExtensionTools }),
    }, (outcome) => {
      if (outcome.type !== "set_tools") throw new Error("unexpected set_tools result");
    });
  }

  /**
   * Reload the runtime (tools, systemPrompt, thinking pin/state and final
   * capabilities converge). Requires `runtime.reload` at the runtime. Resolves
   * only once sessiond's authoritative snapshot refresh has converged the
   * snapshot — never relies on the partial capability event alone.
   */
  reload(): Promise<void> {
    return this.runTypedCommand({ type: "reload" }, (outcome) => {
      if (outcome.type !== "reload") throw new Error("unexpected reload result");
    });
  }

  // --- side-chat control -------------------------------------------------

  /** Idempotently initialize the ephemeral side conversation for this exact runtime. */
  sideChatStart(): Promise<string> {
    if (!this.sideChatAvailable()) return Promise.reject(this.sideChatUnavailableError());
    const existing = this.snapshot?.state.sideChat;
    if (existing) return Promise.resolve(existing.conversationId);
    return this.runSideChatCommand({ type: "side_chat_start" }, (outcome) => {
      if (outcome.type !== "side_chat_start") throw new Error("unexpected side_chat_start result");
      return outcome.conversationId;
    });
  }

  /** Admit one side-chat message without occupying or mutating the main turn lane. */
  sideChatSend(conversationId: string, message: string): Promise<string> {
    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_SIDE_CHAT_MESSAGE_CHARS) {
      return Promise.reject(this.activationFailure({
        code: "invalid_input",
        message: trimmed.length === 0 ? "side chat message cannot be empty" : "side chat message is too long",
        retryable: false,
      } satisfies ProtocolError));
    }
    return this.runSideChatCommand({ type: "side_chat_send", conversationId, message: trimmed }, (outcome) => {
      if (outcome.type !== "side_chat_send") throw new Error("unexpected side_chat_send result");
      return outcome.runId;
    });
  }

  sideChatReset(conversationId: string, mode: "refork" | "clear"): Promise<string> {
    return this.runSideChatCommand({ type: "side_chat_reset", conversationId, mode }, (outcome) => {
      if (outcome.type !== "side_chat_reset") throw new Error("unexpected side_chat_reset result");
      return outcome.conversationId;
    });
  }

  /** Apply model + thinking level to subsequent side-chat turns (idle only). */
  sideChatSetModel(conversationId: string, provider: string, modelId: string, thinkingLevel: ThinkingLevel): Promise<void> {
    return this.runSideChatCommand({ type: "side_chat_set_model", conversationId, provider, modelId, thinkingLevel }, (outcome) => {
      if (outcome.type !== "side_chat_set_model") throw new Error("unexpected side_chat_set_model result");
    });
  }

  abortSideChat(conversationId: string): Promise<unknown> {
    if (!this.sideChatAvailable()) {
      return Promise.reject(this.sideChatUnavailableError());
    }
    return this.sendInterrupt({ type: "abort_side_chat", conversationId });
  }

  // --- D2-P7 compact runtime control --------------------------------
  //
  // `compact` is an ORDINARY command on the single-inflight {@link sendCommand}
  // slot: while a prompt / bash / tools / reload (or another compact) is
  // pending, a compact is honestly `session_busy` and NEVER overwrites the
  // first waiter. Its success is authority-finalized by sessiond (bounded
  // worker.getSnapshot refresh converges messages/messageCount/contextUsage /
  // isCompacting BEFORE the terminal result is released/cached), so the helper
  // makes NO optimistic state writes and trusts the runtime's authoritative
  // answer. `abortCompaction` is an INTERRUPT (independent non-queued control
  // path, never HOL-blocked behind the compact) with typed admission. No UI is
  // added in this slice; `set_auto_compaction` stays wire-open under
  // `runtime.compact` but intentionally has NO Client helper here.

  /**
   * Manually compact the runtime. Requires `runtime.compact` at the runtime.
   * `customInstructions`, when provided, is validated STRICTLY (must be a
   * non-blank string; never silently trimmed/reinterpreted — the value is
   * forwarded to the runtime exactly as given) and then passed through.
   * Resolves only once sessiond's authoritative snapshot refresh has converged
   * the full post-compaction snapshot (messages, messageCount, contextUsage,
   * isCompacting). On a failed/interrupted compact the runtime answers
   * `ok:false` and this helper rejects with the structured ProtocolError.
   */
  compact(customInstructions?: string): Promise<void> {
    if (customInstructions !== undefined) {
      if (typeof customInstructions !== "string" || customInstructions.trim().length === 0) {
        return Promise.reject({
          code: "invalid_input",
          message: "customInstructions cannot be blank",
          retryable: false,
        } satisfies ProtocolError);
      }
    }
    return this.runTypedCommand(
      { type: "compact", ...(customInstructions === undefined ? {} : { customInstructions }) },
      (outcome) => {
        if (outcome.type !== "compact") throw new Error("unexpected compact result");
      },
    );
  }

  /**
   * Abort the running compaction via the INDEPENDENT interrupt path (never
   * HOL-blocked behind the compact command). Requires `runtime.compact.abort`
   * at the runtime. Typed interrupt admission: same-type aborts coalesce, a
   * different in-flight interrupt type returns `session_busy`.
   */
  abortCompaction(): Promise<unknown> {
    return this.sendInterrupt({ type: "abort_compaction" });
  }

  // --- D2-P5 bash runtime control ------------------------------------------
  //
  // `runBash` is an ORDINARY command (single-inflight {@link pendingCommand}
  // slot): while a prompt (or any other ordinary command) is pending, a second
  // ordinary command — including a second bash — is honestly `session_busy` and
  // NEVER overwrites the first waiter. The accumulated output/cancelled/
  // exitCode/truncated/fullOutputPath arrive via `bash_update` deltas through
  // the SHARED Protocol projection into {@link ControllerView.snapshot.state.bash}
  // (no sessiond authority snapshot-finalization is involved), so `runBash`
  // resolves as a bare ack once the runtime settles and callers read the
  // snapshot for output. `abortBash` is an INTERRUPT (independent non-queued
  // control path) with typed admission: it never waits behind the running bash
  // command and never串线 into another interrupt type's promise.

  /**
   * Run a bash command. Requires `runtime.bash` at the runtime. The command is
   * strictly trimmed and must be non-empty (`invalid_input` otherwise); output
   * streams through the shared projection into `snapshot.state.bash` while the
   * command is in flight and stays accumulated after completion. Resolves as a
   * bare ack; on an aborted run the runtime answers `interrupted` (rejected
   * here) and the snapshot still carries the cancelled projection.
   */
  runBash(command: string, options?: { excludeFromContext?: boolean }): Promise<void> {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return Promise.reject({
        code: "invalid_input",
        message: "command cannot be empty",
        retryable: false,
      } satisfies ProtocolError);
    }
    return this.runTypedCommand(
      { type: "bash", command: trimmed, ...(options?.excludeFromContext === undefined ? {} : { excludeFromContext: options.excludeFromContext }) },
      (outcome) => {
        if (outcome.type !== "bash") throw new Error("unexpected bash result");
      },
    );
  }

  /**
   * Abort the running bash command via the INDEPENDENT interrupt path (never
   * HOL-blocked behind the long bash command). Requires `runtime.bash.abort` at
   * the runtime. Typed interrupt admission: same-type aborts coalesce, a
   * different in-flight interrupt type returns `session_busy`.
   */
  abortBash(): Promise<unknown> {
    return this.sendInterrupt({ type: "abort_bash" });
  }

  /**
   * Send a typed side-chat mutation through its dedicated bounded lane. It is
   * independent of the main command/turn slots and coalesces repeated starts.
   */
  private runSideChatCommand<T>(
    command: SideChatCommandWithoutId,
    extract: (outcome: Extract<RuntimeCommandOutcome, { ok: true }>) => T,
  ): Promise<T> {
    if (!this.sideChatAvailable()) {
      const error = this.sideChatUnavailableError();
      return Promise.reject(command.type === "side_chat_send" ? this.activationFailure(error) : error);
    }
    const active = this.pendingSideChatCommand;
    if (active !== null) {
      if (active.type === "side_chat_start" && command.type === "side_chat_start") {
        return active.promise.then((value) => this.extractSideChatResult(value, extract));
      }
      const error = { code: "session_busy", message: "a side chat command is already in progress", retryable: false } satisfies ProtocolError;
      return Promise.reject(command.type === "side_chat_send" ? this.activationFailure(error) : error);
    }
    const commandId = this.id();
    const runtimeCommand = { ...command, commandId } as RuntimeCommand;
    const sessionId = this.sessionId;
    const message: WsClientMessage = { type: "command", id: this.id(), payload: this.withEpoch({ sessionId, command: runtimeCommand }) };
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const pending: SideChatCommandPending = {
      commandId,
      attempt: null,
      wireSeen: false,
      sessionId,
      command: message,
      type: command.type,
      promise,
      timer: null,
      resolve,
      reject,
    };
    this.pendingSideChatCommand = pending;
    pending.timer = this.setTimeoutFn(() => {
      if (this.pendingSideChatCommand !== pending) return;
      this.pendingSideChatCommand = null;
      pending.attempt?.cancel();
      pending.attempt = null;
      pending.timer = null;
      pending.reject(pending.type === "side_chat_send" && !pending.wireSeen
        ? this.activationFailure({ code: "timeout", message: "side chat command timed out", retryable: true })
        : { code: "timeout", message: "side chat command timed out", retryable: true } satisfies ProtocolError);
      this.notify();
    }, this.sideChatCommandTimeoutMs);
    this.sendSideChatCommandAttempt(pending);
    this.notify();
    return promise.then((value) => this.extractSideChatResult(value, extract));
  }

  private extractSideChatResult<T>(
    value: unknown,
    extract: (outcome: Extract<RuntimeCommandOutcome, { ok: true }>) => T,
  ): T {
    const correlated = value as CorrelatedRuntimeCommandResult;
    if (!correlated.result.ok) throw correlated.result.error;
    return extract(correlated.result);
  }

  /**
   * Send a typed command through the single-inflight {@link sendCommand} path
   * with an internally-minted commandId, then unwrap the correlated result.
   * `extract` runs only on an `ok:true` outcome (the error path rejects).
   *
   * `command` uses a distributive Omit so each RuntimeCommand variant keeps its
   * own discriminant fields (a plain `Omit<RuntimeCommand, "commandId">` would
   * collapse the union and reject valid variants like `set_session_name`).
   */
  private runTypedCommand<T>(
    command: RuntimeCommandWithoutId,
    extract: (outcome: Extract<RuntimeCommandOutcome, { ok: true }>) => T,
  ): Promise<T> {
    return this.sendCommand({ ...command, commandId: this.id() } as RuntimeCommand).then((value) => {
      const correlated = value as CorrelatedRuntimeCommandResult;
      if (!correlated.result.ok) throw correlated.result.error;
      return extract(correlated.result);
    });
  }

  /**
   * Phase 2B typed read helper: send a read on the DEDICATED read envelope
   * (negotiated `runtime.read-rpc.v1`), correlated by (sessionId, epoch,
   * requestId, generation, read type) — never the mutation commandId ledger.
   * An `ok:false` outcome rejects with its ProtocolError; success extracts the
   * typed payload.
   */
  private runTypedRead<T>(
    read: { type: RuntimeReadType },
    extract: (outcome: Extract<RuntimeReadOutcome, { ok: true }>) => T,
  ): Promise<T> {
    return this.sendRead(read).then((outcome) => {
      if (!outcome.ok) throw outcome.error;
      return extract(outcome);
    });
  }

  /**
   * Send one Phase 2B read frame and register a bounded pending read slot.
   * Requires an attached session with a non-null epoch (the read carries the
   * exact expected epoch; a stale-epoch read fails closed at sessiond and the
   * client settles it). Each slot settles exactly once; no automatic resend.
   */
  private sendRead(read: { type: RuntimeReadType }): Promise<RuntimeReadOutcome> {
    if (!this.attached || !this.sessionId || this.epoch === null) {
      return Promise.reject(this.notAttachedError());
    }
    if (this.pendingReads.size >= MAX_PENDING_READS) {
      return Promise.reject({
        code: "session_busy",
        message: "too many runtime reads are pending",
        retryable: true,
      } satisfies ProtocolError);
    }
    const requestId = this.id();
    const sessionId = this.sessionId;
    const epoch = this.epoch;
    const readType = read.type;
    const message: WsClientMessage = {
      type: "read",
      id: requestId,
      payload: { sessionId, epoch, read },
    };
    return new Promise<RuntimeReadOutcome>((resolve, reject) => {
      const pending: ReadPending = { requestId, sessionId, epoch, attempt: null, readType, resolve, reject };
      this.pendingReads.set(requestId, pending);
      this.sendReadAttempt(pending, message);
    });
  }

  /** Abort the running prompt via the INDEPENDENT interrupt path (not queued). */
  abort(): Promise<unknown> {
    return this.sendInterrupt({ type: "abort" });
  }

  /**
   * D2-P4 typed interrupt admission (safe clear-vs-abort isolation). At most
   * ONE interrupt type is ever in flight:
   *  - same type as the in-flight interrupt → coalesce to the existing promise
   *    (existing abort policy preserved);
   *  - a DIFFERENT type → `session_busy`, never串线 into the other's promise.
   * The pending interrupt is correlated by (envelopeId, generation, commandId,
   * interrupt type) so a clear_queue result can never resolve an abort caller
   * or vice versa.
   */
  private sendInterrupt(interrupt: RuntimeInterrupt): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(this.notAttachedError());
    if (this.pendingInterrupt) {
      const pendingInterrupt = this.pendingInterrupt.message.payload.interrupt;
      const sameType = pendingInterrupt.type === interrupt.type;
      const sameTarget = pendingInterrupt.type !== "abort_side_chat"
        || (interrupt.type === "abort_side_chat" && pendingInterrupt.conversationId === interrupt.conversationId);
      if (sameType && sameTarget && this.pendingInterruptPromise) {
        return this.pendingInterruptPromise;
      }
      return Promise.reject({
        code: "session_busy",
        message: "another interrupt is already in progress",
        retryable: false,
      } satisfies ProtocolError);
    }
    const sessionId = this.sessionId;
    const commandId = this.id();
    const wsMessage: WsInterruptMessage = {
      type: "interrupt",
      id: this.id(),
      payload: this.withEpoch({ sessionId, commandId, interrupt }),
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: InterruptPending = { commandId, attempt: null, sessionId, message: wsMessage, resolve, reject };
      this.pendingInterrupt = pending;
      this.sendInterruptAttempt(pending);
    });
    this.pendingInterruptPromise = promise;
    return promise;
  }

  // --- external store (useSyncExternalStore) -----------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ControllerView => this.view;

  /** See {@link ControllerView.resuming}. */
  private get resuming(): boolean {
    return !this.attached
      && this.intendedSession !== null
      && this.intendedSession.sessionId === this.sessionId
      && this.authorityCursorKnown
      && this.epoch !== null
      && this.snapshot !== null
      && !this.sessionStopped
      && !this.stopping
      && !this.fatal
      && !this.runtimeConnection.getSnapshot().fatal;
  }

  /** Narrow registry seams; no private lane fields are inspected externally. */
  get attachedNow(): boolean { return this.attached; }
  get sessionStoppedNow(): boolean { return this.sessionStopped; }
  get hasAttachIntent(): boolean { return this.intendedSession !== null || this.attach !== null; }
  get hasAtomicTurn(): boolean { return this.pendingTurn !== null; }
  get hasDetachInFlight(): boolean { return this.detachPromise !== null; }
  get hasPendingInterrupt(): boolean { return this.pendingInterrupt !== null; }
  get hasRetainedOptimism(): boolean { return this.optimisticUserEntries.length > 0 || this.optimisticPromptRunning; }
  get evictionProtection(): ControllerEvictionProtection {
    const optimisticEntries = this.optimisticUserEntries.length > 0;
    const optimisticTransaction = this.promptTransaction !== null;
    const stagedActivation = this.promptTransaction?.phase === "activating";
    const stoppingTransition = this.stopping || this.stopPromise !== null;
    const attachIntent = this.intendedSession !== null || this.attach !== null || this.attachAttempt !== null;
    const explicitActivation = this.explicitActivationPending;
    const quiescent = !this.attached && !attachIntent
      && this.pendingCommand === null && this.pendingSideChatCommand === null && this.pendingReads.size === 0
      && this.pendingInterrupt === null && this.pendingQueuedTurn === null
      && this.pendingExtensionUiCommand === null
      && this.pendingTurn === null && !optimisticTransaction && !optimisticEntries
      && !this.optimisticPromptRunning && !stagedActivation
      && !stoppingTransition && !explicitActivation && this.detachPromise === null;
    return {
      attached: this.attached,
      attachIntent,
      pendingCommand: this.pendingCommand !== null,
      pendingSideChatCommand: this.pendingSideChatCommand !== null,
      pendingRead: this.pendingReads.size > 0,
      pendingInterrupt: this.pendingInterrupt !== null,
      pendingQueuedTurn: this.pendingQueuedTurn !== null,
      pendingExtensionResponse: this.pendingExtensionUiCommand !== null,
      optimisticTransaction,
      optimisticEntries,
      runningOverlay: this.optimisticPromptRunning,
      stagedActivation,
      stoppingTransition,
      explicitActivation,
      quiescent,
    };
  }

  /** Cancel a superseded acquisition locally. Never detach or stop. */
  cancelObservationIntent(error: ProtocolError): void {
    this.intendedSession = null;
    this.rejectAttach(error);
    if (!this.attached) this.setConnection(this.runtimeConnection.connectionState === "stopped" ? "stopped" : "ready");
    this.notify();
  }

  /** Structured observation-release failure; never a Worker stop. */
  setObservationError(error: ProtocolError): void {
    this.setError(error);
  }

  /** Fail-closed local observation teardown. Never stop the Worker. */
  releaseLocalObservation(): void {
    this.finishLocalObservationRelease(this.observationId);
  }

  private finishLocalObservationRelease(observationId: number): void {
    if (this.releasedObservationId === observationId) return;
    if (this.observationId !== observationId) return;
    this.releasedObservationId = observationId;
    this.admittedSnapshot = null;
    this.attachedFenceRevision = null;
    this.attached = false;
    this.intendedSession = null;
    this.attachGeneration += 1;
    this.attachGen = (this.attachGen ?? 0) + 1;
    this.rejectAttach({ code: "interrupted", message: "detached", retryable: false });
    this.settlePendingSideChatCommand({ code: "interrupted", message: "detached", retryable: false });
    this.connection = this.runtimeConnection.connectionState === "stopped" ? "stopped" : "ready";
    this.notify();
  }

  // --- RuntimeControllerPort --------------------------------------------

  onTransportState(state: ConnectionState): void {
    const generation = this.runtimeConnection.currentGeneration;
    const sameGenerationFacade = (this.connection === "attaching" && this.attachAttempt?.handle.generation === generation)
      || (this.connection === "attached" && this.attachGen === generation);
    const metadataOnlyReady = state === "ready" && sameGenerationFacade;
    if (!metadataOnlyReady) {
      if (this.attached && state !== "attached") this.invalidateAdmittedSnapshot();
      this.connection = state;
      this.attached = false;
      if (state === "ready") {
        if (!this.runtimeConnection.hasPendingCreate && this.intendedSession && !this.sessionStopped && !this.stopping) this.resumeAttach();
      } else if (state === "unavailable" || state === "reconnecting") {
        this.onTransportLoss();
      }
    }
    const transport = this.runtimeConnection.getSnapshot();
    this.fatal = transport.fatal;
    if (transport.error !== null) this.error = transport.error;
    this.notify();
  }

  onTransportFatal(error: ProtocolError): void {
    this.fatal = true;
    this.error = error;
    this.failAllPending(error);
    this.notify();
  }

  onSnapshot(message: WsSnapshotMessage, generation: number): void {
    const payload = message.payload;
    if (this.attached && generation === this.attachGen && payload.sessionId === this.sessionId) {
      const priorSessionId = this.sessionId;
      const priorEpoch = this.epoch;
      const mode = payload.resumeStatus === "epoch_changed" || payload.resumeStatus === "gap" ? "rebase" : "same-epoch";
      if (this.isLowerSameEpochSnapshot(payload, mode)) return;
      this.applySnapshot(payload, mode);
      // Push snapshots (not only attach responses) are lifecycle boundaries.
      // Phase 5B sends an id-less epoch_changed snapshot to the existing attach;
      // every old-epoch pending lane must settle exactly once and never resend.
      // Same-epoch gap/snapshot keeps the existing resend semantics.
      this.resyncAfterAttach(payload.resumeStatus, payload.epoch, priorSessionId, priorEpoch);
      this.notify();
    }
  }

  onEvent(message: WsEventMessage, generation: number): void {
    if (!this.attached || generation !== this.attachGen) return;
    const event = message.payload;
    const decision: EventApplyDecision = decideEvent(event, {
      epoch: this.epoch,
      lastEventId: this.lastEventId,
    });
    if (decision.decision === "apply") {
      if (this.snapshot === null) return;
      try {
        this.snapshot = reduceRuntimeEventData(this.snapshot, event as RuntimeEventData);
        this.lastEventId = event.eventId;
        this.attachedFenceRevision = Math.max(this.attachedFenceRevision ?? event.eventId, event.eventId);
        if (event.type === "running_sessions_changed") this.binding.acceptLegacyRunningEvent(event);
        if (this.optimisticPromptRunning
          && this.optimisticPromptSessionId === event.sessionId
          && (
            this.snapshot.state.isPromptRunning === true
            || this.snapshot.state.isStreaming === true
            || event.type === "agent_settled"
            || event.type === "prompt_done"
            || event.type === "prompt_error"
            || event.type === "worker_crashed"
            || event.type === "runtime_unavailable"
            || event.type === "runtime_closed"
            || (event.type === "message_end" && event.message.role === "assistant")
          )) {
          this.optimisticPromptRunning = false;
          this.optimisticPromptSessionId = null;
        }
        this.settleSnapshotCapabilityLoss();
        this.settleExtensionUiOnRequestClose(event);
        this.recordCommittedLiveEntries(event);
        // Phase 5A committed session_changed leaf fence (cross-tab/self
        // navigate + compaction terminal) — rebase (or defer while the exact
        // turn/stream is in flight).
        this.onCommittedSessionChanged(event);
        // Phase 5A: a stream-ending event may release a deferred leaf-fence
        // rebase even when no pending turn tracked it (self-guarding no-op).
        if (
          event.type === "agent_settled"
          || event.type === "prompt_done"
          || event.type === "prompt_error"
          || event.type === "worker_crashed"
          || event.type === "runtime_unavailable"
          || event.type === "runtime_closed"
        ) {
          this.flushPendingLeafRebase();
        }
      } catch (cause: unknown) {
        // The reducer threw BEFORE the cursor advanced, so re-attaching would
        // replay the same event and throw again — a reconnect loop that never
        // converges. Fail honestly instead: keep the cursor where it is, expose
        // the error and report it once; the next real snapshot/attach boundary
        // re-establishes authority.
        const error: ProtocolError = {
          code: "internal",
          message: `runtime event could not be applied: ${cause instanceof Error ? cause.message : "unknown error"}`,
          retryable: false,
        };
        this.reportEventApplyFailure(error);
        this.setError(error);
      }
      this.notify();
    } else if (decision.decision === "reattach") {
      this.resumeAttach();
    }
  }

  /**
   * Fire-and-forget diagnostic for an event the shared reducer rejected. One
   * structured line per failure, never a retry: the same event would throw
   * again on replay, so a resend has no information to gain.
   */
  private reportEventApplyFailure(error: ProtocolError): void {
    const report = this.runtimeConnection.reportSendFailure;
    if (!report) return;
    try {
      report({
        kind: "event_apply_failure",
        code: error.code,
        phase: "dispatch",
        message: error.message.slice(0, 200),
        retryable: false,
        connectionState: this.runtimeConnection.connectionState,
        epoch: this.epoch,
        sessionKind: this.snapshot?.cwd?.endsWith("/pix/assistant") ? "assistant" : "session",
        sessionId: this.sessionId,
      });
    } catch {
      // Diagnostics never change what the controller reports.
    }
  }

  onUnavailable(message: Extract<WsHostMessage, { type: "runtime_unavailable" }>, _generation: number): void {
    this.setError(message.payload.error);
  }

  private completeAttachSnapshot(message: WsSnapshotMessage, generation: number, sessionId: string): void {
    if (sessionId !== this.sessionId || message.payload.sessionId !== this.sessionId || message.payload.snapshot.sessionId !== this.sessionId) return;
    const attemptMode = this.attachAttempt?.mode ?? "fresh";
    const attemptIntent = this.attachAttempt?.intent ?? "legacy";
    this.attachAttempt = null;
    const priorSessionId = this.sessionId;
    const priorEpoch = this.epoch;
    const applyMode = attemptMode === "fresh"
      ? "fresh"
      : message.payload.resumeStatus === "snapshot"
        ? "same-epoch"
        : "rebase";
    const staleSameEpoch = this.isLowerSameEpochSnapshot(message.payload, applyMode);
    // A stale attach response still settles the attach deferred, but cannot
    // roll authority back. A later same-epoch snapshot may advance normally.
    if (!staleSameEpoch) {
      if (attemptIntent === "existing") this.admittedSnapshot = null;
      this.applySnapshot(message.payload, applyMode, applyMode === "same-epoch" && attemptMode === "resume");
    }
    this.attachGen = generation;
    this.attached = true;
    this.observationId += 1;
    this.error = null;
    this.setConnection("attached");
    const attach = this.attach;
    if (attach) { this.attach = null; attach.resolve(); }
    this.resyncAfterAttach(message.payload.resumeStatus, message.payload.epoch, priorSessionId, priorEpoch);
  }

  private failAttachResponse(message: WsResponseMessage, sessionId: string): void {
    this.attachAttempt = null;
    const error: ProtocolError = message.payload.ok
      ? { code: "internal", message: "attach response without snapshot", retryable: false }
      : message.payload.error;
    const attach = this.attach;
    this.attach = null;
    if (this.sessionId !== sessionId) this.intendedSession = null;
    this.setConnection("ready");
    if (attach) attach.reject(error);
    this.setError(error);
    this.expireTerminalAdmittedIfSettled();
  }


  /**
   * Follow the status of the ACCEPTED turn. Delivery is already guaranteed —
   * this only refines the bubble's authority identity (so the committed entry
   * consumes it by exact id) and refreshes the catalog at terminal.
   *
   * There is no delivery verdict here: an accepted message is delivered, and a
   * failed turn still committed the user's message.
   */
  onTurnStatus(message: WsTurnStatusMessage, generation: number): void {
    const pending = this.pendingTurn;
    if (!pending || pending.terminal) return;
    if (generation !== this.runtimeConnection.currentGeneration) return;
    const status = message.payload;
    if (status.sessionId !== pending.sessionId || status.operationId !== pending.operationId) return;
    if (pending.turnId !== null && status.turnId !== pending.turnId) return;
    if (pending.epoch !== null && status.epoch !== pending.epoch) return;
    if (status.revision <= pending.statusRevision) return;
    pending.turnId = status.turnId;
    pending.epoch = status.epoch;
    pending.statusRevision = status.revision;
    // Authority identity for the bubble: first answer wins, never another
    // operation's identity.
    if (status.userEntryId !== undefined && pending.userEntryId === null) {
      pending.userEntryId = status.userEntryId;
      if (pending.optimisticId !== null) {
        this.updateOptimisticIdentity(pending.optimisticId, { userEntryId: status.userEntryId });
      }
    }
    if (status.finalLeafId !== undefined && pending.finalLeafId === null) {
      pending.finalLeafId = status.finalLeafId;
      if (pending.optimisticId !== null) {
        this.updateOptimisticIdentity(pending.optimisticId, { finalLeafId: status.finalLeafId });
      }
    }
    if (status.state === "completed" || status.state === "failed") {
      const authority = message.authority;
      if (authority !== undefined
        && authority.sessionId === this.sessionId && authority.snapshot.sessionId === this.sessionId
        && authority.epoch === status.epoch && (this.epoch === null || this.epoch === authority.epoch)
        && (!this.authorityCursorKnown || authority.lastEventId >= this.lastEventId)
        // An observing controller consumes the queued events first. Advancing
        // its cursor here could discard message_end before the FIFO snapshot.
        && (!this.attached || authority.lastEventId === this.lastEventId)) {
        this.epoch = authority.epoch;
        this.lastEventId = authority.lastEventId;
        this.authorityCursorKnown = true;
        this.snapshot = structuredClone(authority.snapshot);
        this.settleSnapshotCapabilityLoss();
      }
      pending.terminal = true;
      // Release only this turn's speculative overlay. The refreshed snapshot
      // remains authoritative, including a genuinely running external stream.
      if (this.optimisticPromptSessionId === pending.sessionId) {
        this.optimisticPromptRunning = false;
        this.optimisticPromptSessionId = null;
      }
      // A brand-new session can receive its first committed events before the
      // observation snapshot establishes a history anchor. The terminal status
      // carries the exact final JSONL leaf: pin it without clearing the live
      // tail, so the HTTP history query can converge while the already-rendered
      // first turn remains visible.
      const terminalLeafId = status.finalLeafId ?? pending.finalLeafId;
      if (terminalLeafId !== null && this.historyAnchorLeafId === null) {
        this.establishHistoryAnchorPreservingLiveTail(terminalLeafId);
      } else if (terminalLeafId === null && this.admittedSnapshot?.operationId === pending.operationId
        && this.admittedSnapshot.epoch === status.epoch) {
        // No final leaf is a bounded terminal outcome only after the exact
        // observation attempt settles; keep the bridge during its gap.
        this.admittedSnapshot = { ...this.admittedSnapshot, terminalWithoutFinalLeaf: true };
      }
      pending.attempt?.cancel();
      this.binding.unregisterTurn(pending.operationId);
      this.pendingTurn = null;
      this.expireTerminalAdmitted(pending.operationId, status.epoch);
      // Pi 1.0 explicit receipt: a terminal "handled" turn owes NO assistant
      // reply and NO user transcript entry — remove THIS operation's bubble by
      // its own identity. Never infer handled from a missing userEntryId.
      if (status.disposition === "handled" && pending.optimisticId !== null) {
        this.removeOptimisticEntry(pending.optimisticId);
      }
      this.publishTurnTerminal({
        sessionId: status.sessionId,
        operationId: status.operationId,
        turnId: status.turnId,
        state: status.state,
        ...(status.disposition === undefined ? {} : { disposition: status.disposition }),
        ...(status.error === undefined ? {} : { error: status.error }),
        ...(status.userEntryId === undefined ? {} : { userEntryId: status.userEntryId }),
      });
      // The exact turn reached terminal — a deferred leaf-fence rebase applies
      // NOW, forced (the terminal status is authoritative).
      this.flushPendingLeafRebase(true);
    }
    this.notify();
  }

  /**
   * Adopt an ACCEPTED send as the tracked turn. From here the message is the
   * authority's responsibility; this only follows its status so the UI can
   * reconcile the bubble and refresh the catalog at terminal.
   */
  private adoptSentTurn(entry: OutboxEntry, admission: Extract<SubmitTurnAdmission, { status: "accepted" | "duplicate" }>, optimisticId: string | null): void {
    const provenance = this.captureProvenance();
    if (this.pendingTurn !== null) {
      // A previous accepted turn is still tracked (this send may have been
      // queued behind it). Its bubble is consumed by its own committed entry,
      // so drop the stale tracker instead of leaking it.
      this.pendingTurn.attempt?.cancel();
      this.binding.unregisterTurn(this.pendingTurn.operationId);
      this.pendingTurn = null;
    }
    if (optimisticId !== null) {
      // Refine the bubble's authority identity (first answer wins per field), so
      // the committed user entry consumes it by exact id.
      this.updateOptimisticIdentity(optimisticId, {
        ...(admission.turnId === undefined ? {} : { turnId: admission.turnId }),
        ...(admission.turnStatus.userEntryId === undefined ? {} : { userEntryId: admission.turnStatus.userEntryId }),
      });
    }
    // Accepted admission consumes the one-shot created submit fence.
    const keepAheadSameEpoch = this.authorityCursorKnown
      && this.epoch === admission.epoch
      && this.lastEventId > admission.revision
      && this.snapshot !== null;
    if (!keepAheadSameEpoch) {
      this.epoch = admission.epoch;
      this.lastEventId = admission.revision;
    }
    this.authorityCursorKnown = true;
    if (admission.snapshot !== undefined) {
      if (!keepAheadSameEpoch) this.snapshot = structuredClone(admission.snapshot);
      // Authoritative-settings eligibility: installed BEFORE the send settles
      // so the composer can surface the admitted model/thinking immediately.
      this.admittedSnapshot = {
        historyGeneration: this.historyGeneration,
        provenance,
        operationId: entry.operationId,
        epoch: admission.epoch,
        terminalWithoutFinalLeaf: false,
      };
      // The admission snapshot is captured before the prompt starts, so its
      // leaf is the exact parent of this turn's future user entry. Repair only
      // the unknown (null) base of THIS operation's bubble.
      const admissionBase = admission.snapshot.state.leafId;
      if (admissionBase !== undefined && optimisticId !== null) {
        this.optimisticUserEntries = this.optimisticUserEntries.map((candidate) =>
          candidate.entry.entryId === optimisticId && candidate.baseEntryId === null
            ? { ...candidate, baseEntryId: admissionBase }
            : candidate,
        );
      }
    }
    this.pendingTurn = {
      operationId: entry.operationId,
      sessionId: entry.sessionId,
      provenance,
      epoch: admission.epoch,
      turnId: admission.turnId ?? null,
      statusRevision: admission.turnStatus.revision,
      userEntryId: admission.turnStatus.userEntryId ?? null,
      finalLeafId: null,
      optimisticId,
      attempt: null,
      terminal: false,
    };
    if (!this.attached) {
      // LC-02: the request carries the SEND-START provenance — a late admission
      // for a superseded presentation completes in the background and never
      // steals the foreground lease. An observation failure here NEVER
      // resubmits the message or starts a new Worker.
      void this.requestObservation(entry.sessionId, { intent: "post-admission", provenance }).then(
        () => { this.expireTerminalAdmitted(entry.operationId, admission.epoch); },
        (error: unknown) => {
          this.setError(this.protocolErrorFrom(error, "post-admission observation failed"));
          this.expireTerminalAdmitted(entry.operationId, admission.epoch);
        },
      );
    }
  }

  /**
   * Lifecycle teardown of the tracked turn (dispose / detach / stop / session
   * switch / epoch change). An accepted message is already delivered, so this
   * only drops the status tracker and keeps the bubble — the authority's own
   * committed entry consumes it when it arrives.
   */
  private settleTurn(error: ProtocolError): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    void error;
    pending.attempt?.cancel();
    this.binding.unregisterTurn(pending.operationId);
    this.pendingTurn = null;
    // Lifecycle teardown releases a deferred leaf-fence rebase.
    this.flushPendingLeafRebase();
    this.notify();
  }

  private publishTurnTerminal(terminal: TurnTerminalInfo): void {
    for (const listener of [...this.turnTerminalListeners]) {
      try {
        listener(terminal);
      } catch {
        // A throwing listener must never break the store.
      }
    }
  }

  // --- attach lifecycle (stable deferred) --------------------------------

  /**
   * Begin (or resume) the logical attach for `sessionId`. The returned promise
   * is a STABLE deferred: a reconnect re-uses it so the original create/open
   * caller always settles (HIGH-2). Each (re)send mints a fresh envelope attempt.
   */
  private startAttach(sessionId: string, mode: "fresh" | "resume", intent: AttachIntent = "legacy"): Promise<void> {
    if (sessionId !== this.sessionId) return Promise.reject(this.identityMismatchError(sessionId));
    this.intendedSession = { sessionId, intent };
    // Session-switch cleanup, driven by the ONE pending-lane table: a lane bound
    // to a session OTHER than this attach target is settled exactly once so its
    // late frame/status can never settle the newly attached context. A resume
    // keeps the ambiguous turn lane (resyncAfterAttach decides it by delivery
    // evidence); every other lane and every fresh attach settle here.
    for (const lane of this.pendingLanes()) {
      if (lane.switchSettle === "fresh-only" && mode !== "fresh") continue;
      const pending = lane.pending();
      if (pending !== null && pending.sessionId !== sessionId) {
        lane.settle({ code: "interrupted", message: "session switched", retryable: false });
      }
    }
    this.attached = false;
    this.attachedFenceRevision = null;
    if (this.attach && this.attach.sessionId === sessionId) {
      // Reuse the in-flight deferred (reconnect handoff) and send a new attempt.
      this.sendAttachAttempt(sessionId, mode, intent);
      return this.attach.promise;
    }
    if (this.attach) {
      // Identity-scoped supersession: a DIFFERENT session's attach is already
      // in flight (rapid A→B→C switching). Settle the old deferred EXACTLY
      // ONCE so its openSession caller never hangs, then start the new attach.
      this.rejectAttach({
        code: "interrupted",
        message: "superseded by a newer session selection",
        retryable: false,
      });
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const deferred: AttachDeferred = { sessionId, resolve, reject, promise };
    this.attach = deferred;
    this.sendAttachAttempt(sessionId, mode, intent);
    return promise;
  }

  private sendAttachAttempt(sessionId: string, mode: "fresh" | "resume", intent: AttachIntent): void {
    const base = mode === "resume" && this.epoch !== null
      ? { sessionId, epoch: this.epoch, lastEventId: this.lastEventId }
      : { sessionId };
    // LC-02: the observation intent stamps `attachMode: "existing_only"` on
    // EVERY attempt of this logical attach (fresh, resume and reconnect
    // resend) — the Host can then prove observation-only and never falls back
    // to activation for this path. The legacy intent keeps the exact old v2
    // payload (finite shim, unchanged wire shape).
    const params: BrowserRuntimeAttachParams = intent === "existing" ? { ...base, attachMode: "existing_only" } : base;
    this.attachAttempt?.handle.cancel();
    this.setConnection("attaching");
    let handle: RuntimeAttemptHandle | null = null;
    handle = this.binding.sendAttempt({
      buildMessage: (id) => ({ type: "attach", id, payload: params }),
      expectation: { kind: "attach", sessionId },
      disconnectPolicy: "logical_retry",
      onFrame: (frame) => {
        if (frame.type === "snapshot") this.completeAttachSnapshot(frame, handle?.generation ?? this.runtimeConnection.currentGeneration, sessionId);
        else if (frame.type === "response") this.failAttachResponse(frame, sessionId);
      },
      onSendFailure: (cause) => {
        this.attachAttempt = null;
        this.rejectAttach(this.protocolErrorFrom(cause, "attach send failed"));
      },
      onDisconnect: () => { /* logical attach survives and re-registers after reconnect */ },
    });
    if (handle !== null) this.attachAttempt = { handle, sessionId, mode, intent };
  }

  /**
   * Re-attach an ALREADY attached session after a transport loss or a cursor
   * violation (gap / epoch / session mismatch). Always observation-safe
   * (`existing_only`): the session was attached before, so a recovery attach
   * must never be able to cold-activate a Worker — even when
   * {@link cancelObservationIntent} already cleared the declared intent (LC-02).
   */
  private resumeAttach(): void {
    if (!this.sessionId) return;
    void this.startAttach(this.sessionId, "resume", this.intendedSession?.intent ?? "existing").catch(() => {
      // Resume failed; socket backoff retries and `ready` re-triggers resume.
    });
  }

  /** Reject + clear any in-flight attach deferred (detach / stop / dispose). */
  private rejectAttach(error: ProtocolError): void {
    if (this.attach) { this.attach.reject(error); this.attach = null; }
    this.attachAttempt?.handle.cancel();
    this.attachAttempt = null;
  }

  /**
   * The ONE pending-lane table. Every attach boundary and every session switch
   * walks it: a lane is re-sent only when its OWN sessionId matches the newly
   * attached session AND the prior epoch identity survived (the prior session /
   * epoch are captured BEFORE applySnapshot overwrote them); on epoch_changed or
   * a session mismatch the lane's effect is ambiguous → settle, never resend.
   *
   * Lanes that are pure control/input channels keep one deliberate difference:
   * the interrupt settle is a `moot control` error that is never surfaced in the
   * view (`reportsError: false`), because after an epoch rollover the old Worker
   * is gone and the interrupt has nothing left to interrupt.
   */
  private pendingLanes(): readonly PendingLane[] {
    return [
      {
        name: "command",
        pending: () => this.pendingCommand,
        resend: () => { const pending = this.pendingCommand; if (pending) this.sendCommandAttempt(pending); },
        settle: (error) => {
          if (!this.pendingCommand) return;
          this.pendingCommand.reject(error);
          this.pendingCommand = null;
        },
        reportsError: true,
        switchSettle: "always",
      },
      {
        name: "side-chat command",
        pending: () => this.pendingSideChatCommand,
        resend: () => { const pending = this.pendingSideChatCommand; if (pending) this.sendSideChatCommandAttempt(pending); },
        settle: (error) => this.settlePendingSideChatCommand(error),
        reportsError: false,
        // The side-chat caller already owns its own error surface; the resync
        // never invents a second one.
        switchSettle: "always",
      },
      {
        name: "queued turn",
        pending: () => this.pendingQueuedTurn,
        resend: () => {
          const pending = this.pendingQueuedTurn;
          if (pending === null) return;
          // A transport resync and an armed reconcile timer must never both fire
          // for the same commandId.
          this.clearQueuedTurnReconcile(pending);
          this.sendQueuedTurnAttempt(pending);
        },
        settle: (error) => {
          if (!this.pendingQueuedTurn) return;
          this.clearQueuedTurnReconcile(this.pendingQueuedTurn);
          this.pendingQueuedTurn.reject(error);
          this.pendingQueuedTurn = null;
          this.notify();
        },
        reportsError: true,
        switchSettle: "always",
      },
      {
        name: "extension ui response",
        pending: () => this.pendingExtensionUiCommand,
        resend: () => { const pending = this.pendingExtensionUiCommand; if (pending) this.sendExtensionUiAttempt(pending); },
        settle: (error) => {
          if (!this.pendingExtensionUiCommand) return;
          this.pendingExtensionUiCommand.reject(error);
          this.pendingExtensionUiCommand = null;
          this.notify();
        },
        reportsError: true,
        switchSettle: "always",
      },
      {
        name: "pending read",
        // Reads are pure queries bound to the prior session/epoch: applySnapshot
        // settles them on any identity change, and a same-epoch resume never
        // re-issues them (the caller does). The lane states that explicitly so
        // no read can be resent across a reconnect.
        pending: () => this.pendingReads.values().next().value ?? null,
        settle: (error) => this.settleAllPendingReads(error),
        reportsError: false,
        switchSettle: "always",
        // A same-epoch resume leaves reads alone (applySnapshot settles them when
        // the session/epoch identity changed; the caller re-issues the query).
        skipResync: () => true,
      },
      {
        name: "interrupt",
        pending: () => this.pendingInterrupt,
        resend: () => { const pending = this.pendingInterrupt; if (pending) this.sendInterruptAttempt(pending); },
        settle: (error) => {
          this.pendingInterrupt?.reject(error);
          this.pendingInterrupt = null;
          this.pendingInterruptPromise = null;
        },
        reportsError: false,
        switchSettle: "always",
        resyncError: { code: "epoch_changed", message: "epoch changed; interrupt not re-sent", retryable: false },
      },
      {
        // An ACCEPTED turn needs no resend: the message is already delivered.
        // A resume keeps its status tracker; a session switch drops it (the
        // bubble survives and the authority's committed entry consumes it).
        name: "turn",
        pending: () => this.pendingTurn,
        settle: (error) => this.settleTurn(error),
        reportsError: false,
        switchSettle: "always",
        skipResync: () => true,
      },
    ];
  }

  /**
   * After an initial snapshot, decide every pending lane (see
   * {@link pendingLanes}). No-op when nothing is pending (fresh attach).
   */
  private resyncAfterAttach(
    resumeStatus: "snapshot" | "gap" | "epoch_changed",
    snapshotEpoch: string,
    priorSessionId: string | null,
    priorEpoch: string | null,
  ): void {
    const attachedSessionId = this.sessionId;
    // Epoch identity survived only when we were ALREADY on this same session
    // before the snapshot (same sessionId) AND the resume cursor confirms the
    // epoch did not change. A session switch or an epoch change invalidates
    // every in-flight lane.
    const epochSurvived =
      resumeStatus !== "epoch_changed" &&
      priorSessionId !== null &&
      priorSessionId === attachedSessionId &&
      (priorEpoch === null || priorEpoch === snapshotEpoch);
    for (const lane of this.pendingLanes()) {
      const pending = lane.pending();
      if (pending === null) continue;
      if (lane.skipResync?.() === true) continue;
      // Per-lane status: fail closed unless the lane's OWN sessionId matches the
      // newly attached session AND the prior epoch identity survived.
      const laneStatus = epochSurvived && pending.sessionId === attachedSessionId ? resumeStatus : "epoch_changed";
      const decision = decideCommandRetry(laneStatus);
      if (decision.decision === "resend") {
        const resend = lane.resend;
        if (resend === undefined) {
          // A lane with no resend shape never crosses a reconnect: settle it
          // instead of leaving the slot armed forever.
          lane.settle({ code: "epoch_changed", message: `${lane.name} could not be re-sent after reconnect`, retryable: false });
          continue;
        }
        resend();
        continue;
      }
      lane.settle(lane.resyncError ?? decision.error);
      if (lane.reportsError) this.setError(decision.error);
    }
  }

  // --- helpers -----------------------------------------------------------

  /** Lower same-epoch snapshots are stale pushes, not authority changes. */
  private isLowerSameEpochSnapshot(payload: WsSnapshotMessage["payload"], mode: "fresh" | "same-epoch" | "rebase"): boolean {
    return mode === "same-epoch"
      && this.epoch !== null
      && payload.epoch === this.epoch
      && payload.lastEventId < this.lastEventId;
  }

  private applySnapshot(
    payload: WsSnapshotMessage["payload"],
    mode: "fresh" | "same-epoch" | "rebase" = "same-epoch",
    preserveResumeCursor = false,
  ): void {
    if (payload.sessionId !== this.sessionId || payload.snapshot.sessionId !== this.sessionId) return;
    const priorSessionId = this.sessionId;
    const priorEpoch = this.epoch;
    if (mode === "rebase" || (priorEpoch !== null && priorEpoch !== payload.epoch)) {
      this.admittedSnapshot = null;
    }
    this.epoch = payload.epoch;
    // Same-epoch resume snapshot is reconstructed at the prior client cursor;
    // payload.lastEventId is the journal head. Keep the cursor so replay,
    // including message_end, is not dropped. Fresh/rebase/epoch change still take payload.
    if (!(preserveResumeCursor && priorEpoch !== null && priorEpoch === payload.epoch)) {
      this.lastEventId = payload.lastEventId;
    }
    if (priorSessionId !== payload.sessionId || priorEpoch !== payload.epoch || this.attachedFenceRevision === null) {
      this.attachedFenceRevision = payload.lastEventId;
    } else {
      this.attachedFenceRevision = Math.max(this.attachedFenceRevision, payload.lastEventId);
    }
    this.authorityCursorKnown = true;
    this.snapshot = structuredClone(payload.snapshot);
    // Phase 2B: pending reads are bound to the PRIOR session/epoch. When either
    // identity changed, settle each read exactly once with a fixed error — a
    // late read_result for the old identity can never settle a new-session read.
    if (priorSessionId !== payload.sessionId || priorEpoch !== payload.epoch) {
      this.settleAllPendingReads({ code: "epoch_changed", message: "session epoch changed", retryable: false });
    }
    // Activation reveals the target session's authoritative pre-prompt leaf.
    // Bind any detached UI-first transaction that did not know its base yet;
    // this identity later prevents a committed historical prompt from becoming
    // a duplicate ghost bubble after cross-session supersession.
    const activationBase = this.snapshot.state.leafId ?? null;
    this.optimisticUserEntries = this.optimisticUserEntries.map((candidate) =>
      candidate.sessionId === payload.sessionId && candidate.baseEntryId === undefined
        ? { ...candidate, baseEntryId: activationBase }
        : candidate,
    );
    // Protocol v2 history layer:
    //  - fresh attach: anchor to snapshot.state.leafId, increment generation,
    //    clear live entries (later committed events re-accumulate);
    //  - rebase (epoch_changed / gap / Phase 5A leaf fence): new anchor,
    //    generation++, clear live entries → the transcript hook refetches the
    //    first page;
    //  - same-epoch reconnect (gap / replay): PRESERVE anchor + live entries
    //    (the resume cursor dedupes replayed events, and appendLiveEntry is
    //    idempotent by entryId).
    const snapshotLeaf = this.snapshot.state.leafId ?? null;
    const establishesMissingAnchor = mode === "same-epoch"
      && this.historyAnchorLeafId === null
      && snapshotLeaf !== null;
    // A same-epoch snapshot with no leaf is weaker than the exact committed
    // leaf/live entries already observed by this controller. This occurs for a
    // late new-session observation snapshot; treating null as a branch reset
    // erased the previous turn until reload. Epoch changes still rebase and
    // clear normally — only same-epoch unknown leaf is preserved.
    const preservesKnownSameEpochHistory = priorEpoch === payload.epoch
      && snapshotLeaf === null
      && (this.historyAnchorLeafId !== null || this.liveEntries.length > 0);
    if (preservesKnownSameEpochHistory) {
      // The snapshot supersedes any deferred fence even though its unknown leaf
      // cannot erase the stronger committed anchor/live tail.
      this.pendingLeafRebase = null;
    } else if (mode !== "same-epoch" || establishesMissingAnchor) {
      // A created session's first observation attach is a same-epoch resume,
      // but events committed between submit admission and that attach are not
      // part of the Browser's live tail. When its authoritative snapshot has a
      // leaf and the controller has never established a history anchor, rebase
      // once so HTTP history supplies those early commits (notably the first
      // user message) instead of leaving optimism unreconciled until refresh.
      this.rebaseHistoryLayerTo(snapshotLeaf);
      // The snapshot's own anchor supersedes any deferred Phase 5A leaf-fence
      // rebase (the fresh/rebase snapshot is the newer authority position).
      this.pendingLeafRebase = null;
    }
    this.settleSnapshotCapabilityLoss();
    this.notify();
  }

  private settleSnapshotCapabilityLoss(): void {
    this.settleExtensionUiOnCapabilityLoss();
    this.settleSideChatOnCapabilityLoss();
  }

  /**
   * Append a committed live SessionEntry keyed by its persisted entryId.
   * Idempotent by entryId (never by content/timestamp/array overlap) so
   * same-epoch replay and duplicate completions can never double-append.
   */
  private appendLiveEntry(entry: SessionEntry): void {
    if (this.liveEntries.some((existing) => existing.entryId === entry.entryId)) return;
    this.liveEntries = [...this.liveEntries, entry];
  }

  /**
   * COMMON history rebase (fresh attach / gap / epoch_changed / Phase 5A
   * committed `session_changed` leaf fence): new anchor leaf, history + attach
   * generation increments (so the transcript infinite-query invalidates and
   * refetches the newest page from the NEW branch), live tail cleared (later
   * committed events re-accumulate). Optimistic entries are a separate
   * session-scoped transaction layer and SURVIVE the rebase (current
   * transaction semantics) — their owning promise/authority identity removes
   * them, never a history teardown.
   */
  private establishHistoryAnchorPreservingLiveTail(anchorLeafId: string): void {
    this.historyGeneration += 1;
    this.admittedSnapshot = null;
    this.attachGeneration += 1;
    this.historyAnchorLeafId = anchorLeafId;
  }

  private rebaseHistoryLayerTo(anchorLeafId: string | null): void {
    this.historyGeneration += 1;
    this.admittedSnapshot = null;
    this.attachGeneration += 1;
    this.historyAnchorLeafId = anchorLeafId;
    this.liveEntries = [];
    // A rebase for the target session must not erase a prompt that is still
    // activating or awaiting its committed message_end.
    if (this.optimisticPromptSessionId !== this.sessionId) {
      this.optimisticPromptRunning = false;
      this.optimisticPromptSessionId = null;
    }
  }

  /**
   * Phase 5A: true while the exact turn/stream owns the live tail, so a
   * committed `session_changed` leaf fence must DEFER its rebase until the
   * turn/stream reaches terminal (never rebase mid-stream — the tail entries
   * of the ACTIVE branch would be dropped while they are still appending).
   */
  private isLiveTurnInFlightForRebase(): boolean {
    if (this.pendingTurn !== null && !this.pendingTurn.terminal) return true;
    if (this.promptTransaction !== null) return true;
    const state = this.snapshot?.state;
    if (state?.isStreaming === true || state?.isPromptRunning === true) return true;
    if (this.optimisticPromptRunning && this.optimisticPromptSessionId === this.sessionId) return true;
    return false;
  }

  /**
   * Phase 5A committed `session_changed` leaf fence (cross-tab/self navigate +
   * compaction terminal). Leaf EQUALITY only: the same leaf is already
   * continuous (no generation churn); a different leaf rebases the COMMON
   * history layer (anchor/generation/live-tail) — deferred while the exact
   * turn is active/streaming, flushed at terminal. Events with no leafId
   * (cwd-only) never fence the history layer. Never orders or merges across
   * epochs — the resume cursor/gap machinery owns that.
   */
  private onCommittedSessionChanged(event: RuntimeEventData & { readonly eventId: number; readonly epoch: string }): void {
    if (event.type !== "session_changed") return;
    if (event.leafId === undefined) return;
    if (event.leafId === this.historyAnchorLeafId) return;
    if (this.isLiveTurnInFlightForRebase()) {
      // Same-epoch order only: a later fence replaces an earlier deferred one.
      this.pendingLeafRebase = event.leafId;
      return;
    }
    this.rebaseHistoryLayerTo(event.leafId);
  }

  /**
   * Apply a deferred Phase 5A leaf-fence rebase once the exact turn/stream
   * reached terminal (turn status terminal / settle / stream-ending event /
   * teardown). No-op while anything is still in flight; a rebase snapshot or
   * teardown clears the deferred anchor (superseded).
   *
   * `force` (exact turn_status completed/failed ONLY): the terminal status is
   * AUTHORITATIVE — release this session's optimistic running overlay first
   * (a possibly stale snapshot may still claim isPromptRunning/isStreaming)
   * and apply the deferred rebase even though those guards would defer. Never
   * forced from lifecycle teardown (`settleTurn` accepted/uncertain: the
   * server may legitimately still be running the turn) — those callers keep
   * the non-forced guards. Applies at most once (`pendingLeafRebase` is
   * cleared before rebasing; later calls are no-ops).
   */
  private flushPendingLeafRebase(force = false): void {
    const leaf = this.pendingLeafRebase;
    if (leaf === null) return;
    if (!force && this.isLiveTurnInFlightForRebase()) return;
    if (force && this.optimisticPromptRunning && this.optimisticPromptSessionId === this.sessionId) {
      this.optimisticPromptRunning = false;
      this.optimisticPromptSessionId = null;
    }
    this.pendingLeafRebase = null;
    if (leaf !== this.historyAnchorLeafId) this.rebaseHistoryLayerTo(leaf);
  }

  /**
   * Phase 5A: remove one optimistic bubble by its local id.
   */
  private removeOptimisticEntry(optimisticId: string): void {
    this.optimisticUserEntries = this.optimisticUserEntries.filter(
      (candidate) => candidate.entry.entryId !== optimisticId,
    );
  }

  private recordCommittedLiveEntries(event: RuntimeEventData & { readonly eventId: number; readonly epoch: string }): void {
    if (event.type === "message_end") {
      if (event.message.role === "user") {
        const candidates = this.optimisticUserEntries.filter((candidate) => candidate.sessionId === event.sessionId);
        // Phase 5A identity-first removal: a bubble carrying authority identity
        // is consumed ONLY by the exact committed entryId the authority bound to
        // it (userEntryId, or finalLeafId when the user entry IS the final
        // leaf). NEVER by text — a same-text historical entry or another
        // operation's commit can never consume an identity-bound bubble.
        const byIdentity = candidates.find((candidate) =>
          candidate.identity !== undefined
          && (candidate.identity.userEntryId === event.entryId
            || candidate.identity.finalLeafId === event.entryId));
        if (byIdentity !== undefined) {
          this.removeOptimisticEntry(byIdentity.entry.entryId);
        } else {
          // LEGACY Protocol-v2 fallback — QUARANTINED. It applies ONLY to
          // candidates the authority has NOT given a user-entry/final-leaf
          // identity yet (legacy command-envelope prompt / queued turns, or a
          // negotiated turn whose turn_status pushes have not carried
          // userEntryId/finalLeafId). A candidate with a KNOWN identity
          // (userEntryId or finalLeafId non-null) is EXCLUDED — wrong identity
          // never removes. Removal condition: Protocol v3 minimum version +
          // Phase 7 build contract (runtime.submit-turn.v1 universal ⇒ every
          // prompt carries and reports an operation identity); delete this
          // block together with the legacy submit shim (migration ledger §72).
          const legacyCandidates = candidates.filter((candidate) =>
            candidate.identity === undefined
            || (candidate.identity.userEntryId === null && candidate.identity.finalLeafId === null));
          const content = event.message.content;
          const committedText = (typeof content === "string"
            ? content
            : content.filter((block) => block.type === "text").map((block) => block.text).join("\n"))
            .trim();
          const contentMatch = legacyCandidates.find((candidate) => {
            const optimisticContent = candidate.entry.message;
            return optimisticContent.role === "user"
              && typeof optimisticContent.content === "string"
              && optimisticContent.content.trim() === committedText;
          });
          // Prefer exact content correlation. If the session has exactly one
          // speculative LEGACY entry, it is the only possible owner; otherwise
          // do not guess by FIFO and risk consuming another queued turn.
          // Identity-bound bubbles that did not match this event's entryId are
          // deliberately retained — wrong identity never removes.
          const matched = contentMatch ?? (legacyCandidates.length === 1 ? legacyCandidates[0] : undefined);
          if (matched) {
            this.removeOptimisticEntry(matched.entry.entryId);
          }
        }
      }
      this.appendLiveEntry({
        entryId: event.entryId,
        ...(event.parentEntryId === undefined ? {} : { parentEntryId: event.parentEntryId }),
        message: event.message,
      });
      return;
    }
    if (event.type === "bash_update" && (event.exitCode !== undefined || event.cancelled === true) && event.entryId !== undefined) {
      const bash = this.snapshot?.state.bash;
      if (!bash) return;
      this.appendLiveEntry({
        entryId: event.entryId,
        ...(event.parentEntryId === undefined ? {} : { parentEntryId: event.parentEntryId }),
        message: {
          role: "bashExecution",
          command: bash.command,
          output: bash.output,
          ...(bash.exitCode === undefined ? {} : { exitCode: bash.exitCode }),
          ...(bash.cancelled === undefined ? {} : { cancelled: bash.cancelled }),
          ...(bash.truncated === undefined ? {} : { truncated: bash.truncated }),
          ...(bash.fullOutputPath === undefined ? {} : { fullOutputPath: bash.fullOutputPath }),
          ...(bash.excludeFromContext === undefined ? {} : { excludeFromContext: bash.excludeFromContext }),
        },
      });
    }
  }

  /** Clear the history layer (detach / stop / session switch). */
  private clearHistoryLayer(): void {
    this.historyGeneration += 1;
    this.admittedSnapshot = null;
    this.attachGeneration += 1;
    this.historyAnchorLeafId = null;
    this.liveEntries = [];
    // Phase 5A: teardown supersedes any deferred leaf-fence rebase (a stale
    // deferred anchor must never apply to the next attach's fresh anchor).
    this.pendingLeafRebase = null;
    // Speculative entries are transaction-owned and may target the session
    // being activated next. Their owning promise/event removes them; history
    // teardown must not create a visible disappear/reappear cycle.
    if (this.optimisticPromptSessionId === this.sessionId) {
      this.optimisticPromptRunning = false;
      this.optimisticPromptSessionId = null;
    }
  }

  /** One-shot response attempt (getSnapshot / detach / stop), bounded when requested. */
  private sendEnvelope(message: WsClientMessage, ackTimeoutMs?: number): Promise<unknown> {
    if (message.type !== "getSnapshot" && message.type !== "detach" && message.type !== "stop") {
      return Promise.reject(new Error("unsupported one-shot runtime envelope"));
    }
    const sessionId = message.payload.sessionId;
    return new Promise((resolve, reject) => {
      let timer: unknown = undefined;
      let attempt: RuntimeAttemptHandle | null = null;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clearTimeoutFn(timer);
        fn();
      };
      attempt = this.binding.sendAttempt({
        buildMessage: (id) => ({ ...message, id }),
        expectation: { kind: message.type, sessionId },
        disconnectPolicy: "reject_on_disconnect",
        onFrame: (frame) => {
          if (frame.type !== "response") return;
          const payload = frame.payload;
          if (payload.ok) finish(() => resolve(payload.result));
          else finish(() => { reject(payload.error); this.setError(payload.error); });
        },
        onSendFailure: (cause) => finish(() => reject(cause)),
        onDisconnect: (cause) => finish(() => reject(cause)),
      });
      if (ackTimeoutMs !== undefined && !settled) {
        timer = this.setTimeoutFn(() => {
          attempt?.cancel();
          finish(() => reject({ code: "timeout", message: "response timed out", retryable: true } satisfies ProtocolError));
        }, ackTimeoutMs);
      }
    });
  }

  private sendSideChatCommandAttempt(pending: SideChatCommandPending): void {
    pending.attempt?.cancel();
    pending.attempt = this.binding.sendAttempt({
      buildMessage: (id) => ({ ...pending.command, id }),
      expectation: { kind: "command", sessionId: pending.sessionId, commandId: pending.commandId, resultType: pending.type },
      disconnectPolicy: "logical_retry",
      onSent: () => { pending.wireSeen = true; },
      onFrame: (frame) => {
        if (this.pendingSideChatCommand !== pending || frame.type !== "response") return;
        this.pendingSideChatCommand = null;
        pending.attempt = null;
        if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
        pending.timer = null;
        if (frame.payload.ok) pending.resolve(frame.payload.result);
        else pending.reject(frame.payload.error);
        this.notify();
      },
      onSendFailure: (cause) => {
        if (this.pendingSideChatCommand !== pending) return;
        this.pendingSideChatCommand = null;
        pending.attempt = null;
        if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
        pending.timer = null;
        pending.reject(pending.type === "side_chat_send" && !pending.wireSeen ? this.activationFailure(cause) : cause);
        this.notify();
      },
      onDisconnect: () => { /* same-epoch resync decides whether to resend */ },
    });
  }

  private sendCommandAttempt(pending: CommandPending): void {
    pending.attempt?.cancel();
    const command = pending.command.type === "command" ? pending.command.payload.command : null;
    if (command === null) return;
    pending.attempt = this.binding.sendAttempt({
      buildMessage: (id) => ({ ...pending.command, id }),
      expectation: { kind: "command", sessionId: pending.sessionId, commandId: pending.commandId, resultType: command.type },
      disconnectPolicy: "logical_retry",
      onSent: () => { pending.wireSeen = true; },
      onFrame: (frame) => {
        if (this.pendingCommand !== pending || frame.type !== "response") return;
        this.pendingCommand = null;
        pending.attempt = null;
        if (frame.payload.ok) pending.resolve(frame.payload.result);
        else { pending.reject(frame.payload.error); this.setError(frame.payload.error); }
      },
      onSendFailure: (cause) => {
        if (this.pendingCommand !== pending) return;
        this.pendingCommand = null;
        pending.attempt = null;
        const error = this.protocolErrorFrom(cause, "command send failed");
        pending.reject(command.type === "prompt" && !pending.wireSeen ? this.activationFailure(error) : error);
      },
      onDisconnect: () => { /* logical command re-registers after exact attach resync */ },
    });
  }

  /**
   * Transport recovery: hold the queued turn (bubble already shown) until the
   * resume attach lands. resyncAfterAttach then re-sends this slot with the
   * same commandId (same epoch) or rejects it (epoch changed), exactly like a
   * turn that was in flight when the transport dropped. Only the bound lives
   * here: no re-attach in time fails it before it ever reached the wire.
   */
  private sendQueuedTurnAfterResume(pending: QueuedTurnPending): void {
    void this.waitForReattach(pending.sessionId, QUEUED_TURN_RESUME_TIMEOUT_MS).then((attached) => {
      if (attached || this.pendingQueuedTurn !== pending) return;
      this.pendingQueuedTurn = null;
      const error = { code: "unavailable", message: "session did not reconnect in time", retryable: false } satisfies ProtocolError;
      this.reportQueuedSendFailure(pending, error, "activation");
      pending.reject(this.activationFailure(error));
      this.notify();
    });
  }

  /** Resolve true once attached to `sessionId` again; false on timeout or when recovery is abandoned. */
  private waitForReattach(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (this.attached && this.sessionId === sessionId) return Promise.resolve(true);
    // Send intent: reconnect now instead of after the pending backoff step.
    void this.runtimeConnection.whenSendable(timeoutMs).catch(() => undefined);
    return new Promise<boolean>((resolve) => {
      let unsubscribe: () => void = () => undefined;
      const timer = this.setTimeoutFn(() => { unsubscribe(); resolve(false); }, timeoutMs);
      unsubscribe = this.subscribe(() => {
        if (this.attached && this.sessionId === sessionId) {
          this.clearTimeoutFn(timer);
          unsubscribe();
          resolve(true);
        } else if (!this.resuming) {
          this.clearTimeoutFn(timer);
          unsubscribe();
          resolve(false);
        }
      });
    });
  }

  /** Fire-and-forget diagnostic for a steer / follow-up send. `phase` is the
   *  real outcome: a frame that never reached the wire is `activation`, an
   *  unresolved admission is `dispatch`. */
  private reportQueuedSendFailure(
    pending: QueuedTurnPending,
    error: ProtocolError,
    phase: "activation" | "dispatch",
  ): void {
    const report = this.runtimeConnection.reportSendFailure;
    if (!report) return;
    try {
      report({
        kind: "send_failure",
        code: error.code,
        phase,
        message: `${pending.type}: ${error.message}`.slice(0, 200),
        retryable: error.retryable,
        connectionState: this.runtimeConnection.connectionState,
        epoch: this.epoch,
        sessionKind: this.snapshot?.cwd?.endsWith("/pix/assistant") ? "assistant" : "session",
        sessionId: pending.sessionId,
      });
    } catch {
      // Diagnostics never change send outcome.
    }
  }

  /**
   * Schedule the ONE bounded reconciliation re-send for an unresolved queued
   * turn. The same {@link SUBMIT_MAX_RESENDS} budget and
   * {@link SUBMIT_RECOVERY_BUDGET_MS} deadline as the prompt lane apply, so a
   * steer / follow_up cannot re-send forever either. The deadline is armed on
   * the first re-send and its timer settles the lane if the re-send never comes
   * back. Returns false when the budget is spent — the caller settles instead.
   */
  private scheduleQueuedTurnReconcile(pending: QueuedTurnPending): boolean {
    if (pending.resendCount >= SUBMIT_MAX_RESENDS) return false;
    const now = Date.now();
    if (pending.resendDeadline === null) pending.resendDeadline = now + SUBMIT_RECOVERY_BUDGET_MS;
    if (now >= pending.resendDeadline) return false;
    pending.resendCount += 1;
    this.clearQueuedTurnReconcile(pending);
    pending.reconcileTimer = this.setTimeoutFn(() => {
      pending.reconcileTimer = null;
      if (this.pendingQueuedTurn === pending) this.sendQueuedTurnAttempt(pending);
    }, QUEUED_TURN_RECONCILE_DELAY_MS);
    this.armQueuedTurnDeadline(pending);
    return true;
  }

  /**
   * The queued-turn deadline: armed once alongside the first re-send, it
   * settles an unresolved lane by delivery evidence ({@link settleQueuedTurn})
   * instead of leaving the queue lane locked when the transport never returns.
   */
  private armQueuedTurnDeadline(pending: QueuedTurnPending): void {
    if (pending.resendTimer !== null || pending.resendDeadline === null) return;
    const budget = Math.max(0, pending.resendDeadline - Date.now());
    pending.resendTimer = this.setTimeoutFn(() => {
      pending.resendTimer = null;
      if (this.pendingQueuedTurn !== pending) return;
      this.settleQueuedTurn(pending, {
        code: "timeout",
        message: "queued turn delivery could not be confirmed",
        retryable: true,
      } satisfies ProtocolError);
    }, budget);
  }

  private clearQueuedTurnReconcile(pending: QueuedTurnPending): void {
    if (pending.reconcileTimer === null) return;
    this.clearTimeoutFn(pending.reconcileTimer);
    pending.reconcileTimer = null;
  }

  /** Release this lane's timers and settle its caller exactly once. */
  private settleQueuedTurn(pending: QueuedTurnPending, error: ProtocolError): void {
    if (this.pendingQueuedTurn !== pending) return;
    this.pendingQueuedTurn = null;
    pending.attempt?.cancel();
    pending.attempt = null;
    this.clearQueuedTurnReconcile(pending);
    pending.resendDeadline = null;
    if (pending.resendTimer !== null) {
      this.clearTimeoutFn(pending.resendTimer);
      pending.resendTimer = null;
    }
    this.reportQueuedSendFailure(pending, error, pending.wireSeen ? "dispatch" : "activation");
    this.notify();
    pending.reject(pending.wireSeen ? this.uncertainTagged(error) : this.activationFailure(error));
  }

  private sendQueuedTurnAttempt(pending: QueuedTurnPending): void {
    this.clearQueuedTurnReconcile(pending);
    pending.attempt?.cancel();
    pending.attempt = this.binding.sendAttempt({
      buildMessage: (id) => ({ ...pending.command, id }),
      expectation: { kind: "command", sessionId: pending.sessionId, commandId: pending.commandId, resultType: pending.type },
      disconnectPolicy: "logical_retry",
      onSent: () => { pending.wireSeen = true; pending.wireAttempts += 1; },
      onFrame: (frame) => {
        if (this.pendingQueuedTurn !== pending || frame.type !== "response") return;
        const result = frame.payload.ok ? frame.payload.result as CorrelatedRuntimeCommandResult : null;
        const error = result && !result.result.ok ? result.result.error : frame.payload.ok ? null : frame.payload.error;
        if (error === null) {
          this.pendingQueuedTurn = null;
          pending.attempt = null;
          pending.resendDeadline = null;
          if (pending.resendTimer !== null) {
            this.clearTimeoutFn(pending.resendTimer);
            pending.resendTimer = null;
          }
          this.notify();
          pending.resolve(result);
          return;
        }
        // Transport/RPC failures may arrive after enqueue; retry with the
        // same commandId and keep delivery uncertain if reconciliation fails.
        if (QUEUED_TURN_UNCERTAIN_CODES.has(error.code)) {
          if (this.scheduleQueuedTurnReconcile(pending)) {
            this.notify();
            return;
          }
          // Shared budget spent: unresolved delivery, never "not sent".
          this.settleQueuedTurn(pending, error);
          return;
        }
        // A nested Worker failure can happen after the SDK has queued the
        // message (for example while reading its state afterward). Only a
        // first-attempt top-level session_busy is a proven pre-admission reject.
        const provenUnsent = result === null && !error.retryable && pending.wireAttempts === 1
          && error.code === "session_busy";
        this.pendingQueuedTurn = null;
        pending.attempt = null;
        pending.resendDeadline = null;
        if (pending.resendTimer !== null) {
          this.clearTimeoutFn(pending.resendTimer);
          pending.resendTimer = null;
        }
        this.notify();
        pending.reject(provenUnsent ? { ...error, status: "rejected", delivery: "not_delivered" } : this.uncertainTagged(error));
        this.setError(error);
      },
      onSendFailure: (cause) => {
        if (this.pendingQueuedTurn !== pending) return;
        this.pendingQueuedTurn = null;
        pending.attempt = null;
        pending.resendDeadline = null;
        if (pending.resendTimer !== null) {
          this.clearTimeoutFn(pending.resendTimer);
          pending.resendTimer = null;
        }
        const error = this.protocolErrorFrom(cause, "queued turn send failed");
        pending.reject(pending.wireSeen ? error : this.activationFailure(error));
        this.notify();
      },
      onDisconnect: () => {},
    });
  }

  private sendExtensionUiAttempt(pending: ExtensionUiPending): void {
    pending.attempt?.cancel();
    pending.attempt = this.binding.sendAttempt({
      buildMessage: (id) => ({ ...pending.command, id }),
      expectation: { kind: "command", sessionId: pending.sessionId, commandId: pending.commandId, resultType: "extension_ui_response" },
      disconnectPolicy: "logical_retry",
      onFrame: (frame) => {
        if (this.pendingExtensionUiCommand !== pending || frame.type !== "response") return;
        this.pendingExtensionUiCommand = null;
        pending.attempt = null;
        this.notify();
        if (!frame.payload.ok) { pending.reject(frame.payload.error); this.setError(frame.payload.error); return; }
        const correlated = frame.payload.result as CorrelatedRuntimeCommandResult;
        if (correlated.result.ok) pending.resolve();
        else { pending.reject(correlated.result.error); this.setError(correlated.result.error); }
      },
      onSendFailure: (cause) => {
        if (this.pendingExtensionUiCommand !== pending) return;
        this.pendingExtensionUiCommand = null;
        pending.attempt = null;
        pending.reject(cause);
        this.notify();
      },
      onDisconnect: () => {},
    });
  }

  private sendReadAttempt(pending: ReadPending, message: WsClientMessage): void {
    pending.attempt?.cancel();
    pending.attempt = this.binding.sendAttempt({
      envelopeId: pending.requestId,
      buildMessage: (id) => ({ ...message, id }),
      expectation: { kind: "read", sessionId: pending.sessionId, epoch: pending.epoch, requestId: pending.requestId, readType: pending.readType },
      disconnectPolicy: "reject_on_disconnect",
      onFrame: (frame) => {
        if (this.pendingReads.get(pending.requestId) !== pending || frame.type !== "read_result") return;
        this.pendingReads.delete(pending.requestId);
        pending.attempt = null;
        const outcome = frame.payload.result;
        if (outcome.ok) pending.resolve(outcome);
        else { pending.reject(outcome.error); this.setError(outcome.error); }
      },
      onSendFailure: (cause) => {
        if (this.pendingReads.get(pending.requestId) !== pending) return;
        this.pendingReads.delete(pending.requestId);
        pending.attempt = null;
        pending.reject(cause);
      },
      onDisconnect: (cause) => {
        if (this.pendingReads.get(pending.requestId) !== pending) return;
        this.pendingReads.delete(pending.requestId);
        pending.attempt = null;
        pending.reject(cause);
      },
    });
  }

  private sendInterruptAttempt(pending: InterruptPending): void {
    pending.attempt?.cancel();
    const interruptType = pending.message.payload.interrupt.type;
    pending.attempt = this.binding.sendAttempt({
      buildMessage: (id) => ({ ...pending.message, id }),
      expectation: { kind: "interrupt", sessionId: pending.sessionId, commandId: pending.commandId, interruptType },
      disconnectPolicy: "logical_retry",
      onFrame: (frame) => {
        if (this.pendingInterrupt !== pending || frame.type !== "interrupt_result") return;
        this.pendingInterrupt = null;
        this.pendingInterruptPromise = null;
        pending.attempt = null;
        const result = frame.payload.result;
        if (result.ok) pending.resolve(result);
        else { pending.reject(result.error); this.setError(result.error); }
      },
      onSendFailure: (cause) => {
        if (this.pendingInterrupt !== pending) return;
        this.pendingInterrupt = null;
        this.pendingInterruptPromise = null;
        pending.attempt = null;
        pending.reject(cause);
      },
      onDisconnect: () => {},
    });
  }

  private protocolErrorFrom(cause: unknown, fallback: string): ProtocolError {
    if (cause !== null && typeof cause === "object") {
      const value = cause as Partial<ProtocolError>;
      if (typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean") {
        return value as ProtocolError;
      }
    }
    return { code: "unavailable", message: fallback, retryable: true };
  }

  /** Reject one-shot envelope requests on transport loss (MEDIUM-3). */
  private onTransportLoss(): void {
    this.invalidateAdmittedSnapshot();
    // RuntimeConnection removes every old-generation attempt first. One-shot
    // and read callbacks reject exactly once there; logical retry objects stay
    // pending here until the exact attach resync decision re-registers them.
  }

  /** Reject the in-flight prompt promise exactly once (MEDIUM-4). */
  private settlePendingCommand(error: ProtocolError): void {
    const pending = this.pendingCommand;
    if (pending) {
      pending.attempt?.cancel();
      const prompt = pending.command.type === "command" && pending.command.payload.command.type === "prompt";
      pending.reject(prompt && !pending.wireSeen ? this.activationFailure(error) : error);
      this.pendingCommand = null;
    }
  }

  /** Reject the in-flight side-chat command exactly once. */
  private settlePendingSideChatCommand(error: ProtocolError): void {
    const pending = this.pendingSideChatCommand;
    if (pending === null) return;
    this.pendingSideChatCommand = null;
    pending.attempt?.cancel();
    pending.attempt = null;
    if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
    pending.timer = null;
    pending.reject(pending.type === "side_chat_send" && !pending.wireSeen ? this.activationFailure(error) : error);
    this.notify();
  }

  private sideChatAvailable(): boolean {
    return this.attached && this.epoch !== null && this.hasRuntimeCapability("runtime.side_chat");
  }

  private sideChatUnavailableError(): ProtocolError {
    return {
      code: "unsupported_capability",
      message: "side chat is unavailable",
      retryable: false,
    };
  }

  /** Capability revocation invalidates the independent lane immediately. */
  private settleSideChatOnCapabilityLoss(): void {
    if (this.snapshot?.capabilities.capabilities.includes("runtime.side_chat") !== true) {
      this.settlePendingSideChatCommand(this.sideChatUnavailableError());
    }
  }

  /**
   * Phase 2B: settle EVERY pending read exactly once (detach / stop / switch /
   * dispose / epoch change / transport loss / capability loss). No automatic
   * resend after reconnect — reads are pure queries re-issued by the caller.
   */
  private settleAllPendingReads(error: ProtocolError): void {
    if (this.pendingReads.size === 0) return;
    for (const [, pending] of this.pendingReads) { pending.attempt?.cancel(); pending.reject(error); }
    this.pendingReads.clear();
  }

  /** Reject the in-flight queued turn exactly once (D2-P4 stop/detach/dispose/session switch). */
  private settlePendingQueuedTurn(error: ProtocolError): void {
    const pending = this.pendingQueuedTurn;
    if (pending) {
      this.clearQueuedTurnReconcile(pending);
      pending.attempt?.cancel();
      pending.reject(pending.wireSeen ? error : this.activationFailure(error));
      this.pendingQueuedTurn = null;
      this.notify();
    }
  }

  /** Reject the in-flight extension reply exactly once (D2-P8 stop/detach/dispose/session switch). */
  private settlePendingExtensionUi(error: ProtocolError): void {
    if (this.pendingExtensionUiCommand) {
      this.pendingExtensionUiCommand.attempt?.cancel();
      this.pendingExtensionUiCommand.reject(error);
      this.pendingExtensionUiCommand = null;
      this.notify();
    }
  }

  /**
   * D2-P8 capability-loss settle: when the runtime drops `runtime.extension_ui`
   * (authoritative snapshot/event), an in-flight reply is rejected so the slot
   * never leaks and the UI's capability refs make the rejection inert.
   */
  private settleExtensionUiOnCapabilityLoss(): void {
    if (this.snapshot?.capabilities.capabilities.includes("runtime.extension_ui") !== true) {
      this.settlePendingExtensionUi({
        code: "unsupported_capability",
        message: "runtime capability revoked",
        retryable: false,
      });
    }
  }

  /**
   * F6 request-close settle: an `extension_ui_request` event carrying the
   * canonical close marker (`request.closed: true`) is the wire for the runtime
   * deciding a pending extension request is done — cancel, abort, timeout and
   * normal completion all surface as close, so the in-flight reply can NEVER
   * resolve success. `reduceRuntimeEventData` already removed the request from
   * the projection above, but the {@link pendingExtensionUiCommand} promise
   * slot would otherwise stay occupied until lifecycle cleanup. This settles it
   * ONLY when every exact condition matches (same generation, sessionId,
   * requestId, method); any mismatch means the close belongs to a different
   * reply and is ignored. Deliberately NON-STICKY: a close for an unknown or
   * already-settled request is a no-op, so a LATER pending reply is still
   * settled by its own close. Never sets the global error (this is an expected,
   * non-fatal interruption of a single request).
   */
  private settleExtensionUiOnRequestClose(event: RuntimeEventData & { readonly eventId: number; readonly epoch: string }): void {
    if (event.type !== "extension_ui_request" || event.request.closed !== true) return;
    const pending = this.pendingExtensionUiCommand;
    if (!pending) return;
    if (
      pending.attempt?.generation !== (this.attachGen ?? -1) ||
      pending.sessionId !== event.sessionId ||
      pending.requestId !== event.request.id ||
      pending.method !== event.request.method
    ) {
      return;
    }
    pending.attempt?.cancel();
    this.pendingExtensionUiCommand = null;
    this.notify();
    pending.reject({
      code: "interrupted",
      message: "extension UI request closed",
      retryable: false,
    } satisfies ProtocolError);
  }

  private ensureConnecting(): void {
    if (this.connection === "idle") this.runtimeConnection.connect();
  }

  /**
   * Lifecycle gate for create/open: proceed once the socket is SENDABLE and
   * PROVABLY fresh (the shared transport gate — a stale-but-sendable
   * connection is probed/recovered instead of written into). An in-flight
   * attach must not block a newer selection — startAttach supersedes it
   * identity-scoped (rapid A→B→C switching).
   */
  private whenReadyForLifecycle(): Promise<void> {
    return this.whenSendable(LIFECYCLE_GATE_TIMEOUT_MS);
  }

  /** Resolve when the socket is sendable (ready/attaching/attached), bounded. */
  private whenSendable(timeoutMs: number): Promise<void> {
    return this.runtimeConnection.whenSendable(timeoutMs);
  }

  private failAllPending(error: ProtocolError): void {
    this.rejectAttach(error);
    this.settlePendingCommand(error);
    this.settlePendingSideChatCommand(error);
    this.settleAllPendingReads(error);
    this.settlePendingQueuedTurn(error);
    this.settlePendingExtensionUi(error);
    this.settleTurn(error);
    this.invalidateAdmittedSnapshot();
    this.pendingInterrupt?.reject(error);
    this.pendingInterrupt = null;
    this.pendingInterruptPromise = null;
    // Teardown: drop the speculative live layer (bubbles + running overlay) and
    // release the single-flight prompt transaction slot.
    this.optimisticUserEntries = [];
    this.optimisticPromptRunning = false;
    this.optimisticPromptSessionId = null;
    this.promptTransaction = null;
    this.pendingLeafRebase = null;
  }

  private isPromptRunning(): boolean {
    return this.optimisticPromptRunning
      || this.snapshot?.state.isPromptRunning === true
      || this.snapshot?.state.isStreaming === true;
  }

  private identityMismatchError(actual: string): ProtocolError {
    return {
      code: "not_found",
      message: `controller ${this.sessionId} cannot own session ${actual}`,
      retryable: false,
    };
  }

  private notAttachedError(): ProtocolError {
    return { code: "unavailable", message: "not attached to a runtime session", retryable: false };
  }

  private setError(error: ProtocolError): void {
    this.error = error;
    this.notify();
  }

  private setConnection(state: ConnectionState): void {
    this.connection = state;
    this.notify();
  }

  private computeView(): ControllerView {
    // Speculative overlay: the view's snapshot is a PROJECTION that reflects
    // the optimistic running flag WITHOUT ever mutating the authoritative
    // snapshot (reduced from real events / replaced by fetchSnapshot). The
    // whole UI (transcript pulse, composer Stop) sees the instant running
    // state while the wire round-trip settles.
    const authoritative = this.snapshot;
    const projected = this.optimisticPromptRunning
      && this.optimisticPromptSessionId === this.sessionId
      && authoritative
      ? {
          ...authoritative,
          state: { ...authoritative.state, isPromptRunning: true },
          streaming: {
            ...authoritative.streaming,
            active: true,
            phase: authoritative.streaming?.phase ?? "waiting_model",
          },
        }
      : authoritative;
    const snapshot = projected;
    const streaming = snapshot?.streaming?.active === true || snapshot?.state.isStreaming === true;
    const streamingPartial = snapshot?.streaming?.partialMessage ?? null;
    const transport = this.runtimeConnection.getSnapshot();
    return {
      connection: this.connection,
      host: transport.host,
      attached: this.attached,
      sessionStopped: this.sessionStopped,
      sessionId: this.sessionId,
      epoch: this.epoch,
      snapshot,
      streaming,
      streamingPartial,
      promptPending: this.promptTransaction !== null,
      optimisticRunningSessionId: this.optimisticPromptSessionId,
      runningSessionIds: [...transport.runningSessionIds],
      liveSessionIds: [...transport.liveSessionIds],
      liveSessionStateKnown: transport.liveSessionStateKnown,
      attachGeneration: this.attachGeneration,
      historyGeneration: this.historyGeneration,
      historyAnchorLeafId: this.historyAnchorLeafId,
      hasAdmittedSnapshot: this.computeAdmittedSnapshotEligible(),
      resuming: this.resuming,
      createdWithAutoThinking: this.createdWithAutoThinking,
      // Exact-session projection: `liveEntries` is COMMITTED ONLY. Speculative
      // user bubbles live exclusively in `optimisticEntries`. The legacy
      // Test-only TestRuntimeStore recomposes the old merged tail for relocated
      // facade-parity tests (see runtime/testing/test-runtime-store.ts).
      liveEntries: [...this.liveEntries],
      optimisticEntries: this.optimisticUserEntries.map((candidate) => ({
        sessionId: candidate.sessionId,
        entry: candidate.entry,
        ...(candidate.baseEntryId === undefined ? {} : { baseEntryId: candidate.baseEntryId }),
        ...(candidate.identity === undefined ? {} : { identity: candidate.identity }),
      })),
      error: this.error,
      fatal: transport.fatal || this.fatal,
      canAgent: transport.host?.capabilities.includes("agent") === true,
      queuedTurnPending: this.pendingQueuedTurn !== null,
      extensionUiReplyPending: this.pendingExtensionUiCommand !== null,
      capabilities: this.attached || this.resuming ? (snapshot?.capabilities ?? null) : null,
      turnActive: this.pendingTurn !== null,
      // An accepted turn is always delivered; there is no delivery verdict to
      // report any more (the outbox owns retries and the authority owns
      // delivery). Kept on the view for existing consumers.
      turnDelivery: this.pendingTurn === null ? null : "accepted",
      submitTurnEnabled: this.runtimeConnection.hasFeature(RUNTIME_SUBMIT_TURN_FEATURE),
    };
  }

  private notify(): void {
    this.view = this.computeView();
    for (const listener of this.listeners) listener();
  }
}
