/**
 * TestRuntimeStore — TEST-ONLY relocated compatibility projection.
 *
 * Phase 4A.3.2b: the production `SessionStore` facade is DELETED. Its merged
 * view projection + delegation surface is relocated HERE (under runtime/testing,
 * never imported by production) so the 197 facade-parity tests keep covering
 * the exact/controller/registry/connection behavior through the SAME injected
 * owners with identical semantics. It is a NON-OWNING test driver: it only
 * subscribes to / delegates the injected connection + registry and never
 * disposes them (harness.dispose() disposes the registry exactly once).
 *
 * It reproduces the old facade's merged `RuntimeView` projection
 * (current controller + foreground operation + transport global fields, the
 * compatibility `liveEntries` merged tail, monotonic attach/history generation
 * accumulation) so the relocated facade test files assert byte-for-byte the
 * same merged behavior they did against the production facade.
 */
import type {
  ExtensionUiRequest,
  ImageAttachment,
  ProtocolError,
  RuntimeCapability,
  RuntimeCapabilitySet,
  RuntimeCommand,
  RuntimeSnapshot,
  RuntimeState,
  SessionStats,
  SlashCommandInfo,
  ThinkingLevel,
  ToolInfo,
} from "@fffattiger/pix-protocol";
import { RuntimeConnection } from "../runtime-connection.js";
import {
  SessionController,
  type ControllerView,
  type ExtensionUiReply,
  type PromptActivationSettings,
  type SessionControllerOptions,
  type TurnTerminalInfo,
} from "../session-controller.js";
import {
  SessionControllerRegistry,
  type SessionControllerRegistryOptions,
} from "../session-controller-registry.js";

export type RuntimeView = ControllerView;
export type TestStoreOptions = Omit<SessionControllerOptions, "requestObservation" | "initialAuthority"> & {
  readonly maxControllers?: number;
};

/**
 * Build registry options from the test-driver options so the harness creates
 * the registry once and injects it (the driver never constructs it).
 */
export function buildRegistryOptions(options: TestStoreOptions = {}): SessionControllerRegistryOptions {
  const { maxControllers, ...controllerOptions } = options;
  return {
    ...(maxControllers === undefined ? {} : { maxControllers }),
    controllerOptions,
  };
}

const EMPTY_VIEW: RuntimeView = {
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

export class TestRuntimeStore {
  private readonly listeners = new Set<() => void>();
  private readonly registryUnsubscribe: () => void;
  private readonly connectionUnsubscribe: () => void;
  private readonly seenGenerations = new Map<string, { attach: number; history: number }>();
  private disposed = false;
  private stopPromise: Promise<void> | null = null;
  private attachGeneration = 0;
  private historyGeneration = 0;
  private view: RuntimeView = EMPTY_VIEW;

  readonly registry: SessionControllerRegistry;

  /**
   * NON-OWNING: both owners are injected by the harness. This driver only
   * subscribes to them and delegates. It never constructs a registry.
   */
  constructor(
    private readonly runtimeConnection: RuntimeConnection,
    registry: SessionControllerRegistry,
    _options: TestStoreOptions = {},
  ) {
    this.registry = registry;
    this.registryUnsubscribe = this.registry.subscribe(() => this.onRegistryChanged());
    this.connectionUnsubscribe = runtimeConnection.subscribe(() => this.notify());
    this.notify();
  }

  connect(): void { this.runtimeConnection.connect(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registryUnsubscribe();
    this.connectionUnsubscribe();
    this.notify();
  }

  createSession(params: { cwd: string; projectRoot: string }): Promise<{ sessionId: string }> {
    return this.registry.createSession(params);
  }

  openSession(sessionId: string): Promise<void> {
    if (!sessionId) return Promise.reject(this.invalidSessionError());
    return this.registry.acquire(sessionId);
  }

  detach(): Promise<void> { return this.registry.release(); }

  refreshRunningSessions(): Promise<readonly string[]> {
    return this.runtimeConnection.refreshRunningSessions();
  }

  stop(reason?: string): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    const controller = this.currentController();
    if (controller === null) return Promise.resolve();
    this.stopPromise = this.registry.stop(controller.sessionId, reason).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  fetchSnapshot(): Promise<RuntimeSnapshot | null> {
    return this.withCurrent((controller) => controller.fetchSnapshot());
  }

  runtimeCapabilities(): RuntimeCapabilitySet | null {
    return this.currentController()?.runtimeCapabilities() ?? null;
  }

  hasRuntimeCapability(capability: RuntimeCapability): boolean {
    return this.currentController()?.hasRuntimeCapability(capability) ?? false;
  }

  sendCommand(command: RuntimeCommand): Promise<unknown> {
    return this.withCurrent((controller) => controller.sendCommand(command));
  }

  submitTurn(input: {
    sessionId: string;
    prompt: string;
    images?: readonly ImageAttachment[];
    activationOverrides?: {
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: ThinkingLevel | null;
    };
    expectedEpoch?: string;
    expectedRevision?: number;
  }): Promise<unknown> {
    return this.withExact(input.sessionId, (controller) => controller.submitTurn(input));
  }

  subscribeTurnTerminal(listener: (terminal: TurnTerminalInfo) => void): () => void {
    return this.registry.subscribeTurnTerminal(listener);
  }

  sendPrompt(message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    return this.withCurrent((controller) => controller.sendPrompt(message, images));
  }

  sendPromptToSession(
    sessionId: string,
    message: string,
    images?: readonly ImageAttachment[],
    activationSettings?: PromptActivationSettings,
  ): Promise<unknown> {
    return this.withExact(sessionId, (controller) => controller.sendPromptToSession(sessionId, message, images, activationSettings));
  }

  respondExtensionUi(request: ExtensionUiRequest, reply: ExtensionUiReply): Promise<void> {
    return this.withCurrent((controller) => controller.respondExtensionUi(request, reply));
  }

  sendExtensionUiInput(request: ExtensionUiRequest, data: string): Promise<void> {
    return this.withCurrent((controller) => controller.sendExtensionUiInput(request, data));
  }

  steer(message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    return this.withCurrent((controller) => controller.steer(message, images));
  }

  followUp(message: string, images?: readonly ImageAttachment[]): Promise<unknown> {
    return this.withCurrent((controller) => controller.followUp(message, images));
  }

  clearQueue(): Promise<unknown> { return this.withCurrent((controller) => controller.clearQueue()); }
  getState(): Promise<RuntimeState> { return this.withCurrent((controller) => controller.getState()); }
  getCommands(): Promise<readonly SlashCommandInfo[]> { return this.withCurrent((controller) => controller.getCommands()); }
  getLastAssistantText(): Promise<string> { return this.withCurrent((controller) => controller.getLastAssistantText()); }
  getSessionStats(): Promise<SessionStats> { return this.withCurrent((controller) => controller.getSessionStats()); }
  setSessionName(name: string): Promise<void> { return this.withCurrent((controller) => controller.setSessionName(name)); }
  setThinkingLevel(level: ThinkingLevel): Promise<void> { return this.withCurrent((controller) => controller.setThinkingLevel(level)); }
  setModel(provider: string, modelId: string): Promise<void> { return this.withCurrent((controller) => controller.setModel(provider, modelId)); }
  getTools(): Promise<readonly ToolInfo[]> { return this.withCurrent((controller) => controller.getTools()); }
  setTools(names: readonly string[]): Promise<void> { return this.withCurrent((controller) => controller.setTools(names)); }
  reload(): Promise<void> { return this.withCurrent((controller) => controller.reload()); }
  compact(customInstructions?: string): Promise<void> { return this.withCurrent((controller) => controller.compact(customInstructions)); }
  abortCompaction(): Promise<unknown> { return this.withCurrent((controller) => controller.abortCompaction()); }
  runBash(command: string, options?: { excludeFromContext?: boolean }): Promise<void> {
    return this.withCurrent((controller) => controller.runBash(command, options));
  }
  abortBash(): Promise<unknown> { return this.withCurrent((controller) => controller.abortBash()); }
  abort(): Promise<unknown> { return this.withCurrent((controller) => controller.abort()); }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): RuntimeView => this.view;

  private currentController(): SessionController | null { return this.registry.currentController(); }

  private withCurrent<T>(run: (controller: SessionController) => Promise<T>): Promise<T> {
    const controller = this.currentController();
    return controller === null ? Promise.reject(this.notAttachedError()) : run(controller);
  }

  private withExact<T>(sessionId: string, run: (controller: SessionController) => Promise<T>): Promise<T> {
    try {
      return run(this.registry.getOrCreate(sessionId));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private onRegistryChanged(): void {
    const controller = this.currentController();
    if (controller !== null) {
      const current = controller.getSnapshot();
      const seen = this.seenGenerations.get(controller.sessionId) ?? { attach: 0, history: 0 };
      if (current.attachGeneration > seen.attach) this.attachGeneration += current.attachGeneration - seen.attach;
      if (current.historyGeneration > seen.history) this.historyGeneration += current.historyGeneration - seen.history;
      this.seenGenerations.set(controller.sessionId, { attach: current.attachGeneration, history: current.historyGeneration });
    }
    this.notify();
  }

  private computeView(): RuntimeView {
    const transport = this.runtimeConnection.getSnapshot();
    const baseController = this.currentController();
    const base = baseController?.getSnapshot() ?? EMPTY_VIEW;
    const foreground = this.registry.foregroundOperationController()?.getSnapshot() ?? null;
    const lease = this.registry.leaseSnapshot;
    const connection = lease.phase === "acquiring" || lease.phase === "releasing"
      ? "attaching"
      : baseController === null ? transport.state : base.connection;
    return {
      ...base,
      connection,
      host: transport.host,
      runningSessionIds: [...transport.runningSessionIds],
      liveSessionIds: [...transport.liveSessionIds],
      liveSessionStateKnown: transport.liveSessionStateKnown,
      attachGeneration: this.attachGeneration,
      historyGeneration: this.historyGeneration,
      // Compatibility projection: the exact controller reports `liveEntries`
      // committed-only. Re-compose the OLD merged shape (authority first,
      // same-session speculative tail last) so relocated tests stay unchanged.
      liveEntries: [
        ...base.liveEntries,
        ...base.optimisticEntries
          .filter((candidate) => candidate.sessionId === base.sessionId)
          .map((candidate) => candidate.entry),
      ],
      optimisticEntries: foreground?.optimisticEntries ?? base.optimisticEntries,
      promptPending: foreground?.promptPending ?? base.promptPending,
      optimisticRunningSessionId: foreground?.optimisticRunningSessionId ?? base.optimisticRunningSessionId,
      turnActive: foreground?.turnActive ?? base.turnActive,
      turnDelivery: foreground?.turnDelivery ?? base.turnDelivery,
      error: foreground?.error ?? base.error ?? transport.error,
      fatal: transport.fatal || base.fatal || foreground?.fatal === true,
      canAgent: transport.host?.capabilities.includes("agent") === true,
      submitTurnEnabled: this.runtimeConnection.hasFeature("runtime.submit-turn.v1"),
    };
  }

  private notify(): void {
    this.view = this.computeView();
    for (const listener of this.listeners) listener();
  }

  private invalidSessionError(): ProtocolError {
    return { code: "invalid_input", message: "no session selected", retryable: false };
  }

  private notAttachedError(): ProtocolError {
    return { code: "unavailable", message: "not attached to a runtime session", retryable: false };
  }
}
