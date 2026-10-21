import type { Model, Api } from "@earendil-works/pi-ai";
import type { AssistantOpsChannel, WorkerSessionStatusItem } from "@fffattiger/pix-protocol";
import type { SideChatController } from "./vendor/pi-side-chat/index.js";
import type { PromptDisposition, QueuedInputDisposition } from "@fffattiger/pix-runtime-core";
export type { PromptDisposition, QueuedInputDisposition };

import type {
  BuiltInRuntimeState,
  RuntimeStateChangedContext,
  ImageAttachment,
  ModelRef,
  QueuedMessages,
  QuestionnaireAnswer,
  QuestionnaireQuestion,
  RuntimeCapability,
  RuntimeCloseReason,
  RuntimeEvent,
  RuntimeStartInput,
  SlashCommandInfo,
  SubagentProjection,
  ThinkingLevel,
  TodoProjection,
  ToolInfo,
} from "@fffattiger/pix-runtime-core";

export interface DriverIdentity {
  sessionId: string;
  sessionFile: string;
  createdAt?: number;
  cwd: string;
}

export interface DriverState {
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  pendingMessageCount: number;
  sessionName?: string;
  /**
   * Active session-tree leaf (branch pointer) id, when the backend exposes one.
   * `undefined` when the session has no entries yet (fresh session). Carried
   * through the canonical snapshot so navigate/convergence observers can read
   * the authoritative leaf without a separate lookup.
   */
  leafId?: string;
  /**
   * Total committed message entries (user/assistant/toolResult/bashExecution)
   * derived WITHOUT mapping the full message history (Protocol v2: snapshots
   * must not carry transcript history). Uses the backend session stats when
   * available; falls back to the in-memory message array length only when the
   * backend exposes no stats.
   */
  messageCount: number;
  tools: readonly ToolInfo[];
  contextUsage?: { percent: number; contextWindow?: number; tokens?: number } | null;
  steering: readonly { message: string; images?: readonly ImageAttachment[] }[];
  followUp: readonly { message: string; images?: readonly ImageAttachment[] }[];
  sessionStats?: {
    messageCount: number;
    pendingMessageCount?: number;
    tokenCount?: number;
    contextUsage?: { percent: number; contextWindow?: number; tokens?: number };
  };
  lastAssistantText?: string;
  commands?: readonly SlashCommandInfo[];
  builtIns?: BuiltInRuntimeState;
  subagents?: SubagentProjection;
  todo?: TodoProjection;
}

/** The driver's narrow read returns the canonical context event shape. */
export type DriverContextState = RuntimeStateChangedContext;

export interface DriverUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "questionnaire";
  title?: string;
  message?: string;
  options?: readonly string[];
  placeholder?: string;
  prefill?: string;
  questions?: readonly QuestionnaireQuestion[];
  timeout?: number;
  settle(value: { value?: string; confirmed?: boolean; cancelled?: true; answers?: readonly QuestionnaireAnswer[] }): void;
  input?(data: string): void;
  cancel(): void;
  fail?(error: unknown): void;
  onSettled(listener: () => void): void;
}

export type DriverEventListener = (event: unknown) => void;

export interface PiRuntimeDriver {
  readonly identity: DriverIdentity;
  readonly capabilities: readonly RuntimeCapability[];
  getState(): DriverState;
  /**
   * Narrow read-lane accessors (Phase 2B). Each returns ONLY the requested
   * projection so a get_tools / get_commands read never pays for the
   * monolithic {@link getState} (which is O(all entries) via session stats).
   */
  getTools(): readonly ToolInfo[];
  getCommands(): readonly SlashCommandInfo[];
  getSessionStats(): DriverState["sessionStats"];
  getLastAssistantText(): string;
  /**
   * Narrow coherent context read (context-usage consistency). Optional so a
   * driver that cannot provide it keeps `runtime_state_changed` signal-only;
   * when present the adapter publishes the payload atomically.
   */
  getContextState?(): DriverContextState;
  subscribe(listener: DriverEventListener): () => void;
  /** Pi 1.0 input receipt: "started" (a model turn began), "handled" (an
   * extension command/input handler consumed it — NO assistant reply and NO
   * user transcript entry is owed), or "queued" (parked via steer/followUp;
   * the turn happens later). */
  prompt(message: string, images?: readonly ImageAttachment[], streamingBehavior?: "steer" | "followUp"): Promise<{ disposition: PromptDisposition }>;
  steer(message: string, images?: readonly ImageAttachment[]): Promise<QueuedInputDisposition>;
  followUp(message: string, images?: readonly ImageAttachment[]): Promise<QueuedInputDisposition>;
  /**
   * Move one still-queued turn between the steering and follow-up queues
   * (adapter command `switch_queued_delivery`). OPTIONAL: a driver that
   * cannot rebuild the SDK queues leaves it absent and the adapter fails the
   * command closed with `unavailable`. When present, it rebuilds the queues
   * by clearQueue + re-queue of ONLY the physically queued turns: an entry
   * the agent loop already drained but has not delivered yet stays untouched
   * (reported as `in_delivery`), so a switch can never duplicate or drop a
   * message. `previous` is the adapter's image-bearing queue mirror; images
   * ride along to the rebuilt entries. Delivery order stays
   * steering-then-follow-up; the moved entry lands at the end of its new list.
   */
  switchQueuedDelivery?(input: {
    address: { list: "steering" | "followUp"; index: number; message: string };
    previous: QueuedMessages;
  }): Promise<
    | { status: "switched"; queue: QueuedMessages }
    | { status: "in_delivery" }
    | { status: "stale" }
    | { status: "unavailable" }
  >;
  abort(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void> | void;
  compact(customInstructions?: string): Promise<unknown>;
  abortCompaction(): void;
  setSessionName(name: string): void;
  setAutoCompaction(enabled: boolean): void;
  setAutoRetry(enabled: boolean): void;
  clearQueue(): void;
  setTools(toolNames: readonly string[], includeExtensionTools: boolean): void;
  reload(): Promise<readonly RuntimeCapability[]>;
  /**
   * Resolve the CURRENTLY committed leaf entry identity (Protocol v2). Returns
   * undefined when the leaf is not a committed message-like entry matching the
   * expected role (no entries yet, or a structural entry like a model change
   * sits at the leaf — meaning the correlation cannot be made and the caller
   * must fail closed). `expectedRole` is the message role being completed:
   * `custom` → custom_message entry, otherwise a `message` entry (including
   * bashExecution). Structural identity only — never derived by
   * content/timestamp matching.
   */
  resolveLeafEntry(expectedRole?: string): { entryId: string; parentEntryId?: string } | undefined;
  /** Resolve the exact committed tail entries for deferred same-turn bash flushes. */
  resolveLeafEntries?(
    expectedRole: string,
    count: number,
  ): readonly { entryId: string; parentEntryId?: string }[] | undefined;
  /**
   * Persist one batch of adapter-collected nested-call results as a plain
   * SDK `custom` entry (`pix-nested-results`) right after the committed
   * parent tool-result entry. Optional: display-only enrichment — when a
   * driver cannot persist it, the live event still carries the results and
   * only reload enrichment is absent.
   */
  appendNestedResults?(payload: { version: 1; toolCallId: string; calls: readonly { id: string; text: string; truncated: boolean; imageCount: number; isError: boolean }[] }): void;
  bash(command: string, excludeFromContext: boolean, onChunk: (chunk: string) => void): Promise<{
    output: string;
    exitCode?: number;
    cancelled?: boolean;
    truncated?: boolean;
    fullOutputPath?: string;
  }>;
  abortBash(): void;
  navigate(targetId: string): Promise<void>;
  fork(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  generateSessionTitle(options?: { model?: { provider: string; modelId: string } }): Promise<string>;
  bindUi(onRequest: (request: DriverUiRequest) => void, emit: (event: RuntimeEvent) => void): Promise<void>;
  /** Create the real pinned headless side-chat controller from current parent authority. */
  createSideChatController?(): SideChatController;
  /**
   * Resolve a model selector against the SAME registry/auth the main session
   * uses for set_model (no main-session mutation). Throws "unknown model:
   * provider/id" for unregistered selectors.
   */
  resolveModel?(provider: string, modelId: string): Promise<Model<Api>>;
  close(reason: RuntimeCloseReason): Promise<void>;
}

export interface DriverFactoryOptions {
  capabilities?: readonly RuntimeCapability[];
  reloadCapabilities?: readonly RuntimeCapability[];
  /**
   * Read-only authoritative session-status channel (worker supervisor IPC;
   * only assistant workers get answers). Threading it through driver options
   * keeps the frozen AgentRuntimeFactory create/open signatures unchanged.
   */
  sessionStatus?: () => Promise<readonly WorkerSessionStatusItem[]>;
  /**
   * Write channel the assistant tools use to send/create/stop/rename other
   * sessions. Threaded through driver options so a per-open injection can
   * override the factory-captured channel without changing create/open.
   */
  assistantOps?: AssistantOpsChannel;
}

export interface PiRuntimeDriverFactory {
  create(input: RuntimeStartInput, options: DriverFactoryOptions): Promise<PiRuntimeDriver>;
  open(sessionId: string, cwd: string | undefined, model: ModelRef | undefined, options: DriverFactoryOptions): Promise<PiRuntimeDriver>;
}

export interface InitializationTraceSink {
  record(step: string): void;
}
