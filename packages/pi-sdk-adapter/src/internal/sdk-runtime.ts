import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type {
  BuiltInRuntimeState,
  ImageAttachment,
  ModelRef,
  RuntimeCapability,
  RuntimeCloseReason,
  RuntimeStartInput,
  SlashCommandInfo,
  SubagentProjection,
  ThinkingLevel,
  TodoProjection,
  ToolInfo,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError, RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { redactText } from "./sanitize.js";
import { createPiSdkSessionStore } from "./session-store.js";
import { readGlobalToolsPreference } from "./settings-config-store.js";
import { estimateSdkBranchContextTokens, type SdkContextMessage } from "./context-tokens.js";
import { generateSessionTitle as generateSessionTitleForSession } from "./session-title.js";
import { readBuiltInCapabilityConfigSync } from "./built-in-capability-store.js";
import {
  buildBuiltInRuntimeState,
  capabilitiesWithLoadedTokens,
  cloneBuiltIns,
  detectLoadedBuiltIns,
} from "./built-in-detection.js";
import { resourceLoaderOptionsForBuiltIns } from "./curated-plugins.js";
import {
  cloneSubagents,
  isSubagentRefreshEvent,
  nextSubagentProjection,
  projectSubagentStreamEvent,
  readSubagentObservation,
  type SubagentObservation,
} from "./subagent-projection.js";
import { SubagentArtifactObserver } from "./subagent-observer.js";
import {
  cloneTodo,
  isTodoReplayEvent,
  nextTodoProjection,
  todoItemsFromBranch,
  todoItemsFromToolEnd,
} from "./todo-projection.js";
import { createSideChatController, type FileActivityTracker, type SideChatController } from "./vendor/pi-side-chat/index.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  hasTrustRequiringProjectResources,
  initTheme,
  ModelRuntime,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionUIContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  DriverContextState,
  DriverEventListener,
  DriverFactoryOptions,
  DriverState,
  DriverUiRequest,
  InitializationTraceSink,
  PiRuntimeDriver,
  PiRuntimeDriverFactory,
  PromptDisposition,
  QueuedInputDisposition,
} from "./types.js";

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

/**
 * Extension/resource tools that activate on registration (SDK semantics):
 * declarable exposure (`direct`/`model-only`) and not `defaultActive:false`.
 * Tools the SDK registers inactive on purpose — codemode, tool_search, and
 * MCP tools with codemode/deferred exposure — are only activated by naming
 * them explicitly (defaultTools/setTools), never by the adapter's implicit
 * include-extension-tools union.
 */
function registrationActivatedToolNames(session: AgentSession): string[] {
  return session.getAllTools()
    .filter((tool) => !BUILTIN_TOOL_NAMES.has(tool.name))
    .filter((tool) =>
      (tool.exposure === "direct" || tool.exposure === "model-only")
      && session.getToolDefinition(tool.name)?.defaultActive !== false)
    .map((tool) => tool.name);
}

interface ToolPolicyState {
  forcedEmpty: boolean;
}

function createToolPolicyExtension(policy: ToolPolicyState) {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", () => policy.forcedEmpty ? { systemPrompt: "" } : undefined);
  };
}

function images(value: readonly ImageAttachment[] | undefined): ImageContent[] | undefined {
  return value?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

/**
 * Estimate the runtime's selected SessionManager branch using the same SDK
 * arithmetic as the history reader. The manager is the runtime's in-memory
 * session tree, not a fresh disk read; an intentional navigation may differ
 * from the persisted catalog head. Missing windows and post-compaction usage
 * remain unknown.
 */
export function contextUsageFromSession(session: AgentSession):
  | { percent: number | null; contextWindow: number; tokens: number | null }
  | undefined {
  const contextWindow = session.getContextUsage()?.contextWindow ?? 0;
  if (contextWindow <= 0) return undefined;
  const tokens = estimateSdkBranchContextTokens(
    session.sessionManager.getBranch(),
    session.sessionManager.buildSessionContext().messages as SdkContextMessage[],
  );
  return tokens === null
    ? { percent: null, contextWindow, tokens: null }
    : { percent: (tokens / contextWindow) * 100, contextWindow, tokens };
}

function toolsView(session: AgentSession): ToolInfo[] {
  const active = new Set(session.getActiveToolNames());
  // Picker surface: only tools the user can directly turn on/off for the
  // model — `direct` and `model-only` exposure. `hidden`, `codemode` and
  // `deferred` tools (e.g. codemode-exposure MCP tools) are callable through
  // ctx.executeTool without being active, so their active flag is not an ACL
  // switch and they must not appear as on/off rows.
  return session.getAllTools()
    .filter((tool) => tool.exposure === "direct" || tool.exposure === "model-only")
    .map((tool): ToolInfo => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), active: active.has(tool.name) }));
}

/**
 * Names the global tool selection may enable: every registered tool with
 * `direct` or `model-only` exposure (the SDK defaults an omitted exposure to
 * `direct`). Tools withheld by the `extensions` `-builtin:` gating are never
 * in the registry, so the selection never crosses that gate.
 */
export function selectableToolNames(session: AgentSession): string[] {
  return session.getAllTools()
    .filter((tool) => tool.exposure === "direct" || tool.exposure === "model-only")
    .map((tool) => tool.name);
}

/** Runtime form of the persisted global tool selection. */
export type RuntimeToolsSelection =
  | { mode: "all" }
  | { mode: "custom"; toolNames: readonly string[] }
  | { mode: "native" };

/**
 * Apply one tool selection to a live session.
 *
 * - `all`: activate every selectable registered tool (codemode/tool_search
 *   included once their extensions register).
 * - `custom`: activate the intersection with the selectable registry; saved
 *   names that are currently unavailable stay persisted, they just do not
 *   apply. An empty result keeps the registry intact with nothing active.
 * - `native`: the SDK's own `defaultTools`-driven active set (including `+`/`-`
 *   modifiers and registration activation) stays authoritative — pix adds
 *   nothing and removes nothing.
 *
 * The forced-empty system-prompt policy follows the APPLIED set in every mode.
 */
export function applyToolsSelection(
  session: AgentSession,
  selection: RuntimeToolsSelection,
  policy: ToolPolicyState,
): void {
  if (selection.mode === "native") {
    policy.forcedEmpty = session.getActiveToolNames().length === 0;
    return;
  }
  const selectable = new Set(selectableToolNames(session));
  const names = selection.mode === "all"
    ? [...selectable]
    : selection.toolNames.filter((name) => selectable.has(name));
  policy.forcedEmpty = names.length === 0;
  session.setActiveToolsByName(names);
}

/**
 * Resolve + apply the CURRENT global tool selection (pix `pixDefaultTools`
 * first; absent key falls back to the effective native `defaultTools` of the
 * session's own settings manager; neither key means Pix defaults to all).
 * Used at startup, after bindExtensions and after a successful SDK reload —
 * only for runtimes that FOLLOW the global preference (no explicit
 * `input.toolNames` and no runtime `setTools` override).
 */
export async function applyGlobalToolsSelection(
  session: AgentSession,
  policy: ToolPolicyState,
  agentDir: string,
): Promise<void> {
  const preference = await readGlobalToolsPreference(agentDir);
  const selection: RuntimeToolsSelection = preference.mode === "unset"
    ? (session.settingsManager.getDefaultTools() === undefined ? { mode: "all" } : { mode: "native" })
    : preference;
  applyToolsSelection(session, selection, policy);
}

function commandsView(session: AgentSession): SlashCommandInfo[] {
  return [
    ...session.extensionRunner.getRegisteredCommands().map((command) => ({ name: command.invocationName, ...(command.description === undefined ? {} : { description: command.description }), source: "extension" as const, sourceInfo: command.sourceInfo })),
    ...session.promptTemplates.map((prompt) => ({ name: prompt.name, ...(prompt.description === undefined ? {} : { description: prompt.description }), source: "prompt" as const, sourceInfo: prompt.sourceInfo })),
    ...session.resourceLoader.getSkills().skills.map((skill) => ({ name: `skill:${skill.name}`, ...(skill.description === undefined ? {} : { description: skill.description }), source: "skill" as const, sourceInfo: skill.sourceInfo })),
  ];
}

function sessionStatsView(session: AgentSession, usage: ReturnType<typeof contextUsageFromSession>): NonNullable<DriverState["sessionStats"]> {
  const stats = session.getSessionStats();
  const contextUsageView = usage === undefined
    ? undefined
    : usage.percent === null
      ? null
      : { percent: usage.percent, contextWindow: usage.contextWindow, ...(usage.tokens === null ? {} : { tokens: usage.tokens }) };
  return {
    messageCount: stats.totalMessages,
    pendingMessageCount: session.pendingMessageCount,
    tokenCount: stats.tokens.total,
    ...(contextUsageView === undefined || contextUsageView === null ? {} : { contextUsage: contextUsageView }),
  };
}

function driverState(
  session: AgentSession,
  forcedEmpty: boolean,
  usage: ReturnType<typeof contextUsageFromSession>,
  projections: { builtIns?: BuiltInRuntimeState; subagents?: SubagentProjection; todo?: TodoProjection },
): DriverState {
  const model = session.model;
  const stats = session.getSessionStats();
  const leafId = session.sessionManager.getLeafId();
  const contextUsageView = usage === undefined
    ? undefined
    : usage.percent === null
      ? null
      : { percent: usage.percent, contextWindow: usage.contextWindow, ...(usage.tokens === null ? {} : { tokens: usage.tokens }) };
  return {
    model: model ? { provider: model.provider, id: model.id } : null,
    thinkingLevel: session.thinkingLevel as ThinkingLevel,
    systemPrompt: forcedEmpty ? "" : session.systemPrompt,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isBashRunning: session.isBashRunning,
    autoCompactionEnabled: session.autoCompactionEnabled,
    autoRetryEnabled: session.autoRetryEnabled,
    pendingMessageCount: session.pendingMessageCount,
    ...(leafId === null || leafId === undefined ? {} : { leafId }),
    messageCount: stats.totalMessages,
    tools: toolsView(session),
    ...(contextUsageView === undefined ? {} : { contextUsage: contextUsageView }),
    steering: session.getSteeringMessages().map((message) => ({ message })),
    followUp: session.getFollowUpMessages().map((message) => ({ message })),
    sessionStats: sessionStatsView(session, usage),
    lastAssistantText: session.getLastAssistantText() ?? "",
    commands: commandsView(session),
    ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
    ...(projections.builtIns === undefined ? {} : { builtIns: cloneBuiltIns(projections.builtIns) }),
    ...(projections.subagents === undefined ? {} : { subagents: cloneSubagents(projections.subagents) }),
    ...(projections.todo === undefined ? {} : { todo: cloneTodo(projections.todo) }),
  };
}

class SdkRuntimeDriver implements PiRuntimeDriver {
  readonly identity;
  private currentCapabilities: readonly RuntimeCapability[];
  private uiRequest: ((request: DriverUiRequest) => void) | undefined;
  private emitCanonical: ((event: never) => void) | undefined;
  private activeUiCancels = new Set<() => void>();
  private bashChunks: ((chunk: string) => void) | undefined;
  private readonly listeners = new Set<DriverEventListener>();
  private readonly unsubscribeSession: () => void;
  private rawFanoutDepth = 0;
  private publishingProjection = false;
  private readonly pendingProjections = new Map<string, { type: string; [key: string]: unknown }>();
  private closed = false;
  private builtIns: BuiltInRuntimeState | undefined;
  private subagents: SubagentProjection | undefined;
  private subagentChildSignatures: readonly string[] | undefined;
  private subagentObserver: SubagentArtifactObserver | undefined;
  private subagentStreamGeneration = 0;
  private todo: TodoProjection | undefined;

  constructor(
    private readonly session: AgentSession,
    private readonly baseCapabilities: readonly RuntimeCapability[],
    private readonly reloadCapabilities: readonly RuntimeCapability[] | undefined,
    private readonly toolPolicy: ToolPolicyState,
    private readonly agentDir: string,
    private configuredTools?: { toolNames: readonly string[]; includeExtensionTools: boolean },
    private readonly trace?: InitializationTraceSink,
  ) {
    this.identity = {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
      cwd: session.sessionManager.getCwd(),
    };
    this.currentCapabilities = this.recomputeProjections(this.baseCapabilities);
    this.unsubscribeSession = this.session.subscribe((event) => this.handleSessionEvent(event));
    this.installSubagentStreamBridge();
  }

  get capabilities(): readonly RuntimeCapability[] { return this.currentCapabilities; }

  getState(): DriverState {
    if (!this.closed && !this.publishingProjection && this.builtIns?.loaded.includes("subagents")) {
      this.subagentObserver?.refresh(true);
    }
    return driverState(this.session, this.toolPolicy.forcedEmpty, this.contextUsage(), {
      ...(this.builtIns === undefined ? {} : { builtIns: this.builtIns }),
      ...(this.subagents === undefined ? {} : { subagents: this.subagents }),
      ...(this.todo === undefined ? {} : { todo: this.todo }),
    });
  }

  /**
   * Narrow read-lane accessors (Phase 2B). Each returns ONLY the requested
   * projection — a get_tools / get_commands read never pays for the monolithic
   * {@link getState} (O(all entries) via session stats). One source of truth
   * with {@link driverState} (shared view helpers).
   */
  getTools(): readonly ToolInfo[] { return toolsView(this.session); }
  getCommands(): readonly SlashCommandInfo[] { return commandsView(this.session); }
  getSessionStats(): DriverState["sessionStats"] { return sessionStatsView(this.session, this.contextUsage()); }
  getLastAssistantText(): string { return this.session.getLastAssistantText() ?? ""; }

  /**
   * Cached selected-branch context NUMERATOR. Recomputed only when the branch
   * identity (committed leaf id + entry count) changed, so a snapshot flood
   * never re-flattens the session per call (the state pipeline is already
   * O(entries) via getSessionStats). The window/percent are deliberately NOT
   * cached: they derive from the CURRENT session model on every call, so a
   * `set_model` window change can never keep a stale denominator for the
   * same leaf.
   */
  private usageCacheKey: string | null = null;
  private usageCacheTokens: number | null | undefined = undefined;
  private branchContextTokens(): number | null {
    const manager = this.session.sessionManager;
    const key = `${manager.getLeafId() ?? "root"}:${manager.getEntries().length}`;
    if (key !== this.usageCacheKey || this.usageCacheTokens === undefined) {
      this.usageCacheKey = key;
      this.usageCacheTokens = estimateSdkBranchContextTokens(
        manager.getBranch(),
        manager.buildSessionContext().messages as SdkContextMessage[],
      );
    }
    return this.usageCacheTokens;
  }
  private contextUsage(): ReturnType<typeof contextUsageFromSession> {
    // The SDK resolves virtual selections to the last physical response's limits.
    const contextWindow = this.session.getContextUsage()?.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;
    const tokens = this.branchContextTokens();
    return tokens === null
      ? { percent: null, contextWindow, tokens: null }
      : { percent: (tokens / contextWindow) * 100, contextWindow, tokens };
  }

  /**
   * Narrow coherent context read (context-usage consistency): ONE accessor
   * capturing the model identity, the committed branch leaf, and the current
   * context usage TOGETHER, so a `runtime_state_changed` payload can never mix
   * fields read at different points in time. `contextUsage` is `null` when the
   * current window/estimate is unknown — a model switch or a post-compaction
   * branch CLEARS any stale prior value instead of reusing it. Avoids the
   * monolithic `getState` (tools/commands/full stats) per published event.
   */
  getContextState(): DriverContextState {
    const model = this.session.model;
    const usage = this.contextUsage();
    return {
      model: model ? { provider: model.provider, id: model.id } : null,
      leafId: this.session.sessionManager.getLeafId(),
      contextUsage: usage === undefined || usage.percent === null || usage.tokens === null
        ? null
        : { percent: usage.percent, contextWindow: usage.contextWindow, tokens: usage.tokens },
    };
  }

  subscribe(listener: DriverEventListener): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    if (this.closed) return;
    this.rawFanoutDepth += 1;
    try {
      if (event.type === "bash_execution_update") this.bashChunks?.(event.delta);
      const rawListeners = [...this.listeners];
      for (const listener of rawListeners) {
        if (this.closed) return;
        if (this.listeners.has(listener)) listener(event);
      }
      if (!this.closed) this.refreshProjectionsFromEvent(event);
    } finally {
      this.rawFanoutDepth -= 1;
      this.flushProjections();
    }
  }

  private recomputeProjections(capabilityBase: readonly RuntimeCapability[]): RuntimeCapability[] {
    const config = readBuiltInCapabilityConfigSync(this.agentDir);
    const detected = new Set(detectLoadedBuiltIns({
      tools: this.session.getAllTools(),
      commands: this.session.extensionRunner.getRegisteredCommands().map((command) => ({ name: command.invocationName })),
    }));
    if (this.session.model !== undefined && this.session.model !== null) detected.add("side_chat");
    this.builtIns = buildBuiltInRuntimeState({ config, loaded: detected });
    const loaded = new Set(this.builtIns.loaded);
    if (loaded.has("subagents")) {
      if (this.subagentObserver === undefined) {
        const observer = new SubagentArtifactObserver({
          read: () => readSubagentObservation({
            agentDir: this.agentDir,
            parentSessionId: this.session.sessionId,
            parentSessionFile: this.session.sessionFile ?? "",
          }),
          onObservation: (observation, publish) => this.applySubagentObservation(observation, publish),
          onError: () => this.publishSubagentObserverError(),
        });
        this.subagentObserver = observer;
        observer.start(false);
      } else {
        this.subagentObserver.refresh(false);
      }
      this.installSubagentStreamBridge();
    } else {
      this.subagentObserver?.close();
      this.subagentObserver = undefined;
      this.subagentChildSignatures = undefined;
      this.subagents = nextSubagentProjection(this.subagents, []).projection;
      this.uninstallSubagentStreamBridge();
    }
    this.todo = nextTodoProjection(
      this.todo,
      loaded.has("todo") ? todoItemsFromBranch(this.session.sessionManager.getBranch()) : [],
    ).projection;
    return capabilitiesWithLoadedTokens(capabilityBase, loaded);
  }

  private applySubagentObservation(observation: SubagentObservation, publish: boolean): void {
    const contentChanged = this.subagentChildSignatures !== undefined
      && JSON.stringify(this.subagentChildSignatures) !== JSON.stringify(observation.childSignatures);
    const next = nextSubagentProjection(this.subagents, observation.tasks, { contentChanged });
    this.subagentChildSignatures = [...observation.childSignatures];
    if (!next.changed) return;
    this.subagents = next.projection;
    if (publish) this.publishToListeners({ type: "subagents_changed", subagents: cloneSubagents(next.projection) });
  }

  private publishToListeners(event: { type: string; [key: string]: unknown }): void {
    if (this.closed) return;
    // Full-replacement projections coalesce by type. Transient child streams
    // coalesce per childSessionId so concurrent children do not clobber each other.
    const key = event.type === "subagent_delta" && typeof event.childSessionId === "string"
      ? `subagent_delta:${event.childSessionId}`
      : event.type;
    this.pendingProjections.set(key, event);
    this.flushProjections();
  }

  private flushProjections(): void {
    if (this.closed || this.rawFanoutDepth > 0 || this.publishingProjection) return;
    this.publishingProjection = true;
    try {
      for (const [type, event] of this.pendingProjections) {
        this.pendingProjections.delete(type);
        for (const listener of [...this.listeners]) {
          if (this.closed) return;
          if (this.listeners.has(listener)) listener(event);
        }
      }
    } finally {
      this.publishingProjection = false;
    }
  }

  private installSubagentStreamBridge(): void {
    if (this.closed || !this.builtIns?.loaded.includes("subagents")) return;
    const holder = globalThis as { __pixSubagentStream?: (childSessionId: string, event: unknown) => void };
    if (holder.__pixSubagentStream !== undefined) return;
    const generation = this.subagentStreamGeneration;
    holder.__pixSubagentStream = (childSessionId, event) => this.handleSubagentStreamEvent(generation, childSessionId, event);
  }

  private uninstallSubagentStreamBridge(): void {
    this.subagentStreamGeneration += 1;
    const holder = globalThis as { __pixSubagentStream?: (childSessionId: string, event: unknown) => void };
    delete holder.__pixSubagentStream;
  }

  private handleSubagentStreamEvent(generation: number, childSessionId: string, event: unknown): void {
    if (this.closed || generation !== this.subagentStreamGeneration) return;
    const projected = projectSubagentStreamEvent({
      childSessionId,
      event,
      tasks: this.subagents?.tasks ?? [],
      sessionId: this.identity.sessionId,
    });
    if (projected === undefined) return;
    this.publishToListeners(projected);
  }

  private publishSubagentObserverError(): void {
    this.publishToListeners({
      type: "extension_error",
      error: "Subagent filesystem observation failed; refresh the runtime snapshot to recover.",
      details: { code: "subagent_observer_error", recovery: "refresh_snapshot" },
    });
  }

  private refreshProjectionsFromEvent(event: unknown): void {
    const subagentRefresh = isSubagentRefreshEvent(event);
    if (subagentRefresh && this.builtIns?.loaded.includes("subagents")) {
      try {
        this.subagentObserver?.refresh(true);
      } catch {
        // The observer already emitted a structured extension_error.
      }
    }
    const todoItems = todoItemsFromToolEnd(event);
    if (todoItems !== null && this.builtIns?.loaded.includes("todo")) {
      const next = nextTodoProjection(this.todo, todoItems);
      if (next.changed) {
        this.todo = next.projection;
        this.publishToListeners({ type: "todo_changed", todo: cloneTodo(next.projection) });
      }
      return;
    }
    // Successful compaction rewrote the selected branch: replay the Todo cold
    // seed from the authoritative durable branch, including entries hidden
    // from the compacted LLM message view.
    if (isTodoReplayEvent(event) && this.builtIns?.loaded.includes("todo")) {
      const next = nextTodoProjection(this.todo, todoItemsFromBranch(this.session.sessionManager.getBranch()));
      if (next.changed) {
        this.todo = next.projection;
        this.publishToListeners({ type: "todo_changed", todo: cloneTodo(next.projection) });
      }
    }
  }

  async prompt(message: string, attached?: readonly ImageAttachment[], streamingBehavior?: "steer" | "followUp"): Promise<{ disposition: PromptDisposition }> {
    // Pi 1.0 receipt: the SDK reports how the accepted input was dispatched via
    // the preflight callback (prompt() itself resolves void). "handled" means
    // an extension command/input handler consumed it — NO assistant reply is
    // owed and reusing a historical last-assistant as the "final" would be
    // wrong. "queued" parks the input; the turn happens when the queue drains.
    let disposition: PromptDisposition | undefined;
    await this.session.prompt(message, {
      ...(attached && attached.length > 0 ? { images: images(attached)! } : {}),
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
      source: "rpc",
      preflightResult: (value) => { disposition = value; },
    });
    if (disposition === undefined) throw new Error("prompt completed without an input disposition receipt");
    if (disposition !== "started") return { disposition };
    const final = [...this.session.messages].reverse().find((item): item is Extract<typeof item, { role: "assistant" }> => item.role === "assistant");
    if (!final) throw new Error("prompt completed without a final assistant message");
    if (final.stopReason === "aborted") {
      throw makeRuntimeError("interrupted", final.errorMessage ?? "prompt aborted", { retryable: true });
    }
    if (final.stopReason === "error") {
      throw makeRuntimeError("external", final.errorMessage ?? "model failed to complete the prompt", {
        cause: { kind: "model", detail: "model returned an error stop reason" },
      });
    }
    return { disposition };
  }
  async steer(message: string, attached?: readonly ImageAttachment[]): Promise<QueuedInputDisposition> { return this.session.steer(message, images(attached), { source: "rpc" }); }
  async followUp(message: string, attached?: readonly ImageAttachment[]): Promise<QueuedInputDisposition> { return this.session.followUp(message, images(attached), { source: "rpc" }); }
  async abort(): Promise<void> { await this.session.abort(); }
  async setModel(model: ModelRef): Promise<void> {
    let resolved = this.session.modelRuntime.getModel(model.provider, model.id);
    if (!resolved) { await this.session.modelRuntime.refresh({ allowNetwork: false }); resolved = this.session.modelRuntime.getModel(model.provider, model.id); }
    if (!resolved) throw new Error(`unknown model: ${model.provider}/${model.id}`);
    await this.session.setModel(resolved);
  }
  setThinkingLevel(level: ThinkingLevel): void { this.session.setThinkingLevel(level as never); }
  async compact(customInstructions?: string): Promise<unknown> { return this.session.compact(customInstructions); }
  abortCompaction(): void { this.session.abortCompaction(); }
  setSessionName(name: string): void { this.session.setSessionName(name); }
  setAutoCompaction(enabled: boolean): void { this.session.setAutoCompactionEnabled(enabled); }
  setAutoRetry(enabled: boolean): void { this.session.setAutoRetryEnabled(enabled); }
  clearQueue(): void { this.session.clearQueue(); }
  setTools(toolNames: readonly string[], includeExtensionTools: boolean): void {
    // Defense-in-depth at the driver boundary: the adapter validates at the
    // canonical boundary, but a direct driver call or a stale reload
    // re-application must NEVER silently drop unknown tools (the SDK's
    // setActiveToolsByName ignores unknown names). Validate every name against
    // the REAL session's complete registry (builtins + loaded extension/
    // resource tools via session.getAllTools()) and throw a structured
    // invalid_input that the adapter maps to the exact canonical error shape.
    // Trim/dedupe here too so this driver applies exactly what it validated.
    const known = new Set(this.session.getAllTools().map((tool) => tool.name));
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of toolNames) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (name.length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw makeRuntimeError("invalid_input", "tool names must be non-empty");
      }
      if (!known.has(name)) {
        throw makeRuntimeError("invalid_input", `unknown tool: ${redactText(name).slice(0, 200)}`);
      }
      if (!seen.has(name)) { seen.add(name); normalized.push(name); }
    }
    this.configuredTools = { toolNames: normalized, includeExtensionTools };
    this.toolPolicy.forcedEmpty = normalized.length === 0;
    const selected = normalized.length === 0
      ? []
      : [
          ...normalized,
          ...(includeExtensionTools ? registrationActivatedToolNames(this.session) : []),
        ];
    this.session.setActiveToolsByName([...new Set(selected)]);
  }
  async reload(): Promise<readonly RuntimeCapability[]> {
    this.uninstallSubagentStreamBridge();
    this.subagentObserver?.close();
    this.subagentObserver = undefined;
    try {
      await this.session.reload();
    } catch (error) {
      this.currentCapabilities = this.recomputeProjections(this.currentCapabilities);
      throw error;
    }
    if (this.configuredTools) {
      this.setTools(this.configuredTools.toolNames, this.configuredTools.includeExtensionTools);
    } else {
      // Global tool preference application point #3: a prefs-following runtime
      // recomputes the selection after the SDK's own reload (fresh settings +
      // re-registered extensions). An explicit runtime override (`setTools`)
      // keeps winning — no reset flag, the override simply stays configured.
      await applyGlobalToolsSelection(this.session, this.toolPolicy, this.agentDir);
    }
    this.currentCapabilities = this.recomputeProjections(this.reloadCapabilities ?? this.baseCapabilities);
    this.installSubagentStreamBridge();
    return this.currentCapabilities;
  }

  /**
   * Resolve the currently committed leaf entry identity (Protocol v2). The
   * SDK appends the just-committed message entry synchronously after its
   * `message_end` emit (and bash results append via recordBashResult), so a
   * microtask/awaited resolution sees the exact committed entry. Returns
   * undefined (fail closed, never content-matched) when the leaf is not a
   * committed message-like entry matching the expected role.
   */
  resolveLeafEntry(expectedRole?: string): { entryId: string; parentEntryId?: string } | undefined {
    const entry = this.session.sessionManager.getLeafEntry();
    if (!entry || !this.entryMatchesRole(entry, expectedRole)) return undefined;
    return {
      entryId: entry.id,
      ...(entry.parentId === null || entry.parentId === undefined ? {} : { parentEntryId: entry.parentId }),
    };
  }

  resolveLeafEntries(
    expectedRole: string,
    count: number,
  ): readonly { entryId: string; parentEntryId?: string }[] | undefined {
    if (!Number.isInteger(count) || count < 1) return undefined;
    const manager = this.session.sessionManager;
    const resolved: { entryId: string; parentEntryId?: string }[] = [];
    let entry = manager.getLeafEntry();
    // Deferred bash messages are flushed consecutively at the session tail
    // immediately before agent_settled. Require that exact structural shape;
    // never skip intervening entries or content-match a command/output.
    while (entry && resolved.length < count) {
      if (!this.entryMatchesRole(entry, expectedRole)) return undefined;
      resolved.push({
        entryId: entry.id,
        ...(entry.parentId === null || entry.parentId === undefined ? {} : { parentEntryId: entry.parentId }),
      });
      entry = entry.parentId === null || entry.parentId === undefined
        ? undefined
        : manager.getEntry(entry.parentId);
    }
    if (resolved.length !== count) return undefined;
    return resolved.reverse();
  }

  private entryMatchesRole(entry: unknown, expectedRole?: string): boolean {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { type?: unknown; message?: { role?: unknown } };
    const expectedType = expectedRole === "custom" ? "custom_message" : "message";
    if (candidate.type !== expectedType) return false;
    if (expectedRole === undefined || expectedRole === "custom") return true;
    return candidate.message?.role === expectedRole;
  }

  async bash(command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void) {
    this.bashChunks = onChunk;
    try {
      const result = await this.session.executeBash(command, onChunk, { excludeFromContext });
      return {
        output: result.output,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        cancelled: result.cancelled,
        truncated: result.truncated,
        ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
      };
    } finally {
      this.bashChunks = undefined;
    }
  }
  abortBash(): void { this.session.abortBash(); }
  async navigate(targetId: string): Promise<void> { const result = await this.session.navigateTree(targetId); if (result.cancelled) throw new Error("navigation cancelled"); }
  async fork(entryId: string): Promise<{ sessionId: string; sessionFile: string }> {
    const manager = this.session.sessionManager;
    const file = manager.getSessionFile();
    if (!file) throw new Error("session is not persisted");
    const entry = manager.getEntry(entryId);
    if (!entry) throw new Error(`unknown fork point: ${entryId}`);
    const source = SessionManager.open(file, manager.getSessionDir());
    const parentSessionId = source.getSessionId();
    const forkedFile = source.createBranchedSession(entry.id);
    if (!forkedFile) throw new Error("failed to create forked session");
    source.appendCustomEntry("pix-fork-provenance", {
      version: 1,
      parentSessionId,
      forkPointEntryId: entry.id,
    });
    if (!existsSync(forkedFile)) {
      const header = source.getHeader();
      if (!header) throw new Error("forked session is missing its header");
      mkdirSync(source.getSessionDir(), { recursive: true, mode: 0o700 });
      const lines = [header, ...source.getEntries()].map((value) => JSON.stringify(value));
      writeFileSync(forkedFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    return { sessionId: source.getSessionId(), sessionFile: forkedFile };
  }
  async generateSessionTitle(options?: { model?: { provider: string; modelId: string } }): Promise<string> {
    const override = options?.model;
    const resolved = override
      ? this.session.modelRuntime.getModel(override.provider, override.modelId)
      : undefined;
    // Missing/unknown override model fails closed; the adapter layer sanitizes
    // the message, so a plain Error is sufficient here.
    if (override !== undefined && resolved === undefined) {
      throw new Error("title model is not available");
    }
    // Real generation through a temporary shadow agent (idle-gated, 90s
    // bounded, tools disabled). The driver applies the result — the caller
    // never mutates the live session tree.
    const title = await generateSessionTitleForSession(
      this.session,
      resolved === undefined ? {} : { model: resolved },
    );
    this.session.setSessionName(title);
    return title;
  }

  async bindUi(onRequest: (request: DriverUiRequest) => void, emit: (event: never) => void): Promise<void> {
    this.uiRequest = onRequest;
    this.emitCanonical = emit;
    const ui = this.createUiContext();
    await this.session.bindExtensions({
      uiContext: ui,
      mode: "rpc",
      shutdownHandler: () => { throw new Error("extension shutdown is not supported by the worker runtime"); },
      onError: (error) => emit({ type: "extension_error", sessionId: this.session.sessionId, error: error.error } as never),
    });
    // Global tool preference application point #2: extension/resource tools
    // (codemode, tool_search, MCP tools) only register during bindExtensions,
    // so the selection is re-applied against the now-complete registry. Only
    // prefs-following runtimes (no explicit input.toolNames, no setTools
    // override) re-apply; an explicit override survives binding untouched.
    if (this.configuredTools === undefined) {
      await applyGlobalToolsSelection(this.session, this.toolPolicy, this.agentDir);
    }
    this.currentCapabilities = this.recomputeProjections(this.currentCapabilities);
    this.trace?.record("bind_extensions");
    this.trace?.record("ready");
  }

  createSideChatController(tracker: FileActivityTracker): SideChatController {
    if (this.closed) throw makeRuntimeError("unavailable", "runtime is closed");
    const model = this.session.model;
    if (model === undefined || model === null) throw makeRuntimeError("unavailable", "side chat requires an active model");
    return createSideChatController({
      forkContext: {
        messages: this.session.sessionManager.buildSessionContext().messages,
        model,
        systemPrompt: this.toolPolicy.forcedEmpty ? "" : this.session.systemPrompt,
        thinkingLevel: this.session.thinkingLevel,
        cwd: this.session.sessionManager.getCwd(),
        // Pi 1.0 surface fence: the side chat is a standalone Agent, so only
        // tools whose SDK exposure semantics match a directly-declared,
        // directly-callable tool may enter it. Hidden/codemode/deferred tools
        // are never model-declared; model-only tools are never callable. The
        // main session's CURRENT ACTIVE set is the baseline (a tool disabled
        // in main is not resurrected in the side chat), and codemode/
        // tool_search themselves are excluded: their value is nested calls via
        // ctx.executeTool, which the side chat's agent loop does not host.
        extensionTools: sideChatExtensionSurface(this.session),
      },
      modelRuntime: this.session.modelRuntime,
      sessionManager: this.session.sessionManager,
      createExtensionContext: () => this.session.extensionRunner.createContext(),
      tracker,
    });
  }

  async close(reason: RuntimeCloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.uninstallSubagentStreamBridge();
    this.pendingProjections.clear();
    this.unsubscribeSession();
    this.listeners.clear();
    this.subagentObserver?.close();
    this.subagentObserver = undefined;
    for (const cancel of [...this.activeUiCancels]) cancel();
    this.activeUiCancels.clear();
    try {
      if (this.session.isStreaming || !this.session.isIdle) await this.session.abort();
    } catch { /* best-effort shutdown continues */ }
    if (this.session.isBashRunning) this.session.abortBash();
    if (this.session.isCompacting) this.session.abortCompaction();
    await this.session.extensionRunner.emit?.({ type: "session_shutdown", reason: reason === "shutdown" ? "quit" : "quit" });
    this.session.dispose();
  }

  private createUiContext(): ExtensionUIContext {
    const request = <T>(
      body: Omit<DriverUiRequest, "settle" | "cancel" | "input" | "onSettled">,
      parse: (result: { value?: string; confirmed?: boolean; cancelled?: true }) => T,
      options?: { signal?: AbortSignal; timeout?: number; incremental?: boolean },
    ): Promise<T> => new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listeners = new Set<() => void>();
      const finish = (result: { value?: string; confirmed?: boolean; cancelled?: true }) => {
        if (settled) return;
        settled = true;
        this.activeUiCancels.delete(cancel);
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        for (const listener of listeners) listener();
        listeners.clear();
        resolve(parse(result));
      };
      const cancel = () => finish({ cancelled: true });
      this.activeUiCancels.add(cancel);
      if (options?.signal?.aborted) { cancel(); return; }
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeout !== undefined) timer = setTimeout(cancel, options.timeout);
      this.uiRequest?.({
        ...body,
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        settle: finish,
        input: options?.incremental ? () => {} : (data) => finish({ value: data }),
        cancel,
        onSettled: (listener) => { if (settled) listener(); else listeners.add(listener); },
      });
    });
    const unsupported = () => undefined;
    return {
      select: (title, options, opts) => request({ id: crypto.randomUUID(), method: "select", title, options }, (result) => result.cancelled ? undefined : result.value, opts),
      confirm: (title, message, opts) => request({ id: crypto.randomUUID(), method: "confirm", title, message }, (result) => result.cancelled ? false : result.confirmed ?? false, opts),
      input: (title, placeholder, opts) => request({ id: crypto.randomUUID(), method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) }, (result) => result.cancelled ? undefined : result.value, opts),
      editor: (title, prefill) => request({ id: crypto.randomUUID(), method: "editor", title, ...(prefill === undefined ? {} : { prefill }) }, (result) => result.cancelled ? undefined : result.value),
      notify: (message, type) => {
        if (type === "error") {
          this.emitCanonical?.({ type: "extension_error", sessionId: this.session.sessionId, error: message } as never);
          return;
        }
        // info/warning are notifications, not errors: `/mcp` status text and
        // OAuth authorization URLs arrive here and must stay visible as
        // notices (typed event + bounded state ring), never as fake errors.
        this.emitCanonical?.({
          type: "extension_notification",
          sessionId: this.session.sessionId,
          level: type === "warning" ? "warning" : "info",
          message,
          at: Date.now(),
        } as never);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => this.emitCanonical?.({ type: "extension_statuses", sessionId: this.session.sessionId, statuses: text === undefined ? [] : [{ key, text }] } as never),
      setWorkingMessage: unsupported,
      setWorkingVisible: unsupported,
      setWorkingIndicator: unsupported,
      setHiddenThinkingLabel: unsupported,
      setWidget: (key, content, options) => { if (Array.isArray(content)) this.emitCanonical?.({ type: "extension_widgets", sessionId: this.session.sessionId, widgets: [{ key, lines: content, placement: options?.placement ?? "aboveEditor" }] } as never); },
      setFooter: unsupported,
      setHeader: unsupported,
      setTitle: (title) => this.emitCanonical?.({ type: "session_title", sessionId: this.session.sessionId, name: title } as never),
      custom: async () => request({ id: crypto.randomUUID(), method: "custom", lines: ["Custom extension UI"] }, (result) => result.value as never, { incremental: true }),
      pasteToEditor: unsupported,
      setEditorText: unsupported,
      getEditorText: () => "",
      addAutocompleteProvider: unsupported,
      setEditorComponent: unsupported,
      getEditorComponent: () => undefined,
      theme: {} as ExtensionUIContext["theme"],
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "headless adapter does not switch themes" }),
      getToolsExpanded: () => false,
      setToolsExpanded: unsupported,
    };
  }
}

/**
 * SDK-exact continuation semantics: the SDK classifies a session as
 * "existing" when `buildSessionContext().messages.length > 0` (sdk.js),
 * which includes ordinary messages AND context-producing entries
 * (custom_message, branch summaries, compaction summaries). Any of those
 * means the persisted model must be restored — matching on `message` entry
 * types alone would misclassify e.g. model_change + custom_message as fresh
 * and re-inject the global default.
 */
export function hasSdkContinuation(manager: SessionManager): boolean {
  return manager.buildSessionContext().messages.length > 0;
}

export interface SdkRuntimeComposition {
  openSession(input: RuntimeStartInput | { sessionId: string; cwd?: string }): Promise<{ manager: SessionManager; cwd: string }>;
  initializeTheme(): void;
  createServices(
    cwd: string,
    trusted: boolean,
    toolPolicy?: ToolPolicyState,
  ): Promise<Awaited<ReturnType<typeof createAgentSessionServices>>>;
  resolveProjectTrust(cwd: string): Promise<boolean>;
  prepareExtensionMode(cwd: string, trusted: boolean): Promise<void>;
  listVisibleModels(services: Awaited<ReturnType<typeof createAgentSessionServices>>): readonly Model<Api>[] | Promise<readonly Model<Api>[]>;
  getDefaults(services: Awaited<ReturnType<typeof createAgentSessionServices>>): { provider?: string; modelId?: string };
  hasContinuation(manager: SessionManager): boolean;
  createSession(options: Parameters<typeof createAgentSessionFromServices>[0]): ReturnType<typeof createAgentSessionFromServices>;
}

/**
 * Pi 1.0 native built-in extension descriptors, mirroring the CLI's own
 * assembly: named `builtin:<name>` resources (settings `extensions`
 * `-builtin:mcp` etc. disable them), replaceable so a user extension that
 * registers codemode/tool_search//mcp takes over instead of running a second
 * authority. codemode/tool_search register with defaultActive:false — only
 * defaultTools or MCP auto-activation turn them on. MCP reads the global
 * agentDir mcp.json and the TRUSTED project .pi/mcp.json via the SDK's own
 * trust gate. Exported so the deterministic factory tests compose the exact
 * production list (no drift between wiring and tests).
 */
export function nativeBuiltinExtensionFactories(): InlineExtension[] {
  return [
    {
      name: "codemode",
      factory: createCodemodeExtension(),
      builtin: true,
      replaceable: true,
    },
    {
      name: "tool-search",
      factory: createToolSearchExtension(),
      builtin: true,
      replaceable: true,
    },
    {
      name: "mcp",
      // The worker is headless: never spawn a host-machine browser for OAuth.
      // Web users follow the authorization URL from the typed
      // extension_notification and paste the redirect via the existing
      // extension input callback.
      factory: createMcpExtension({ openUrl: () => {} }),
      builtin: true,
      replaceable: true,
    },
  ];
}

/** Tools that orchestrate other tools through ctx.executeTool; excluded
 * from the side chat because its standalone agent loop hosts no nested
 * runner (main-session-only until a nested host exists). */
const NESTED_HOST_TOOL_NAMES = new Set(["codemode", "tool_search"]);

/**
 * Pi 1.0 side-chat extension surface: the MAIN session's registered tools
 * that are (a) currently ACTIVE in main, (b) exposure `direct` (declared to
 * the model AND callable — the only semantics a standalone agent tool has),
 * and (c) not nested-host tools. Hidden/codemode/deferred/model-only tools
 * and tools disabled in main never enter the side chat catalog.
 */
export function sideChatExtensionSurface(session: AgentSession) {
  const active = new Set(session.getActiveToolNames());
  const exposures = new Map(session.getAllTools().map((tool) => [tool.name, tool.exposure]));
  return session.extensionRunner.getAllRegisteredTools().filter((registered) => {
    if (!active.has(registered.definition.name)) return false;
    if (NESTED_HOST_TOOL_NAMES.has(registered.definition.name)) return false;
    return exposures.get(registered.definition.name) === "direct";
  });
}

function defaultComposition(): SdkRuntimeComposition {
  // Reuse the catalog owner's disposable index and exact identity validation.
  // A runtime open must not parse every historical JSONL through SDK listAll
  // before it can start the one selected session.
  const sessions = createPiSdkSessionStore({ projection: { enabled: true } });
  return {
    async openSession(input) {
      if ("sessionId" in input) {
        const location = await sessions.locate(input.sessionId);
        if (!location.exists) throw makeRuntimeError("not_found", "session not found");
        const manager = SessionManager.open(location.sessionFile, undefined, input.cwd);
        // Never accept a mismatched manager or proceed to runtime initialization
        // if the path changes after locate. The SDK's existing empty-file and
        // migration writes during open remain an owner-level filesystem risk.
        if (manager.getSessionId() !== input.sessionId) throw makeRuntimeError("not_found", "session not found");
        return { manager, cwd: manager.getCwd() };
      }
      const manager = SessionManager.create(input.cwd);
      mkdirSync(manager.getSessionDir(), { recursive: true, mode: 0o700 });
      return { manager, cwd: manager.getCwd() };
    },
    initializeTheme: () => initTheme(),
    createServices: (cwd, trusted, toolPolicy = { forcedEmpty: false }) => {
      const agentDir = getAgentDir();
      const trustOptions = hasTrustRequiringProjectResources(cwd)
        ? { resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted } }
        : {};
      return createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          ...resourceLoaderOptionsForBuiltIns(agentDir),
          extensionFactories: [createToolPolicyExtension(toolPolicy), ...nativeBuiltinExtensionFactories()],
        },
        ...trustOptions,
      });
    },
    // RISK (project-trust coupling): the Pi SDK couples resource loading to its
    // own ProjectTrustStore under the Pi agent dir. A1 does NOT migrate a pix
    // ProjectTrust port — it forwards the SDK's trust decision into service
    // creation. A future trust milestone must own the gate and stop leaning on
    // the SDK-internal store; until then trust is an SDK-internal concern and
    // is reported here as a residual risk, not exposed as a pix capability.
    resolveProjectTrust: async (cwd) =>
      !hasTrustRequiringProjectResources(cwd) || new ProjectTrustStore(getAgentDir()).get(cwd) === true,
    prepareExtensionMode: async (_cwd, _trusted) => {},
    listVisibleModels: async (services) => {
      const enabled = services.settingsManager.getEnabledModels();
      if (!enabled || enabled.length === 0) return services.modelRuntime.getAvailableSnapshot();
      return (await resolveModelScopeWithDiagnostics(enabled, services.modelRuntime)).scopedModels.map((item) => item.model);
    },
    getDefaults: (services) => ({
      ...(services.settingsManager.getDefaultProvider() === undefined
        ? {}
        : { provider: services.settingsManager.getDefaultProvider()! }),
      ...(services.settingsManager.getDefaultModel() === undefined
        ? {}
        : { modelId: services.settingsManager.getDefaultModel()! }),
    }),
    hasContinuation: (manager) => hasSdkContinuation(manager),
    createSession: (options) => createAgentSessionFromServices(options),
  };
}

export class SdkRuntimeDriverFactory implements PiRuntimeDriverFactory {
  private readonly composition: SdkRuntimeComposition;
  constructor(private readonly trace?: InitializationTraceSink, composition?: SdkRuntimeComposition) {
    this.composition = composition ?? defaultComposition();
  }

  async create(input: RuntimeStartInput, options: DriverFactoryOptions): Promise<PiRuntimeDriver> {
    const opened = await this.composition.openSession(input);
    return this.construct(opened.manager, opened.cwd, input, options);
  }

  async open(sessionId: string, cwd: string | undefined, model: ModelRef | undefined, options: DriverFactoryOptions): Promise<PiRuntimeDriver> {
    const opened = await this.composition.openSession({ sessionId, ...(cwd === undefined ? {} : { cwd }) });
    return this.construct(opened.manager, opened.cwd, { cwd: opened.cwd, ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.id } }) }, options);
  }

  private async construct(manager: SessionManager, cwd: string, input: RuntimeStartInput, options: DriverFactoryOptions): Promise<PiRuntimeDriver> {
    this.trace?.record("session_manager");
    this.trace?.record("cwd");
    this.composition.initializeTheme();
    this.trace?.record("theme");
    const trusted = await this.composition.resolveProjectTrust(cwd);
    this.trace?.record("trust_gate");
    await this.composition.prepareExtensionMode(cwd, trusted);
    this.trace?.record("extension_mode");
    const toolPolicy: ToolPolicyState = { forcedEmpty: input.toolNames?.length === 0 };
    const services = await this.composition.createServices(cwd, trusted, toolPolicy);
    this.trace?.record("services");
    const models = await this.composition.listVisibleModels(services);
    this.trace?.record("visible_models");
    const defaults = this.composition.getDefaults(services);
    const defaultProvider = defaults.provider;
    const defaultModelId = defaults.modelId;
    this.trace?.record("default_model");
    const continuation = this.composition.hasContinuation(manager);
    this.trace?.record("continuation");
    // Continuation without an explicit input.model must NOT inject the global
    // default here: passing options.model to createSession overrides the SDK's
    // native persisted-session restore, silently running a resumed session on
    // the global default (historical model A becomes actual B). Omit the
    // selector so the SDK restores the session's own model, falling back to
    // its configured/default resolution only when that restore fails.
    // Fresh sessions keep the existing default/visible-model selection.
    const selector = input.model
      ?? (continuation || !(defaultProvider && defaultModelId)
        ? undefined
        : { provider: defaultProvider, modelId: defaultModelId });
    const selected = selector
      ? services.modelRuntime.getModel(selector.provider, selector.modelId)
      : continuation
        ? undefined
        : models[0];
    const model = selected as Model<Api> | undefined;
    if (input.model && !model) {
      throw new Error(`unknown model: ${input.model.provider}/${input.model.modelId}`);
    }
    this.trace?.record("initial_scope");
    const result = await this.composition.createSession({
      services,
      sessionManager: manager,
      ...(model === undefined ? {} : { model }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel as never }),
      ...(input.toolNames?.length === 0 ? { tools: [] } : {}),
      ...(models.length === 0 ? {} : { scopedModels: models.map((scopedModel) => ({ model: scopedModel })) }),
    });
    this.trace?.record("agent_session");
    if (input.model) services.settingsManager.setDefaultModelAndProvider(input.model.provider, input.model.modelId);
    if (input.name?.trim()) result.session.setSessionName(input.name.trim());
    if (input.thinkingLevel && input.thinkingLevel !== "off") services.settingsManager.setDefaultThinkingLevel(input.thinkingLevel as never);
    await services.settingsManager.flush();
    this.trace?.record("startup_preferences");
    if (input.toolNames === undefined) {
      // Global tool preference application point #1 (pre-bind; point #2 after
      // bindExtensions completes the registry). No unconditional builtin union
      // anymore: a native `defaultTools` selection (e.g. `-read`) is honored
      // verbatim, and the Pix default enables every selectable tool.
      await applyGlobalToolsSelection(result.session, toolPolicy, services.agentDir);
    } else {
      const selectedTools = input.toolNames.length === 0
        ? []
        : [
            ...input.toolNames,
            ...registrationActivatedToolNames(result.session),
          ];
      result.session.setActiveToolsByName([...new Set(selectedTools)]);
    }
    this.trace?.record("active_tools");
    this.trace?.record("empty_system_prompt");
    const driver = new SdkRuntimeDriver(
      result.session,
      options.capabilities ?? RUNTIME_CAPABILITIES,
      options.reloadCapabilities,
      toolPolicy,
      services.agentDir,
      input.toolNames === undefined
        ? undefined
        : { toolNames: [...input.toolNames], includeExtensionTools: true },
      this.trace,
    );
    return driver;
  }
}
