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
  RuntimeSnapshot,
  RuntimeState,
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

interface PendingUi {
  request: ExtensionUiRequest;
  driver: DriverUiRequest;
}

export class CanonicalAgentRuntimeAdapter implements AgentRuntimePort {
  readonly identity: RuntimeIdentity;
  private capabilities: RuntimeCapabilitySet;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private unsubscribeDriver: () => void;
  private closed = false;
  private closeReason: RuntimeCloseReason | null = null;
  private promptRunning = false;
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
      messages: this.driver.getState().messages.map((message) => mapMessage(message) as never),
    };
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    for (const pending of this.pendingUi.values()) {
      listener({ type: "extension_ui_request", sessionId: this.identity.sessionId, request: pending.request });
    }
    return () => this.listeners.delete(listener);
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
        case "prompt":
          this.promptRunning = true;
          try {
            await this.driver.prompt(command.message, command.images, command.streamingBehavior);
            this.emit({ type: "prompt_done", sessionId: this.identity.sessionId });
            return { ok: true, type: "prompt" };
          } finally {
            this.promptRunning = false;
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
        case "get_state": return { ok: true, type: "get_state", state: this.buildState() };
        case "set_model":
          await this.driver.setModel({ provider: command.provider, id: command.modelId });
          await this.reapplyPinnedThinking();
          this.emitState();
          return { ok: true, type: "set_model" };
        case "set_thinking_level": {
          const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
          if (!levels.includes(command.level)) return this.failure(command.type, makeRuntimeError("invalid_input", `unknown thinking level: ${command.level}`));
          await this.driver.setThinkingLevel(command.level);
          this.thinkingPinned = true;
          this.pinnedThinkingLevel = command.level;
          this.emitState();
          return { ok: true, type: "set_thinking_level" };
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
        case "get_session_stats": {
          const stats = this.driver.getState().sessionStats;
          return { ok: true, type: "get_session_stats", stats: stats ?? { messageCount: this.driver.getState().messages.length } };
        }
        case "get_last_assistant_text": return { ok: true, type: "get_last_assistant_text", text: this.driver.getState().lastAssistantText ?? "" };
        case "set_auto_compaction": this.driver.setAutoCompaction(command.enabled); this.emitState(); return { ok: true, type: "set_auto_compaction" };
        case "set_auto_retry": this.driver.setAutoRetry(command.enabled); this.emitState(); return { ok: true, type: "set_auto_retry" };
        case "get_tools": return { ok: true, type: "get_tools", tools: this.driver.getState().tools };
        case "get_commands": return { ok: true, type: "get_commands", commands: this.driver.getState().commands ?? [] };
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
          this.emit({
            type: "bash_update",
            sessionId: this.identity.sessionId,
            command: command.command,
            ...(suffix.length > 0 ? { output: suffix } : {}),
            ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled }),
            ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
            ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
            ...(command.excludeFromContext === undefined ? {} : { excludeFromContext: command.excludeFromContext }),
          });
          if (result.cancelled) return this.failure("bash", makeRuntimeError("interrupted", "bash aborted", { retryable: true }));
          return { ok: true, type: "bash" };
        }
        case "navigate_tree": await this.driver.navigate(command.targetId); this.emitState(); return { ok: true, type: "navigate_tree" };
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
          const name = await this.driver.generateSessionTitle();
          this.emit({ type: "session_title", sessionId: this.identity.sessionId, name });
          return { ok: true, type: "generate_session_title" };
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
      isStreaming: state.isStreaming,
      isPromptRunning: this.promptRunning || state.isStreaming,
      isBashRunning: state.isBashRunning,
      isCompacting: state.isCompacting || this.compaction !== null,
      ...(this.bash === null ? {} : { bash: this.bash }),
      ...(this.compaction === null ? {} : { compaction: this.compaction }),
      autoCompactionEnabled: state.autoCompactionEnabled,
      autoRetryEnabled: state.autoRetryEnabled,
      model: state.model,
      messageCount: state.messages.length,
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
      case "agent_settled": this.emit({ type, sessionId }); return;
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
        this.emit({ type, sessionId, message });
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
        return;
      }
      case "auto_compaction_start": this.compaction = { reason: "auto", status: "running", startedAt: Date.now() }; this.emit({ type, sessionId }); return;
      case "auto_compaction_end": this.forwardedCompactionStartAt = null; this.compaction = null; this.emit({ type, sessionId, ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }) }); return;
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
    // Exact method correlation. The input command only carries input/editor, so
    // a mismatch rejects select/confirm/custom with structured invalid_input;
    // the request stays pending and usable (no SDK input call, no close).
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

  private emitState(): void { this.emit({ type: "runtime_state_changed", sessionId: this.identity.sessionId }); }
  private emit(event: RuntimeEvent): void { for (const listener of [...this.listeners]) listener(event); }
}
