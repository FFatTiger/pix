/**
 * Canonical runtime state and snapshot models.
 *
 * The snapshot is the recoverable projection used for attach/resume; it must
 * include in-flight streaming state, the queue, pending extension UI,
 * compaction/bash/model/tools state, capabilities and written files.
 */
import type { RuntimeCapabilitySet } from "./capabilities.js";
import type {
  AgentMessage,
  ContextUsage,
  StreamingAgentMessage,
  ThinkingLevel,
} from "./messages.js";
import type { ModelRef } from "./model.js";
import type {
  ExtensionStatusItem,
  ExtensionWidgetItem,
  PendingExtensionUi,
} from "./extension.js";
import type { QueuedMessages } from "./queue.js";
import type { ToolInfo } from "./resources.js";

export type StreamingPhase =
  | "idle"
  | "waiting_model"
  | "streaming"
  | "running_tools"
  | "compacting"
  | "bash"
  | "retrying";

/** In-flight streaming projection for reconnect UIs. */
export interface StreamingProjection {
  active: boolean;
  partialMessage?: StreamingAgentMessage;
  toolCallIds?: readonly string[];
  phase?: StreamingPhase;
}

export interface BashProjection {
  command: string;
  output: string;
  excludeFromContext: boolean;
  truncated: boolean;
  cancelled: boolean;
  completed: boolean;
  exitCode?: number;
  fullOutputPath?: string;
  /** Monotonic emitted chunk/update count for reconnect progress UIs. */
  updateCount: number;
}

export interface CompactionProjection {
  reason: "manual" | "auto";
  status: "running" | "aborting";
  customInstructions?: string;
  startedAt: number;
}

/** Canonical runtime state (get_state / snapshot). */
export interface RuntimeState {
  sessionId: string;
  sessionFile?: string;
  leafId?: string;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  bash?: BashProjection;
  compaction?: CompactionProjection;
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  model: ModelRef | null;
  messageCount: number;
  pendingMessageCount?: number;
  queuedMessages?: QueuedMessages;
  contextUsage?: ContextUsage | null;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingLevelPinned?: boolean;
  tools?: readonly ToolInfo[];
  extensionStatuses?: readonly ExtensionStatusItem[];
  extensionWidgets?: readonly ExtensionWidgetItem[];
  pendingExtensionUi?: readonly PendingExtensionUi[];
  sessionName?: string;
  /** Session-level aggregate of files written by agent turns (deduped). */
  writtenFiles?: readonly string[];
}

/** Full runtime snapshot returned by getSnapshot(). */
export interface RuntimeSnapshot {
  sessionId: string;
  state: RuntimeState;
  capabilities: RuntimeCapabilitySet;
  streaming?: StreamingProjection;
  /** Recent complete messages (cold-attach convenience; not a full dump). */
  messages?: readonly AgentMessage[];
}
