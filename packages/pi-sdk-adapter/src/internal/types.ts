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
  messages: readonly unknown[];
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
