/**
 * Reference agent runtime — a deterministic in-memory implementation of
 * {@link AgentRuntimePort} used by the contract suite.
 *
 * The reference runtime models the canonical semantics the suite asserts:
 * scripted streaming turns, tool execution with written files, queueing of
 * steer/follow-up, pending extension UI, compaction (manual + auto), fork
 * (new session + parent provenance + old runtime closed after the result),
 * zero-preserving usage, and structured/sanitized errors.
 */
import type {
  AgentMessage,
  AgentRuntimePort,
  AssistantMessage,
  AssistantContentBlock,
  CompactionProjection,
  ImageAttachment,
  ModelRef,
  ModelSelector,
  QueuedMessages,
  RuntimeCapabilitySet,
  RuntimeCloseReason,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeCommandType,
  RuntimeEvent,
  RuntimeError,
  RuntimeIdentity,
  RuntimeInterrupt,
  RuntimeInterruptResult,
  RuntimeSnapshot,
  RuntimeState,
  BashProjection,
  ThinkingLevel,
  ToolInfo,
  TokenUsage,
  UserMessage,
} from "@fffattiger/pi-web-runtime-core";
import {
  createCapabilitySet,
  emptyQueuedMessages,
  makeRuntimeError,
  requiredCapabilityForCommand,
  requiredCapabilityForInterrupt,
  unsupportedCapabilityError,
} from "@fffattiger/pi-web-runtime-core";
import type { ReferenceSessionStore, StoredSession } from "./store.js";

export const KNOWN_TOOLS = ["read", "write", "failing_tool"] as const;
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const STEP_MS = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingExtension {
  request: { id: string; method: "confirm" | "input"; title?: string; message?: string; placeholder?: string };
  settle: (result: { kind: "response"; command: RuntimeCommand } | { kind: "aborted" }) => void;
}

export interface ReferenceRuntimeOptions {
  store: ReferenceSessionStore;
  session: StoredSession;
  cwd: string;
  capabilities: RuntimeCapabilitySet;
  reloadCapabilities?: RuntimeCapabilitySet;
  model: ModelRef;
  resolveModel: (selector: ModelSelector) => ModelRef | null;
  initialTools?: readonly string[];
  initialThinkingLevel?: ThinkingLevel;
  initialThinkingLevelPinned?: boolean;
}

export class ReferenceAgentRuntime implements AgentRuntimePort {
  readonly identity: RuntimeIdentity;

  private store: ReferenceSessionStore;
  private cwd: string;
  private capabilities: RuntimeCapabilitySet;
  private reloadCapabilities: RuntimeCapabilitySet | undefined;
  private model: ModelRef;
  private resolveModel: (selector: ModelSelector) => ModelRef | null;
  private tools = new Map<string, boolean>(
    (["read", "write", "failing_tool"] as const).map((name) => [name, true]),
  );

  private thinkingLevel: ThinkingLevel = "off";
  private thinkingLevelPinned = false;
  private autoCompaction = false;
  private autoRetry = false;
  private systemPrompt = "You are a coding agent.";
  private queue: QueuedMessages = emptyQueuedMessages();
  private listeners = new Set<(event: RuntimeEvent) => void>();

  private status: "idle" | "prompt" | "bash" | "compacting" = "idle";
  private abortPrompt = false;
  private abortBash = false;
  private abortCompact = false;
  private pendingExtension: PendingExtension | null = null;
  private partialMessage: AssistantMessage | null = null;
  private bashProjection: BashProjection | null = null;
  private compactionProjection: CompactionProjection | null = null;
  private lastAssistantText = "";
  private turnSeq = 0;

  private closed = false;
  private closedReason: RuntimeCloseReason | null = null;

  private extensionStatuses = [
    { key: "model", text: "claude-sonnet-4" },
    { key: "branch", text: "main" },
  ];
  private extensionWidgets = [
    { key: "summary", lines: ["line1", "line2"], placement: "belowEditor" as const },
  ];

  constructor(options: ReferenceRuntimeOptions) {
    this.store = options.store;
    this.cwd = options.cwd;
    this.capabilities = options.capabilities;
    this.reloadCapabilities = options.reloadCapabilities;
    this.model = options.model;
    this.resolveModel = options.resolveModel;
    if (options.initialTools !== undefined) {
      for (const name of this.tools.keys()) {
        this.tools.set(name, options.initialTools.includes(name));
      }
      this.systemPrompt = options.initialTools.length === 0 ? "" : "You are a coding agent.";
    }
    this.thinkingLevel = options.initialThinkingLevel ?? "off";
    this.thinkingLevelPinned = options.initialThinkingLevelPinned ?? false;
    this.identity = {
      sessionId: options.session.sessionId,
      sessionFile: options.session.sessionFile,
      createdAt: options.session.createdAt,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Port surface                                                      */
  /* ---------------------------------------------------------------- */

  getCapabilities(): RuntimeCapabilitySet {
    return this.capabilities;
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    if (this.closed) {
      throw makeRuntimeError("unavailable", "runtime is closed");
    }
    const session = this.store.getSession(this.identity.sessionId);
    return {
      sessionId: this.identity.sessionId,
      state: this.buildState(),
      capabilities: this.capabilities,
      streaming:
        this.status === "prompt"
          ? {
              active: true,
              ...(this.partialMessage === null
                ? {}
                : { partialMessage: this.partialMessage }),
              phase: "streaming",
              toolCallIds: [],
            }
          : { active: false, phase: "idle" },
      messages: session ? session.entries.map((entry) => entry.message) : [],
    };
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (this.closed) {
      return {
        ok: false,
        type: command.type,
        error: makeRuntimeError("unavailable", "runtime is closed"),
      };
    }
    const capability = requiredCapabilityForCommand(command.type);
    if (capability && !this.capabilities.capabilities.includes(capability)) {
      return { ok: false, type: command.type, error: unsupportedCapabilityError(capability) };
    }
    switch (command.type) {
      case "prompt":
        return this.executePrompt(command);
      case "steer":
        return this.executeSteerOrFollowUp(command);
      case "follow_up":
        return this.executeSteerOrFollowUp(command);
      case "abort":
        this.abortPrompt = true;
        this.cancelPendingExtension();
        return { ok: true, type: "abort" };
      case "abort_bash":
        this.abortBash = true;
        return { ok: true, type: "abort_bash" };
      case "abort_compaction":
        this.abortCompact = true;
        if (this.compactionProjection) {
          this.compactionProjection = { ...this.compactionProjection, status: "aborting" };
        }
        return { ok: true, type: "abort_compaction" };
      case "clear_queue":
        this.queue = emptyQueuedMessages();
        this.emitQueueUpdate();
        return { ok: true, type: "clear_queue" };
      case "get_state":
        return { ok: true, type: "get_state", state: this.buildState() };
      case "set_model":
        return this.executeSetModel(command);
      case "set_thinking_level": {
        if (!THINKING_LEVELS.includes(command.level)) {
          return {
            ok: false,
            type: "set_thinking_level",
            error: makeRuntimeError("invalid_input", `unknown thinking level: ${command.level}`),
          };
        }
        this.thinkingLevel = command.level;
        this.thinkingLevelPinned = true;
        this.emitStateChanged();
        return { ok: true, type: "set_thinking_level" };
      }
      case "compact":
        return this.executeCompact(command);
      case "set_session_name":
        this.store.getSession(this.identity.sessionId)!.title = command.name;
        this.emitStateChanged();
        return { ok: true, type: "set_session_name" };
      case "get_session_stats": {
        const session = this.store.getSession(this.identity.sessionId)!;
        return {
          ok: true,
          type: "get_session_stats",
          stats: {
            messageCount: session.entries.length,
            pendingMessageCount:
              this.queue.steering.length + this.queue.followUp.length,
            tokenCount: session.entries.length * 100,
            contextUsage: {
              percent: Math.min(100, session.entries.length * 10),
              tokens: session.entries.length * 1000,
              contextWindow: 200000,
            },
          },
        };
      }
      case "get_last_assistant_text":
        return { ok: true, type: "get_last_assistant_text", text: this.lastAssistantText };
      case "set_auto_compaction":
        this.autoCompaction = command.enabled;
        this.emitStateChanged();
        return { ok: true, type: "set_auto_compaction" };
      case "get_tools":
        return { ok: true, type: "get_tools", tools: this.listTools() };
      case "get_commands":
        return {
          ok: true,
          type: "get_commands",
          commands: [
            { name: "compact", description: "Compact the conversation", source: "prompt" },
            { name: "clear", description: "Clear the queue", source: "prompt" },
            {
              name: "frontend-review",
              description: "Review frontend changes",
              source: "skill",
              sourceInfo: { skill: "frontend-review" },
            },
          ],
        };
      case "set_tools":
        return this.executeSetTools(command);
      case "reload": {
        const next = this.reloadCapabilities
          ? createCapabilitySet(
              this.reloadCapabilities.capabilities,
              this.capabilities.version + 1,
            )
          : { ...this.capabilities, version: this.capabilities.version + 1 };
        this.capabilities = next;
        this.emit({
          type: "runtime_capabilities_changed",
          sessionId: this.identity.sessionId,
          capabilities: next,
        });
        return { ok: true, type: "reload" };
      }
      case "extension_ui_response":
        return this.executeExtensionResponse(command);
      case "extension_ui_input":
        return this.executeExtensionResponse(command);
      case "set_auto_retry":
        this.autoRetry = command.enabled;
        this.emitStateChanged();
        return { ok: true, type: "set_auto_retry" };
      case "bash":
        return this.executeBash(command);
      case "fork":
        return this.executeFork(command);
      case "navigate_tree": {
        if (!command.targetId.trim()) {
          return {
            ok: false,
            type: "navigate_tree",
            error: makeRuntimeError("invalid_input", "targetId must not be empty"),
          };
        }
        this.store.setLeafId(this.identity.sessionId, command.targetId);
        this.emitStateChanged();
        return { ok: true, type: "navigate_tree" };
      }
      case "generate_session_title": {
        const name = `Title for ${this.identity.sessionId}`;
        this.store.getSession(this.identity.sessionId)!.title = name;
        this.emit({ type: "session_title", sessionId: this.identity.sessionId, name });
        return { ok: true, type: "generate_session_title" };
      }
      default: {
        const type = (command as { type: string }).type as RuntimeCommandType;
        return {
          ok: false,
          type,
          error: makeRuntimeError("invalid_command", `unknown command type: ${type}`),
        };
      }
    }
  }

  async interrupt(interrupt: RuntimeInterrupt): Promise<RuntimeInterruptResult> {
    if (this.closed) {
      return {
        ok: false,
        type: interrupt.type,
        error: makeRuntimeError("unavailable", "runtime is closed"),
      };
    }
    const capability = requiredCapabilityForInterrupt(interrupt.type);
    if (!this.capabilities.capabilities.includes(capability)) {
      return {
        ok: false,
        type: interrupt.type,
        error: unsupportedCapabilityError(capability),
      };
    }
    switch (interrupt.type) {
      case "abort":
        this.abortPrompt = true;
        this.cancelPendingExtension();
        break;
      case "abort_bash":
        this.abortBash = true;
        break;
      case "abort_compaction":
        this.abortCompact = true;
        if (this.compactionProjection) {
          this.compactionProjection = { ...this.compactionProjection, status: "aborting" };
        }
        break;
      case "clear_queue":
        this.queue = emptyQueuedMessages();
        this.emitQueueUpdate();
        break;
    }
    return { ok: true, type: interrupt.type };
  }

  async close(reason: RuntimeCloseReason): Promise<void> {
    this.shutdown(reason);
  }

  /* ---------------------------------------------------------------- */
  /* Command implementations                                           */
  /* ---------------------------------------------------------------- */

  private async executePrompt(
    command: Extract<RuntimeCommand, { type: "prompt" }>,
  ): Promise<RuntimeCommandResult> {
    if (this.status !== "idle") {
      return {
        ok: false,
        type: "prompt",
        error: makeRuntimeError("session_busy", "a turn is already running", { retryable: true }),
      };
    }
    if (command.message.includes("boom")) {
      const error = this.mapExternalError({
        message: "upstream failed: secret-token-abc123\n    at adapter (secret-token-abc123)",
        cause: { kind: "backend", detail: "sk-nested-secret" },
        details: { token: "secret-token-nested456", safe: true },
      });
      this.emit({
        type: "prompt_error",
        sessionId: this.identity.sessionId,
        errorMessage: error.message,
        error,
      });
      return { ok: false, type: "prompt", error };
    }
    this.turnSeq += 1;
    const outcome = await this.runTurn("prompt", command.message, command.images, true);
    if (outcome === "aborted") {
      this.emitAgentEndSettled();
      this.status = "idle";
      return {
        ok: false,
        type: "prompt",
        error: makeRuntimeError("interrupted", "prompt aborted", { retryable: true }),
      };
    }
    this.status = "idle";
    this.drainQueue();
    return { ok: true, type: "prompt" };
  }

  private async executeSteerOrFollowUp(
    command: Extract<RuntimeCommand, { type: "steer" | "follow_up" }>,
  ): Promise<RuntimeCommandResult> {
    if (this.status === "prompt") {
      const steering = [...this.queue.steering];
      const followUp = [...this.queue.followUp];
      const nextTurn = {
        message: command.message,
        ...(command.images === undefined ? {} : { images: command.images }),
      };
      this.queue =
        command.type === "steer"
          ? { steering: [...steering, nextTurn], followUp }
          : { steering, followUp: [...followUp, nextTurn] };
      this.emitQueueUpdate();
      return { ok: true, type: command.type };
    }
    if (this.status !== "idle") {
      return {
        ok: false,
        type: command.type,
        error: makeRuntimeError("session_busy", "runtime is busy", { retryable: true }),
      };
    }
    this.turnSeq += 1;
    const outcome = await this.runTurn(command.type, command.message, command.images, true);
    if (outcome === "aborted") {
      this.emitAgentEndSettled();
      this.status = "idle";
      return {
        ok: false,
        type: command.type,
        error: makeRuntimeError("interrupted", "turn aborted", { retryable: true }),
      };
    }
    this.status = "idle";
    this.drainQueue();
    return { ok: true, type: command.type };
  }

  private async executeSetModel(
    command: Extract<RuntimeCommand, { type: "set_model" }>,
  ): Promise<RuntimeCommandResult> {
    const resolved = this.resolveModel({ provider: command.provider, modelId: command.modelId });
    if (!resolved) {
      return {
        ok: false,
        type: "set_model",
        error: makeRuntimeError(
          "invalid_input",
          `unknown model: ${command.provider}/${command.modelId}`,
        ),
      };
    }
    this.model = resolved;
    const session = this.store.getSession(this.identity.sessionId);
    if (session) session.model = resolved;
    this.extensionStatuses = [
      { key: "model", text: resolved.id },
      { key: "branch", text: "main" },
    ];
    this.emitStateChanged();
    return { ok: true, type: "set_model" };
  }

  private executeSetTools(
    command: Extract<RuntimeCommand, { type: "set_tools" }>,
  ): RuntimeCommandResult {
    for (const name of command.toolNames) {
      if (!this.tools.has(name)) {
        return {
          ok: false,
          type: "set_tools",
          error: makeRuntimeError("invalid_input", `unknown tool: ${name}`),
        };
      }
    }
    for (const name of this.tools.keys()) {
      this.tools.set(name, command.toolNames.includes(name));
    }
    // D-019: all-tools-off means toolNames=[] AND an empty system prompt.
    this.systemPrompt = command.toolNames.length === 0 ? "" : "You are a coding agent.";
    this.emitStateChanged();
    return { ok: true, type: "set_tools" };
  }

  private async executeCompact(
    command: Extract<RuntimeCommand, { type: "compact" }>,
  ): Promise<RuntimeCommandResult> {
    if (this.status !== "idle") {
      return {
        ok: false,
        type: "compact",
        error: makeRuntimeError("session_busy", "runtime is busy", { retryable: true }),
      };
    }
    this.status = "compacting";
    this.abortCompact = false;
    this.compactionProjection = {
      reason: "manual",
      status: "running",
      ...(command.customInstructions === undefined
        ? {}
        : { customInstructions: command.customInstructions }),
      startedAt: Date.now(),
    };
    this.emit({ type: "compaction_start", sessionId: this.identity.sessionId, reason: "manual" });
    await delay(STEP_MS);
    await delay(STEP_MS);
    if (this.abortCompact) {
      this.emit({
        type: "compaction_end",
        sessionId: this.identity.sessionId,
        reason: "manual",
        aborted: true,
      });
      this.status = "idle";
      this.compactionProjection = null;
      this.emitStateChanged();
      return { ok: true, type: "compact" };
    }
    const entriesRemoved = this.store.trimEntries(this.identity.sessionId, 2);
    this.emit({
      type: "compaction_end",
      sessionId: this.identity.sessionId,
      reason: "manual",
      aborted: false,
      result: { entriesRemoved, customInstructions: command.customInstructions ?? null },
    });
    this.status = "idle";
    this.compactionProjection = null;
    this.emitStateChanged();
    return { ok: true, type: "compact" };
  }

  private async executeBash(
    command: Extract<RuntimeCommand, { type: "bash" }>,
  ): Promise<RuntimeCommandResult> {
    if (this.status !== "idle") {
      return {
        ok: false,
        type: "bash",
        error: makeRuntimeError("session_busy", "runtime is busy", { retryable: true }),
      };
    }
    this.status = "bash";
    this.abortBash = false;
    const sessionId = this.identity.sessionId;
    this.bashProjection = {
      command: command.command,
      output: "",
      excludeFromContext: command.excludeFromContext ?? false,
      truncated: false,
      cancelled: false,
      completed: false,
      updateCount: 1,
    };
    this.emit({ type: "bash_update", sessionId, command: command.command, output: "" });
    await delay(STEP_MS);
    this.bashProjection = { ...this.bashProjection, output: "line 1\n", updateCount: 2 };
    this.emit({ type: "bash_update", sessionId, command: command.command, output: "line 1\n" });
    await delay(STEP_MS);
    this.bashProjection = {
      ...this.bashProjection,
      output: "line 1\nline 2\n",
      updateCount: 3,
    };
    this.emit({
      type: "bash_update",
      sessionId,
      command: command.command,
      output: "line 1\nline 2\n",
    });
    await delay(STEP_MS);
    if (this.abortBash) {
      this.bashProjection = {
        ...this.bashProjection,
        cancelled: true,
        completed: true,
        updateCount: 4,
      };
      this.emit({
        type: "bash_update",
        sessionId,
        command: command.command,
        output: "line 1\nline 2\n",
        cancelled: true,
        truncated: false,
      });
      this.status = "idle";
      return {
        ok: false,
        type: "bash",
        error: makeRuntimeError("interrupted", "bash aborted", { retryable: true }),
      };
    }
    this.bashProjection = {
      ...this.bashProjection,
      exitCode: 0,
      completed: true,
      updateCount: 4,
    };
    this.emit({
      type: "bash_update",
      sessionId,
      command: command.command,
      output: "line 1\nline 2\n",
      exitCode: 0,
      truncated: false,
    });
    this.status = "idle";
    return { ok: true, type: "bash" };
  }

  private executeFork(
    command: Extract<RuntimeCommand, { type: "fork" }>,
  ): RuntimeCommandResult {
    if (this.status !== "idle") {
      return {
        ok: false,
        type: "fork",
        error: makeRuntimeError("session_busy", "runtime is busy", { retryable: true }),
      };
    }
    const session = this.store.getSession(this.identity.sessionId)!;
    const forkIndex = session.entries.findIndex((entry) => entry.entryId === command.entryId);
    if (forkIndex === -1) {
      return {
        ok: false,
        type: "fork",
        error: makeRuntimeError("invalid_input", `unknown fork point entry: ${command.entryId}`),
      };
    }
    const forkedEntries = session.entries.slice(0, forkIndex + 1);
    const forked = this.store.createSession({
      parentSessionId: session.sessionId,
      forkPointEntryId: command.entryId,
      leafId: command.entryId,
      entries: forkedEntries,
      writtenFiles: [...session.writtenFiles],
    });
    // D-018: the execute promise must settle before runtime_closed is observable.
    // A timer turn runs strictly after promise reactions queued by async callers.
    setTimeout(() => {
      this.shutdown("forked");
    }, 0);
    return {
      ok: true,
      type: "fork",
      forkedSessionId: forked.sessionId,
      forkPointEntryId: command.entryId,
    };
  }

  private executeExtensionResponse(
    command: Extract<RuntimeCommand, { type: "extension_ui_response" | "extension_ui_input" }>,
  ): RuntimeCommandResult {
    const pending = this.pendingExtension;
    if (!pending || pending.request.id !== command.id) {
      return {
        ok: false,
        type: command.type,
        error: makeRuntimeError("not_found", `no pending extension UI request: ${command.id}`),
      };
    }
    this.pendingExtension = null;
    pending.settle({ kind: "response", command });
    this.emitStateChanged();
    return { ok: true, type: command.type };
  }

  /* ---------------------------------------------------------------- */
  /* Turn machinery                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Runs one scripted agent turn. Returns "completed" or "aborted".
   * When `emitPromptDone` is false (queue drain), no prompt_done is emitted.
   */
  private async runTurn(
    kind: "prompt" | "steer" | "follow_up",
    message: string,
    images: readonly ImageAttachment[] | undefined,
    emitPromptDone: boolean,
  ): Promise<"completed" | "aborted"> {
    const sessionId = this.identity.sessionId;
    this.status = "prompt";
    this.abortPrompt = false;
    this.partialMessage = null;
    this.turnWrittenFiles = [];
    this.emit({ type: "agent_start", sessionId });

    const userMessage: UserMessage = {
      role: "user",
      content:
        images && images.length > 0
          ? [
              { type: "text", text: message },
              ...images.map((image) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: image.mimeType,
                  data: image.data,
                },
              })),
            ]
          : message,
      timestamp: Date.now(),
    };
    this.emit({ type: "message_start", sessionId, message: userMessage });
    this.store.appendEntry(sessionId, userMessage);

    if (message.includes("widget")) {
      this.emit({
        type: "extension_statuses",
        sessionId,
        statuses: this.extensionStatuses,
      });
      this.emit({
        type: "extension_widgets",
        sessionId,
        widgets: this.extensionWidgets,
      });
    }

    if (this.autoCompaction && message.includes("auto-compact")) {
      this.compactionProjection = {
        reason: "auto",
        status: "running",
        startedAt: Date.now(),
      };
      this.emit({ type: "auto_compaction_start", sessionId });
      await delay(STEP_MS);
      if (this.wasAborted()) {
        this.compactionProjection = null;
        return "aborted";
      }
      this.emit({
        type: "auto_compaction_end",
        sessionId,
        aborted: false,
        result: { reason: "auto", entriesRemoved: 0 },
      });
      this.compactionProjection = null;
    }

    if (this.autoRetry && message.includes("retry")) {
      this.emit({
        type: "auto_retry_start",
        sessionId,
        attempt: 1,
        maxAttempts: 2,
        errorMessage: "transient upstream error",
      });
      await delay(STEP_MS);
      if (this.wasAborted()) return "aborted";
      this.emit({ type: "auto_retry_end", sessionId, success: true });
    }

    if (message.includes("confirm")) {
      const extensionResult = await this.awaitExtension("confirm", {
        id: `ext-${this.turnSeq}-confirm`,
        method: "confirm",
        title: "Confirm",
        message: "Continue?",
      });
      if (extensionResult.aborted || this.wasAborted()) return "aborted";
    }

    let inputData = "";
    if (message.includes("input-request")) {
      const extensionResult = await this.awaitExtension("input", {
        id: `ext-${this.turnSeq}-input`,
        method: "input",
        title: "Enter value",
        placeholder: "value",
      });
      if (extensionResult.aborted || this.wasAborted()) return "aborted";
      inputData = extensionResult.data;
    }

    /* Assistant streaming */
    const base = {
      role: "assistant" as const,
      model: this.model.id,
      provider: this.model.provider,
    };
    const blocks: AssistantContentBlock[] = [];
    const partial = (): AssistantMessage => ({ ...base, content: [...blocks] });
    this.partialMessage = partial();
    this.emit({ type: "message_start", sessionId, message: this.partialMessage });
    await delay(STEP_MS);
    if (this.wasAborted()) return "aborted";

    if (this.thinkingLevel !== "off") {
      blocks.push({ type: "thinking", thinking: `Reasoning about: ${message}` });
      this.partialMessage = partial();
      this.emit({ type: "message_update", sessionId, message: this.partialMessage });
      await delay(STEP_MS);
      if (this.wasAborted()) return "aborted";
    }

    blocks.push({ type: "text", text: `Hello! I'm processing "${message}".` });
    this.partialMessage = partial();
    this.emit({ type: "message_update", sessionId, message: this.partialMessage });
    await delay(STEP_MS);
    if (this.wasAborted()) return "aborted";

    if (message.includes("long")) {
      for (let i = 0; i < 5; i += 1) {
        blocks.push({ type: "text", text: `Continuing step ${i + 1}.` });
        this.partialMessage = partial();
        this.emit({ type: "message_update", sessionId, message: this.partialMessage });
        await delay(STEP_MS);
        if (this.wasAborted()) return "aborted";
      }
    }

    /* Tool phase */
    if (message.includes("fail-tool") && this.tools.get("failing_tool")) {
      const toolCallId = `call-${this.turnSeq}-fail`;
      const toolName = "failing_tool";
      blocks.push({ type: "toolCall", toolCallId, toolName, input: { reason: "simulated failure" } });
      this.partialMessage = partial();
      this.emit({ type: "message_update", sessionId, message: this.partialMessage });
      await delay(STEP_MS);
      if (this.wasAborted()) return "aborted";
      this.emit({ type: "tool_execution_start", sessionId, toolCallId, toolName, args: { reason: "simulated failure" } });
      await delay(STEP_MS);
      this.emit({ type: "tool_execution_update", sessionId, toolCallId, toolName, partialResult: { status: "running" } });
      await delay(STEP_MS);
      this.emit({
        type: "tool_execution_end",
        sessionId,
        toolCallId,
        toolName,
        isError: true,
        result: { content: [{ type: "text", text: "tool failed" }] },
      });
      const toolResult: AgentMessage = {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "tool failed" }],
        isError: true,
        timestamp: Date.now(),
      };
      this.emit({ type: "message_start", sessionId, message: { role: "toolResult", toolCallId, toolName } });
      this.emit({ type: "message_end", sessionId, message: toolResult });
      this.store.appendEntry(sessionId, toolResult);
      await delay(STEP_MS);
      if (this.wasAborted()) return "aborted";
    } else if (this.tools.get("write") && !message.includes("no-write")) {
      const path = `${this.cwd}/notes-${this.turnSeq}.md`;
      const toolCallId = `call-${this.turnSeq}-write`;
      const toolName = "write";
      blocks.push({ type: "toolCall", toolCallId, toolName, input: { path, content: "hello" } });
      this.partialMessage = partial();
      this.emit({ type: "message_update", sessionId, message: this.partialMessage });
      await delay(STEP_MS);
      if (this.wasAborted()) return "aborted";
      this.emit({
        type: "tool_execution_start",
        sessionId,
        toolCallId,
        toolName,
        args: { path, content: "hello" },
      });
      await delay(STEP_MS);
      this.emit({ type: "tool_execution_update", sessionId, toolCallId, toolName, partialResult: { path } });
      await delay(STEP_MS);
      this.store.addWrittenFiles(sessionId, [path]);
      this.turnWrittenFiles.push(path);
      this.emit({
        type: "tool_execution_end",
        sessionId,
        toolCallId,
        toolName,
        isError: false,
        result: { ok: true, path },
        writtenFiles: [path],
      });
      const toolResult: AgentMessage = {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: `Wrote ${path}` }],
        isError: false,
        timestamp: Date.now(),
      };
      this.emit({ type: "message_start", sessionId, message: { role: "toolResult", toolCallId, toolName } });
      this.emit({ type: "message_end", sessionId, message: toolResult });
      this.store.appendEntry(sessionId, toolResult);
      await delay(STEP_MS);
      if (this.wasAborted()) return "aborted";
    }

    /* Final assistant message */
    const finalText = `Done processing "${message}".${inputData ? ` input=${inputData}` : ""}`;
    blocks.push({ type: "text", text: finalText });
    this.partialMessage = partial();
    this.emit({ type: "message_update", sessionId, message: this.partialMessage });
    await delay(STEP_MS);
    if (this.wasAborted()) return "aborted";

    const usage = this.usageFor(message);
    const assistantMessage: AssistantMessage = {
      ...base,
      content: blocks,
      stopReason: "end_turn",
      timestamp: Date.now(),
      usage,
      ...(this.turnWrittenFiles.length > 0
        ? { writtenFiles: [...this.turnWrittenFiles] }
        : {}),
    };
    this.turnWrittenFiles = [];
    this.partialMessage = null;
    this.emit({ type: "message_end", sessionId, message: assistantMessage });
    this.store.appendEntry(sessionId, assistantMessage);
    this.lastAssistantText = finalText;
    this.emit({ type: "agent_end", sessionId });
    this.emit({ type: "agent_settled", sessionId });
    if (emitPromptDone) {
      this.emit({ type: "prompt_done", sessionId });
    }
    return "completed";
  }

  private turnWrittenFiles: string[] = [];

  private async awaitExtension(
    method: "confirm" | "input",
    request: { id: string; method: "confirm" | "input"; title?: string; message?: string; placeholder?: string },
  ): Promise<{ aborted: boolean; data: string }> {
    const sessionId = this.identity.sessionId;
    this.emit({ type: "extension_ui_request", sessionId, request });
    return new Promise((resolve) => {
      this.pendingExtension = {
        request,
        settle: (result) => {
          if (result.kind === "aborted") {
            resolve({ aborted: true, data: "" });
            return;
          }
          resolve({
            aborted: false,
            data:
              result.command.type === "extension_ui_input"
                ? result.command.data
                : "",
          });
        },
      };
    });
  }

  private cancelPendingExtension(): void {
    const pending = this.pendingExtension;
    if (!pending) return;
    this.pendingExtension = null;
    pending.settle({ kind: "aborted" });
    this.emitStateChanged();
  }

  private usageFor(message: string): TokenUsage {
    if (message.includes("zero-usage")) {
      return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
    return {
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  private mapExternalError(error: unknown): RuntimeError {
    const record =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : {};
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof record.message === "string"
          ? record.message
          : String(error);
    const sanitize = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value
          .replace(/secret-token-[a-z0-9]+/gi, "[REDACTED]")
          .replace(/sk-[A-Za-z0-9_-]+/gi, "[REDACTED]")
          .split("\n")[0] ?? "";
      }
      if (Array.isArray(value)) return value.map(sanitize);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [key, sanitize(nested)]),
        );
      }
      return value;
    };
    const sanitizedMessage = String(sanitize(rawMessage));
    const sanitizedCause = sanitize(record.cause) as
      | { kind?: string; detail?: string }
      | undefined;
    return makeRuntimeError("external", sanitizedMessage, {
      retryable: false,
      cause: {
        kind: "backend",
        ...(typeof sanitizedCause?.detail === "string"
          ? { detail: sanitizedCause.detail }
          : { detail: "mapped by reference adapter" }),
      },
      details: sanitize(record.details ?? { sanitized: true }),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  private wasAborted(): boolean {
    return this.abortPrompt || this.closed;
  }

  private emitAgentEndSettled(): void {
    const sessionId = this.identity.sessionId;
    this.emit({ type: "agent_end", sessionId });
    this.emit({ type: "agent_settled", sessionId });
  }

  private drainQueue(): void {
    void this.runNextQueued();
  }

  private popQueued(): { kind: "steer" | "follow_up"; message: string; images?: readonly ImageAttachment[] } | null {
    if (this.queue.steering.length > 0) {
      const [turn, ...rest] = this.queue.steering;
      this.queue = { ...this.queue, steering: rest };
      this.emitQueueUpdate();
      return turn ? { kind: "steer", ...turn } : null;
    }
    if (this.queue.followUp.length > 0) {
      const [turn, ...rest] = this.queue.followUp;
      this.queue = { ...this.queue, followUp: rest };
      this.emitQueueUpdate();
      return turn ? { kind: "follow_up", ...turn } : null;
    }
    return null;
  }

  private async runNextQueued(): Promise<void> {
    if (this.closed || this.status !== "idle") return;
    const next = this.popQueued();
    if (!next) return;
    this.turnSeq += 1;
    const outcome = await this.runTurn(next.kind, next.message, next.images, false);
    if (outcome === "aborted") {
      this.emitAgentEndSettled();
      this.status = "idle";
      return;
    }
    this.status = "idle";
    void this.runNextQueued();
  }

  private emitQueueUpdate(): void {
    this.emit({
      type: "queue_update",
      sessionId: this.identity.sessionId,
      steering: this.queue.steering.map((turn) => ({ ...turn })),
      followUp: this.queue.followUp.map((turn) => ({ ...turn })),
    });
  }

  private emitStateChanged(): void {
    this.emit({ type: "runtime_state_changed", sessionId: this.identity.sessionId });
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private shutdown(reason: RuntimeCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    this.status = "idle";
    this.cancelPendingExtension();
    this.partialMessage = null;
    this.compactionProjection = null;
    this.store.recordClose(this.identity.sessionId, reason);
    this.emit({ type: "runtime_closed", sessionId: this.identity.sessionId, reason });
  }

  private listTools(): ToolInfo[] {
    return (["read", "write", "failing_tool"] as const).map((name) => ({
      name,
      active: this.tools.get(name) ?? false,
    }));
  }

  private buildState(): RuntimeState {
    const session = this.store.getSession(this.identity.sessionId);
    return {
      sessionId: this.identity.sessionId,
      sessionFile: this.identity.sessionFile,
      ...(session?.leafId === undefined ? {} : { leafId: session.leafId }),
      isStreaming: this.status === "prompt",
      isPromptRunning: this.status === "prompt",
      isBashRunning: this.status === "bash",
      isCompacting: this.compactionProjection !== null,
      autoCompactionEnabled: this.autoCompaction,
      autoRetryEnabled: this.autoRetry,
      model: this.model,
      messageCount: session?.entries.length ?? 0,
      pendingMessageCount:
        this.queue.steering.length + this.queue.followUp.length,
      queuedMessages: {
        steering: this.queue.steering.map((turn) => ({ ...turn })),
        followUp: this.queue.followUp.map((turn) => ({ ...turn })),
      },
      contextUsage: {
        percent: Math.min(100, (session?.entries.length ?? 0) * 10),
        tokens: (session?.entries.length ?? 0) * 1000,
        contextWindow: 200000,
      },
      systemPrompt: this.systemPrompt,
      thinkingLevel: this.thinkingLevel,
      thinkingLevelPinned: this.thinkingLevelPinned,
      ...(this.bashProjection ? { bash: { ...this.bashProjection } } : {}),
      ...(this.compactionProjection
        ? { compaction: { ...this.compactionProjection } }
        : {}),
      tools: this.listTools(),
      extensionStatuses: this.extensionStatuses,
      extensionWidgets: this.extensionWidgets,
      pendingExtensionUi: this.pendingExtension ? [this.pendingExtension.request] : [],
      ...(session?.title === undefined ? {} : { sessionName: session.title }),
      writtenFiles: session ? [...session.writtenFiles] : [],
    };
  }
}
