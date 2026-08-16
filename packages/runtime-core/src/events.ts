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
  /**
   * CUMULATIVE partial message (not a delta). Each update carries the full
   * in-progress message built so far. The downstream R1 Mapper diffs successive
   * cumulative partials into the Protocol `message_update.delta` (a per-event
   * diff) and synthesizes the streamId/messageId; sessiond stamps epoch/eventId.
   * Runtime Core never emits deltas or stream ids.
   */
  message: StreamingAgentMessage;
}

/**
 * message_end carries a complete message plus the canonical persisted identity
 * of the just-committed leaf entry (Protocol v2). The adapter resolves
 * `entryId`/`parentEntryId` against the backend's committed leaf BEFORE
 * publishing; an unkeyed completion is never emitted (fail closed).
 */
export interface MessageEndEvent extends RuntimeEventBase {
  type: "message_end";
  message: AgentMessage;
  /** Canonical persisted entryId of the just-committed entry. */
  entryId: string;
  parentEntryId?: string;
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
  /**
   * DELTA chunk added since the previous bash_update — NOT a cumulative snapshot.
   * This is a frozen delta semantic: the field is passed through unchanged to
   * the Protocol `bash_update.output` (same delta), and the sessiond
   * SnapshotProjection is the single accumulator. Runtime Core never emits a
   * cumulative bash output on events.
   */
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  /**
   * Canonical persisted entryId of the committed bash entry. Terminal events
   * (exitCode or cancelled present) carry it; delta-only events do not.
   */
  entryId?: string;
  parentEntryId?: string;
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
