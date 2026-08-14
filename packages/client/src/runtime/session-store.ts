/**
 * SessionStore — the client-side Runtime brain.
 *
 * Owns the {@link RuntimeSocket} (transport) and, on top of it:
 *  - the projection {@link RuntimeSnapshot} (reduced through the SHARED Protocol
 *    `reduceRuntimeEventData`, identical semantics to the sessiond authority);
 *  - the resume cursor (sessionId / epoch / lastEventId) and per-generation
 *    attach gating ("no event applies before this generation's first snapshot");
 *  - strict create/open/attach/detach/stop + prompt/abort/getSnapshot with
 *    at-most-once correlation (envelope id vs createRequestId vs commandId vs
 *    interrupt commandId) and bounded reconnect resynchronization;
 *  - the reactive {@link RuntimeView} exposed to React via useSyncExternalStore
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
 *    (second → session_busy); cleared on send-failure / stop / detach /
 *    dispose / session-switch / epoch_changed, resent with the SAME commandId
 *    on snapshot/gap. clear_queue uses typed interrupt admission (never
 *    coalesces with abort; different interrupt type → session_busy).
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
  reduceRuntimeEventData,
  type AgentMessage,
  type CorrelatedRuntimeCommandResult,
  type ImageAttachment,
  type ProtocolError,
  type RuntimeAttachParams,
  type RuntimeCapability,
  type RuntimeCapabilitySet,
  type RuntimeCommand,
  type RuntimeCommandOutcome,
  type RuntimeCreateParams,
  type RuntimeEventData,
  type RuntimeInterrupt,
  type RuntimeSnapshot,
  type RuntimeState,
  type SessionStats,
  type SlashCommandInfo,
  type StreamingAgentMessage,
  type ThinkingLevel,
  type ToolInfo,
  type WsClientMessage,
  type WsEventMessage,
  type WsHostMessage,
  type WsInterruptMessage,
  type WsInterruptResultMessage,
  type WsResponseMessage,
  type WsSnapshotMessage,
} from "@fffattiger/pix-protocol";
import {
  RuntimeSocket,
  type NegotiatedHost,
  type RuntimeSocketDeps,
  type RuntimeSocketHandler,
} from "./socket.js";
import { canSend, type ConnectionState } from "./lifecycle.js";
import {
  createDefaultIdFactory,
  decideCommandRetry,
  decideEvent,
  type EventApplyDecision,
  type IdFactory,
} from "./correlation.js";

/** Reactive view consumed by React via useSyncExternalStore (immutable per change). */
export interface RuntimeView {
  readonly connection: ConnectionState;
  readonly host: NegotiatedHost | null;
  readonly attached: boolean;
  readonly sessionStopped: boolean;
  readonly sessionId: string | null;
  readonly epoch: string | null;
  readonly snapshot: RuntimeSnapshot | null;
  readonly streaming: boolean;
  readonly streamingPartial: StreamingAgentMessage | null;
  readonly messages: readonly AgentMessage[];
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
   * Authoritative runtime capability set from the latest snapshot
   * ({@link RuntimeCapabilitySet}), or null before the first attach snapshot.
   * This is the runtime capability authority — never inferred from the Host
   * `agent` capability ({@link canAgent}).
   */
  readonly capabilities: RuntimeCapabilitySet | null;
}

const INITIAL_VIEW: RuntimeView = {
  connection: "idle",
  host: null,
  attached: false,
  sessionStopped: false,
  sessionId: null,
  epoch: null,
  snapshot: null,
  streaming: false,
  streamingPartial: null,
  messages: [],
  error: null,
  fatal: false,
  canAgent: false,
  queuedTurnPending: false,
  capabilities: null,
};

/**
 * A `RuntimeCommand` with its transport `commandId` removed, preserving each
 * variant's own discriminant fields (distributive Omit — a plain
 * `Omit<RuntimeCommand, "commandId">` collapses the union). Used by the D2-P1
 * typed command helpers which mint the commandId internally.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RuntimeCommandWithoutId = DistributiveOmit<RuntimeCommand, "commandId">;

export interface SessionStoreOptions {
  readonly id?: IdFactory;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Bounded wait for the abort interrupt result before a forced stop (HOL rule). */
  readonly abortTimeoutMs?: number;
  /** Bounded wait for the socket to become sendable before issuing stop. */
  readonly stopSendTimeoutMs?: number;
  /** Bounded wait for the stop ack response. */
  readonly stopAckTimeoutMs?: number;
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface TimedWaiter extends Waiter {
  handle: unknown;
}

interface EnvelopePending {
  readonly kind: "getSnapshot" | "detach" | "stop";
  readonly generation: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface CreatePending {
  readonly createRequestId: string;
  envelopeId: string;
  generation: number;
  readonly payload: RuntimeCreateParams;
  resolve(value: { sessionId: string }): void;
  reject(error: unknown): void;
}

/** Per-attempt wire correlation for an attach (envelope id + generation). */
interface AttachAttempt {
  readonly envelopeId: string;
  readonly generation: number;
  readonly sessionId: string;
}

/** Stable, logical attach deferred — survives reconnect handoff (HIGH-2). */
interface AttachDeferred {
  readonly sessionId: string;
  resolve(): void;
  reject(error: unknown): void;
  promise: Promise<void>;
}

interface CommandPending {
  readonly commandId: string;
  envelopeId: string;
  generation: number;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
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
  envelopeId: string;
  generation: number;
  readonly sessionId: string;
  readonly command: WsClientMessage;
  readonly type: "steer" | "follow_up";
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface InterruptPending {
  readonly commandId: string;
  envelopeId: string;
  generation: number;
  readonly sessionId: string;
  readonly message: WsInterruptMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_ACK_TIMEOUT_MS = 10_000;

export class SessionStore implements RuntimeSocketHandler {
  private readonly socket: RuntimeSocket;
  private readonly id: IdFactory;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly abortTimeoutMs: number;
  private readonly stopSendTimeoutMs: number;
  private readonly stopAckTimeoutMs: number;

  // reactive state
  private connection: ConnectionState = "idle";
  private host: NegotiatedHost | null = null;
  private attached = false;
  private sessionStopped = false;
  private sessionId: string | null = null;
  private epoch: string | null = null;
  private lastEventId = 0;
  private snapshot: RuntimeSnapshot | null = null;
  private error: ProtocolError | null = null;
  private fatal = false;

  // attach / cursor gating
  private intendedSession: { sessionId: string } | null = null;
  private attach: AttachDeferred | null = null;
  private attachAttempt: AttachAttempt | null = null;
  private attachGen: number | null = null;
  private awaitingSnapshot = false;

  // pending requests
  private pendingByEnvelope = new Map<string, EnvelopePending>();
  private pendingCreate: CreatePending | null = null;
  private pendingCommand: CommandPending | null = null;
  /** D2-P4 dual-slot: at most ONE queued turn (steer/follow_up) in flight, independent of prompt. */
  private pendingQueuedTurn: QueuedTurnPending | null = null;
  private pendingInterrupt: InterruptPending | null = null;
  /** At most ONE interrupt in flight (well under H1's 16-interrupt cap). */
  private pendingInterruptPromise: Promise<unknown> | null = null;
  /** At most ONE stop in flight (LOW: concurrent stops merge into one frame). */
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  private readyWaiters: Waiter[] = [];
  private sendableWaiters: TimedWaiter[] = [];
  private readonly listeners = new Set<() => void>();
  private view: RuntimeView = INITIAL_VIEW;

  constructor(socketDeps: RuntimeSocketDeps, options: SessionStoreOptions = {}) {
    this.socket = new RuntimeSocket(socketDeps, this);
    this.id = options.id ?? createDefaultIdFactory();
    this.setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.stopSendTimeoutMs = options.stopSendTimeoutMs ?? DEFAULT_STOP_SEND_TIMEOUT_MS;
    this.stopAckTimeoutMs = options.stopAckTimeoutMs ?? DEFAULT_STOP_ACK_TIMEOUT_MS;
  }

  // --- public transport --------------------------------------------------

  connect(): void { this.socket.connect(); }

  /** Idempotent teardown: closes the socket + settles all pending. NEVER runtime.stop. */
  dispose(): void {
    const error: ProtocolError = { code: "unavailable", message: "runtime disposed", retryable: false };
    this.rejectReadyWaiters(error);
    this.rejectSendableWaiters(error);
    this.failAllPending(error);
    this.socket.dispose();
  }

  getRuntimeSocket(): RuntimeSocket { return this.socket; }

  // --- public lifecycle --------------------------------------------------

  /** Create a new session, then freshly attach (attach snapshot is authoritative). */
  createSession(params: {
    cwd: string;
    projectRoot: string;
    model?: { provider: string; modelId: string };
    thinkingLevel?: RuntimeCreateParams["thinkingLevel"];
    name?: string;
  }): Promise<{ sessionId: string }> {
    this.sessionStopped = false;
    // MEDIUM-6: a second concurrent create is rejected as busy (both settle, one frame).
    if (this.pendingCreate) {
      return Promise.reject({ code: "session_busy", message: "a session create is already in progress", retryable: false } satisfies ProtocolError);
    }
    this.ensureConnecting();
    return new Promise((resolve, reject) => {
      this.whenReady().then(
        () => {
          if (this.pendingCreate) {
            reject({ code: "session_busy", message: "a session create is already in progress", retryable: false } satisfies ProtocolError);
            return;
          }
          const createRequestId = this.id();
          const payload: RuntimeCreateParams = {
            createRequestId,
            cwd: params.cwd,
            projectRoot: params.projectRoot,
            ...(params.model === undefined ? {} : { model: params.model }),
            ...(params.thinkingLevel === undefined ? {} : { thinkingLevel: params.thinkingLevel }),
            ...(params.name === undefined ? {} : { name: params.name }),
          };
          const envelopeId = this.id();
          this.pendingCreate = {
            createRequestId,
            envelopeId,
            generation: this.socket.currentGeneration,
            payload,
            resolve: (result) => {
              // create ok → fresh attach; settle createSession with the attach outcome.
              this.startAttach(result.sessionId, "fresh").then(() => resolve({ sessionId: result.sessionId }), reject);
            },
            reject,
          };
          this.send({ type: "create", id: envelopeId, payload });
        },
        (error) => reject(error),
      );
    });
  }

  /** Open (cold-activate via H1) an existing session with a FRESH attach. */
  openSession(sessionId: string): Promise<void> {
    this.sessionStopped = false;
    this.ensureConnecting();
    return new Promise<void>((resolve, reject) => {
      this.whenReady().then(
        () => { void this.startAttach(sessionId, "fresh").then(resolve, reject); },
        (error) => reject(error),
      );
    });
  }

  /** Detach the current attach; the Worker is PRESERVED (no stop). */
  detach(): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    return this.sendEnvelope({ type: "detach", id: this.id(), payload: { sessionId: this.sessionId } }).then(() => {
      this.attached = false;
      this.awaitingSnapshot = false;
      this.intendedSession = null;
      // D2-P4: a queued turn is bound to the live streaming session; detaching
      // invalidates it (fixed error, never overwrites a prompt promise).
      this.settlePendingQueuedTurn({ code: "interrupted", message: "detached", retryable: false });
      // D2-P5/D2-P7: a pending bash command or compact command bound to the
      // detached session — reject it exactly once so the single ordinary-command
      // slot frees and a late result/event can never settle a newly attached
      // session. Ordinary prompt semantics are preserved (the prompt promise is
      // never overwritten here; it settles on its own correlated response or
      // transport loss).
      this.settlePendingControlCommand({ code: "interrupted", message: "detached", retryable: false });
      this.rejectAttach({ code: "interrupted", message: "detached", retryable: false });
      this.setConnection(this.socket.connectionState === "stopped" ? "stopped" : "ready");
      this.notify();
    });
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
      // D2-P4: settle any in-flight queued turn exactly once (stop invalidates it).
      this.settlePendingQueuedTurn({ code: "interrupted", message: "session stopped", retryable: false });
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
      this.awaitingSnapshot = false;
      this.sessionStopped = true;
      this.intendedSession = null;
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
   * Send an arbitrary runtime command, reusing the at-most-once command
   * correlation / epoch rules shared with {@link sendPrompt}. The caller owns
   * the full {@link RuntimeCommand} (including a freshly-minted commandId) and
   * capability gating (see {@link hasRuntimeCapability}); an unsupported
   * command resolves to a correlated `unsupported_capability` result rather
   * than throwing.
   */
  sendCommand(command: RuntimeCommand): Promise<unknown> {
    if (!this.attached || !this.sessionId) {
      return Promise.reject(this.notAttachedError());
    }
    if (this.pendingCommand) {
      return Promise.reject({
        code: "session_busy",
        message: "a runtime command is already in progress",
        retryable: false,
      } satisfies ProtocolError);
    }
    const sessionId = this.sessionId;
    const envelopeId = this.id();
    const message: WsClientMessage = {
      type: "command",
      id: envelopeId,
      payload: { sessionId, command },
    };
    return new Promise((resolve, reject) => {
      this.pendingCommand = { commandId: command.commandId, envelopeId, generation: this.socket.currentGeneration, sessionId, command: message, resolve, reject };
      this.send(message);
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
      return Promise.reject({
        code: "invalid_input",
        message: "message cannot be empty",
        retryable: false,
      } satisfies ProtocolError);
    }
    if (!this.attached || !this.sessionId) {
      return Promise.reject(this.notAttachedError());
    }
    if (this.pendingQueuedTurn) {
      return Promise.reject({
        code: "session_busy",
        message: "a queued turn is already in progress",
        retryable: false,
      } satisfies ProtocolError);
    }
    const commandId = this.id();
    const imagePayload = images === undefined || images.length === 0 ? {} : { images: [...images] as ImageAttachment[] };
    const command: RuntimeCommand = type === "steer"
      ? { commandId, type: "steer", message: trimmed, ...imagePayload }
      : { commandId, type: "follow_up", message: trimmed, ...imagePayload };
    const sessionId = this.sessionId;
    const envelopeId = this.id();
    const wsMessage: WsClientMessage = {
      type: "command",
      id: envelopeId,
      payload: { sessionId, command },
    };
    return new Promise((resolve, reject) => {
      this.pendingQueuedTurn = { commandId: command.commandId, envelopeId, generation: this.socket.currentGeneration, sessionId, command: wsMessage, type, resolve, reject };
      this.notify();
      this.send(wsMessage);
    });
  }

  /** Send a prompt (ordinary command). commandId is stable across same-epoch retries. */
  sendPrompt(message: string): Promise<unknown> {
    return this.sendCommand({ commandId: this.id(), type: "prompt", message });
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

  // --- D2-P1 typed runtime command helpers -----------------------------------
  //
  // Each helper mints its own commandId, reuses the single-inflight
  // {@link sendCommand} correlation (honest `session_busy` on concurrency) and
  // unwraps the correlated result: an `ok:false` outcome rejects with its
  // ProtocolError (including a capability-gated `unsupported_capability`), a
  // success returns only the command's payload. Callers gate by capability via
  // {@link hasRuntimeCapability} (the UI does this); the helpers themselves
  // stay honest and let the runtime answer.

  /** Query the current canonical runtime state. Always available. */
  getState(): Promise<RuntimeState> {
    return this.runTypedCommand({ type: "get_state" }, (outcome) => {
      if (outcome.type !== "get_state") throw new Error("unexpected get_state result");
      return outcome.state;
    });
  }

  /** List the runtime's slash commands. Always available. */
  getCommands(): Promise<readonly SlashCommandInfo[]> {
    return this.runTypedCommand({ type: "get_commands" }, (outcome) => {
      if (outcome.type !== "get_commands") throw new Error("unexpected get_commands result");
      return outcome.commands;
    });
  }

  /** Last assistant text ("" when none yet). Always available. */
  getLastAssistantText(): Promise<string> {
    return this.runTypedCommand({ type: "get_last_assistant_text" }, (outcome) => {
      if (outcome.type !== "get_last_assistant_text") throw new Error("unexpected get_last_assistant_text result");
      return outcome.text;
    });
  }

  /** Session statistics. Requires the `runtime.stats` capability. */
  getSessionStats(): Promise<SessionStats> {
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
   * `runtime.tools.read` at the runtime. Pure query — never triggers an
   * authority refresh and never mutates projection state.
   */
  getTools(): Promise<readonly ToolInfo[]> {
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
   * non-whitespace character). Resolves only once sessiond's authoritative
   * snapshot refresh has converged `state.tools` and the related systemPrompt;
   * the store makes no optimistic writes.
   */
  setTools(names: readonly string[]): Promise<void> {
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
    return this.runTypedCommand({ type: "set_tools", toolNames: trimmed }, (outcome) => {
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
  // the SHARED Protocol projection into {@link RuntimeView.snapshot.state.bash}
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
      if (this.pendingInterrupt.message.payload.interrupt.type === interrupt.type && this.pendingInterruptPromise) {
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
    const envelopeId = this.id();
    const wsMessage: WsInterruptMessage = {
      type: "interrupt",
      id: envelopeId,
      payload: { sessionId, commandId, interrupt },
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingInterrupt = { commandId, envelopeId, generation: this.socket.currentGeneration, sessionId, message: wsMessage, resolve, reject };
      this.send(wsMessage);
    });
    this.pendingInterruptPromise = promise;
    return promise;
  }

  // --- external store (useSyncExternalStore) -----------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): RuntimeView => this.view;

  // --- RuntimeSocketHandler ---------------------------------------------

  onConnectionState(state: ConnectionState): void {
    const wasReady = canSend(this.connection);
    this.connection = state;
    // Socket-driven states never include attached/attaching (those are
    // store-driven), so any socket transition means we are no longer attached.
    this.attached = false;
    if (state === "ready") {
      this.resolveReadyWaiters();
      this.resolveSendableWaiters();
      // Reconnect resync: a lost create response is resent idempotently.
      if (this.pendingCreate) {
        this.resendCreate();
      } else if (this.intendedSession && !this.sessionStopped && !this.stopping) {
        // Reconnect resync: resume the intended session's attach (reuses deferred).
        this.resumeAttach();
      }
    } else if (state === "unavailable" || state === "reconnecting") {
      // MEDIUM-3: one-shot envelope requests cannot survive a generation boundary.
      this.onTransportLoss();
    } else if (state === "stopped") {
      const error: ProtocolError = { code: "unavailable", message: "runtime connection stopped", retryable: false };
      this.rejectReadyWaiters(error);
      this.rejectSendableWaiters(error);
    }
    if (canSend(state) && !wasReady) this.resolveSendableWaiters();
    this.notify();
  }

  onHandshakeAck(host: NegotiatedHost): void {
    this.host = host;
    this.notify();
  }

  onHandshakeReject(error: ProtocolError): void {
    this.fatal = true;
    this.error = error;
    this.rejectReadyWaiters(error);
    this.rejectSendableWaiters(error);
    this.failAllPending(error);
    this.notify();
  }

  onMessage(message: WsHostMessage, generation: number): void {
    switch (message.type) {
      case "snapshot": this.handleSnapshot(message, generation); break;
      case "event": this.handleEvent(message, generation); break;
      case "response": this.handleResponse(message, generation); break;
      case "interrupt_result": this.handleInterruptResult(message, generation); break;
      case "runtime_unavailable": this.handleUnavailable(message, generation); break;
      default: break;
    }
  }

  // --- message handlers --------------------------------------------------

  private handleSnapshot(message: WsSnapshotMessage, generation: number): void {
    const payload = message.payload;
    // Initial attach snapshot: strictly correlated by (generation, attempt id, sessionId).
    if (
      this.attachAttempt &&
      message.id === this.attachAttempt.envelopeId &&
      generation === this.attachAttempt.generation &&
      payload.sessionId === this.attachAttempt.sessionId
    ) {
      this.attachAttempt = null;
      this.applySnapshot(payload);
      this.attachGen = generation;
      this.awaitingSnapshot = false;
      this.attached = true;
      this.error = null;
      this.setConnection("attached");
      const attach = this.attach;
      if (attach) { this.attach = null; attach.resolve(); }
      this.resyncAfterAttach(payload.resumeStatus, payload.epoch);
      return;
    }
    // Replay / live snapshot (gap / epoch_changed mid-stream): full replace + cursor.
    if (this.attached && generation === this.attachGen && payload.sessionId === this.sessionId) {
      this.applySnapshot(payload);
      this.notify();
    }
  }

  private handleEvent(message: WsEventMessage, generation: number): void {
    if (!this.attached || generation !== this.attachGen) return;
    const event = message.payload;
    const decision: EventApplyDecision = decideEvent(event, {
      sessionId: this.sessionId,
      epoch: this.epoch,
      lastEventId: this.lastEventId,
      snapshotReceived: !this.awaitingSnapshot,
      generation,
      activeGeneration: this.attachGen ?? -1,
    });
    if (decision.decision === "apply") {
      if (this.snapshot === null) return;
      try {
        this.snapshot = reduceRuntimeEventData(this.snapshot, event as RuntimeEventData);
        this.lastEventId = event.eventId;
      } catch {
        // Projection inconsistency (stream event out of order): re-attach.
        this.reattach();
      }
      this.notify();
    } else if (decision.decision === "reattach") {
      this.reattach();
    }
    // "drop" (duplicate / awaiting-snapshot): ignore.
  }

  private handleResponse(message: WsResponseMessage, generation: number): void {
    const ok = message.payload.ok;
    // attach failure: success arrives as a snapshot, so any `response` matching a
    // pending attach attempt is a failure → reject the stable deferred (HIGH-1/2).
    if (this.attachAttempt && message.id === this.attachAttempt.envelopeId && generation === this.attachAttempt.generation) {
      const attemptSessionId = this.attachAttempt.sessionId;
      this.attachAttempt = null;
      this.awaitingSnapshot = false;
      const error: ProtocolError = ok
        ? { code: "internal", message: "attach response without snapshot", retryable: false }
        : message.payload.error;
      const attach = this.attach;
      this.attach = null;
      // Fresh open/create attach failure: drop intendedSession so reconnect does not
      // auto-retry a known-bad session. Keep it only when re-attaching a previously
      // live session (sessionId already set) so resume can try again.
      if (this.sessionId !== attemptSessionId) this.intendedSession = null;
      this.setConnection("ready"); // HIGH-1: reset so a subsequent open proceeds immediately.
      if (attach) attach.reject(error);
      this.setError(error);
      return;
    }
    // create
    if (this.pendingCreate && message.id === this.pendingCreate.envelopeId && generation === this.pendingCreate.generation) {
      const pending = this.pendingCreate;
      this.pendingCreate = null;
      if (!ok) { pending.reject(message.payload.error); this.setError(message.payload.error); return; }
      const result = message.payload.result as { sessionId: string };
      // create optional snapshot is IGNORED; the attach snapshot is authoritative.
      pending.resolve({ sessionId: result.sessionId });
      return;
    }
    // command
    if (this.pendingCommand && message.id === this.pendingCommand.envelopeId && generation === this.pendingCommand.generation) {
      const pending = this.pendingCommand;
      this.pendingCommand = null;
      if (ok) pending.resolve(message.payload.result);
      else { pending.reject(message.payload.error); this.setError(message.payload.error); }
      return;
    }
    // D2-P4 dual-slot queued turn (steer / follow_up), correlated by envelope+generation.
    if (this.pendingQueuedTurn && message.id === this.pendingQueuedTurn.envelopeId && generation === this.pendingQueuedTurn.generation) {
      const pending = this.pendingQueuedTurn;
      this.pendingQueuedTurn = null;
      this.notify();
      if (ok) pending.resolve(message.payload.result);
      else { pending.reject(message.payload.error); this.setError(message.payload.error); }
      return;
    }
    // envelope-keyed one-shots: getSnapshot / detach / stop
    const entry = this.pendingByEnvelope.get(message.id);
    if (entry && entry.generation === generation) {
      this.pendingByEnvelope.delete(message.id);
      if (ok) entry.resolve(message.payload.result);
      else { entry.reject(message.payload.error); this.setError(message.payload.error); }
      return;
    }
    // late / unknown response (incl. stale generation): drop — never resolves new pending.
  }

  private handleInterruptResult(message: WsInterruptResultMessage, generation: number): void {
    if (
      this.pendingInterrupt &&
      message.id === this.pendingInterrupt.envelopeId &&
      generation === this.pendingInterrupt.generation &&
      // response id / commandId / interrupt type triple match — a clear_queue
      // result can never resolve an abort caller or vice versa (D2-P4).
      message.payload.commandId === this.pendingInterrupt.commandId &&
      message.payload.interruptType === this.pendingInterrupt.message.payload.interrupt.type
    ) {
      const pending = this.pendingInterrupt;
      this.pendingInterrupt = null;
      this.pendingInterruptPromise = null;
      const result = message.payload.result;
      if (result.ok) pending.resolve(result);
      else { pending.reject(result.error); this.setError(result.error); }
    }
  }

  private handleUnavailable(message: Extract<WsHostMessage, { type: "runtime_unavailable" }>, _generation: number): void {
    this.setError(message.payload.error);
  }

  // --- attach lifecycle (stable deferred) --------------------------------

  /**
   * Begin (or resume) the logical attach for `sessionId`. The returned promise
   * is a STABLE deferred: a reconnect re-uses it so the original create/open
   * caller always settles (HIGH-2). Each (re)send mints a fresh envelope attempt.
   */
  private startAttach(sessionId: string, mode: "fresh" | "resume"): Promise<void> {
    this.intendedSession = { sessionId };
    // D2-P4 session-switch cleanup: a queued turn bound to a DIFFERENT session
    // must not resolve into the new session's context (fixed error).
    if (this.pendingQueuedTurn && this.sessionId !== null && this.sessionId !== sessionId) {
      this.settlePendingQueuedTurn({ code: "interrupted", message: "session switched", retryable: false });
    }
    // D2-P5/D2-P7: a pending bash command or compact command bound to the OLD
    // session is rejected exactly once on a switch so its late result/events
    // cannot settle the new session.
    if (this.pendingCommand && this.sessionId !== null && this.sessionId !== sessionId) {
      this.settlePendingControlCommand({ code: "interrupted", message: "session switched", retryable: false });
    }
    this.attached = false;
    this.awaitingSnapshot = true;
    if (this.attach && this.attach.sessionId === sessionId) {
      // Reuse the in-flight deferred (reconnect handoff) and send a new attempt.
      this.sendAttachAttempt(sessionId, mode);
      return this.attach.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const deferred: AttachDeferred = { sessionId, resolve, reject, promise };
    this.attach = deferred;
    this.sendAttachAttempt(sessionId, mode);
    return promise;
  }

  private sendAttachAttempt(sessionId: string, mode: "fresh" | "resume"): void {
    const envelopeId = this.id();
    const params: RuntimeAttachParams = mode === "resume" && this.epoch !== null
      ? { sessionId, epoch: this.epoch, lastEventId: this.lastEventId }
      : { sessionId };
    this.attachAttempt = { envelopeId, generation: this.socket.currentGeneration, sessionId };
    this.setConnection("attaching");
    this.send({ type: "attach", id: envelopeId, payload: params });
  }

  /** Reconnect resume: re-attach the intended session, reusing any deferred. */
  private resumeAttach(): void {
    if (!this.intendedSession) return;
    void this.startAttach(this.intendedSession.sessionId, "resume").catch(() => {
      // Resume failed; socket backoff retries and `ready` re-triggers resume.
    });
  }

  /** Re-attach after a cursor violation (gap / epoch / session mismatch). */
  private reattach(): void {
    if (!this.sessionId) return;
    this.attached = false;
    this.awaitingSnapshot = true;
    void this.startAttach(this.sessionId, "resume").catch(() => undefined);
  }

  /** Reject + clear any in-flight attach deferred (detach / stop / dispose). */
  private rejectAttach(error: ProtocolError): void {
    if (this.attach) { this.attach.reject(error); this.attach = null; }
    this.attachAttempt = null;
  }

  /**
   * After an initial snapshot, re-send pending command/interrupt ONLY when the
   * epoch survived (snapshot/gap). On epoch_changed the prior command's effect is
   * ambiguous → reject, never resend. No-op when nothing is pending (fresh attach).
   */
  private resyncAfterAttach(resumeStatus: "snapshot" | "gap" | "epoch_changed", snapshotEpoch: string): void {
    const epochSurvived = resumeStatus !== "epoch_changed" && (this.epoch === null || this.epoch === snapshotEpoch);
    if (this.pendingCommand) {
      const decision = decideCommandRetry(epochSurvived ? resumeStatus : "epoch_changed");
      if (decision.decision === "resend") {
        this.resendCommand();
      } else {
        this.pendingCommand.reject(decision.error);
        this.pendingCommand = null;
        this.setError(decision.error);
      }
    }
    // D2-P4 dual-slot queued turn: same-epoch snapshot/gap → resend with the
    // SAME commandId on a fresh envelope; epoch_changed → reject, never resend.
    if (this.pendingQueuedTurn) {
      const decision = decideCommandRetry(epochSurvived ? resumeStatus : "epoch_changed");
      if (decision.decision === "resend") {
        this.resendQueuedTurn();
      } else {
        this.pendingQueuedTurn.reject(decision.error);
        this.pendingQueuedTurn = null;
        this.notify();
        this.setError(decision.error);
      }
    }
    if (this.pendingInterrupt) {
      if (epochSurvived) {
        this.resendInterrupt();
      } else {
        const err: ProtocolError = { code: "epoch_changed", message: "epoch changed; interrupt not re-sent", retryable: false };
        this.pendingInterrupt.reject(err);
        this.pendingInterrupt = null;
        this.pendingInterruptPromise = null;
      }
    }
  }

  /** Re-send a pending create with the SAME createRequestId (stable across retries). */
  private resendCreate(): void {
    const pending = this.pendingCreate;
    if (!pending) return;
    const envelopeId = this.id();
    pending.envelopeId = envelopeId;
    pending.generation = this.socket.currentGeneration;
    this.send({ type: "create", id: envelopeId, payload: pending.payload });
  }

  /** Re-send a pending command with the SAME commandId (at-most-once per epoch). */
  private resendCommand(): void {
    const pending = this.pendingCommand;
    if (!pending) return;
    const envelopeId = this.id();
    const command: WsClientMessage = { ...pending.command, id: envelopeId };
    this.pendingCommand = { ...pending, envelopeId, generation: this.socket.currentGeneration, command };
    this.send(command);
  }

  /** Re-send a pending queued turn with the SAME commandId (at-most-once per epoch). */
  private resendQueuedTurn(): void {
    const pending = this.pendingQueuedTurn;
    if (!pending) return;
    const envelopeId = this.id();
    const command: WsClientMessage = { ...pending.command, id: envelopeId };
    this.pendingQueuedTurn = { ...pending, envelopeId, generation: this.socket.currentGeneration, command };
    this.send(command);
  }

  /** Re-send a pending interrupt with the SAME commandId (at-most-once per epoch). */
  private resendInterrupt(): void {
    const pending = this.pendingInterrupt;
    if (!pending) return;
    const envelopeId = this.id();
    const message: WsInterruptMessage = { ...pending.message, id: envelopeId };
    this.pendingInterrupt = { ...pending, envelopeId, generation: this.socket.currentGeneration, message };
    this.send(message);
  }

  // --- helpers -----------------------------------------------------------

  private applySnapshot(payload: WsSnapshotMessage["payload"]): void {
    this.sessionId = payload.sessionId;
    this.epoch = payload.epoch;
    this.lastEventId = payload.lastEventId;
    this.snapshot = structuredClone(payload.snapshot);
    this.notify();
  }

  /**
   * Track + send a one-shot envelope request (getSnapshot / detach / stop),
   * resolved/rejected by the matching {@link WsResponseMessage}. An optional
   * bounded ack timeout rejects (and removes) the entry if no response arrives.
   */
  private sendEnvelope(message: WsClientMessage, ackTimeoutMs?: number): Promise<unknown> {
    const id = message.id;
    if (id === undefined) return Promise.reject(new Error("envelope request requires an id"));
    return new Promise((resolve, reject) => {
      let handle: unknown = undefined;
      const finish = (fn: () => void): void => {
        if (handle !== undefined) this.clearTimeoutFn(handle);
        fn();
      };
      this.pendingByEnvelope.set(id, {
        kind: message.type === "getSnapshot" ? "getSnapshot" : message.type === "detach" ? "detach" : "stop",
        generation: this.socket.currentGeneration,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      if (ackTimeoutMs !== undefined) {
        handle = this.setTimeoutFn(() => {
          if (!this.pendingByEnvelope.has(id)) return; // already settled
          this.pendingByEnvelope.delete(id);
          reject({ code: "timeout", message: "response timed out", retryable: true } satisfies ProtocolError);
        }, ackTimeoutMs);
      }
      this.send(message);
    });
  }

  private send(message: WsClientMessage): void {
    try {
      this.socket.send(message);
    } catch (error) {
      this.routeSendFailure(message, error);
    }
  }

  private routeSendFailure(message: WsClientMessage, error: unknown): void {
    const id = "id" in message && typeof message.id === "string" ? message.id : null;
    if (id && this.pendingByEnvelope.has(id)) {
      const entry = this.pendingByEnvelope.get(id)!;
      this.pendingByEnvelope.delete(id);
      entry.reject(error);
    } else if (this.pendingCommand?.envelopeId === id) {
      this.pendingCommand.reject(error);
      this.pendingCommand = null;
    } else if (this.pendingQueuedTurn?.envelopeId === id) {
      this.pendingQueuedTurn.reject(error);
      this.pendingQueuedTurn = null;
      this.notify();
    } else if (this.pendingInterrupt?.envelopeId === id) {
      this.pendingInterrupt.reject(error);
      this.pendingInterrupt = null;
      this.pendingInterruptPromise = null;
    } else if (this.pendingCreate?.envelopeId === id) {
      this.pendingCreate.reject(error);
      this.pendingCreate = null;
    } else if (this.attachAttempt?.envelopeId === id) {
      this.attachAttempt = null;
      this.rejectAttach(error as ProtocolError);
    }
  }

  /** Reject one-shot envelope requests on transport loss (MEDIUM-3). */
  private onTransportLoss(): void {
    const error: ProtocolError = { code: "unavailable", message: "runtime connection lost", retryable: true };
    for (const [, entry] of this.pendingByEnvelope) entry.reject(error);
    this.pendingByEnvelope.clear();
  }

  /** Reject the in-flight prompt promise exactly once (MEDIUM-4). */
  private settlePendingCommand(error: ProtocolError): void {
    if (this.pendingCommand) { this.pendingCommand.reject(error); this.pendingCommand = null; }
  }

  /** Reject the in-flight queued turn exactly once (D2-P4 stop/detach/dispose/session switch). */
  private settlePendingQueuedTurn(error: ProtocolError): void {
    if (this.pendingQueuedTurn) {
      this.pendingQueuedTurn.reject(error);
      this.pendingQueuedTurn = null;
      this.notify();
    }
  }

  /**
   * Reject an in-flight BASH or COMPACT command exactly once (D2-P5/D2-P7
   * detach/session-switch). Both occupy the single ordinary-command slot
   * ({@link pendingCommand}) like prompts, but are long-running control
   * resources with their own abort path: on detach/switch they must be settled
   * so the slot frees and a late result/event can never settle a newly attached
   * session. A pending PROMPT is deliberately left untouched here (prompt
   * promise semantics are preserved — it settles on its own correlated response
   * or transport loss).
   */
  private settlePendingControlCommand(error: ProtocolError): void {
    const pending = this.pendingCommand;
    if (pending && pending.command.type === "command") {
      const commandType = pending.command.payload.command.type;
      if (commandType === "bash" || commandType === "compact") {
        this.pendingCommand = null;
        pending.reject(error);
      }
    }
  }

  private ensureConnecting(): void {
    if (this.connection === "idle") this.socket.connect();
  }

  private whenReady(): Promise<void> {
    if (this.connection === "ready") return Promise.resolve();
    if (this.fatal || this.connection === "stopped") {
      return Promise.reject(this.error ?? { code: "unavailable", message: "runtime not ready", retryable: false });
    }
    return new Promise<void>((resolve, reject) => { this.readyWaiters.push({ resolve, reject }); });
  }

  /** Resolve when the socket is sendable (ready/attaching/attached), bounded. */
  private whenSendable(timeoutMs: number): Promise<void> {
    if (canSend(this.connection)) return Promise.resolve();
    if (this.fatal || this.connection === "stopped") {
      return Promise.reject(this.error ?? { code: "unavailable", message: "runtime not sendable", retryable: false });
    }
    return new Promise<void>((resolve, reject) => {
      const handle = this.setTimeoutFn(() => {
        this.sendableWaiters = this.sendableWaiters.filter((w) => w.handle !== handle);
        reject({ code: "timeout", message: "runtime not sendable in time", retryable: true } satisfies ProtocolError);
      }, timeoutMs);
      this.sendableWaiters.push({ resolve, reject, handle });
    });
  }

  private resolveReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private rejectReadyWaiters(error: unknown): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(error);
  }

  private resolveSendableWaiters(): void {
    const waiters = this.sendableWaiters;
    this.sendableWaiters = [];
    for (const w of waiters) { this.clearTimeoutFn(w.handle); w.resolve(); }
  }

  private rejectSendableWaiters(error: unknown): void {
    const waiters = this.sendableWaiters;
    this.sendableWaiters = [];
    for (const w of waiters) { this.clearTimeoutFn(w.handle); w.reject(error); }
  }

  private failAllPending(error: ProtocolError): void {
    this.pendingCreate?.reject(error);
    this.pendingCreate = null;
    this.rejectAttach(error);
    this.settlePendingCommand(error);
    this.settlePendingQueuedTurn(error);
    this.pendingInterrupt?.reject(error);
    this.pendingInterrupt = null;
    this.pendingInterruptPromise = null;
    for (const [, entry] of this.pendingByEnvelope) entry.reject(error);
    this.pendingByEnvelope.clear();
  }

  private isPromptRunning(): boolean {
    return this.snapshot?.state.isPromptRunning === true || this.snapshot?.state.isStreaming === true;
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

  private computeView(): RuntimeView {
    const snapshot = this.snapshot;
    const streaming = snapshot?.streaming?.active === true || snapshot?.state.isStreaming === true;
    return {
      connection: this.connection,
      host: this.host,
      attached: this.attached,
      sessionStopped: this.sessionStopped,
      sessionId: this.sessionId,
      epoch: this.epoch,
      snapshot,
      streaming,
      streamingPartial: snapshot?.streaming?.partialMessage ?? null,
      messages: snapshot?.messages ?? [],
      error: this.error,
      fatal: this.fatal,
      canAgent: this.host?.capabilities.includes("agent") === true,
      queuedTurnPending: this.pendingQueuedTurn !== null,
      capabilities: this.attached ? (snapshot?.capabilities ?? null) : null,
    };
  }

  private notify(): void {
    this.view = this.computeView();
    for (const listener of this.listeners) listener();
  }
}
