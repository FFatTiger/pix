import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type {
  ImageAttachment,
  ModelRef,
  RuntimeCapability,
  RuntimeCloseReason,
  RuntimeStartInput,
  ThinkingLevel,
  ToolInfo,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError, RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { redactText } from "./sanitize.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  initTheme,
  ModelRuntime,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentState } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  DriverEventListener,
  DriverFactoryOptions,
  DriverState,
  DriverUiRequest,
  InitializationTraceSink,
  PiRuntimeDriver,
  PiRuntimeDriverFactory,
} from "./types.js";

function images(value: readonly ImageAttachment[] | undefined): ImageContent[] | undefined {
  return value?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

function driverState(session: AgentSession, forcedEmpty: boolean): DriverState {
  const model = session.model;
  const usage = session.getContextUsage();
  const stats = session.getSessionStats();
  const active = new Set(session.getActiveToolNames());
  const leafId = session.sessionManager.getLeafId();
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
    messages: session.messages,
    tools: session.getAllTools().map((tool): ToolInfo => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), active: active.has(tool.name) })),
    ...(usage === undefined ? {} : { contextUsage: { percent: usage.percent ?? 0, contextWindow: usage.contextWindow, ...(usage.tokens === null ? {} : { tokens: usage.tokens }) } }),
    steering: session.getSteeringMessages().map((message) => ({ message })),
    followUp: session.getFollowUpMessages().map((message) => ({ message })),
    sessionStats: {
      messageCount: stats.totalMessages,
      pendingMessageCount: session.pendingMessageCount,
      tokenCount: stats.tokens.total,
      ...(usage === undefined ? {} : { contextUsage: { percent: usage.percent ?? 0, contextWindow: usage.contextWindow, ...(usage.tokens === null ? {} : { tokens: usage.tokens }) } }),
    },
    lastAssistantText: session.getLastAssistantText() ?? "",
    commands: [
      ...session.extensionRunner.getRegisteredCommands().map((command) => ({ name: command.invocationName, ...(command.description === undefined ? {} : { description: command.description }), source: "extension" as const, sourceInfo: command.sourceInfo })),
      ...session.promptTemplates.map((prompt) => ({ name: prompt.name, ...(prompt.description === undefined ? {} : { description: prompt.description }), source: "prompt" as const, sourceInfo: prompt.sourceInfo })),
      ...session.resourceLoader.getSkills().skills.map((skill) => ({ name: `skill:${skill.name}`, ...(skill.description === undefined ? {} : { description: skill.description }), source: "skill" as const, sourceInfo: skill.sourceInfo })),
    ],
    ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
  };
}

class SdkRuntimeDriver implements PiRuntimeDriver {
  readonly identity;
  readonly capabilities: readonly RuntimeCapability[];
  private forcedEmpty = false;
  private uiRequest: ((request: DriverUiRequest) => void) | undefined;
  private emitCanonical: ((event: never) => void) | undefined;
  private activeUiCancels = new Set<() => void>();
  private bashChunks: ((chunk: string) => void) | undefined;
  private listenerMap = new Map<DriverEventListener, () => void>();

  constructor(
    private readonly session: AgentSession,
    capabilities: readonly RuntimeCapability[],
    private readonly reloadCapabilities: readonly RuntimeCapability[] | undefined,
    forcedEmpty: boolean,
    private configuredTools?: { toolNames: readonly string[]; includeExtensionTools: boolean },
    private readonly trace?: InitializationTraceSink,
  ) {
    this.identity = {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
      cwd: session.sessionManager.getCwd(),
    };
    this.capabilities = capabilities;
    this.forcedEmpty = forcedEmpty;
  }

  getState(): DriverState { return driverState(this.session, this.forcedEmpty); }

  subscribe(listener: DriverEventListener): () => void {
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "bash_execution_update") this.bashChunks?.(event.delta);
      listener(event);
    });
    this.listenerMap.set(listener, unsubscribe);
    return () => { unsubscribe(); this.listenerMap.delete(listener); };
  }

  async prompt(message: string, attached?: readonly ImageAttachment[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.session.prompt(message, {
      ...(attached && attached.length > 0 ? { images: images(attached)! } : {}),
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
      source: "rpc",
    });
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
  }
  async steer(message: string, attached?: readonly ImageAttachment[]): Promise<void> { await this.session.steer(message, images(attached)); }
  async followUp(message: string, attached?: readonly ImageAttachment[]): Promise<void> { await this.session.followUp(message, images(attached)); }
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
    this.forcedEmpty = normalized.length === 0;
    const builtinNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const selected = normalized.length === 0
      ? []
      : [
          ...normalized,
          ...(includeExtensionTools
            ? this.session.getAllTools().map((tool) => tool.name).filter((name) => !builtinNames.has(name))
            : []),
        ];
    this.session.setActiveToolsByName([...new Set(selected)]);
    this.applyForcedEmptySystemPrompt();
  }
  async reload(): Promise<readonly RuntimeCapability[]> {
    await this.session.reload();
    if (this.configuredTools) {
      this.setTools(this.configuredTools.toolNames, this.configuredTools.includeExtensionTools);
    } else if (this.forcedEmpty) {
      this.session.setActiveToolsByName([]);
    }
    this.applyForcedEmptySystemPrompt();
    return this.reloadCapabilities ?? this.capabilities;
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
  async generateSessionTitle(): Promise<string> { const text = this.session.getLastAssistantText()?.trim(); const title = text ? text.slice(0, 80) : `Session ${this.session.sessionId.slice(0, 8)}`; this.session.setSessionName(title); return title; }

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
    this.trace?.record("bind_extensions");
    this.trace?.record("ready");
  }

  async close(reason: RuntimeCloseReason): Promise<void> {
    for (const cancel of [...this.activeUiCancels]) cancel();
    this.activeUiCancels.clear();
    try {
      if (this.session.isStreaming || !this.session.isIdle) await this.session.abort();
    } catch { /* best-effort shutdown continues */ }
    if (this.session.isBashRunning) this.session.abortBash();
    if (this.session.isCompacting) this.session.abortCompaction();
    await this.session.extensionRunner.emit?.({ type: "session_shutdown", reason: reason === "shutdown" ? "quit" : "quit" });
    for (const unsubscribe of this.listenerMap.values()) unsubscribe();
    this.listenerMap.clear();
    this.session.dispose();
  }

  private applyForcedEmptySystemPrompt(): void {
    if (!this.forcedEmpty) return;
    const state = this.session.agent.state as AgentState & { systemPrompt?: string };
    state.systemPrompt = "";
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
      notify: (message, type) => this.emitCanonical?.({ type: "extension_error", sessionId: this.session.sessionId, error: `[${type ?? "info"}] ${message}` } as never),
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

export interface SdkRuntimeComposition {
  openSession(input: RuntimeStartInput | { sessionId: string; cwd?: string }): Promise<{ manager: SessionManager; cwd: string }>;
  initializeTheme(): void;
  createServices(cwd: string, trusted: boolean): Promise<Awaited<ReturnType<typeof createAgentSessionServices>>>;
  resolveProjectTrust(cwd: string): Promise<boolean>;
  prepareExtensionMode(cwd: string, trusted: boolean): Promise<void>;
  listVisibleModels(services: Awaited<ReturnType<typeof createAgentSessionServices>>): readonly Model<Api>[] | Promise<readonly Model<Api>[]>;
  getDefaults(services: Awaited<ReturnType<typeof createAgentSessionServices>>): { provider?: string; modelId?: string };
  hasContinuation(manager: SessionManager): boolean;
  createSession(options: Parameters<typeof createAgentSessionFromServices>[0]): ReturnType<typeof createAgentSessionFromServices>;
}

function defaultComposition(): SdkRuntimeComposition {
  return {
    async openSession(input) {
      if ("sessionId" in input) {
        const sessions = await SessionManager.listAll();
        const info = sessions.find((item) => item.id === input.sessionId);
        if (!info) throw new Error(`session not found: ${input.sessionId}`);
        const manager = SessionManager.open(info.path, undefined, input.cwd);
        return { manager, cwd: manager.getCwd() };
      }
      const manager = SessionManager.create(input.cwd);
      mkdirSync(manager.getSessionDir(), { recursive: true, mode: 0o700 });
      return { manager, cwd: manager.getCwd() };
    },
    initializeTheme: () => initTheme(),
    createServices: (cwd, trusted) => {
      const agentDir = getAgentDir();
      const trustOptions = hasTrustRequiringProjectResources(cwd)
        ? { resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted } }
        : {};
      return createAgentSessionServices({ cwd, agentDir, ...trustOptions });
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
    hasContinuation: (manager) => manager.getBranch().some((entry) => entry.type === "message"),
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
    const services = await this.composition.createServices(cwd, trusted);
    this.trace?.record("services");
    const models = await this.composition.listVisibleModels(services);
    this.trace?.record("visible_models");
    const defaults = this.composition.getDefaults(services);
    const defaultProvider = defaults.provider;
    const defaultModelId = defaults.modelId;
    this.trace?.record("default_model");
    const continuation = this.composition.hasContinuation(manager);
    this.trace?.record("continuation");
    const selector = input.model ?? (defaultProvider && defaultModelId ? { provider: defaultProvider, modelId: defaultModelId } : undefined);
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
    if (input.toolNames !== undefined) {
      const builtinNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
      const selectedTools = input.toolNames.length === 0
        ? []
        : [
            ...input.toolNames,
            ...result.session.getAllTools().map((tool) => tool.name).filter((name) => !builtinNames.has(name)),
          ];
      result.session.setActiveToolsByName([...new Set(selectedTools)]);
    }
    this.trace?.record("active_tools");
    const forcedEmpty = input.toolNames?.length === 0;
    if (forcedEmpty) {
      const state = result.session.agent.state as AgentState & { systemPrompt?: string };
      state.systemPrompt = "";
    }
    this.trace?.record("empty_system_prompt");
    const driver = new SdkRuntimeDriver(
      result.session,
      options.capabilities ?? RUNTIME_CAPABILITIES,
      options.reloadCapabilities,
      forcedEmpty,
      input.toolNames === undefined
        ? undefined
        : { toolNames: [...input.toolNames], includeExtensionTools: true },
      this.trace,
    );
    return driver;
  }
}
