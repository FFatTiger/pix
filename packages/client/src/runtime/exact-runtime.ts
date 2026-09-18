/**
 * Exact-session runtime view/types + action factory (Phase 4A.3.2a).
 *
 * Pure, React-free module: defines the EXACT per-session projection and the
 * ID-bound action surface consumed by the React exact hooks. This keeps the
 * exact view/types for the provider-owned registry/connection and gives the
 * UI a narrow, non-owning surface:
 *
 *  - `ExactRuntimeView` carries ONLY exact-session fields (no global host /
 *    running / fatal, no optimisticRunningSessionId);
 *  - `RuntimeConnectionApi` carries ONLY connection-global fields;
 *  - actions are ID-bound: they admit on invocation via the injected registry
 *    (never during render) and the caller never passes a session ID;
 *  - all actions delegate to the SAME injected registry/controller instances
 *    the provider owns — this module never constructs a second owner.
 */
import type {
  ExtensionUiRequest,
  ImageAttachment,
  ProtocolError,
  RuntimeCapabilitySet,
  RuntimeCommand,
  RuntimeSnapshot,
  RuntimeState,
  SessionEntry,
  SessionStats,
  SlashCommandInfo,
  StreamingAgentMessage,
  ThinkingLevel,
  ToolInfo,
} from "@fffattiger/pix-protocol";
import type {
  RuntimeConnectionView,
} from "./runtime-connection.js";
import type {
  ControllerView,
  ExtensionUiReply,
  OptimisticSessionEntry,
  PromptActivationSettings,
  SessionController,
  TurnDelivery,
  TurnTerminalInfo,
} from "./session-controller.js";
import type { SessionControllerRegistry } from "./session-controller-registry.js";
import { createDefaultIdFactory } from "./correlation.js";

/** Fresh command ids for the read-only exact UI helper (navigateTree). */
const uiCommandId = createDefaultIdFactory();

/** Exact-session reactive projection. NO global host/running/fatal/optimisticRunningSessionId. */
export interface ExactRuntimeView {
  /**
   * False when no exact controller is registered for the bound sessionId
   * (absent or evicted). The wrapper keeps the exact sessionId and the full
   * action surface; `acquire`/actions re-admit on invocation.
   */
  readonly available: boolean;
  /** Exact bound session id — always present, never inferred from URL/attached. */
  readonly sessionId: string;
  readonly attached: boolean;
  readonly stopped: boolean;
  readonly epoch: string | null;
  readonly snapshot: RuntimeSnapshot | null;
  readonly streaming: boolean;
  readonly partial: StreamingAgentMessage | null;
  readonly promptPending: boolean;
  readonly attachGeneration: number;
  readonly historyGeneration: number;
  readonly historyAnchorLeafId: string | null;
  /**
   * Authoritative-settings eligibility for the admission→observation gap:
   * true while this exact controller's snapshot is the ACCEPTED admission's
   * authoritative snapshot and no history-layer transition (fresh attach /
   * rebase / detach / stop / session switch) or later presentation reselect
   * superseded it. Consumers may surface its model/thinking; it is NOT
   * attached/running state (never gates WS/running/presentation leases).
   */
  readonly hasAdmittedSnapshot: boolean;
  /** Browser-local identity-only create carried automatic thinking intent. */
  readonly createdWithAutoThinking: boolean;
  /** Committed live entries only; optimism lives exclusively in {@link optimisticEntries}. */
  readonly liveEntries: readonly SessionEntry[];
  readonly optimisticEntries: readonly OptimisticSessionEntry[];
  readonly error: ProtocolError | null;
  readonly queuedTurnPending: boolean;
  readonly extensionUiReplyPending: boolean;
  readonly capabilities: RuntimeCapabilitySet | null;
  readonly turnActive: boolean;
  readonly turnDelivery: TurnDelivery | null;
}

/**
 * Exact submit-turn input without a session id (the caller never passes the
 * session id — the hook injects the bound sessionId).
 */
export type ExactSubmitTurnInput = {
  readonly prompt: string;
  readonly images?: readonly ImageAttachment[];
  readonly activationOverrides?: {
    readonly model?: { provider: string; modelId: string } | null;
    readonly thinkingLevel?: ThinkingLevel | null;
  };
  readonly expectedEpoch?: string;
  readonly expectedRevision?: number;
};

/** Exact ID-bound actions + exact view. Method refs are STABLE across admission/eviction/rebind/reconnect. */
export interface ExactRuntimeApi extends ExactRuntimeView {
  /**
   * LC-02 observation-only acquisition of the one Browser attachment lease for
   * this exact session (requires negotiated `runtime.observe-existing.v1`;
   * attachMode `existing_only` on every attempt; never activates a Worker and
   * never falls back to the legacy acquiring attach).
   */
  readonly observeExisting: () => Promise<void>;
  /**
   * LC-02 explicit cold activation → observation, for already-listed explicit
   * non-prompt actions only (cold Compact). Requires negotiated
   * `runtime.explicit-activate.v1`; never sends a prompt and never auto-retries
   * the activation after a disconnect.
   */
  readonly activateAndObserve: () => Promise<void>;
  /**
   * FINITE Protocol-v2 compatibility: legacy acquiring attach (see the
   * registry shim doc). Production observation callers use
   * {@link observeExisting}; cold-explicit callers use
   * {@link activateAndObserve}.
   */
  readonly acquire: () => Promise<void>;
  /** Authoritative stop of this exact session. */
  readonly stop: (reason?: string) => Promise<void>;
  readonly fetchSnapshot: () => Promise<RuntimeSnapshot | null>;
  readonly sendCommand: (command: RuntimeCommand) => Promise<unknown>;
  readonly sendPrompt: (message: string, images?: readonly ImageAttachment[]) => Promise<unknown>;
  readonly submitTurn: (input: ExactSubmitTurnInput) => Promise<unknown>;
  readonly subscribeTurnTerminal: (listener: (terminal: TurnTerminalInfo) => void) => () => void;
  readonly sendPromptToSession: (
    message: string,
    images?: readonly ImageAttachment[],
    activationSettings?: PromptActivationSettings,
  ) => Promise<unknown>;
  readonly respondExtensionUi: (request: ExtensionUiRequest, reply: ExtensionUiReply) => Promise<void>;
  readonly sendExtensionUiInput: (request: ExtensionUiRequest, data: string) => Promise<void>;
  readonly steer: (message: string, images?: readonly ImageAttachment[]) => Promise<unknown>;
  readonly followUp: (message: string, images?: readonly ImageAttachment[]) => Promise<unknown>;
  readonly clearQueue: () => Promise<unknown>;
  readonly runBash: (command: string, options?: { excludeFromContext?: boolean }) => Promise<void>;
  readonly abortBash: () => Promise<unknown>;
  readonly abort: () => Promise<unknown>;
  readonly getState: () => Promise<RuntimeState>;
  readonly getCommands: () => Promise<readonly SlashCommandInfo[]>;
  readonly getLastAssistantText: () => Promise<string>;
  readonly getSessionStats: () => Promise<SessionStats>;
  readonly setSessionName: (name: string) => Promise<void>;
  readonly setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  readonly setModel: (provider: string, modelId: string) => Promise<void>;
  readonly getTools: () => Promise<readonly ToolInfo[]>;
  readonly setTools: (names: readonly string[]) => Promise<void>;
  readonly reload: () => Promise<void>;
  readonly compact: (customInstructions?: string) => Promise<void>;
  readonly abortCompaction: () => Promise<unknown>;
  readonly navigateTree: (targetId: string) => Promise<unknown>;
  /** Registry-backed create (global; the single registry owns create authority). */
  readonly createSession: (params: { cwd: string; projectRoot: string }) => Promise<{ sessionId: string }>;
}

/** Connection-global reactive + actions. No exact/lease actions. */
export interface RuntimeConnectionApi extends RuntimeConnectionView {
  readonly connect: () => void;
  /** Read fresh stats from an already-live session without acquiring attachment. */
  readonly getLiveSessionStats: (sessionId: string) => Promise<SessionStats>;
  /** Send to an already-live session using an epoch-fenced global attempt; never activates or attaches. */
  readonly sendLiveSessionCommand: (sessionId: string, command: RuntimeCommand) => Promise<unknown>;
  /** Registry-backed create — delegates to the injected registry (no second owner). */
  readonly createSession: (params: { cwd: string; projectRoot: string }) => Promise<{ sessionId: string }>;
}

/** Stable wrapper for an absent/evicted exact session: available:false, exact id, null authority. */
export function emptyExactView(sessionId: string): ExactRuntimeView {
  return {
    available: false,
    sessionId,
    attached: false,
    stopped: false,
    epoch: null,
    snapshot: null,
    streaming: false,
    partial: null,
    promptPending: false,
    attachGeneration: 0,
    historyGeneration: 0,
    historyAnchorLeafId: null,
    hasAdmittedSnapshot: false,
    createdWithAutoThinking: false,
    liveEntries: [],
    optimisticEntries: [],
    error: null,
    queuedTurnPending: false,
    extensionUiReplyPending: false,
    capabilities: null,
    turnActive: false,
    turnDelivery: null,
  };
}

/** Project the exact-session subset of a ControllerView. */
export function projectExactView(sessionId: string, view: ControllerView): ExactRuntimeView {
  return {
    available: true,
    sessionId,
    attached: view.attached,
    stopped: view.sessionStopped,
    epoch: view.epoch,
    snapshot: view.snapshot,
    streaming: view.streaming,
    partial: view.streamingPartial,
    promptPending: view.promptPending,
    attachGeneration: view.attachGeneration,
    historyGeneration: view.historyGeneration,
    historyAnchorLeafId: view.historyAnchorLeafId,
    hasAdmittedSnapshot: view.hasAdmittedSnapshot,
    createdWithAutoThinking: view.createdWithAutoThinking,
    liveEntries: view.liveEntries,
    optimisticEntries: view.optimisticEntries,
    error: view.error,
    queuedTurnPending: view.queuedTurnPending,
    extensionUiReplyPending: view.extensionUiReplyPending,
    capabilities: view.capabilities,
    turnActive: view.turnActive,
    turnDelivery: view.turnDelivery,
  };
}

/** Build the immutable exact snapshot for the hook's useSyncExternalStore getSnapshot. */
export function buildExactSnapshot(registry: SessionControllerRegistry, sessionId: string): ExactRuntimeView {
  const controller = registry.peek(sessionId);
  if (controller === null) return emptyExactView(sessionId);
  return projectExactView(sessionId, controller.getSnapshot());
}

/** Stable per-session action refs. Actions admit ONLY on invocation (getOrCreate) and are ID-bound. */
export function createExactActions(
  registry: SessionControllerRegistry,
  sessionId: string,
): Omit<ExactRuntimeApi, keyof ExactRuntimeView> {
  const withController = <T>(run: (controller: SessionController) => Promise<T>): Promise<T> => {
    let controller: SessionController;
    try {
      controller = registry.getOrCreate(sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    try {
      return run(controller);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    acquire: () => registry.acquire(sessionId),
    observeExisting: () => registry.observeExisting(sessionId),
    activateAndObserve: () => registry.activateAndObserve(sessionId),
    // Route stop through the registry so a CONFIRMED stop (`stopped:true`)
    // clears the exact semantic attachment lease (same strict semantics as the
    // facade's store.stop()). A `stopped:false` ack keeps the lease/pending
    // state; an absent session is a no-op (never admitted for stop).
    stop: (reason) => registry.stop(sessionId, reason),
    fetchSnapshot: () => withController((controller) => controller.fetchSnapshot()),
    sendCommand: (command) => withController((controller) => controller.sendCommand(command)),
    sendPrompt: (message, images) => withController((controller) => controller.sendPrompt(message, images)),
    submitTurn: (input) => withController((controller) => controller.submitTurn({ ...input, sessionId })),
    subscribeTurnTerminal: (listener) => registry.subscribeTurnTerminal((terminal) => {
      if (terminal.sessionId === sessionId) listener(terminal);
    }),
    sendPromptToSession: (message, images, activationSettings) =>
      withController((controller) => controller.sendPromptToSession(sessionId, message, images, activationSettings)),
    respondExtensionUi: (request, reply) => withController((controller) => controller.respondExtensionUi(request, reply)),
    sendExtensionUiInput: (request, data) => withController((controller) => controller.sendExtensionUiInput(request, data)),
    steer: (message, images) => withController((controller) => controller.steer(message, images)),
    followUp: (message, images) => withController((controller) => controller.followUp(message, images)),
    clearQueue: () => withController((controller) => controller.clearQueue()),
    runBash: (command, options) => withController((controller) => controller.runBash(command, options)),
    abortBash: () => withController((controller) => controller.abortBash()),
    abort: () => withController((controller) => controller.abort()),
    getState: () => withController((controller) => controller.getState()),
    getCommands: () => withController((controller) => controller.getCommands()),
    getLastAssistantText: () => withController((controller) => controller.getLastAssistantText()),
    getSessionStats: () => withController((controller) => controller.getSessionStats()),
    setSessionName: (name) => withController((controller) => controller.setSessionName(name)),
    setThinkingLevel: (level) => withController((controller) => controller.setThinkingLevel(level)),
    setModel: (provider, modelId) => withController((controller) => controller.setModel(provider, modelId)),
    getTools: () => withController((controller) => controller.getTools()),
    setTools: (names) => withController((controller) => controller.setTools(names)),
    reload: () => withController((controller) => controller.reload()),
    compact: (customInstructions) => withController((controller) => controller.compact(customInstructions)),
    abortCompaction: () => withController((controller) => controller.abortCompaction()),
    navigateTree: (targetId) =>
      withController((controller) => controller.sendCommand({ commandId: uiCommandId(), type: "navigate_tree", targetId })),
    createSession: (params) => registry.createSession(params),
  };
}
