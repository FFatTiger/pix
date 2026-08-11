import type {
  RuntimeEventData,
  RuntimeSnapshot,
  RuntimeState,
  StreamingAgentMessage,
  StreamingMessageDelta,
} from "@fffattiger/pi-web-protocol";

const clone = <T>(value: T): T => structuredClone(value);

function applyDelta(message: StreamingAgentMessage, delta: StreamingMessageDelta): StreamingAgentMessage {
  if (message.role !== delta.role) throw new Error("stream role mismatch");
  switch (delta.role) {
    case "assistant": {
      if (message.role !== "assistant") throw new Error("stream role mismatch");
      const content = [...(message.content ?? [])];
      if (delta.delta.type === "text") content.push({ type: "text", text: delta.delta.text });
      else if (delta.delta.type === "thinking") content.push({ type: "thinking", thinking: delta.delta.thinking });
      else content.push({ type: "toolCall", toolCallId: delta.delta.toolCallId, toolName: delta.delta.toolName, input: delta.delta.input });
      return { ...message, content };
    }
    case "toolResult": {
      if (message.role !== "toolResult") throw new Error("stream role mismatch");
      if (message.toolCallId !== undefined && message.toolCallId !== delta.toolCallId) throw new Error("tool call mismatch");
      const content = [...(message.content ?? [])];
      if (delta.delta.type === "text") content.push({ type: "text", text: delta.delta.text });
      else content.push(delta.delta.image);
      return { ...message, toolCallId: delta.toolCallId, content };
    }
    case "custom": {
      if (message.role !== "custom") throw new Error("stream role mismatch");
      const previous = typeof message.content === "string" ? message.content : "";
      return { ...message, customType: delta.customType, content: `${previous}${delta.delta.text}` };
    }
    case "bashExecution": {
      if (message.role !== "bashExecution") throw new Error("stream role mismatch");
      if (delta.delta.type === "output") return { ...message, output: `${message.output ?? ""}${delta.delta.output}` };
      return { ...message, ...delta.delta };
    }
  }
}

export class SnapshotProjection {
  private snapshotValue: RuntimeSnapshot;

  constructor(initial: RuntimeSnapshot) {
    this.snapshotValue = clone(initial);
  }

  snapshot(): RuntimeSnapshot { return clone(this.snapshotValue); }

  replace(snapshot: RuntimeSnapshot): void {
    this.snapshotValue = clone(snapshot);
  }

  rekey(sessionId: string): void {
    this.snapshotValue.sessionId = sessionId;
    this.snapshotValue.state.sessionId = sessionId;
  }

  apply(event: RuntimeEventData): void {
    if (event.sessionId !== this.snapshotValue.sessionId) throw new Error("event session mismatch");
    const snapshot = this.snapshotValue;
    const state: RuntimeState = snapshot.state;
    switch (event.type) {
      case "message_start":
        snapshot.streaming = { active: true, streamId: event.streamId, messageId: event.messageId, partialMessage: clone(event.message), phase: "streaming" };
        state.isStreaming = true;
        break;
      case "message_update": {
        const stream = snapshot.streaming;
        if (!stream?.active || stream.streamId !== event.streamId || stream.messageId !== event.messageId || stream.partialMessage === undefined) throw new Error("stale or uncorrelated stream update");
        stream.partialMessage = applyDelta(stream.partialMessage, event.delta);
        break;
      }
      case "message_end": {
        const stream = snapshot.streaming;
        if (!stream?.active || stream.streamId !== event.streamId || stream.messageId !== event.messageId) throw new Error("stale or uncorrelated stream end");
        snapshot.messages = [...(snapshot.messages ?? []), clone(event.message)];
        snapshot.streaming = { active: false, phase: "idle" };
        state.isStreaming = false;
        state.messageCount = snapshot.messages.length;
        break;
      }
      case "queue_update":
        state.queuedMessages = { steering: clone(event.steering ?? []), followUp: clone(event.followUp ?? []) };
        state.pendingMessageCount = state.queuedMessages.steering.length + state.queuedMessages.followUp.length;
        break;
      case "extension_ui_request":
        state.pendingExtensionUi = [...(state.pendingExtensionUi ?? []).filter((item) => item.id !== event.request.id), clone(event.request)];
        break;
      case "extension_statuses": state.extensionStatuses = clone(event.statuses); break;
      case "extension_widgets": state.extensionWidgets = clone(event.widgets); break;
      case "runtime_capabilities_changed": snapshot.capabilities = clone(event.capabilities); break;
      case "session_title": state.sessionName = event.name; break;
      case "bash_update": {
        const existing = state.bash;
        const command = event.command ?? existing?.command ?? "";
        const completed = event.exitCode !== undefined || event.cancelled === true;
        state.bash = {
          command,
          output: event.output === undefined ? (existing?.output ?? "") : `${existing?.output ?? ""}${event.output}`,
          excludeFromContext: event.excludeFromContext ?? existing?.excludeFromContext ?? false,
          truncated: event.truncated ?? existing?.truncated ?? false,
          cancelled: event.cancelled ?? existing?.cancelled ?? false,
          completed,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          ...(event.fullOutputPath === undefined ? {} : { fullOutputPath: event.fullOutputPath }),
          updateCount: (existing?.updateCount ?? 0) + 1,
        };
        state.isBashRunning = !completed;
        snapshot.streaming = completed ? { active: false, phase: "idle" } : { active: true, phase: "bash" };
        break;
      }
      case "compaction_start":
      case "auto_compaction_start":
        state.isCompacting = true;
        state.compaction = { reason: event.type === "compaction_start" && event.reason === "auto" ? "auto" : "manual", status: "running", startedAt: event.ts ?? Date.now() };
        snapshot.streaming = { active: true, phase: "compacting" };
        break;
      case "compaction_end":
      case "auto_compaction_end":
        state.isCompacting = false;
        delete state.compaction;
        snapshot.streaming = { active: false, phase: "idle" };
        break;
      case "tool_execution_end":
        if (event.writtenFiles?.length) state.writtenFiles = [...new Set([...(state.writtenFiles ?? []), ...event.writtenFiles])];
        break;
      case "worker_crashed":
      case "runtime_unavailable":
        state.isPromptRunning = false;
        state.isBashRunning = false;
        state.isCompacting = false;
        state.isStreaming = false;
        snapshot.streaming = { active: false, phase: "idle" };
        break;
      case "session_changed":
        snapshot.cwd = event.cwd;
        if (event.sessionFile !== undefined) state.sessionFile = event.sessionFile;
        if (event.leafId !== undefined) state.leafId = event.leafId;
        break;
      case "agent_start": state.isPromptRunning = true; break;
      case "agent_end":
      case "agent_settled":
      case "prompt_done":
      case "prompt_error": state.isPromptRunning = false; break;
      default:
        break;
    }
  }
}
