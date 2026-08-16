import type {
  ImageAttachment,
  ModelRef,
  RuntimeCapability,
  RuntimeCloseReason,
  RuntimeEvent,
  RuntimeStartInput,
  SlashCommandInfo,
  ThinkingLevel,
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
}

export interface DriverUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "custom";
  title?: string;
  message?: string;
  options?: readonly string[];
  placeholder?: string;
  prefill?: string;
  lines?: readonly string[];
  timeout?: number;
  settle(value: { value?: string; confirmed?: boolean; cancelled?: true }): void;
  input?(data: string): void;
  cancel(): void;
  onSettled(listener: () => void): void;
}

export type DriverEventListener = (event: unknown) => void;

export interface PiRuntimeDriver {
  readonly identity: DriverIdentity;
  readonly capabilities: readonly RuntimeCapability[];
  getState(): DriverState;
  subscribe(listener: DriverEventListener): () => void;
  prompt(message: string, images?: readonly ImageAttachment[], streamingBehavior?: "steer" | "followUp"): Promise<void>;
  steer(message: string, images?: readonly ImageAttachment[]): Promise<void>;
  followUp(message: string, images?: readonly ImageAttachment[]): Promise<void>;
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
  generateSessionTitle(): Promise<string>;
  bindUi(onRequest: (request: DriverUiRequest) => void, emit: (event: RuntimeEvent) => void): Promise<void>;
  close(reason: RuntimeCloseReason): Promise<void>;
}

export interface DriverFactoryOptions {
  capabilities?: readonly RuntimeCapability[];
  reloadCapabilities?: readonly RuntimeCapability[];
}

export interface PiRuntimeDriverFactory {
  create(input: RuntimeStartInput, options: DriverFactoryOptions): Promise<PiRuntimeDriver>;
  open(sessionId: string, cwd: string | undefined, model: ModelRef | undefined, options: DriverFactoryOptions): Promise<PiRuntimeDriver>;
}

export interface InitializationTraceSink {
  record(step: string): void;
}
