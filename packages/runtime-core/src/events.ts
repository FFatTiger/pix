/**
 * Canonical runtime events.
 *
 * Events are the realtime projection of a runtime. Wire concerns such as
 * event ids, epochs and resume cursors are Protocol-layer concepts and are
 * intentionally absent here; events carry session identity plus product
 * semantics only.
 */
import type { RuntimeCapabilitySet } from "./capabilities.js";
import type {
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
} from "./extension.js";
import type { RuntimeCloseReason } from "./identity.js";
import type { AgentMessage, StreamingAgentMessage } from "./messages.js";
import type { QueuedTurn } from "./queue.js";
import type { RuntimeError } from "./errors.js";

export interface RuntimeEventBase {
  sessionId: string;
  ts?: number;
}

export interface AgentStartEvent extends RuntimeEventBase {
  type: "agent_start";
}

export interface AgentEndEvent extends RuntimeEventBase {
  type: "agent_end";
}

export interface AgentSettledEvent extends RuntimeEventBase {
  type: "agent_settled";
}

export interface PromptDoneEvent extends RuntimeEventBase {
  type: "prompt_done";
}

export interface PromptErrorEvent extends RuntimeEventBase {
  type: "prompt_error";
  errorMessage: string;
  error?: RuntimeError;
}

export interface MessageStartEvent extends RuntimeEventBase {
  type: "message_start";
  message: StreamingAgentMessage;
}

export interface MessageUpdateEvent extends RuntimeEventBase {
  type: "message_update";
  message: StreamingAgentMessage;
}

/** message_end carries a complete message only. */
export interface MessageEndEvent extends RuntimeEventBase {
  type: "message_end";
  message: AgentMessage;
}

export interface ToolExecutionStartEvent extends RuntimeEventBase {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args?: unknown;
}

export interface ToolExecutionUpdateEvent extends RuntimeEventBase {
  type: "tool_execution_update";
  toolCallId: string;
  toolName?: string;
  partialResult?: unknown;
}

export interface ToolExecutionEndEvent extends RuntimeEventBase {
  type: "tool_execution_end";
  toolCallId: string;
  toolName?: string;
  isError?: boolean;
  result?: unknown;
  /** Files this tool execution wrote or modified. */
  writtenFiles?: readonly string[];
}

export interface QueueUpdateEvent extends RuntimeEventBase {
  type: "queue_update";
  steering?: readonly QueuedTurn[];
  followUp?: readonly QueuedTurn[];
}

export interface AutoRetryStartEvent extends RuntimeEventBase {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

export interface AutoRetryEndEvent extends RuntimeEventBase {
  type: "auto_retry_end";
  success?: boolean;
}

export interface CompactionStartEvent extends RuntimeEventBase {
  type: "compaction_start";
  reason?: string;
}

export interface CompactionEndEvent extends RuntimeEventBase {
  type: "compaction_end";
  reason?: string;
  aborted?: boolean;
  errorMessage?: string;
  result?: unknown;
}

export interface AutoCompactionStartEvent extends RuntimeEventBase {
  type: "auto_compaction_start";
}

export interface AutoCompactionEndEvent extends RuntimeEventBase {
  type: "auto_compaction_end";
  aborted?: boolean;
  errorMessage?: string;
  result?: unknown;
}

export interface BashUpdateEvent extends RuntimeEventBase {
  type: "bash_update";
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
}

export interface ExtensionErrorEvent extends RuntimeEventBase {
  type: "extension_error";
  error: string;
  details?: unknown;
}

export interface ExtensionUiRequestEvent extends RuntimeEventBase {
  type: "extension_ui_request";
  request: ExtensionUiRequest;
}

export interface ExtensionStatusesEvent extends RuntimeEventBase {
  type: "extension_statuses";
  statuses: readonly ExtensionStatusItem[];
}

export interface ExtensionWidgetsEvent extends RuntimeEventBase {
  type: "extension_widgets";
  widgets: readonly ExtensionWidgetItem[];
}

export interface SessionTitleEvent extends RuntimeEventBase {
  type: "session_title";
  name: string;
}

/** State changed; the authoritative state is available via getSnapshot(). */
export interface RuntimeStateChangedEvent extends RuntimeEventBase {
  type: "runtime_state_changed";
}

/** Capability set changed (e.g. after reload). */
export interface RuntimeCapabilitiesChangedEvent extends RuntimeEventBase {
  type: "runtime_capabilities_changed";
  capabilities: RuntimeCapabilitySet;
}

export interface RuntimeErrorEvent extends RuntimeEventBase {
  type: "runtime_error";
  error: RuntimeError;
}

/** The runtime has ended; no further events will be delivered. */
export interface RuntimeClosedEvent extends RuntimeEventBase {
  type: "runtime_closed";
  reason: RuntimeCloseReason;
}

export type RuntimeEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentSettledEvent
  | PromptDoneEvent
  | PromptErrorEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | QueueUpdateEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | AutoCompactionStartEvent
  | AutoCompactionEndEvent
  | BashUpdateEvent
  | ExtensionErrorEvent
  | ExtensionUiRequestEvent
  | ExtensionStatusesEvent
  | ExtensionWidgetsEvent
  | SessionTitleEvent
  | RuntimeStateChangedEvent
  | RuntimeCapabilitiesChangedEvent
  | RuntimeErrorEvent
  | RuntimeClosedEvent;
