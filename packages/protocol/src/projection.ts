/**
 * Pure, browser-safe, side-effect-free Runtime projection reducer.
 *
 * This is the SINGLE authoritative source of truth for how a
 * {@link RuntimeSnapshot} evolves from a stream of {@link RuntimeEventData}.
 * Both the sessiond authority (mutable {@code SnapshotProjection} wrapper) and
 * the browser {@code SessionStore} reduce through this exact function, so the
 * host and the client can never drift in projection semantics.
 *
 * Contract guarantees preserved from the original sessiond projection:
 *  - message deltas append NEW content blocks (adjacent text/thinking are NOT
 *    merged); {@code message_update.delta} is a wire DELTA, never cumulative.
 *  - {@code bash_update.output} is the SINGLE accumulator: each delta chunk is
 *    concatenated onto the prior cumulative output.
 *  - session mismatch throws (the caller owns cursor/generation gating).
 *
 * The only non-pure read is the {@code Date.now()} monotonic-clock fallback for
 * a compaction {@code startedAt} when an event omits {@code ts}; this matches
 * the prior sessiond authority verbatim and production events always carry
 * {@code ts}. No network, DOM, storage, or IO access occurs here.
 */
import type { RuntimeEventData } from "./events.js";
import type {
  StreamingAgentMessage,
  StreamingMessageDelta,
} from "./messages.js";
import type { RuntimeSnapshot, RuntimeState } from "./snapshot.js";

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Apply a single streaming {@link StreamingMessageDelta} to a partial streaming
 * message, returning a NEW message. Adjacent text/thinking blocks are appended
 * (never merged); a role mismatch throws. Pure.
 */
export function applyStreamingDelta(
  message: StreamingAgentMessage,
  delta: StreamingMessageDelta,
): StreamingAgentMessage {
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

/**
 * Mutate {@code snapshot} in place by applying a single {@link RuntimeEventData}.
 * Throws on session mismatch. Internal helper; callers should use
 * {@link reduceRuntimeEventData} for the pure clone-and-return form.
 */
function applyEventToSnapshot(snapshot: RuntimeSnapshot, event: RuntimeEventData): void {
  const state: RuntimeState = snapshot.state;
  switch (event.type) {
    case "message_start":
      snapshot.streaming = { active: true, streamId: event.streamId, messageId: event.messageId, partialMessage: clone(event.message), phase: "streaming" };
      state.isStreaming = true;
      break;
    case "message_update": {
      const stream = snapshot.streaming;
      if (!stream?.active || stream.streamId !== event.streamId || stream.messageId !== event.messageId || stream.partialMessage === undefined) throw new Error("stale or uncorrelated stream update");
      stream.partialMessage = applyStreamingDelta(stream.partialMessage, event.delta);
      break;
    }
    case "message_end": {
      const stream = snapshot.streaming;
      if (!stream?.active || stream.streamId !== event.streamId || stream.messageId !== event.messageId) throw new Error("stale or uncorrelated stream end");
      // Protocol v2: the snapshot is control/reconnect state only. A completion
      // advances the authoritative leaf to the committed entry, increments the
      // message count, and clears the stream — it does NOT append transcript
      // history (persisted history comes from the cursor-paginated catalog).
      // entryId is REQUIRED on the wire (the adapter resolves the committed
      // leaf before publishing); the reducer enforces it fail-closed.
      if (event.entryId === undefined) throw new Error("message_end requires a committed entryId");
      state.leafId = event.entryId;
      state.messageCount += 1;
      snapshot.streaming = { active: false, phase: "idle" };
      state.isStreaming = false;
      break;
    }
    case "queue_update":
      state.queuedMessages = { steering: clone(event.steering ?? []), followUp: clone(event.followUp ?? []) };
      state.pendingMessageCount = state.queuedMessages.steering.length + state.queuedMessages.followUp.length;
      break;
    case "extension_ui_request": {
      // Canonical close tombstone: `closed: true` REMOVES the requestId and is
      // never stored. An unknown close is an idempotent no-op. A normal request
      // upserts by requestId (same id replaced, others/order preserved). Both
      // sessiond and the browser reduce through this exact function, so
      // detach/reattach/replay can never resurrect a settled request.
      if (event.request.closed === true) {
        state.pendingExtensionUi = [...(state.pendingExtensionUi ?? []).filter((item) => item.id !== event.request.id)];
        break;
      }
      state.pendingExtensionUi = [...(state.pendingExtensionUi ?? []).filter((item) => item.id !== event.request.id), clone(event.request)];
      break;
    }
    case "extension_statuses": state.extensionStatuses = clone(event.statuses); break;
    case "extension_widgets": state.extensionWidgets = clone(event.widgets); break;
    case "runtime_capabilities_changed": snapshot.capabilities = clone(event.capabilities); break;
    case "session_title": state.sessionName = event.name; break;
    case "bash_update": {
      // bash_update.output is a per-event DELTA chunk (see Protocol events.ts
      // JSDoc). This projection is the SINGLE authoritative accumulator: each
      // delta is concatenated onto the prior cumulative output. An adapter must
      // never pre-accumulate the deltas before they reach here.
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
      // Protocol v2: a TERMINAL bash_update carries the persisted bash entry
      // identity. The reducer advances the leaf to the committed entry and
      // increments the message count so leaf/count converge with the persisted
      // catalog. Delta-only events (not completed) advance nothing.
      if (completed && event.entryId !== undefined) {
        state.leafId = event.entryId;
        state.messageCount += 1;
      }
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

/**
 * Pure reducer: return a NEW {@link RuntimeSnapshot} with {@code data} applied.
 * The input snapshot is never mutated. Throws on session id mismatch so callers
 * can gate events by cursor/generation before calling.
 */
export function reduceRuntimeEventData(
  snapshot: RuntimeSnapshot,
  data: RuntimeEventData,
): RuntimeSnapshot {
  if (data.sessionId !== snapshot.sessionId) throw new Error("event session mismatch");
  const next = clone(snapshot);
  applyEventToSnapshot(next, data);
  return next;
}

// Re-export the snapshot types that callers pair with this reducer.
export type { RuntimeSnapshot, RuntimeState } from "./snapshot.js";
export type { StreamingAgentMessage, StreamingMessageDelta } from "./messages.js";
