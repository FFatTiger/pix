import type {
  AgentRuntimePort,
  BashProjection,
  CompactionProjection,
  ExtensionUiRequest,
  ImageAttachment,
  ModelRef,
  QueuedMessages,
  RuntimeCapabilitySet,
  RuntimeCloseReason,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeCommandType,
  RuntimeError,
  RuntimeEvent,
  RuntimeIdentity,
  RuntimeInterrupt,
  RuntimeInterruptResult,
  RuntimeReadRequest,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeState,
  RuntimeTurnHandle,
  RuntimeTurnStart,
  RuntimeTurnTerminal,
  StreamingAgentMessage,
} from "@fffattiger/pix-runtime-core";
import {
  createCapabilitySet,
  makeRuntimeError,
  requiredCapabilityForCommand,
  requiredCapabilityForInterrupt,
  RUNTIME_COMMAND_TYPES,
  unsupportedCapabilityError,
} from "@fffattiger/pix-runtime-core";
import { mapDriverError, mapMessage } from "../mappers/index.js";
import { redactText } from "./sanitize.js";
import type { DriverUiRequest, PiRuntimeDriver } from "./types.js";

const COMMAND_TYPES = new Set<string>(RUNTIME_COMMAND_TYPES);

/**
 * Fixed sanitized navigate-failure message per canonical code. The worker/adapter
 * raw error text (which may carry the target leaf id, a path, or SDK/transport
 * internals) never crosses the boundary — every navigate failure is re-projected
 * onto a fixed message, preserving only the canonical code + retryable.
 */
const NAVIGATE_FAILURE_MESSAGES: Readonly<Partial<Record<RuntimeError["code"], string>>> = {
  invalid_input: "navigation target is invalid",
  not_found: "navigation target not found",
  interrupted: "navigation was cancelled",
  session_busy: "session is busy",
  timeout: "navigation timed out",
  unavailable: "navigation is unavailable",
};

/**
 * Fixed sanitized fork-failure message per canonical code. The worker/adapter
 * raw error text (which may carry the fork-point entry id, a session file path,
 * or SDK/transport internals) never crosses the boundary — every fork failure
 * is re-projected onto a fixed message, preserving only the canonical code +
 * retryable. The fork params (`entryId`) are NEVER echoed in an error.
 */
const FORK_FAILURE_MESSAGES: Readonly<Partial<Record<RuntimeError["code"], string>>> = {
  invalid_input: "fork point is invalid",
  not_found: "fork point not found",
  session_busy: "session is busy",
  external: "fork failed",
  unavailable: "fork is unavailable",
  internal: "fork failed",
};

/**
 * Fixed sanitized auto_name (generate_session_title) failure message per
 * canonical code. The worker/adapter raw error text (which may carry the
 * generated title, a session id, a path, or SDK/transport internals) never
 * crosses the boundary — every title-generation failure is re-projected onto a
 * fixed message, preserving only the canonical code + retryable. The command
 * has no parameters, so there is nothing to echo.
 */
const AUTO_NAME_FAILURE_MESSAGES: Readonly<Partial<Record<RuntimeError["code"], string>>> = {
  invalid_input: "session title is invalid",
  not_found: "session not found",
  interrupted: "title generation was cancelled",
  session_busy: "session is busy",
  timeout: "title generation timed out",
  unavailable: "title generation is unavailable",
  external: "title generation failed",
  internal: "title generation failed",
};

interface PendingUi {
  request: ExtensionUiRequest;
  driver: DriverUiRequest;
}

interface PendingBashTerminal {
  command: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
}

/**
 * Phase 5A session-change publication: the canonical runtime-core
 * `session_changed` RuntimeEvent (carrying the authoritative post-change
 * `cwd` + session-tree `leafId`) is emitted on the REGULAR
 * `AgentRuntimePort.subscribe` channel after (a) a SUCCESSFUL `navigate_tree`
 * (the branch pointer moved) and (b) a compaction terminal
 * (`compaction_end` / `auto_compaction_end`, plus the adapter's own synthetic
 * interrupted manual end), so history/live consumers can leaf-fence rebase on
 * a provable leaf change. Never emitted for a rejected navigate/compact — a
 * failed command never reports a session change. The worker's stateful mapper
 * projects this onto the existing Protocol `SessionChangedEventData` frame
 * (packages/protocol/src/events.ts) and sessiond passes it through the generic
 * worker.event lane; the shared Protocol reducer applies {cwd, sessionFile?,
 * leafId?} to the snapshot.
 */

export class CanonicalAgentRuntimeAdapter implements AgentRuntimePort {
  readonly identity: RuntimeIdentity;
  private capabilities: RuntimeCapabilitySet;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private unsubscribeDriver: () => void;
  private closed = false;
  private closeReason: RuntimeCloseReason | null = null;
  private promptRunning = false;
  /** Short critical section covering override validation/application + prompt launch. */
  private turnAdmissionBusy = false;
  /**
   * Short critical section covering plain set_model / set_thinking_level from
   * the busy guard through the driver write + state publication (released in
   * finally). A submitTurn arriving inside this window fails closed with
   * session_busy: admitting it would interleave the turn's activation-override
   * model application (and its pinned-thinking reapply, which model changes
   * clamp/reset) with the in-flight mutation, leaving the session model to
   * nondeterministic write ordering — never a success under the wrong model.
   * Mutually exclusive with turnAdmissionBusy/promptRunning in BOTH
   * directions, per-runtime (never global), never held across a prompt, and
   * never blocking the independent interrupt/stop control channel.
   */
  private modelMutationBusy = false;
  /** Structurally resolved user entry for the currently admitted turn, when available. */
  private activeTurnUserEntryId: string | undefined;
  private partialMessage: StreamingAgentMessage | null = null;
  private bash: BashProjection | null = null;
  private compaction: CompactionProjection | null = null;
  /**
   * startedAt of the manual compaction whose `compaction_start` was forwarded to
   * consumers (so a synthetic `compaction_end` on interrupted cleanup clears the
   * sessiond/client projection only when it previously saw a start). null when no
   * manual start was forwarded for the current lineage.
   */
  private forwardedCompactionStartAt: number | null = null;
  private pendingUi = new Map<string, PendingUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, { key: string; lines: readonly string[]; placement: "aboveEditor" | "belowEditor" }>();
  private writtenFiles = new Set<string>();
  private pendingToolWrites = new Map<string, { toolName: string; path: string }>();
  private completedToolCalls = new Set<string>();
  private pendingBashTerminals: PendingBashTerminal[] = [];
  private thinkingPinned = false;
  private pinnedThinkingLevel: RuntimeState["thinkingLevel"] | undefined;
  private queued: QueuedMessages = { steering: [], followUp: [] };

  private readyPromise: Promise<void>;

  constructor(private readonly driver: PiRuntimeDriver, options?: { thinkingPinned?: boolean }) {
    this.identity = {
      sessionId: driver.identity.sessionId,
      sessionFile: driver.identity.sessionFile,
      ...(driver.identity.createdAt === undefined ? {} : { createdAt: driver.identity.createdAt }),
    };
    this.capabilities = createCapabilitySet(driver.capabilities, 1);
    this.thinkingPinned = options?.thinkingPinned ?? false;
    if (this.thinkingPinned) this.pinnedThinkingLevel = driver.getState().thinkingLevel;
    this.unsubscribeDriver = driver.subscribe((event) => this.handleDriverEvent(event));
    this.readyPromise = driver.bindUi(
      (request) => this.registerUiRequest(request),
      (event) => this.emit(event),
    );
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  getCapabilities(): RuntimeCapabilitySet {
    return this.capabilities;
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    if (this.closed) throw makeRuntimeError("unavailable", "runtime is closed");
    const state = this.buildState();
    return {
      sessionId: this.identity.sessionId,
      state,
      capabilities: this.capabilities,
      streaming: this.promptRunning || state.isStreaming
        ? {
            active: true,
            ...(this.partialMessage === null ? {} : { partialMessage: this.partialMessage }),
            phase: state.isCompacting ? "compacting" : state.isBashRunning ? "bash" : "streaming",
          }
        : { active: false, phase: "idle" },
      // Protocol v2: the snapshot is control/reconnect state only — it NEVER
      // carries completed transcript history (a huge JSONL would blow the
      // Worker 2 MiB / Host ~4 MiB frame budgets during primeProjection).
      // Persisted history comes from the cursor-paginated session context.
    };
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    for (const pending of this.pendingUi.values()) {
      listener({ type: "extension_ui_request", sessionId: this.identity.sessionId, request: pending.request });
    }
    return () => this.listeners.delete(listener);
  }

  /**
   * Phase 5A: publish the canonical `session_changed` RuntimeEvent on the
   * REGULAR subscribe channel, built from the AUTHORITATIVE driver
   * identity/state at call time (never a caller-supplied or cached leaf —
   * `leafId` is omitted when the backend exposes none).
   */
  private emitSessionChanged(): void {
    if (this.closed) return;
    const leafId = this.driver.getState().leafId;
    this.emit({
      type: "session_changed",
      sessionId: this.identity.sessionId,
      cwd: this.driver.identity.cwd,
      ...(leafId === undefined || leafId === null ? {} : { leafId }),
    });
  }

  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (this.closed) return this.failure(command.type, makeRuntimeError("unavailable", "runtime is closed"));
    if (!COMMAND_TYPES.has(command.type)) {
      const type = (command as { type: string }).type as RuntimeCommandType;
      return this.failure(type, makeRuntimeError("invalid_command", `unknown command type: ${type}`));
    }
    const capability = requiredCapabilityForCommand(command.type);
    if (capability && !this.capabilities.capabilities.includes(capability)) {
      return this.failure(command.type, unsupportedCapabilityError(capability));
    }
    try {
      switch (command.type) {
        case "prompt": {
          // Protocol-v2 compatibility path: reuse the SAME atomic turn-start
          // implementation, but preserve the old command contract by awaiting
          // the long completion before returning the command result.
          const handle = await this.submitTurn({
            prompt: command.message,
            ...(command.images === undefined ? {} : { images: command.images }),
          });
          if (!handle.admission.ok) return this.failure("prompt", handle.admission.error);
          const terminal = await handle.completion;
          return terminal.ok ? { ok: true, type: "prompt" } : this.failure("prompt", terminal.error);
        }
        case "steer": {
          if (this.driver.getState().isStreaming) {
            this.queued = {
              ...this.queued,
              steering: [...this.queued.steering, {
                message: command.message,
                ...(command.images === undefined ? {} : { images: command.images }),
              }],
            };
          }
          await this.driver.steer(command.message, command.images);
          return { ok: true, type: "steer" };
        }
        case "follow_up": {
          if (this.driver.getState().isStreaming) {
            this.queued = {
              ...this.queued,
              followUp: [...this.queued.followUp, {
                message: command.message,
                ...(command.images === undefined ? {} : { images: command.images }),
              }],
            };
          }
          await this.driver.followUp(command.message, command.images);
          return { ok: true, type: "follow_up" };
        }
        case "abort":
          await this.driver.abort();
          this.cancelPendingUi();
          this.clearToolCorrelations();
          return { ok: true, type: "abort" };
        case "abort_bash": this.driver.abortBash(); return { ok: true, type: "abort_bash" };
        case "abort_compaction": this.driver.abortCompaction(); if (this.compaction) this.compaction = { ...this.compaction, status: "aborting" }; return { ok: true, type: "abort_compaction" };
        case "clear_queue":
          this.driver.clearQueue();
          this.queued = { steering: [], followUp: [] };
          return { ok: true, type: "clear_queue" };
        case "get_state": return this.read({ type: "get_state" });
        case "set_model":
          if (this.turnAdmissionBusy || this.promptRunning || this.driver.getState().isStreaming) return this.failure("set_model", makeRuntimeError("session_busy", "a prompt is already in progress", { retryable: true }));
          if (this.modelMutationBusy) return this.failure("set_model", makeRuntimeError("session_busy", "a model change is already in progress", { retryable: true }));
          this.modelMutationBusy = true;
          try {
            await this.driver.setModel({ provider: command.provider, id: command.modelId });
            await this.reapplyPinnedThinking();
            this.emitState();
            return { ok: true, type: "set_model" };
          } finally { this.modelMutationBusy = false; }
        case "set_thinking_level": {
          if (this.turnAdmissionBusy || this.promptRunning || this.driver.getState().isStreaming) return this.failure("set_thinking_level", makeRuntimeError("session_busy", "a prompt is already in progress", { retryable: true }));
          if (this.modelMutationBusy) return this.failure("set_thinking_level", makeRuntimeError("session_busy", "a model change is already in progress", { retryable: true }));
          const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
          if (!levels.includes(command.level)) return this.failure(command.type, makeRuntimeError("invalid_input", `unknown thinking level: ${command.level}`));
          this.modelMutationBusy = true;
          try {
            await this.driver.setThinkingLevel(command.level);
            this.thinkingPinned = true;
            this.pinnedThinkingLevel = command.level;
            this.emitState();
            return { ok: true, type: "set_thinking_level" };
          } finally { this.modelMutationBusy = false; }
        }
        case "compact": {
          // Defensive compact busy guard (D2-P7) BEFORE any state mutation or
          // SDK call: a manual compact must never overlap a live prompt stream,
          // an ACTIVE bash command, or an already-running compaction (real or
          // adapter-local). The real SDK auto-aborts a prompt / overlaps bash on
          // a direct wire compact, so the canonical boundary rejects first with
          // a structured session_busy and leaves NO partial compaction state or
          // event behind. A bash is busy only while NONTERMINAL: the adapter
          // retains the terminal bash projection (`bash.completed === true`)
          // forever after a finished/cancelled command, so a mere non-null
          // projection must NOT block compact — only the real driver
          // isBashRunning OR a nonterminal in-flight projection (the window
          // where the adapter has admitted the bash but the SDK state has not
          // yet flipped) is busy.
          const driverState = this.driver.getState();
          if (
            driverState.isStreaming ||
            driverState.isBashRunning ||
            driverState.isCompacting ||
            this.promptRunning ||
            (this.bash !== null && this.bash.completed === false) ||
            this.compaction !== null
          ) {
            return this.failure("compact", makeRuntimeError("session_busy", "a prompt, bash command, or compaction is already in progress", { retryable: true }));
          }
          this.compaction = {
            reason: "manual",
            status: "running",
            ...(command.customInstructions === undefined
              ? {}
              : { customInstructions: command.customInstructions }),
            startedAt: Date.now(),
          };
          const owned = this.compaction;
          this.forwardedCompactionStartAt = null;
          try {
            await this.driver.compact(command.customInstructions);
            return { ok: true, type: "compact" };
          } finally {
            // Exact-owner cleanup (D2-P7 fix): the real SDK emits compaction_end
            // on success/abort (clearing this.compaction via handleDriverEvent).
            // When it does NOT (a thrown failure before any event, or a
            // no-event settle), clear the local marker for the OWNED compaction
            // — running OR aborting — so the snapshot never claims a pending
            // compaction. `startedAt` is the ownership key: the abort_compaction
            // flip preserves it, a canonical end nulls this.compaction, and a
            // newer compaction (which the busy guard keeps impossible while this
            // is pending) would carry a different startedAt — so we never clear
            // a newer compaction. If a manual compaction_start was forwarded
            // (sessiond saw start) but no end arrived, emit a synthetic
            // compaction_end so the sessiond/client projection clears; no
            // duplicate end when the SDK already emitted one (this.compaction is
            // null then).
            if (this.compaction !== null && this.compaction.startedAt === owned.startedAt) {
              const wasAborting = this.compaction.status === "aborting";
              this.compaction = null;
              if (this.forwardedCompactionStartAt === owned.startedAt) {
                this.forwardedCompactionStartAt = null;
                this.emit({
                  type: "compaction_end",
                  sessionId: this.identity.sessionId,
                  reason: "manual",
                  ...(wasAborting ? { aborted: true } : {}),
                  errorMessage: "compaction interrupted",
                });
                // Phase 5A: this synthetic end IS the manual compaction's
                // terminal — publish the authoritative current leaf (unchanged
                // by an interrupted compaction; consumers rebase only on an
                // actual leaf divergence).
                this.emitSessionChanged();
              }
            }
          }
        }
        case "set_session_name": {
          if (typeof command.name !== "string" || !command.name.trim()) {
            return this.failure(command.type, makeRuntimeError("invalid_input", "session name must be a non-empty string"));
          }
          this.driver.setSessionName(command.name);
          this.emitState();
          return { ok: true, type: "set_session_name" };
        }
        case "get_session_stats": return this.read({ type: "get_session_stats" });
        case "get_last_assistant_text": return this.read({ type: "get_last_assistant_text" });
        case "set_auto_compaction": this.driver.setAutoCompaction(command.enabled); this.emitState(); return { ok: true, type: "set_auto_compaction" };
        case "set_auto_retry": this.driver.setAutoRetry(command.enabled); this.emitState(); return { ok: true, type: "set_auto_retry" };
        case "get_tools": return this.read({ type: "get_tools" });
        case "get_commands": return this.read({ type: "get_commands" });
        case "set_tools": {
          // Validate BEFORE mutation: the driver's setActiveToolsByName silently
          // ignores unknown names (returns ok:true while dropping them), so the
          // canonical boundary must reject malformed/unknown tools up-front and
          // leave state/get_tools untouched on failure. The known catalog is the
          // REAL session's complete registry (builtins + loaded extension/
          // resource tools) surfaced through driver.getState().tools, which is
          // derived from session.getAllTools(). Names are strictly trimmed and
          // de-duplicated (preserving order) so the driver applies exactly what
          // was validated; all-off [] stays valid.
          const normalized = this.normalizeToolNames(command.toolNames);
          if (!normalized.ok) return this.failure("set_tools", normalized.error);
          this.driver.setTools(normalized.names, command.includeExtensionTools !== false);
          this.emitState();
          return { ok: true, type: "set_tools" };
        }
        case "reload": {
          this.clearToolCorrelations();
          const capabilities = await this.driver.reload();
          await this.reapplyPinnedThinking();
          this.capabilities = createCapabilitySet(capabilities, this.capabilities.version + 1);
          this.emit({ type: "runtime_capabilities_changed", sessionId: this.identity.sessionId, capabilities: this.capabilities });
          return { ok: true, type: "reload" };
        }
        case "extension_ui_response": return this.resolveUi(command);
        case "extension_ui_input": return this.inputUi(command);
        case "bash": {
          const deferCommitUntilSettled = this.driver.getState().isStreaming;
          // R0 frozen bash semantics:
          //  - `bash_update.output` events carry a DELTA chunk (the original
          //    chunk), never the accumulated value; the snapshot/state
          //    `bash.output` keeps the accumulated value.
          //  - the driver's final result.output is authoritative: it replaces
          //    the snapshot, but is never re-emitted as a delta. When it
          //    extends the streamed prefix only the unseen suffix is emitted;
          //    when it does not extend the prefix no output is emitted and the
          //    snapshot stays authoritative (fail-closed). This guarantees a
          //    consumer concatenating `bash_update.output` deltas never sees
          //    the accumulated output spliced more than once.
          //  - Protocol v2: the terminal bash_update (exitCode/cancelled)
          //    carries the persisted entry identity so the client can create
          //    one committed live SessionEntry from the cumulative bash state.
          //    The committed identity is resolved AFTER the driver settles (the
          //    SDK appends via recordBashResult inside executeBash); a failure
          //    to correlate stops the terminal publication fail-closed with a
          //    sanitized runtime error.
          this.bash = { command: command.command, output: "", excludeFromContext: command.excludeFromContext ?? false, truncated: false, cancelled: false, completed: false, updateCount: 0 };
          const result = await this.driver.bash(command.command, command.excludeFromContext ?? false, (chunk) => {
            const current = this.bash;
            if (!current) return;
            this.bash = { ...current, output: `${current.output}${chunk}`, updateCount: current.updateCount + 1 };
            this.emit({
              type: "bash_update",
              sessionId: this.identity.sessionId,
              command: command.command,
              output: chunk,
              ...(command.excludeFromContext === undefined
                ? {}
                : { excludeFromContext: command.excludeFromContext }),
            });
          });
          const prior = this.bash;
          const streamed = prior?.output ?? "";
          const authoritative = result.output;
          const suffix = authoritative.startsWith(streamed) ? authoritative.slice(streamed.length) : "";
          this.bash = prior === null
            ? {
                command: command.command,
                output: authoritative,
                excludeFromContext: command.excludeFromContext ?? false,
                truncated: result.truncated ?? false,
                cancelled: result.cancelled ?? false,
                completed: true,
                ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
                ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
                updateCount: 1,
              }
            : {
                ...prior,
                output: authoritative,
                ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
                cancelled: result.cancelled ?? false,
                truncated: result.truncated ?? false,
                ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
                completed: true,
                updateCount: prior.updateCount + 1,
              };
          const terminal: PendingBashTerminal = {
            command: command.command,
            ...(suffix.length > 0 ? { output: suffix } : {}),
            ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled }),
            ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
            ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
            ...(command.excludeFromContext === undefined ? {} : { excludeFromContext: command.excludeFromContext }),
          };
          if (deferCommitUntilSettled) {
            // The SDK queues bash results while an agent turn is active and
            // appends them only immediately before agent_settled. Publishing a
            // terminal event now would bind it to the wrong current leaf.
            this.pendingBashTerminals.push(terminal);
          } else {
            this.publishCommittedBashTerminals([terminal]);
          }
          if (result.cancelled) return this.failure("bash", makeRuntimeError("interrupted", "bash aborted", { retryable: true }));
          return { ok: true, type: "bash" };
        }
        case "navigate_tree": {
          // D2 navigate busy guard (mirrors the compact guard): navigate is a
          // serial-lane mutating command that must NEVER overlap an in-flight
          // prompt stream, an ACTIVE bash command, an already-running
          // compaction, or a pending extension-UI wait (the adapter's
          // promptRunning covers a prompt blocked on an extension request).
          // Reject first with a structured session_busy and leave NO partial
          // mutation/event behind — the in-flight turn is never corrupted. A
          // bash is busy only while NONTERMINAL (the retained terminal bash
          // projection must not block navigate).
          const driverState = this.driver.getState();
          if (
            driverState.isStreaming ||
            driverState.isBashRunning ||
            driverState.isCompacting ||
            this.promptRunning ||
            (this.bash !== null && this.bash.completed === false) ||
            this.compaction !== null
          ) {
            return this.failure("navigate_tree", makeRuntimeError("session_busy", "a prompt, bash command, or compaction is already in progress", { retryable: true }));
          }
          // Blank/missing leaf reference: structured invalid_input BEFORE any
          // SDK call (the Protocol NonEmptyStringSchema already rejects it at
          // the wire, but the canonical boundary must stay fail-closed).
          if (typeof command.targetId !== "string" || !command.targetId.trim()) {
            return this.failure("navigate_tree", makeRuntimeError("invalid_input", "navigation target is required"));
          }
          try {
            await this.driver.navigate(command.targetId);
          } catch (error) {
            // Map the driver failure to a canonical code, but NEVER surface the
            // raw SDK message (which may carry the target id / path / transport
            // text) — project every navigate failure onto a fixed sanitized
            // message keyed by the code.
            const mapped = mapDriverError(error);
            const fixed = NAVIGATE_FAILURE_MESSAGES[mapped.code] ?? "navigation failed";
            return this.failure("navigate_tree", makeRuntimeError(mapped.code, fixed, { retryable: mapped.retryable }));
          }
          // Phase 5A: a successful navigate moved the branch pointer — publish
          // the authoritative post-navigate leaf to session-change consumers
          // (leaf-fence rebase) BEFORE the generic state-change event.
          this.emitSessionChanged();
          this.emitState();
          return { ok: true, type: "navigate_tree" };
          // NOTE (frozen semantics): unlike compact, navigate intentionally has
          // NO dedicated in-flight marker. navigateTree-without-summarize is a
          // quick in-memory leaf move (SessionManager.branch) that never blocks
          // on a model, so overlapping navigates are benign and deterministic
          // last-writer-wins (the sessiond lifecycle mutex serializes admission;
          // the SDK resolves the target against a stable entry map). The busy
          // guard above already rejects navigate against a real in-flight
          // prompt/bash/compaction/extension-UI wait. A prompt issued after a
          // navigate simply appends at the current (navigated) leaf — pi's own
          // semantics. This asymmetry with compact is deliberate and covered by
          // the concurrent-navigate test below.
        }
        case "fork": {
          // D2 fork busy guard (mirrors the compact/navigate guard): fork is a
          // serial-lane mutating command that must NEVER overlap an in-flight
          // prompt stream, an ACTIVE bash command, an already-running
          // compaction, or a pending extension-UI wait. Reject first with a
          // structured session_busy and leave NO partial fork/close state
          // behind — the in-flight turn is never corrupted.
          const driverState = this.driver.getState();
          if (
            driverState.isStreaming ||
            driverState.isBashRunning ||
            driverState.isCompacting ||
            this.promptRunning ||
            (this.bash !== null && this.bash.completed === false) ||
            this.compaction !== null
          ) {
            return this.failure("fork", makeRuntimeError("session_busy", "a prompt, bash command, or compaction is already in progress", { retryable: true }));
          }
          // Blank/missing fork point: structured invalid_input BEFORE any SDK
          // call (the Protocol NonEmptyStringSchema already rejects it at the
          // wire, but the canonical boundary must stay fail-closed). The fork
          // params are never echoed in any error.
          if (typeof command.entryId !== "string" || !command.entryId.trim()) {
            return this.failure("fork", makeRuntimeError("invalid_input", "fork point is required"));
          }
          try {
            const forked = await this.driver.fork(command.entryId);
            // D2 fork: the result must settle before runtime_closed is
            // observable. The close is deferred by a timer turn (strictly after
            // promise reactions queued by async callers), mirroring the fake
            // runtime contract (D-018).
            setTimeout(() => void this.close("forked"), 0);
            return { ok: true, type: "fork", forkedSessionId: forked.sessionId, forkPointEntryId: command.entryId };
          } catch (error) {
            // Map the driver failure to a canonical code, but NEVER surface the
            // raw SDK message (which may carry the entry id / path / transport
            // text) — project every fork failure onto a fixed sanitized message
            // keyed by the code. On failure the runtime is NOT closed (the old
            // worker keeps running).
            const mapped = mapDriverError(error);
            const fixed = FORK_FAILURE_MESSAGES[mapped.code] ?? "fork failed";
            return this.failure("fork", makeRuntimeError(mapped.code, fixed, { retryable: mapped.retryable }));
          }
        }
        case "generate_session_title": {
          // auto_name (runtime.auto_name) generation now performs a REAL model
          // call through a temporary shadow agent: the driver snapshots the
          // session's messages (idle-gated via waitForIdle, 90s bounded, tools
          // replaced with throwing fakes) and derives a ≤80-char title. The
          // live session tree is still never mutated — the shadow agent runs
          // on a copy and the driver applies only the resulting session name.
          // An optional additive `model` override pins the title model; when
          // absent the session's current model is used. There is NO dedicated
          // busy guard at the adapter boundary: the driver gates on the source
          // agent's idle state internally, so a prompt issued around it is
          // unaffected and the lane/worker serialization still orders it FIFO.
          // This asymmetry with navigate/fork/compact is deliberate and frozen.
          try {
            const name = await this.driver.generateSessionTitle(
              command.model === undefined ? undefined : { model: command.model },
            );
            this.emit({ type: "session_title", sessionId: this.identity.sessionId, name });
            // The adapter applies the title to the worker AND returns it: the
            // RPC result is the single source of truth sessiond uses to publish
            // the §51 revisioned title overlay (never derived from a racy wire
            // event, mirroring the live rename overlay publication path).
            return { ok: true, type: "generate_session_title", title: name };
          } catch (error) {
            // Map the driver failure to a canonical code, but NEVER surface the
            // raw SDK message (which may carry the generated title / session id
            // / path / transport text) — project every failure onto a fixed
            // sanitized message keyed by the code.
            const mapped = mapDriverError(error);
            const fixed = AUTO_NAME_FAILURE_MESSAGES[mapped.code] ?? "title generation failed";
            return this.failure("generate_session_title", makeRuntimeError(mapped.code, fixed, { retryable: mapped.retryable }));
          }
        }
      }
    } catch (error) {
      const mapped = mapDriverError(error);
      if (command.type === "prompt") {
        this.promptRunning = false;
        this.clearPendingToolWrites();
        if (mapped.code === "interrupted") this.cancelPendingUi();
        this.emit({
          type: "prompt_error",
          sessionId: this.identity.sessionId,
          errorMessage: mapped.message,
          error: mapped,
        });
      }
      return this.failure(command.type, mapped);
    }
  }

  /**
   * Phase 3 atomic prompt admission. Validation and overrides execute inside a
   * short adapter-owned critical section; the long prompt runs in the returned
   * completion promise and never holds the caller's ordinary control lane.
   */
  async submitTurn(input: RuntimeTurnStart): Promise<RuntimeTurnHandle> {
    const rejected = async (error: RuntimeError): Promise<RuntimeTurnHandle> => {
      const snapshot = await this.getSnapshot().catch(() => ({
        sessionId: this.identity.sessionId,
        state: this.buildState(),
        capabilities: this.capabilities,
        streaming: { active: false as const, phase: "idle" as const },
      }));
      const terminal: RuntimeTurnTerminal = { ok: false, error, snapshot };
      return { admission: { ok: false, error, snapshot }, completion: Promise.resolve(terminal) };
    };
    if (this.closed) return rejected(makeRuntimeError("unavailable", "runtime is closed"));
    if (this.turnAdmissionBusy || this.promptRunning || this.driver.getState().isStreaming) {
      return rejected(makeRuntimeError("session_busy", "a prompt is already in progress", { retryable: true }));
    }
    if (this.modelMutationBusy) {
      return rejected(makeRuntimeError("session_busy", "a model change is already in progress", { retryable: true }));
    }
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      return rejected(makeRuntimeError("invalid_input", "prompt must be non-empty"));
    }
    const promptCapability = requiredCapabilityForCommand("prompt");
    if (promptCapability && !this.capabilities.capabilities.includes(promptCapability)) {
      return rejected(unsupportedCapabilityError(promptCapability));
    }
    const overrides = input.activationOverrides;
    if (overrides?.model !== undefined) {
      const capability = requiredCapabilityForCommand("set_model");
      if (capability && !this.capabilities.capabilities.includes(capability)) return rejected(unsupportedCapabilityError(capability));
      if (!overrides.model.provider.trim() || !overrides.model.modelId.trim()) return rejected(makeRuntimeError("invalid_input", "model selector is invalid"));
    }
    if (overrides?.thinkingLevel !== undefined) {
      const capability = requiredCapabilityForCommand("set_thinking_level");
      if (capability && !this.capabilities.capabilities.includes(capability)) return rejected(unsupportedCapabilityError(capability));
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(overrides.thinkingLevel)) {
        return rejected(makeRuntimeError("invalid_input", "thinking level is invalid"));
      }
    }

    this.turnAdmissionBusy = true;
    try {
      // Model first because model changes can clamp/reset thinking. Reapply the
      // prior pin, then the explicit turn override wins last.
      if (overrides?.model !== undefined) {
        await this.driver.setModel({ provider: overrides.model.provider, id: overrides.model.modelId });
        await this.reapplyPinnedThinking();
      }
      if (overrides?.thinkingLevel !== undefined) {
        await this.driver.setThinkingLevel(overrides.thinkingLevel);
        this.thinkingPinned = true;
        this.pinnedThinkingLevel = overrides.thinkingLevel;
      }

      this.activeTurnUserEntryId = undefined;
      // Mark/synthesize the running state honestly BEFORE the admission snapshot:
      // an accepted admission must report a prompt in progress.
      this.promptRunning = true;
      // The admission barrier completes BEFORE driver.prompt() starts. If the
      // authoritative snapshot construction fails, NO prompt call has happened:
      // the running state is reset truthfully below and the admission reports a
      // clean rejection — nothing continues in the background. Do not fabricate
      // the snapshot or swallow the failure.
      const snapshot = await this.getSnapshot();
      // The admission snapshot awaited: close() is never blocked by an
      // in-flight admission, so the runtime may have closed while we were
      // suspended. Recheck BEFORE launching the prompt — a closed runtime
      // must fail closed with a clean not-delivered rejection, never an
      // accepted admission that prompts into a disposed driver. Build the
      // handle DIRECTLY from the just-captured snapshot: the driver is already
      // disposed, so any second read (rejected()'s re-snapshot → buildState →
      // driver.getState) would throw and leak a raw error instead of a
      // structured handle. The captured snapshot was marked running BEFORE the
      // prompt launch decision; this turn provably launched nothing, so the
      // no-prompt truth is projected onto the adapter-owned fields only
      // (never a second driver read).
      if (this.closed) {
        this.promptRunning = false;
        const closedError = makeRuntimeError("unavailable", "runtime is closed");
        const notDelivered = {
          ...snapshot,
          streaming: { active: false as const, phase: "idle" as const },
          state: { ...snapshot.state, isPromptRunning: false, isStreaming: false },
        };
        return {
          admission: { ok: false, error: closedError, snapshot: notDelivered },
          completion: Promise.resolve({ ok: false, error: closedError, snapshot: notDelivered }),
        };
      }
      // Launch the prompt EXACTLY once; the long completion runs in the returned
      // promise and never holds the caller's ordinary control lane.
      const completion = (async (): Promise<RuntimeTurnTerminal> => {
        try {
          await this.driver.prompt(input.prompt, input.images);
          // Allow the message_end structural-correlation microtask to publish
          // the committed user identity before terminal snapshot capture.
          await Promise.resolve();
          this.emit({ type: "prompt_done", sessionId: this.identity.sessionId });
          const snapshot = await this.getSnapshot();
          return {
            ok: true,
            snapshot,
            ...(this.activeTurnUserEntryId === undefined ? {} : { userEntryId: this.activeTurnUserEntryId }),
          };
        } catch (error) {
          const mapped = mapDriverError(error);
          this.clearPendingToolWrites();
          if (mapped.code === "interrupted") this.cancelPendingUi();
          this.emit({ type: "prompt_error", sessionId: this.identity.sessionId, errorMessage: mapped.message, error: mapped });
          const snapshot = await this.getSnapshot().catch(() => ({
            sessionId: this.identity.sessionId,
            state: this.buildState(),
            capabilities: this.capabilities,
            streaming: { active: false as const, phase: "idle" as const },
          }));
          return {
            ok: false,
            error: mapped,
            snapshot,
            ...(this.activeTurnUserEntryId === undefined ? {} : { userEntryId: this.activeTurnUserEntryId }),
          };
        } finally {
          this.promptRunning = false;
          this.activeTurnUserEntryId = undefined;
        }
      })();
      return { admission: { ok: true, snapshot }, completion };
    } catch (error) {
      // A partial override is truthful authority state; never roll it back or
      // launch the prompt after a later override failed.
      const mapped = mapDriverError(error);
      this.promptRunning = false;
      const snapshot = await this.getSnapshot().catch(() => ({
        sessionId: this.identity.sessionId,
        state: this.buildState(),
        capabilities: this.capabilities,
        streaming: { active: false as const, phase: "idle" as const },
      }));
      return {
        admission: { ok: false, error: mapped, snapshot },
        completion: Promise.resolve({ ok: false, error: mapped, snapshot }),
      };
    } finally {
      this.turnAdmissionBusy = false;
    }
  }

  /**
   * Phase 2B independent read lane: pure reads over the runtime projection.
   * Reads never mutate state, stay available while a long prompt/bash/compact
   * turn is pending, and use the driver's NARROW accessors so a get_tools /
   * get_commands read never pays for the monolithic O(all entries) session
   * stats. A closed runtime fails with a structured `unavailable` result.
   */
  async read(request: RuntimeReadRequest): Promise<RuntimeReadResult> {
    if (this.closed) return { ok: false, type: request.type, error: makeRuntimeError("unavailable", "runtime is closed") };
    const capability = requiredCapabilityForCommand(request.type);
    if (capability && !this.capabilities.capabilities.includes(capability)) {
      return { ok: false, type: request.type, error: unsupportedCapabilityError(capability) };
    }
    switch (request.type) {
      case "get_state":
        return { ok: true, type: "get_state", state: this.buildState() };
      case "get_session_stats": {
        const stats = this.driver.getSessionStats();
        return { ok: true, type: "get_session_stats", stats: stats ?? { messageCount: this.driver.getState().messageCount } };
      }
      case "get_last_assistant_text":
        return { ok: true, type: "get_last_assistant_text", text: this.driver.getLastAssistantText() ?? "" };
      case "get_tools":
        return { ok: true, type: "get_tools", tools: this.driver.getTools() };
      case "get_commands":
        return { ok: true, type: "get_commands", commands: this.driver.getCommands() };
    }
  }

  async interrupt(interrupt: RuntimeInterrupt): Promise<RuntimeInterruptResult> {
    if (this.closed) return { ok: false, type: interrupt.type, error: makeRuntimeError("unavailable", "runtime is closed") };
    const capability = requiredCapabilityForInterrupt(interrupt.type);
    if (!this.capabilities.capabilities.includes(capability)) return { ok: false, type: interrupt.type, error: unsupportedCapabilityError(capability) };
    try {
      switch (interrupt.type) {
        case "abort":
          await this.driver.abort();
          this.cancelPendingUi();
          this.clearToolCorrelations();
          break;
        case "abort_bash": this.driver.abortBash(); break;
        case "abort_compaction": this.driver.abortCompaction(); if (this.compaction) this.compaction = { ...this.compaction, status: "aborting" }; break;
        case "clear_queue": this.driver.clearQueue(); this.queued = { steering: [], followUp: [] }; break;
      }
      return { ok: true, type: interrupt.type };
    } catch (error) {
      return { ok: false, type: interrupt.type, error: mapDriverError(error) };
    }
  }

  async close(reason: RuntimeCloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.unsubscribeDriver();
    this.clearToolCorrelations();
    // Cancel every pending request and emit its canonical close tombstone via
    // finishUiRequest (idempotent per id, so a synchronous onSettled and this
    // explicit call never double-emit).
    for (const pending of [...this.pendingUi.values()]) {
      try { pending.driver.cancel(); } catch { /* best-effort: settle may have raced */ }
      this.finishUiRequest(pending.request.id);
    }
    await this.driver.close(reason);
    this.emit({ type: "runtime_closed", sessionId: this.identity.sessionId, reason });
    this.listeners.clear();
  }

  private buildState(): RuntimeState {
    const state = this.driver.getState();
    const queuedMessages: QueuedMessages = this.queued;
    return {
      sessionId: this.identity.sessionId,
      sessionFile: this.identity.sessionFile,
      ...(state.leafId === undefined ? {} : { leafId: state.leafId }),
      isStreaming: state.isStreaming,
      isPromptRunning: this.promptRunning || state.isStreaming,
      isBashRunning: state.isBashRunning,
      isCompacting: state.isCompacting || this.compaction !== null,
      ...(this.bash === null ? {} : { bash: this.bash }),
      ...(this.compaction === null ? {} : { compaction: this.compaction }),
      autoCompactionEnabled: state.autoCompactionEnabled,
      autoRetryEnabled: state.autoRetryEnabled,
      model: state.model,
      messageCount: state.messageCount,
      pendingMessageCount: state.pendingMessageCount,
      queuedMessages,
      ...(state.contextUsage === undefined ? {} : { contextUsage: state.contextUsage }),
      systemPrompt: state.systemPrompt,
      thinkingLevel: state.thinkingLevel,
      thinkingLevelPinned: this.thinkingPinned,
      tools: state.tools,
      extensionStatuses: [...this.extensionStatuses].map(([key, text]) => ({ key, text })),
      extensionWidgets: [...this.extensionWidgets.values()],
      pendingExtensionUi: [...this.pendingUi.values()].map((item) => item.request),
      ...(state.sessionName === undefined ? {} : { sessionName: state.sessionName }),
      writtenFiles: [...this.writtenFiles],
    };
  }

  private handleDriverEvent(value: unknown): void {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const type = typeof raw.type === "string" ? raw.type : "";
    const sessionId = this.identity.sessionId;
    switch (type) {
      case "agent_start": this.emit({ type, sessionId }); return;
      case "agent_end": this.clearPendingToolWrites(); this.emit({ type, sessionId }); return;
      case "agent_settled": {
        // SDK _runAgentPrompt flushes queued same-turn bash messages before it
        // emits agent_settled, so their exact consecutive tail identities are
        // authoritative now (but were not available at bash command return).
        if (this.pendingBashTerminals.length > 0) {
          const pending = this.pendingBashTerminals;
          this.pendingBashTerminals = [];
          this.publishCommittedBashTerminals(pending);
        }
        this.emit({ type, sessionId });
        return;
      }
      case "prompt_done": return;
      case "prompt_error": {
        const error = mapDriverError(raw.error ?? raw.errorMessage ?? "prompt failed");
        this.emit({
          type,
          sessionId,
          errorMessage: error.message,
          error,
        });
        return;
      }
      case "message_start": {
        const message = mapMessage(raw.message, true) as StreamingAgentMessage;
        this.partialMessage = message;
        this.emit({ type, sessionId, message });
        return;
      }
      case "message_update": {
        const message = mapMessage(raw.message, true) as StreamingAgentMessage;
        this.partialMessage = message;
        this.emit({ type, sessionId, message });
        return;
      }
      case "message_end": {
        const message = mapMessage(raw.message) as never;
        this.partialMessage = null;
        // Protocol v2: the SDK emits message_end BEFORE synchronously appending
        // the persisted entry. Defer the canonical completion to a microtask so
        // the just-committed leaf entry is resolvable, resolve the EXACT
        // persisted entryId/parentEntryId, and fail closed with a sanitized
        // runtime error (never an unkeyed completion) when the correlation
        // cannot be made. The persisted entry is the ONLY completion identity;
        // content/timestamp/array-overlap matching is never used.
        const role = typeof raw.message === "object" && raw.message !== null
          ? String((raw.message as Record<string, unknown>).role ?? "")
          : "";
        void Promise.resolve().then(() => {
          if (this.closed) return;
          const committed = this.driver.resolveLeafEntry(role);
          if (committed === undefined) {
            this.emit({
              type: "runtime_error",
              sessionId,
              error: makeRuntimeError("internal", "message completion could not be correlated to a persisted entry", { retryable: true }),
            });
            return;
          }
          if (role === "user" && this.promptRunning) this.activeTurnUserEntryId = committed.entryId;
          this.emit({
            type,
            sessionId,
            message,
            entryId: committed.entryId,
            ...(committed.parentEntryId === undefined ? {} : { parentEntryId: committed.parentEntryId }),
          });
          // Context-usage consistency: the committed entry is now durable, so
          // the branch numerator (a fresh assistant usage or a new trailing
          // estimate) is authoritative. Publish the coherent context payload
          // HERE — inside the SAME microtask that resolved the committed
          // identity — so the projection's usage advances with the leaf/count
          // instead of staying frozen at the pre-turn value.
          this.emitState();
        });
        return;
      }
      case "tool_execution_start": {
        const toolCallId = String(raw.toolCallId ?? raw.id ?? "");
        const toolName = String(raw.toolName ?? raw.name ?? "");
        this.completedToolCalls.delete(toolCallId);
        const target = this.writtenTarget(toolName, raw.args);
        if (target) this.pendingToolWrites.set(toolCallId, { toolName, path: target });
        else this.pendingToolWrites.delete(toolCallId);
        this.emit({ type, sessionId, toolCallId, toolName, ...(raw.args === undefined ? {} : { args: raw.args }) });
        return;
      }
      case "tool_execution_update": this.emit({ type, sessionId, toolCallId: String(raw.toolCallId ?? raw.id ?? ""), ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}), ...(raw.partialResult === undefined ? {} : { partialResult: raw.partialResult }) }); return;
      case "tool_execution_end": {
        const toolCallId = String(raw.toolCallId ?? raw.id ?? "");
        if (this.completedToolCalls.has(toolCallId)) return;
        this.completedToolCalls.add(toolCallId);
        const correlation = this.pendingToolWrites.get(toolCallId);
        this.pendingToolWrites.delete(toolCallId);
        const endToolName = typeof raw.toolName === "string" ? raw.toolName : undefined;
        const target = correlation && endToolName === correlation.toolName ? correlation.path : undefined;
        const writtenFiles = raw.isError === false && target ? [target] : [];
        for (const path of writtenFiles) this.writtenFiles.add(path);
        this.emit({ type, sessionId, toolCallId, ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}), ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}), ...(raw.result === undefined ? {} : { result: raw.result }), ...(writtenFiles.length ? { writtenFiles } : {}) });
        return;
      }
      case "queue_update": {
        const state = this.driver.getState();
        this.queued = {
          steering: this.reconcileQueue(this.queued.steering, state.steering),
          followUp: this.reconcileQueue(this.queued.followUp, state.followUp),
        };
        this.emit({ type, sessionId, steering: this.queued.steering, followUp: this.queued.followUp });
        return;
      }
      case "compaction_start": {
        const isManual = raw.reason === "manual";
        const reason = isManual ? "manual" : "auto";
        this.compaction = {
          reason,
          status: "running",
          ...(this.compaction?.customInstructions === undefined
            ? {}
            : { customInstructions: this.compaction.customInstructions }),
          startedAt: this.compaction?.startedAt ?? Date.now(),
        };
        if (isManual) {
          this.forwardedCompactionStartAt = this.compaction?.startedAt ?? null;
          this.emit({ type, sessionId, reason: "manual" });
        } else {
          this.emit({ type: "auto_compaction_start", sessionId });
        }
        return;
      }
      case "compaction_end": {
        const isManual = raw.reason === "manual";
        this.forwardedCompactionStartAt = null;
        this.compaction = null;
        if (isManual) {
          this.emit({ type, sessionId, reason: "manual", ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }), ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}) });
        } else {
          this.emit({ type: "auto_compaction_end", sessionId, ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }), ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}) });
        }
        // Phase 5A: compaction terminal — the branch may have been rewritten
        // (compaction summary at the leaf); publish the authoritative current
        // leaf so consumers leaf-fence rebase exactly when it changed.
        this.emitSessionChanged();
        // Context-usage consistency: post-compaction the true context size is
        // UNKNOWN until the next valid assistant usage. Publish the payload
        // (contextUsage: null) so a stale pre-compaction percentage is cleared
        // from the projection instead of lingering next to the new branch.
        this.emitState();
        return;
      }
      case "auto_compaction_start": this.compaction = { reason: "auto", status: "running", startedAt: Date.now() }; this.emit({ type, sessionId }); return;
      case "auto_compaction_end": this.forwardedCompactionStartAt = null; this.compaction = null; this.emit({ type, sessionId, ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }) }); this.emitSessionChanged(); this.emitState(); return;
      case "auto_retry_start": this.emit({ type, sessionId, attempt: Number(raw.attempt ?? 0), maxAttempts: Number(raw.maxAttempts ?? 0), ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}) }); return;
      case "auto_retry_end": this.emit({ type, sessionId, ...(typeof raw.success === "boolean" ? { success: raw.success } : {}) }); return;
      case "extension_error": this.emit({ type, sessionId, error: String(raw.error ?? raw.message ?? "extension error"), ...(raw.details === undefined ? {} : { details: raw.details }) }); return;
      case "extension_statuses": {
        const statuses = Array.isArray(raw.statuses)
          ? raw.statuses.flatMap((item) => {
              const status = item && typeof item === "object" ? item as Record<string, unknown> : {};
              return typeof status.key === "string" && typeof status.text === "string"
                ? [{ key: status.key, text: status.text }]
                : [];
            })
          : [];
        this.extensionStatuses = new Map(statuses.map((item) => [item.key, item.text]));
        this.emit({ type, sessionId, statuses });
        return;
      }
      case "extension_widgets": {
        const widgets = Array.isArray(raw.widgets)
          ? raw.widgets.flatMap((item) => {
              const widget = item && typeof item === "object" ? item as Record<string, unknown> : {};
              return typeof widget.key === "string" && Array.isArray(widget.lines)
                ? [{
                    key: widget.key,
                    lines: widget.lines.filter((line): line is string => typeof line === "string"),
                    placement: widget.placement === "belowEditor" ? "belowEditor" as const : "aboveEditor" as const,
                  }]
                : [];
            })
          : [];
        this.extensionWidgets = new Map(widgets.map((item) => [item.key, item]));
        this.emit({ type, sessionId, widgets });
        return;
      }
      case "session_info_changed": if (typeof raw.name === "string") this.emit({ type: "session_title", sessionId, name: raw.name }); this.emitState(); return;
      default: return;
    }
  }

  private registerUiRequest(driver: DriverUiRequest): void {
    const request: ExtensionUiRequest = {
      id: driver.id,
      method: driver.method,
      ...(driver.title === undefined ? {} : { title: driver.title }),
      ...(driver.message === undefined ? {} : { message: driver.message }),
      ...(driver.options === undefined ? {} : { options: driver.options }),
      ...(driver.placeholder === undefined ? {} : { placeholder: driver.placeholder }),
      ...(driver.prefill === undefined ? {} : { prefill: driver.prefill }),
      ...(driver.lines === undefined ? {} : { lines: driver.lines }),
      ...(driver.timeout === undefined ? {} : { timeout: driver.timeout, expiresAt: Date.now() + driver.timeout }),
    };
    this.pendingUi.set(driver.id, { request, driver });
    // Publish the request BEFORE registering onSettled: a synchronous settle
    // (already-settled / immediate cancel / timeout) must never emit a close
    // for a request that was never published, and close ordering is
    // deterministic (request → close). finishUiRequest is the single funnel.
    this.emit({ type: "extension_ui_request", sessionId: this.identity.sessionId, request });
    this.emitState();
    driver.onSettled(() => this.finishUiRequest(driver.id));
  }

  private resolveUi(command: Extract<RuntimeCommand, { type: "extension_ui_response" }>): RuntimeCommandResult {
    const pending = this.pendingUi.get(command.id);
    if (!pending) return this.failure(command.type, makeRuntimeError("not_found", `no pending extension UI request: ${command.id}`));
    // Exact method correlation: a response whose method does not match the
    // pending request is structured invalid_input; the request stays pending
    // and usable (no SDK settle, no close). Only the exact method may settle.
    if (pending.request.method !== command.method) {
      return this.failure(command.type, makeRuntimeError("invalid_input", `extension response method mismatch for request ${command.id}`));
    }
    if ("value" in command) pending.driver.settle({ value: command.value });
    else if ("confirmed" in command) pending.driver.settle({ confirmed: command.confirmed });
    else pending.driver.settle({ cancelled: true });
    return { ok: true, type: command.type };
  }

  private inputUi(command: Extract<RuntimeCommand, { type: "extension_ui_input" }>): RuntimeCommandResult {
    const pending = this.pendingUi.get(command.id);
    if (!pending || !pending.driver.input) return this.failure("extension_ui_input", makeRuntimeError("not_found", `no pending extension UI input: ${command.id}`));
    // Exact method correlation. The input command carries input/editor/custom
    // (E15: custom panels stream raw key data), so a mismatch rejects
    // select/confirm with structured invalid_input; the request stays pending
    // and usable (no SDK input call, no close).
    if (pending.request.method !== command.method) {
      return this.failure("extension_ui_input", makeRuntimeError("invalid_input", `extension input method mismatch for request ${command.id}`));
    }
    pending.driver.input(command.data);
    return { ok: true, type: "extension_ui_input" };
  }

  private async reapplyPinnedThinking(): Promise<void> {
    if (!this.thinkingPinned || this.pinnedThinkingLevel === undefined) return;
    await this.driver.setThinkingLevel(this.pinnedThinkingLevel);
  }

  private writtenTarget(toolName: string, args: unknown): string | undefined {
    // Pi SDK 0.84 built-in write/edit both expose the target only as start args.path.
    if (toolName !== "write" && toolName !== "edit") return undefined;
    if (!args || typeof args !== "object") return undefined;
    const path = (args as Record<string, unknown>).path;
    if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) return undefined;
    return this.normalizeWrittenPath(path);
  }

  private normalizeWrittenPath(path: string): string | undefined {
    try {
      const base = this.driver.identity.cwd;
      const normalized = path.startsWith("/") ? path : `${base.replace(/\/$/, "")}/${path}`;
      const segments: string[] = [];
      for (const segment of normalized.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      return `/${segments.join("/")}`;
    } catch { return undefined; }
  }

  private publishCommittedBashTerminals(terminals: readonly PendingBashTerminal[]): void {
    if (terminals.length === 0) return;
    const commits = terminals.length === 1
      ? (() => {
          const commit = this.driver.resolveLeafEntry("bashExecution");
          return commit === undefined ? undefined : [commit];
        })()
      : this.driver.resolveLeafEntries?.("bashExecution", terminals.length);
    if (commits === undefined || commits.length !== terminals.length) {
      this.emit({
        type: "runtime_error",
        sessionId: this.identity.sessionId,
        error: makeRuntimeError("internal", "bash completion could not be correlated to a persisted entry", { retryable: true }),
      });
      return;
    }
    for (let index = 0; index < terminals.length; index += 1) {
      const terminal = terminals[index]!;
      const committed = commits[index]!;
      this.emit({
        type: "bash_update",
        sessionId: this.identity.sessionId,
        ...terminal,
        entryId: committed.entryId,
        ...(committed.parentEntryId === undefined ? {} : { parentEntryId: committed.parentEntryId }),
      });
    }
    // Context-usage consistency: committed bash entries extend the branch's
    // trailing estimate. Publish the coherent payload once after the terminal
    // commits (never per delta) so usage converges with the advanced leaf.
    this.emitState();
  }

  private clearPendingToolWrites(): void { this.pendingToolWrites.clear(); }
  private clearToolCorrelations(): void {
    this.pendingToolWrites.clear();
    this.completedToolCalls.clear();
  }

  private reconcileQueue(
    previous: readonly { message: string; images?: readonly ImageAttachment[] }[],
    current: readonly { message: string; images?: readonly ImageAttachment[] }[],
  ): readonly { message: string; images?: readonly ImageAttachment[] }[] {
    return current.map((turn, index) => {
      const matching = previous.find((item, candidateIndex) =>
        candidateIndex >= index && item.message === turn.message,
      );
      return {
        message: turn.message,
        ...(turn.images === undefined
          ? matching?.images === undefined
            ? {}
            : { images: matching.images }
          : { images: turn.images }),
      };
    });
  }

  /**
   * Single funnel for request settlement (response, cancel, abort/prompt
   * interruption, SDK timeout/signal/onSettled). Emits EXACTLY ONE canonical
   * `extension_ui_request` close tombstone (`closed: true`) for a request that
   * was published, then removes the pending entry and notifies state consumers
   * — in race-safe order (close event before map delete). A second call (or a
   * settle/cancel/onSettled race) sees no entry and emits nothing, so there is
   * never a duplicate close and never a close before a request was published.
   */
  private finishUiRequest(id: string): void {
    const pending = this.pendingUi.get(id);
    if (!pending) return;
    this.emit({
      type: "extension_ui_request",
      sessionId: this.identity.sessionId,
      request: { ...pending.request, closed: true },
    });
    this.pendingUi.delete(id);
    this.emitState();
  }

  private cancelPendingUi(): void {
    for (const pending of [...this.pendingUi.values()]) {
      try { pending.driver.cancel(); } catch { /* best-effort: settle may have raced */ }
      // Cancel may defer onSettled; emit close + remove now for any request the
      // driver did not synchronously settle so the projection converges exactly
      // once (finishUiRequest is idempotent per id).
      this.finishUiRequest(pending.request.id);
    }
  }

  private failure(type: RuntimeCommandType, error: ReturnType<typeof makeRuntimeError>): RuntimeCommandResult {
    return { ok: false, type, error };
  }

  /**
   * Normalize + validate a `set_tools` name list against the real session's
   * complete known tool catalog (builtins + loaded extension/resource tools,
   * surfaced from `session.getAllTools()` via the driver state). Strict
   * trim/dedupe (order preserved) with all-off `[]` valid; the FIRST blank /
   * control / unknown name fails as structured `invalid_input` with a
   * bounded/sanitized display, and no mutation occurs.
   */
  private normalizeToolNames(
    toolNames: readonly string[],
  ): { ok: true; names: string[] } | { ok: false; error: ReturnType<typeof makeRuntimeError> } {
    const known = new Set(this.driver.getState().tools.map((tool) => tool.name));
    const names: string[] = [];
    const seen = new Set<string>();
    for (const raw of toolNames) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (name.length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
        return { ok: false, error: makeRuntimeError("invalid_input", "tool names must be non-empty") };
      }
      if (!known.has(name)) {
        return { ok: false, error: makeRuntimeError("invalid_input", `unknown tool: ${redactText(name).slice(0, 200)}`) };
      }
      if (!seen.has(name)) { seen.add(name); names.push(name); }
    }
    return { ok: true, names };
  }

  /**
   * Signal + coherent context publication (context-usage consistency). The
   * canonical `runtime_state_changed` event stays a signal for consumers that
   * only need "re-read the snapshot"; when the driver exposes the narrow
   * `getContextState` accessor the event ADDITIONALLY carries the atomic
   * {model, leafId, contextUsage} payload captured from ONE driver read, so
   * the shared Protocol reducer can update all three fields together without
   * a snapshot storm. `contextUsage: null` clears a stale projected value.
   */
  private emitState(): void {
    const context = this.driver.getContextState?.();
    this.emit({
      type: "runtime_state_changed",
      sessionId: this.identity.sessionId,
      ...(context === undefined ? {} : { context }),
    });
  }
  private emit(event: RuntimeEvent): void { for (const listener of [...this.listeners]) listener(event); }
}
