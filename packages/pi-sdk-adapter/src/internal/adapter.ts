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
import type { DriverUiRequest, PiRuntimeDriver } from "./types.js";

const COMMAND_TYPES = new Set<string>(RUNTIME_COMMAND_TYPES);

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
        case "compact":
          this.compaction = {
            reason: "manual",
            status: "running",
            ...(command.customInstructions === undefined
              ? {}
              : { customInstructions: command.customInstructions }),
            startedAt: Date.now(),
          };
          await this.driver.compact(command.customInstructions);
          return { ok: true, type: "compact" };
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
        case "set_tools": this.driver.setTools(command.toolNames, command.includeExtensionTools !== false); this.emitState(); return { ok: true, type: "set_tools" };
        case "reload": {
          this.clearToolCorrelations();
          const capabilities = await this.driver.reload();
          await this.reapplyPinnedThinking();
          this.capabilities = createCapabilitySet(capabilities, this.capabilities.version + 1);
          this.emit({ type: "runtime_capabilities_changed", sessionId: this.identity.sessionId, capabilities: this.capabilities });
          return { ok: true, type: "reload" };
        }
        case "extension_ui_response": return this.resolveUi(command);
        case "extension_ui_input": return this.inputUi(command.id, command.data);
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
          const forked = await this.driver.fork(command.entryId);
          setTimeout(() => void this.close("forked"), 0);
          return { ok: true, type: "fork", forkedSessionId: forked.sessionId, forkPointEntryId: command.entryId };
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
    for (const pending of this.pendingUi.values()) pending.driver.cancel();
    this.pendingUi.clear();
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
          this.emit({ type, sessionId, reason: "manual" });
        } else {
          this.emit({ type: "auto_compaction_start", sessionId });
        }
        return;
      }
      case "compaction_end": {
        const isManual = raw.reason === "manual";
        this.compaction = null;
        if (isManual) {
          this.emit({ type, sessionId, reason: "manual", ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }), ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}) });
        } else {
          this.emit({ type: "auto_compaction_end", sessionId, ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }), ...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}) });
        }
        return;
      }
      case "auto_compaction_start": this.compaction = { reason: "auto", status: "running", startedAt: Date.now() }; this.emit({ type, sessionId }); return;
      case "auto_compaction_end": this.compaction = null; this.emit({ type, sessionId, ...(typeof raw.aborted === "boolean" ? { aborted: raw.aborted } : {}), ...(raw.result === undefined ? {} : { result: raw.result }) }); return;
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
    driver.onSettled(() => this.finishUiRequest(driver.id));
    this.emit({ type: "extension_ui_request", sessionId: this.identity.sessionId, request });
    this.emitState();
  }

  private resolveUi(command: Extract<RuntimeCommand, { type: "extension_ui_response" }>): RuntimeCommandResult {
    const pending = this.pendingUi.get(command.id);
    if (!pending) return this.failure(command.type, makeRuntimeError("not_found", `no pending extension UI request: ${command.id}`));
    if ("value" in command) pending.driver.settle({ value: command.value });
    else if ("confirmed" in command) pending.driver.settle({ confirmed: command.confirmed });
    else pending.driver.settle({ cancelled: true });
    return { ok: true, type: command.type };
  }

  private inputUi(id: string, data: string): RuntimeCommandResult {
    const pending = this.pendingUi.get(id);
    if (!pending || !pending.driver.input) return this.failure("extension_ui_input", makeRuntimeError("not_found", `no pending extension UI input: ${id}`));
    if (pending.request.method === "select" || pending.request.method === "confirm") {
      return this.failure("extension_ui_input", makeRuntimeError("invalid_input", `${pending.request.method} does not accept extension input`));
    }
    pending.driver.input(data);
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

  private finishUiRequest(id: string): void {
    if (!this.pendingUi.delete(id)) return;
    this.emitState();
  }

  private cancelPendingUi(): void {
    for (const pending of this.pendingUi.values()) pending.driver.cancel();
    if (this.pendingUi.size > 0) {
      this.pendingUi.clear();
      this.emitState();
    }
  }

  private failure(type: RuntimeCommandType, error: ReturnType<typeof makeRuntimeError>): RuntimeCommandResult {
    return { ok: false, type, error };
  }

  private emitState(): void { this.emit({ type: "runtime_state_changed", sessionId: this.identity.sessionId }); }
  private emit(event: RuntimeEvent): void { for (const listener of [...this.listeners]) listener(event); }
}
