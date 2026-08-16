/**
 * StatefulRuntimeMapper — the core Core RuntimeEvent → Protocol RuntimeEventData
 * projection.
 *
 * One Core event may map to 0..N Protocol events (a single cumulative
 * `message_update` can yield multiple append-only deltas, or zero on a
 * duplicate). All outputs are fresh plain objects validated downstream by the
 * transport's `WorkerToSessiondPushSchema` gate.
 *
 * Streaming semantics (see D): Core `message_update` is a CUMULATIVE partial.
 * The mapper keeps a deep-cloned baseline per active stream and diffs successive
 * cumulative partials into append-only deltas. Duplicate cumulative → no output.
 * Any non-prefix / irreducible mutation does NOT fabricate a `message_end`; it
 * resets the stream, mints fresh ids and emits a new `message_start` so the
 * sessiond projection authoritatively replaces the stale partial.
 */
import type { RuntimeEventData } from "@fffattiger/pix-protocol";
import type {
  AgentMessage,
  RuntimeEvent,
  StreamingAgentMessage,
} from "@fffattiger/pix-runtime-core";
import { StreamIdMinter, type StreamIds } from "./ids.js";
import { diffSameRole } from "./message-diff.js";
import { runtimeErrorToProtocolError } from "./protocol-error.js";
import {
  mapAgentMessage,
  mapCapabilitySet,
  mapExtensionStatuses,
  mapExtensionUiRequest,
  mapExtensionWidgets,
  mapQueuedMessages,
  mapStreamingMessage,
  mapQueuedTurns,
} from "./core-to-protocol.js";

export interface ActiveStream {
  readonly streamId: string;
  readonly messageId: string;
  readonly role: StreamingAgentMessage["role"];
  readonly baseline: StreamingAgentMessage;
}

export interface MapperDiagnosticSink {
  (message: string): void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ts(event: { ts?: number }) {
  return event.ts === undefined ? {} : { ts: event.ts };
}

/** Map a complete AgentMessage into its StreamingAgentMessage form (Core→Core) for a restart start. */
function completeToStreaming(message: AgentMessage): StreamingAgentMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content, ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }) };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        model: message.model,
        provider: message.provider,
        ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        ...(message.usage === undefined ? {} : { usage: message.usage }),
        ...(message.writtenFiles === undefined ? {} : { writtenFiles: message.writtenFiles }),
      };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
        content: message.content,
        ...(message.isError === undefined ? {} : { isError: message.isError }),
        ...(message.details === undefined ? {} : { details: message.details }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "custom":
      return {
        role: "custom",
        customType: message.customType,
        content: message.content,
        display: message.display,
        ...(message.details === undefined ? {} : { details: message.details }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "bashExecution":
      return {
        role: "bashExecution",
        command: message.command,
        output: message.output,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.cancelled === undefined ? {} : { cancelled: message.cancelled }),
        ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
        ...(message.fullOutputPath === undefined ? {} : { fullOutputPath: message.fullOutputPath }),
        ...(message.excludeFromContext === undefined ? {} : { excludeFromContext: message.excludeFromContext }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
  }
}

export class StatefulRuntimeMapper {
  private readonly minter = new StreamIdMinter();
  private readonly diagnostic: MapperDiagnosticSink | undefined;
  private stream: ActiveStream | null = null;

  constructor(diagnostic?: MapperDiagnosticSink) {
    this.diagnostic = diagnostic;
  }

  /** Read the active stream (used by the snapshot mapper). */
  getActiveStream(): ActiveStream | null {
    return this.stream;
  }

  /** Mint ids and establish a baseline for a partial when the snapshot is active but the mapper has no stream yet. */
  activateFromPartial(partial: StreamingAgentMessage): StreamIds {
    if (this.stream !== null) return { streamId: this.stream.streamId, messageId: this.stream.messageId };
    const ids = this.minter.mint();
    this.stream = {
      streamId: ids.streamId,
      messageId: ids.messageId,
      role: partial.role,
      baseline: clone(partial),
    };
    return ids;
  }

  /** Clear the active stream (inactive snapshot / runtime_closed / reset). */
  clearActiveStream(): void {
    this.stream = null;
  }

  private recordDiagnostic(message: string): void {
    this.diagnostic?.(message);
  }

  private startStream(sessionId: string, message: StreamingAgentMessage, eventTs?: number): RuntimeEventData[] {
    const ids = this.minter.mint();
    this.stream = {
      streamId: ids.streamId,
      messageId: ids.messageId,
      role: message.role,
      baseline: clone(message),
    };
    const event: RuntimeEventData = {
      type: "message_start",
      sessionId,
      streamId: ids.streamId,
      messageId: ids.messageId,
      message: mapStreamingMessage(message),
      ...(eventTs === undefined ? {} : { ts: eventTs }),
    };
    return [event];
  }

  /** Project a single Core event to 0..N Protocol events. */
  mapEvent(event: RuntimeEvent): RuntimeEventData[] {
    const sessionId = event.sessionId;
    switch (event.type) {
      case "agent_start":
        return [{ type: "agent_start", sessionId, ...ts(event) }];
      case "agent_end":
        return [{ type: "agent_end", sessionId, ...ts(event) }];
      case "agent_settled":
        return [{ type: "agent_settled", sessionId, ...ts(event) }];
      case "prompt_done":
        return [{ type: "prompt_done", sessionId, ...ts(event) }];
      case "prompt_error": {
        const out: RuntimeEventData = {
          type: "prompt_error",
          sessionId,
          errorMessage: event.errorMessage,
          ...(event.error === undefined ? {} : { error: runtimeErrorToProtocolError(event.error) }),
          ...ts(event),
        };
        return [out];
      }
      case "message_start":
        return this.startStream(sessionId, event.message, event.ts);
      case "message_update":
        return this.handleUpdate(sessionId, event.message, event.ts);
      case "message_end":
        return this.handleEnd(sessionId, event.message, event.entryId, event.parentEntryId, event.ts);
      case "tool_execution_start":
        return [
          {
            type: "tool_execution_start",
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.args === undefined ? {} : { args: event.args }),
            ...ts(event),
          },
        ];
      case "tool_execution_update":
        return [
          {
            type: "tool_execution_update",
            sessionId,
            toolCallId: event.toolCallId,
            ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
            ...(event.partialResult === undefined ? {} : { partialResult: event.partialResult }),
            ...ts(event),
          },
        ];
      case "tool_execution_end":
        return [
          {
            type: "tool_execution_end",
            sessionId,
            toolCallId: event.toolCallId,
            ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
            ...(event.isError === undefined ? {} : { isError: event.isError }),
            ...(event.result === undefined ? {} : { result: event.result }),
            ...(event.writtenFiles === undefined ? {} : { writtenFiles: [...event.writtenFiles] }),
            ...ts(event),
          },
        ];
      case "queue_update":
        return [
          {
            type: "queue_update",
            sessionId,
            ...(event.steering === undefined ? {} : { steering: mapQueuedTurns(event.steering) }),
            ...(event.followUp === undefined ? {} : { followUp: mapQueuedTurns(event.followUp) }),
            ...ts(event),
          },
        ];
      case "auto_retry_start":
        return [
          {
            type: "auto_retry_start",
            sessionId,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
            ...ts(event),
          },
        ];
      case "auto_retry_end":
        return [
          {
            type: "auto_retry_end",
            sessionId,
            ...(event.success === undefined ? {} : { success: event.success }),
            ...ts(event),
          },
        ];
      case "compaction_start":
        return [
          {
            type: "compaction_start",
            sessionId,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...ts(event),
          },
        ];
      case "compaction_end":
        return [
          {
            type: "compaction_end",
            sessionId,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.aborted === undefined ? {} : { aborted: event.aborted }),
            ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
            ...(event.result === undefined ? {} : { result: event.result }),
            ...ts(event),
          },
        ];
      case "auto_compaction_start":
        return [{ type: "auto_compaction_start", sessionId, ...ts(event) }];
      case "auto_compaction_end":
        return [
          {
            type: "auto_compaction_end",
            sessionId,
            ...(event.aborted === undefined ? {} : { aborted: event.aborted }),
            ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
            ...(event.result === undefined ? {} : { result: event.result }),
            ...ts(event),
          },
        ];
      case "bash_update":
        // Per-event delta pass-through (A1 guarantees Core output is already a delta).
        return [
          {
            type: "bash_update",
            sessionId,
            ...(event.command === undefined ? {} : { command: event.command }),
            ...(event.output === undefined ? {} : { output: event.output }),
            ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
            ...(event.cancelled === undefined ? {} : { cancelled: event.cancelled }),
            ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
            ...(event.fullOutputPath === undefined ? {} : { fullOutputPath: event.fullOutputPath }),
            ...(event.excludeFromContext === undefined ? {} : { excludeFromContext: event.excludeFromContext }),
            ...(event.entryId === undefined ? {} : { entryId: event.entryId }),
            ...(event.parentEntryId === undefined ? {} : { parentEntryId: event.parentEntryId }),
            ...ts(event),
          },
        ];
      case "extension_error":
        return [
          {
            type: "extension_error",
            sessionId,
            error: event.error,
            ...(event.details === undefined ? {} : { details: event.details }),
            ...ts(event),
          },
        ];
      case "extension_ui_request":
        return [
          {
            type: "extension_ui_request",
            sessionId,
            request: mapExtensionUiRequest(event.request),
            ...ts(event),
          },
        ];
      case "extension_statuses":
        return [
          {
            type: "extension_statuses",
            sessionId,
            statuses: mapExtensionStatuses(event.statuses) ?? [],
            ...ts(event),
          },
        ];
      case "extension_widgets":
        return [
          {
            type: "extension_widgets",
            sessionId,
            widgets: mapExtensionWidgets(event.widgets) ?? [],
            ...ts(event),
          },
        ];
      case "session_title":
        return [{ type: "session_title", sessionId, name: event.name, ...ts(event) }];
      case "runtime_state_changed":
        return [{ type: "runtime_state_changed", sessionId, ...ts(event) }];
      case "runtime_capabilities_changed":
        return [
          {
            type: "runtime_capabilities_changed",
            sessionId,
            capabilities: mapCapabilitySet(event.capabilities),
            ...ts(event),
          },
        ];
      case "runtime_error":
        return [
          {
            type: "runtime_error",
            sessionId,
            error: runtimeErrorToProtocolError(event.error),
            ...ts(event),
          },
        ];
      case "runtime_closed":
        // Terminal: clear the active stream. No further events are expected.
        this.stream = null;
        return [{ type: "runtime_closed", sessionId, reason: event.reason, ...ts(event) }];
    }
  }

  private handleUpdate(sessionId: string, message: StreamingAgentMessage, eventTs: number | undefined): RuntimeEventData[] {
    const current = this.stream;
    // No active stream, or role change → restart with a fresh message_start.
    if (current === null || current.role !== message.role) {
      if (current !== null) this.recordDiagnostic("message_update role changed; restarting stream");
      return this.startStream(sessionId, message, eventTs);
    }
    const result = diffSameRole(current.baseline, message);
    if (result.kind === "restart") {
      this.recordDiagnostic("message_update non-prefix mutation; restarting stream");
      this.stream = null;
      return this.startStream(sessionId, message, eventTs);
    }
    // Advance the baseline to the new cumulative regardless of delta count.
    this.stream = { ...current, baseline: clone(message) };
    if (result.deltas.length === 0) return []; // duplicate cumulative — no output
    return result.deltas.map((delta): RuntimeEventData => {
      const event: RuntimeEventData = {
        type: "message_update",
        sessionId,
        streamId: current.streamId,
        messageId: current.messageId,
        delta,
      };
      if (eventTs !== undefined) (event as { ts?: number }).ts = eventTs;
      return event;
    });
  }

  private handleEnd(sessionId: string, message: AgentMessage, entryId: string, parentEntryId: string | undefined, eventTs: number | undefined): RuntimeEventData[] {
    const current = this.stream;
    const out: RuntimeEventData[] = [];
    if (current === null || current.role !== message.role) {
      // Out-of-order end with no matching active stream: restart with start+end.
      // The complete message satisfies the Streaming schema, so emit a fresh
      // message_start (new ids) followed by the authoritative message_end.
      this.recordDiagnostic("message_end without matching active stream; emitting start+end");
      const startIds = this.minter.mint();
      this.stream = {
        streamId: startIds.streamId,
        messageId: startIds.messageId,
        role: message.role,
        baseline: clone(completeToStreaming(message)),
      };
      const start: RuntimeEventData = {
        type: "message_start",
        sessionId,
        streamId: startIds.streamId,
        messageId: startIds.messageId,
        message: mapStreamingMessage(completeToStreaming(message)),
      };
      if (eventTs !== undefined) (start as { ts?: number }).ts = eventTs;
      out.push(start);
      const end: RuntimeEventData = {
        type: "message_end",
        sessionId,
        streamId: startIds.streamId,
        messageId: startIds.messageId,
        message: mapAgentMessage(message),
        entryId,
        ...(parentEntryId === undefined ? {} : { parentEntryId }),
      };
      if (eventTs !== undefined) (end as { ts?: number }).ts = eventTs;
      this.stream = null;
      out.push(end);
      return out;
    }
    const end: RuntimeEventData = {
      type: "message_end",
      sessionId,
      streamId: current.streamId,
      messageId: current.messageId,
      message: mapAgentMessage(message),
      entryId,
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
      ...(eventTs === undefined ? {} : { ts: eventTs }),
    };
    this.stream = null;
    return [end];
  }
}
