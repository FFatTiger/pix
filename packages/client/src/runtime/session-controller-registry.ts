import type { ProtocolError, RuntimeCreateResult } from "@fffattiger/pix-protocol";
import { RUNTIME_EXPLICIT_ACTIVATE_FEATURE, RUNTIME_OBSERVE_EXISTING_FEATURE } from "@fffattiger/pix-protocol";
import {
  RuntimeConnection,
  type RuntimeAttachmentRouteHandle,
  type RuntimeTransportState,
} from "./runtime-connection.js";
import {
  SessionController,
  type ControllerEvictionProtection,
  type ObservationRequestContext,
  type PresentationProvenance,
  type SessionControllerOptions,
  type TurnTerminalInfo,
} from "./session-controller.js";

const DEFAULT_MAX_CONTROLLERS = 32;

/**
 * Canonical presentation key for an exact session target. This is the SAME
 * string the shell's session tab identity uses (`sessionTabId`); a contract
 * test pins the equality so the two vocabularies can never drift.
 */
export function sessionPresentationKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Canonical presentation key for a home/draft target. Distinct cwds are distinct presentations. */
export function homePresentationKey(cwd: string | undefined): string {
  return `home:${cwd ?? ""}`;
}

export type AttachmentLeasePhase = "vacant" | "acquiring" | "held" | "releasing" | "suspended";

export interface AttachmentLeaseSnapshot {
  readonly phase: AttachmentLeasePhase;
  readonly generation: number;
  readonly desiredSessionId: string | null;
  readonly holderSessionId: string | null;
  readonly sourceSessionId: string | null;
  readonly targetSessionId: string | null;
}

export interface SessionControllerRegistrySnapshot {
  readonly maxControllers: number;
  readonly controllerCount: number;
  readonly createReserved: boolean;
  readonly accessOrdinal: number;
  readonly ordinals: Readonly<Record<string, number>>;
  readonly lease: AttachmentLeaseSnapshot;
  /** LC-02 presentation truth (route-declared; see {@link declarePresentation}). */
  readonly presentationKey: string | null;
  readonly presentationAuthorized: boolean;
  readonly presentationRevision: number;
}

/** Global indicator-only projection of the most-recent optimistic/turn owner. */
export interface RuntimeForegroundActivity {
  readonly optimisticRunningSessionId: string | null;
}

export interface SessionControllerRegistryOptions {
  readonly maxControllers?: number;
  readonly controllerOptions?: Omit<SessionControllerOptions, "requestObservation" | "initialAuthority">;
}

interface ControllerRecord {
  readonly controller: SessionController;
  accessOrdinal: number;
  readonly unsubscribe: () => void;
  readonly unsubscribeTerminal: () => void;
}

/** Exact-ID observer (pure React hook subscription). See {@link SessionControllerRegistry.subscribeSession}. */
interface SessionObserver {
  readonly listeners: Set<() => void>;
  /** Controller-notification forward while the exact controller is registered. */
  unsubscribeController: (() => void) | null;
}

interface LeaseIntent {
  readonly generation: number;
  readonly sessionId: string;
  /** Which attach intent this acquisition drives on the target controller. */
  readonly mode: "legacy" | "existing" | "activate";
  /** Token captured at explicit-action start; a later distinct presentation rejects it. */
  readonly provenance: PresentationProvenance | null;
  settled: boolean;
  resolve(): void;
  reject(error: unknown): void;
  readonly promise: Promise<void>;
}

function busyCapacityError(): ProtocolError {
  return {
    code: "session_busy",
    message: "runtime session controller registry is full",
    retryable: true,
  };
}

function interruptedAcquireError(): ProtocolError {
  return {
    code: "interrupted",
    message: "superseded by a newer session selection",
    retryable: false,
  };
}

function observationReleaseError(cause: unknown): ProtocolError {
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return {
        code: code as ProtocolError["code"],
        message: "observation release failed",
        retryable: (cause as { retryable?: boolean }).retryable === true,
      };
    }
  }
  return { code: "unavailable", message: "observation release failed", retryable: true };
}

/**
 * Bounded exact-session controller owner and the sole semantic Browser
 * attachment lease. RuntimeConnection remains transport-only: this registry
 * decides admission, retention, observation transfer and reconnect target.
 */
export class SessionControllerRegistry {
  private readonly maxControllers: number;
  private readonly controllerOptions: Omit<SessionControllerOptions, "requestObservation" | "initialAuthority">;
  private readonly records = new Map<string, ControllerRecord>();
  private readonly sessionObservers = new Map<string, SessionObserver>();
  private readonly listeners = new Set<() => void>();
  private readonly terminalListeners = new Set<(terminal: TurnTerminalInfo) => void>();
  private readonly connectionUnsubscribe: () => void;
  private route: RuntimeAttachmentRouteHandle | null = null;
  private ordinal = 0;
  private createReserved = false;
  private disposed = false;
  private activeIntent: LeaseIntent | null = null;
  private lastPresentedSessionId: string | null = null;
  // ── LC-02 presentation truth ──────────────────────────────────────────────
  // The route/shell remains the selection SOURCE OF TRUTH; the registry only
  // records the declared presentation target + admission rights and owns the
  // monotonic revision. Busy-set changes never touch this state.
  private presentationKey: string | null = null;
  private presentationAuthorized = false;
  private presentationRevision = 0;
  /** Presentation token captured at createSession() start (single-flight). */
  private createPresentationCapture: PresentationProvenance | null = null;
  /** Originating draft token of an in-flight first-send create; survives self-promotion. */
  private createOrigin: PresentationProvenance | null = null;
  /** Created session id after a legal first-send promotion (null until then). */
  private createPromotedSessionId: string | null = null;
  /** One-shot create-start token consumed by the FIRST submit of that created controller. */
  private createdSubmitProvenanceBySession = new Map<string, PresentationProvenance>();
  private lease: AttachmentLeaseSnapshot = {
    phase: "vacant",
    generation: 0,
    desiredSessionId: null,
    holderSessionId: null,
    sourceSessionId: null,
    targetSessionId: null,
  };

  constructor(
    private readonly runtimeConnection: RuntimeConnection,
    options: SessionControllerRegistryOptions = {},
  ) {
    this.maxControllers = options.maxControllers ?? DEFAULT_MAX_CONTROLLERS;
    if (!Number.isInteger(this.maxControllers) || this.maxControllers < 1) {
      throw new Error("SessionControllerRegistry maxControllers must be a positive integer");
    }
    this.controllerOptions = options.controllerOptions ?? {};
    this.connectionUnsubscribe = runtimeConnection.subscribe(() => this.onConnectionChanged());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeTurnTerminal(listener: (terminal: TurnTerminalInfo) => void): () => void {
    this.terminalListeners.add(listener);
    return () => { this.terminalListeners.delete(listener); };
  }

  getSnapshot = (): SessionControllerRegistrySnapshot => {
    const ordinals: Record<string, number> = {};
    for (const [sessionId, record] of this.records) ordinals[sessionId] = record.accessOrdinal;
    return {
      maxControllers: this.maxControllers,
      controllerCount: this.records.size,
      createReserved: this.createReserved,
      accessOrdinal: this.ordinal,
      ordinals,
      lease: { ...this.lease },
      presentationKey: this.presentationKey,
      presentationAuthorized: this.presentationAuthorized,
      presentationRevision: this.presentationRevision,
    };
  };

  get leaseSnapshot(): AttachmentLeaseSnapshot { return { ...this.lease }; }
  get controllerCount(): number { return this.records.size; }
  get capacity(): number { return this.maxControllers; }

  /**
   * GLOBAL indicator-only snapshot of the most-recent exact optimistic/turn
   * owner. Never selected/current/lease fallback and never a lifecycle owner.
   * AppShell unions this id into running cues; selected transcript/composer
   * never consume it as selected snapshot.
   */
  getForegroundActivity = (): RuntimeForegroundActivity => {
    const controller = this.foregroundOperationController();
    return { optimisticRunningSessionId: controller?.getSnapshot().optimisticRunningSessionId ?? null };
  };

  /** Exact lookup only. No current/selected fallback. Lookup is an LRU touch. */
  lookup(sessionId: string): SessionController | null {
    const record = this.records.get(sessionId);
    if (record === undefined) return null;
    this.touchRecord(record);
    return record.controller;
  }

  /**
   * PURE exact lookup — never touches LRU recency, never publishes, never
   * admits/adopts. A React exact observer may call this on every notification
   * without perturbing eviction order or emitting any wire/registry side effect.
   */
  peek(sessionId: string): SessionController | null {
    return this.records.get(sessionId)?.controller ?? null;
  }

  /**
   * Exact-ID membership + exact controller subscription for the React exact
   * hooks. The listener fires on: registration, eviction, re-registration and
   * every exact controller view change. It NEVER touches LRU recency and
   * NEVER creates eviction protection — a mounted observer is evictable (the
   * hook falls back to `available:false` on eviction and re-admits only on
   * action invocation).
   */
  subscribeSession(sessionId: string, listener: () => void): () => void {
    let observer = this.sessionObservers.get(sessionId);
    if (observer === undefined) {
      observer = { listeners: new Set(), unsubscribeController: null };
      this.sessionObservers.set(sessionId, observer);
    }
    observer.listeners.add(listener);
    if (observer.unsubscribeController === null) {
      const record = this.records.get(sessionId);
      if (record !== undefined) {
        const target = observer;
        target.unsubscribeController = record.controller.subscribe(() => this.notifySessionObservers(sessionId));
      }
    }
    return () => {
      const current = this.sessionObservers.get(sessionId);
      if (current === undefined) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.unsubscribeController?.();
        current.unsubscribeController = null;
        this.sessionObservers.delete(sessionId);
      }
    };
  }

  /** Exact synchronous lookup/create with bounded admission and stable identity. */
  getOrCreate(sessionId: string): SessionController {
    if (this.disposed) throw { code: "unavailable", message: "runtime registry disposed", retryable: false } satisfies ProtocolError;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw { code: "invalid_input", message: "no session selected", retryable: false } satisfies ProtocolError;
    }
    const existing = this.records.get(sessionId);
    if (existing !== undefined) {
      this.touchRecord(existing);
      return existing.controller;
    }
    this.ensureAdmissionSlot();
    return this.registerController(sessionId);
  }

  /** Reserve capacity before runtime.create can start a Worker. */
  createSession(params: { cwd: string; projectRoot: string }): Promise<{ sessionId: string }> {
    if (this.disposed) return Promise.reject({ code: "unavailable", message: "runtime registry disposed", retryable: false } satisfies ProtocolError);
    if (this.createReserved || this.runtimeConnection.hasPendingCreate) {
      return Promise.reject({ code: "session_busy", message: "a session create is already in progress", retryable: false } satisfies ProtocolError);
    }
    // LC-02: capture the presentation token at CREATE START (= first-send
    // start). The later promotion to the created identity is legal only while
    // this token is still current (see {@link promoteCreatedPresentation}).
    this.createPresentationCapture = this.capturePresentation();
    this.createOrigin = this.createPresentationCapture;
    this.createPromotedSessionId = null;
    try {
      this.reserveCreateSlot();
    } catch (error) {
      this.createPresentationCapture = null;
      this.createOrigin = null;
      this.createPromotedSessionId = null;
      return Promise.reject(error);
    }
    return this.runtimeConnection.createSession(params).then(
      (result) => {
        try {
          const existing = this.records.get(result.sessionId);
          if (existing !== undefined) {
            // Never create a second binding. Merge only when the exact existing
            // controller proves it is detached/quiescent and authority-compatible.
            if (!existing.controller.adoptCreatedAuthority(result)) {
              throw { code: "internal", message: "create response collided with an existing session controller", retryable: false } satisfies ProtocolError;
            }
            this.touchRecord(existing);
          } else {
            this.registerController(result.sessionId, result);
          }
          if (this.createPresentationCapture !== null) {
            this.createdSubmitProvenanceBySession.set(result.sessionId, this.createPresentationCapture);
          }
          // Registration/binding is synchronous above, before this public promise
          // resolves and before any caller continuation can lookup the id.
          return { sessionId: result.sessionId };
        } finally {
          this.createReserved = false;
          this.publish();
        }
      },
      (error) => {
        this.createReserved = false;
        this.createPresentationCapture = null;
        this.createOrigin = null;
        this.createPromotedSessionId = null;
        this.publish();
        throw error;
      },
    );
  }

  /**
   * LC-02 route declaration of the CURRENT presentation target. Idempotent for
   * an unchanged key+authorization (StrictMode double-effects and rerenders
   * never invent newer user intent); the monotonic {@link presentationRevision}
   * advances ONLY when the presentation key or the admission rights actually
   * change. The declaration itself admits/activates NOTHING — the route stays
   * the truth source; observation decisions remain with the lease machine and
   * the shell's admission predicate.
   */
  declarePresentation(key: string | null, authorized: boolean): void {
    if (this.disposed) return;
    if (key === this.presentationKey && authorized === this.presentationAuthorized) return;
    this.presentationRevision += 1;
    this.presentationKey = key;
    this.presentationAuthorized = authorized;
    // Confirming the already-promoted created session is not a user switch.
    // Any other route/auth declaration supersedes the originating draft.
    const promotedKey = this.createPromotedSessionId === null ? null : sessionPresentationKey(this.createPromotedSessionId);
    if (this.createOrigin !== null && key !== this.createOrigin.key && key !== promotedKey) {
      this.createOrigin = null;
      this.createPromotedSessionId = null;
    }
    for (const record of this.records.values()) record.controller.refreshPresentationEligibility();
    this.publish();
  }

  /** Token for send/action-start captures (see {@link PresentationProvenance}). */
  capturePresentation(): PresentationProvenance {
    return { key: this.presentationKey, revision: this.presentationRevision };
  }

  /** Exact-match validity: same key AND same revision (a route or authorization change bumps it). */
  isPresentationCurrent(provenance: PresentationProvenance): boolean {
    if (provenance.key === this.presentationKey && provenance.revision === this.presentationRevision) return true;
    // Self-promotion of an in-flight first-send create is NOT a user switch:
    // the originating draft token remains current until a later distinct
    // route/auth declaration (or create failure) replaces it.
    const origin = this.createOrigin;
    if (origin === null || this.createPromotedSessionId === null) return false;
    if (provenance.key !== origin.key || provenance.revision !== origin.revision) return false;
    return this.presentationKey === sessionPresentationKey(this.createPromotedSessionId);
  }

  /**
   * LC-02 new-session first-send promotion. Called at the dispatch boundary
   * (after the created controller owns the prompt transaction, BEFORE the
   * route navigation). The initiating draft/home token transfers to the created
   * session's presentation key — coherently retargeting the in-flight turn's
   * provenance — ONLY while the captured token is still current. A late create
   * that landed after the user switched to another draft/cwd/file/session stays
   * background: no promotion, no navigation, no lease steal (the caller checks
   * the returned flag before navigating).
   */
  promoteCreatedPresentation(sessionId: string): boolean {
    const capture = this.createPresentationCapture;
    this.createPresentationCapture = null;
    if (capture === null || !this.isPresentationCurrent(capture)) {
      this.createOrigin = null;
      this.createPromotedSessionId = null;
      return false;
    }
    this.createPromotedSessionId = sessionId;
    this.setPresentationTargetForSession(sessionId, capture);
    return true;
  }

  /**
   * Latest-intent-wins acquisition of the one Browser observation lease.
   *
   * FINITE Protocol-v2 compatibility shim (LC-02): this drives the LEGACY
   * activating attach (`SessionController.openSession`). Production
   * observation callers use {@link observeExisting}; cold-explicit callers use
   * {@link activateAndObserve}. Remaining production caller: the
   * legacy v2 send chain (no negotiated submit-turn). Removal condition:
   * Protocol v3 minimum + all callers migrated (migration ledger).
   */
  acquire(sessionId: string): Promise<void> {
    return this.beginLeaseIntent(sessionId, "legacy", this.capturePresentation());
  }

  /**
   * LC-02 observation-only acquisition of the one Browser observation lease —
   * the SAME lease/generation machine as {@link acquire}, driving the target
   * controller's `observeExisting()` (attachMode `existing_only` on every
   * attempt; never an activating fallback). Requires the negotiated
   * `runtime.observe-existing.v1` feature and fails closed with a structured
   * `unsupported_capability` when it is absent (no empty success, no legacy
   * attach). The acquisition records this session as the latest intent target
   * (idempotent when the route already declared it).
   */
  observeExisting(sessionId: string): Promise<void> {
    if (!this.runtimeConnection.hasFeature(RUNTIME_OBSERVE_EXISTING_FEATURE)) {
      return Promise.reject({
        code: "unsupported_capability",
        message: "observation of an existing runtime is unavailable",
        retryable: false,
      } satisfies ProtocolError);
    }
    return this.beginLeaseIntent(sessionId, "existing", this.capturePresentation());
  }

  /**
   * LC-02 explicit cold activation → observation over the SAME one lease as
   * {@link observeExisting}. Captures the presentation token at ACTION START;
   * a later distinct target rejects the in-flight activation without a second
   * activate/attach. Ordinary sends stay atomic via submitTurn.
   */
  activateAndObserve(sessionId: string): Promise<void> {
    if (!this.runtimeConnection.hasFeature(RUNTIME_EXPLICIT_ACTIVATE_FEATURE)) {
      return Promise.reject({
        code: "unsupported_capability",
        message: "explicit runtime activation is unavailable",
        retryable: false,
      } satisfies ProtocolError);
    }
    return this.beginLeaseIntent(sessionId, "activate", this.capturePresentation());
  }

  /** Observation-only release. The controller remains registered and retained. */
  release(): Promise<void> {
    const generation = this.lease.generation + 1;
    const route = this.route;
    this.rejectActiveIntent(interruptedAcquireError());
    const holderId = this.lease.holderSessionId;
    const acquiringId = this.lease.phase === "acquiring" ? this.lease.targetSessionId : null;
    if (acquiringId !== null && acquiringId !== holderId) {
      this.records.get(acquiringId)?.controller.cancelObservationIntent(interruptedAcquireError());
    }
    if (holderId === null) {
      this.lease = { phase: "vacant", generation, desiredSessionId: null, holderSessionId: null, sourceSessionId: null, targetSessionId: null };
      this.clearObservationRoute(route, generation);
      this.publish();
      return Promise.resolve();
    }
    const holder = this.records.get(holderId)?.controller;
    if (holder === undefined) {
      this.lease = { phase: "vacant", generation, desiredSessionId: null, holderSessionId: null, sourceSessionId: null, targetSessionId: null };
      this.clearObservationRoute(route, generation);
      this.publish();
      return Promise.resolve();
    }
    // Fail closed locally immediately: advance the lease first so the exact
    // captured route can be cleared. Detach is sent while the binding is still
    // live; A.attached is then dropped so in-flight events cannot apply.
    this.lease = { phase: "releasing", generation, desiredSessionId: null, holderSessionId: holderId, sourceSessionId: holderId, targetSessionId: null };
    this.clearObservationRoute(route, generation);
    this.publish();
    const detach = holder.detach();
    holder.releaseLocalObservation();
    return detach.then(
      () => {
        if (this.lease.generation !== generation) return;
        this.lease = { phase: "vacant", generation, desiredSessionId: null, holderSessionId: null, sourceSessionId: null, targetSessionId: null };
        this.publish();
      },
      (cause: unknown) => {
        const error = observationReleaseError(cause);
        holder.setObservationError(error);
        if (this.lease.generation !== generation) throw error;
        this.lease = { phase: "vacant", generation, desiredSessionId: null, holderSessionId: null, sourceSessionId: null, targetSessionId: null };
        this.publish();
        throw error;
      },
    );
  }

  /** Explicit exact stop authority; never inferred from release/eviction/dispose. */
  async stop(sessionId: string, reason?: string): Promise<void> {
    const controller = this.records.get(sessionId)?.controller;
    if (controller === undefined) return;
    await controller.stop(reason);
    if (this.lease.holderSessionId === sessionId || this.lease.desiredSessionId === sessionId) {
      this.route?.clear();
      this.route = null;
      this.rejectActiveIntent({ code: "interrupted", message: "stopped", retryable: false } satisfies ProtocolError);
      this.lease = {
        phase: "vacant",
        generation: this.lease.generation + 1,
        desiredSessionId: null,
        holderSessionId: null,
        sourceSessionId: null,
        targetSessionId: null,
      };
    }
    this.publish();
  }

  /** Most-recent exact optimistic/turn owner (indicator projection + TestRuntimeStore). */
  foregroundOperationController(): SessionController | null {
    return [...this.records.values()]
      .filter((record) => {
        const view = record.controller.getSnapshot();
        return view.promptPending || view.turnActive || record.controller.hasRetainedOptimism;
      })
      .sort((a, b) => b.accessOrdinal - a.accessOrdinal)[0]?.controller ?? null;
  }

  /** TEST-ONLY: lease target/holder for TestRuntimeStore merged projection. */
  currentController(): SessionController | null {
    const id = this.lease.desiredSessionId ?? this.lease.holderSessionId;
    if (id !== null) return this.records.get(id)?.controller ?? null;
    if (this.lastPresentedSessionId === null) return null;
    const last = this.records.get(this.lastPresentedSessionId)?.controller ?? null;
    return last?.sessionStoppedNow === true ? last : null;
  }

  /** Registry/provider teardown: local settlement + one socket close, never stop. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectActiveIntent({ code: "unavailable", message: "runtime registry disposed", retryable: false } satisfies ProtocolError);
    this.route?.clear();
    this.route = null;
    this.connectionUnsubscribe();
    for (const sessionId of [...this.records.keys()]) this.evictExact(sessionId);
    this.createdSubmitProvenanceBySession.clear();
    for (const observer of this.sessionObservers.values()) observer.unsubscribeController?.();
    this.sessionObservers.clear();
    this.createReserved = false;
    this.runtimeConnection.dispose();
    this.lease = {
      phase: "vacant",
      generation: this.lease.generation + 1,
      desiredSessionId: null,
      holderSessionId: null,
      sourceSessionId: null,
      targetSessionId: null,
    };
    this.publish();
  }

  private registerController(sessionId: string, authority?: RuntimeCreateResult): SessionController {
    const controller = new SessionController(sessionId, this.runtimeConnection, {
      ...this.controllerOptions,
      ...(authority === undefined ? {} : { initialAuthority: authority }),
      requestObservation: (target, context) => this.requestObservationFor(target, context),
      capturePresentationProvenance: () => this.capturePresentation(),
      consumeCreatedSubmitProvenance: () => this.consumeCreatedSubmitProvenance(sessionId),
      isPresentationCurrent: (provenance) => this.isPresentationCurrent(provenance),
    });
    const record: ControllerRecord = {
      controller,
      accessOrdinal: ++this.ordinal,
      unsubscribe: controller.subscribe(() => this.onControllerChanged(controller)),
      unsubscribeTerminal: controller.subscribeTurnTerminal((terminal) => {
        for (const listener of [...this.terminalListeners]) {
          try { listener(terminal); } catch { /* listener isolation */ }
        }
        this.publish();
      }),
    };
    this.records.set(sessionId, record);
    this.publish();
    // Membership added for exact-ID observers: rewire the controller forward
    // (a re-registered controller replaces any stale forward) and notify.
    const observer = this.sessionObservers.get(sessionId);
    if (observer !== undefined) {
      observer.unsubscribeController?.();
      observer.unsubscribeController = controller.subscribe(() => this.notifySessionObservers(sessionId));
      this.notifySessionObservers(sessionId);
    }
    return controller;
  }

  private touchRecord(record: ControllerRecord): void {
    record.accessOrdinal = ++this.ordinal;
    this.publish();
  }

  private reserveCreateSlot(): void {
    this.ensureAdmissionSlot();
    this.createReserved = true;
    this.publish();
  }

  private ensureAdmissionSlot(): void {
    const used = this.records.size + (this.createReserved ? 1 : 0);
    if (used < this.maxControllers) return;
    const evictable = [...this.records.entries()]
      .filter(([sessionId, record]) => this.canEvict(sessionId, record.controller.evictionProtection))
      .sort((a, b) => a[1].accessOrdinal - b[1].accessOrdinal || a[0].localeCompare(b[0]))[0];
    if (evictable === undefined) throw busyCapacityError();
    this.evictExact(evictable[0]);
  }

  private canEvict(sessionId: string, protection: ControllerEvictionProtection): boolean {
    if (!protection.quiescent) return false;
    return sessionId !== this.lease.holderSessionId
      && sessionId !== this.lease.desiredSessionId
      && sessionId !== this.lease.sourceSessionId
      && sessionId !== this.lease.targetSessionId;
  }

  private evictExact(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    record.unsubscribe();
    record.unsubscribeTerminal();
    this.records.delete(sessionId);
    this.createdSubmitProvenanceBySession.delete(sessionId);
    record.controller.dispose();
    if (this.lastPresentedSessionId === sessionId) this.lastPresentedSessionId = null;
    // Membership removed for exact-ID observers: drop the controller forward
    // (the controller is disposed) and notify so the hook falls back to
    // `available:false`. Never touches the (now disposed) controller.
    const observer = this.sessionObservers.get(sessionId);
    if (observer !== undefined) {
      observer.unsubscribeController?.();
      observer.unsubscribeController = null;
      this.notifySessionObservers(sessionId);
    }
  }

  private consumeCreatedSubmitProvenance(sessionId: string): PresentationProvenance | null {
    const token = this.createdSubmitProvenanceBySession.get(sessionId) ?? null;
    if (token !== null) this.createdSubmitProvenanceBySession.delete(sessionId);
    return token;
  }

  /** Shared latest-intent-wins lease acquisition for both attach intents. */
  private beginLeaseIntent(sessionId: string, mode: "legacy" | "existing" | "activate", provenance: PresentationProvenance | null = null): Promise<void> {
    let target: SessionController;
    try {
      target = this.getOrCreate(sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    this.lastPresentedSessionId = sessionId;
    // Lease acquisition follows the already-declared presentation. The route/
    // promotion owner remains the truth source — an explicit acquire MUST NOT
    // mint a newer presentation revision (that would let a late callback look
    // like a newer user selection).
    if (this.lease.phase === "held" && this.lease.holderSessionId === sessionId && target.attachedNow) {
      return Promise.resolve();
    }
    if (this.activeIntent !== null && !this.activeIntent.settled && this.activeIntent.sessionId === sessionId) {
      // Reuse the in-flight intent for the SAME target regardless of its mode:
      // the wire frame of an already-sent attach cannot be rewritten, and the
      // lease target — not the mode — owns supersession semantics.
      return this.activeIntent.promise;
    }

    const generation = this.lease.generation + 1;
    this.rejectActiveIntent(interruptedAcquireError());
    const priorTargetId = this.lease.phase === "acquiring" ? this.lease.targetSessionId : null;
    if (priorTargetId !== null && priorTargetId !== sessionId && priorTargetId !== this.lease.holderSessionId) {
      this.records.get(priorTargetId)?.controller.cancelObservationIntent(interruptedAcquireError());
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const intent: LeaseIntent = { generation, sessionId, mode, provenance, settled: false, resolve, reject, promise };
    this.activeIntent = intent;
    this.lease = {
      phase: this.lease.holderSessionId !== null && this.lease.holderSessionId !== sessionId ? "releasing" : "acquiring",
      generation,
      desiredSessionId: sessionId,
      holderSessionId: this.lease.holderSessionId,
      sourceSessionId: this.lease.holderSessionId,
      targetSessionId: sessionId,
    };
    this.publish();
    void this.driveAcquire(intent, target);
    return promise;
  }

  /**
   * Presentation-key change driven by an intent action (explicit lease
   * acquisition or the created-session promotion). Coherently transfers the
   * affected controller's in-flight turn provenance from the OLD presentation
   * state to the new one, so a promotion never orphans its own admission.
   */
  private setPresentationTargetForSession(sessionId: string, from?: PresentationProvenance): void {
    const newKey = sessionPresentationKey(sessionId);
    if (newKey === this.presentationKey) return;
    const fromToken = from ?? this.capturePresentation();
    this.presentationRevision += 1;
    this.presentationKey = newKey;
    this.records.get(sessionId)?.controller?.transferPresentationProvenance(fromToken, this.capturePresentation());
    this.publish();
  }

  /**
   * LC-02 gated observation seam for controller-initiated transitions:
   *  - the provenance captured at SEND START must still match the current
   *    presentation (same key + revision). A late admission/activation for a
   *    superseded presentation resolves WITHOUT touching the lease — the turn
   *    already settled exactly once on its own controller and keeps running in
   *    the background; no other session's drafts/stop/replay are touched;
   *  - `post-admission` (negotiated atomic submit) observes EXISTING-ONLY —
   *    the Worker is already active; a missing observe feature rejects
   *    honestly (no activating fallback);
   *  - `activation` is the finite legacy v2 send chain (acquiring attach).
   */
  private requestObservationFor(sessionId: string, context: ObservationRequestContext): Promise<void> {
    if (context.provenance !== null && !this.isPresentationCurrent(context.provenance)) {
      return Promise.resolve();
    }
    if (context.intent === "post-admission") {
      // Accepted atomic submit already activated the Worker. Observation is
      // existing-only, or a structured unsupported_capability — NEVER the
      // legacy activating attach (that would resurrect a stopped Worker).
      if (!this.runtimeConnection.hasFeature(RUNTIME_OBSERVE_EXISTING_FEATURE)) {
        return Promise.reject({
          code: "unsupported_capability",
          message: "observation of an existing runtime is unavailable",
          retryable: false,
        } satisfies ProtocolError);
      }
      return this.beginLeaseIntent(sessionId, "existing", context.provenance);
    }
    return this.beginLeaseIntent(sessionId, "legacy", context.provenance);
  }

  private abandonStaleIntent(intent: LeaseIntent, error: ProtocolError): boolean {
    const stale = intent.provenance === null || !this.isPresentationCurrent(intent.provenance);
    if (this.isCurrentIntent(intent) && !stale) return false;
    const holderAttached = this.lease.holderSessionId === intent.sessionId
      && this.records.get(intent.sessionId)?.controller.attachedNow === true;
    if (holderAttached) {
      // Background observation already landed. A later distinct presentation
      // must not locally drop the retained runtime (no detach frame, no model loss).
      if (this.isCurrentIntent(intent)) this.holdIntent(intent);
      return true;
    }
    if (this.isCurrentIntent(intent)) {
      this.settleIntent(intent, intent.mode === "existing" ? "resolve" : "reject", error);
      this.lease = {
        phase: this.lease.holderSessionId !== null ? "held" : "vacant",
        generation: intent.generation,
        desiredSessionId: this.lease.holderSessionId,
        holderSessionId: this.lease.holderSessionId,
        sourceSessionId: null,
        targetSessionId: null,
      };
      this.publish();
      this.cleanupStaleAcquire(intent);
      return true;
    }
    // A successful hold of this generation already settled the intent. Do not
    // tear down the live route/controller; driveAcquire just must not hold twice.
    if (intent.settled && this.lease.generation === intent.generation && this.lease.holderSessionId === intent.sessionId) {
      return true;
    }
    this.cleanupStaleAcquire(intent);
    return true;
  }

  private cleanupStaleAcquire(intent: LeaseIntent): void {
    if (this.lease.holderSessionId === intent.sessionId
      && this.records.get(intent.sessionId)?.controller.attachedNow === true) {
      this.records.get(intent.sessionId)?.controller.cancelObservationIntent(interruptedAcquireError());
      return;
    }
    const route = this.route;
    const exactOldRoute = route !== null
      && route.sessionId === intent.sessionId
      && route.leaseGeneration === intent.generation;
    if (exactOldRoute) {
      route.clear();
      if (this.route === route) this.route = null;
    }
    const target = this.records.get(intent.sessionId)?.controller;
    if (target === undefined) return;
    target.cancelObservationIntent(interruptedAcquireError());
    // A newer lease/route for this same session (or for C) must not be torn down.
    if (this.lease.generation !== intent.generation && this.route?.sessionId === intent.sessionId) return;
    if (!exactOldRoute && this.route !== null && this.route.sessionId === intent.sessionId) return;
    target.releaseLocalObservation();
  }

  private async driveAcquire(intent: LeaseIntent, target: SessionController): Promise<void> {
    const sourceId = this.lease.holderSessionId;
    if (sourceId === intent.sessionId && target.hasDetachInFlight) {
      try {
        await target.detach();
      } catch (error) {
        if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
        if (this.isCurrentIntent(intent)) {
          this.settleIntent(intent, "reject", error);
          this.lease = { phase: "held", generation: intent.generation, desiredSessionId: sourceId, holderSessionId: sourceId, sourceSessionId: null, targetSessionId: null };
          this.publish();
        }
        return;
      }
      if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
      this.lease = { ...this.lease, holderSessionId: null, sourceSessionId: null };
    }
    if (sourceId !== null && sourceId !== intent.sessionId) {
      const source = this.records.get(sourceId)?.controller;
      if (source !== undefined && source.attachedNow) {
        try {
          await source.detach();
        } catch (error) {
          if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
          if (this.isCurrentIntent(intent)) {
            this.settleIntent(intent, "reject", error);
            this.lease = { phase: "held", generation: intent.generation, desiredSessionId: sourceId, holderSessionId: sourceId, sourceSessionId: null, targetSessionId: null };
            this.publish();
          }
          return;
        }
      }
      if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
      if (this.lease.holderSessionId === sourceId) {
        this.lease = { ...this.lease, holderSessionId: null, sourceSessionId: null };
      }
    }
    if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;

    if (intent.mode === "activate") {
      try {
        await target.activate();
      } catch (error) {
        if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
        if (!this.isCurrentIntent(intent)) return;
        this.settleIntent(intent, "reject", error);
        this.lease = { phase: "vacant", generation: intent.generation, desiredSessionId: null, holderSessionId: null, sourceSessionId: null, targetSessionId: null };
        this.publish();
        return;
      }
      if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
    }

    this.installRoute(target, intent.generation);
    this.lease = {
      phase: "acquiring",
      generation: intent.generation,
      desiredSessionId: intent.sessionId,
      holderSessionId: null,
      sourceSessionId: null,
      targetSessionId: intent.sessionId,
    };
    this.publish();
    try {
      await (intent.mode === "legacy" ? target.openSession() : target.observeExisting());
    } catch (error) {
      if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
      if (!this.isCurrentIntent(intent)) return;
      this.route?.clear();
      this.route = null;
      this.settleIntent(intent, "reject", error);
      this.lease = { phase: "vacant", generation: intent.generation, desiredSessionId: null, holderSessionId: null, sourceSessionId: null, targetSessionId: null };
      this.publish();
      return;
    }
    if (this.abandonStaleIntent(intent, interruptedAcquireError())) return;
    this.holdIntent(intent);
  }

  private clearObservationRoute(route: RuntimeAttachmentRouteHandle | null, generation: number): void {
    if (route === null) return;
    if (this.route !== route) return;
    if (this.lease.generation !== generation) return;
    route.clear();
    if (this.route === route) this.route = null;
  }

  private installRoute(controller: SessionController, leaseGeneration: number): void {
    this.route?.clear();
    this.route = this.runtimeConnection.replaceAttachmentRoute(controller.sessionId, leaseGeneration);
  }

  private onControllerChanged(controller: SessionController): void {
    const intent = this.activeIntent;
    if (intent !== null
      && intent.sessionId === controller.sessionId
      && this.isCurrentIntent(intent)
      && controller.attachedNow
      && this.route?.sessionId === controller.sessionId
      && this.route.leaseGeneration === intent.generation
      && this.route.isCurrent()) {
      this.holdIntent(intent);
      return;
    }
    if (this.lease.phase === "acquiring"
      && this.lease.targetSessionId === controller.sessionId
      && controller.attachedNow
      && this.route?.sessionId === controller.sessionId
      && this.route.isCurrent()) {
      this.lease = {
        phase: "held",
        generation: this.lease.generation,
        desiredSessionId: controller.sessionId,
        holderSessionId: controller.sessionId,
        sourceSessionId: null,
        targetSessionId: null,
      };
    }
    this.publish();
  }

  private onConnectionChanged(): void {
    const state: RuntimeTransportState = this.runtimeConnection.getSnapshot().state;
    const holderId = this.lease.holderSessionId;
    if ((state === "unavailable" || state === "reconnecting") && holderId !== null) {
      this.lease = {
        phase: "suspended",
        generation: this.lease.generation,
        desiredSessionId: this.lease.desiredSessionId ?? holderId,
        holderSessionId: holderId,
        sourceSessionId: holderId,
        targetSessionId: this.lease.desiredSessionId ?? holderId,
      };
    } else if (state === "ready" && this.lease.phase === "suspended") {
      const targetId = this.lease.desiredSessionId ?? holderId;
      if (targetId !== null) {
        const target = this.records.get(targetId)?.controller;
        if (target !== undefined) {
          // RuntimeConnection carries the existing exact route token across the
          // socket generation. Replacing it here would invalidate the attach
          // attempt SessionController synchronously re-registers on ready.
          this.lease = {
            phase: "acquiring",
            generation: this.lease.generation,
            desiredSessionId: targetId,
            holderSessionId: null,
            sourceSessionId: null,
            targetSessionId: targetId,
          };
        }
      }
    }
    this.publish();
  }

  private holdIntent(intent: LeaseIntent): void {
    if (!this.isCurrentIntent(intent)) return;
    this.lease = {
      phase: "held",
      generation: intent.generation,
      desiredSessionId: intent.sessionId,
      holderSessionId: intent.sessionId,
      sourceSessionId: null,
      targetSessionId: null,
    };
    this.lastPresentedSessionId = intent.sessionId;
    this.settleIntent(intent, "resolve");
    this.publish();
  }

  private isCurrentIntent(intent: LeaseIntent): boolean {
    return this.activeIntent === intent && !intent.settled && this.lease.generation === intent.generation
      && this.lease.desiredSessionId === intent.sessionId;
  }

  private rejectActiveIntent(error: ProtocolError): void {
    if (this.activeIntent !== null) this.settleIntent(this.activeIntent, "reject", error);
  }

  private settleIntent(intent: LeaseIntent, kind: "resolve" | "reject", error?: unknown): void {
    if (intent.settled) return;
    intent.settled = true;
    if (this.activeIntent === intent) this.activeIntent = null;
    if (kind === "resolve") intent.resolve();
    else intent.reject(error);
  }

  private notifySessionObservers(sessionId: string): void {
    const observer = this.sessionObservers.get(sessionId);
    if (observer === undefined) return;
    for (const listener of [...observer.listeners]) listener();
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
