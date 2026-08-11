import { z } from "zod";
import {
  EpochSchema,
  EventIdSchema,
  ExtensionStatusItemSchema,
  ExtensionWidgetItemSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
} from "./common.js";
import {
  QueuedMessagesSchema,
  RuntimeCapabilitySetSchema,
  RuntimeCloseReasonSchema,
} from "./domain.js";
import { ExtensionUiRequestSchema } from "./extension.js";
import {
  AgentMessageSchema,
  StreamingAgentMessageSchema,
  StreamingMessageDeltaSchema,
} from "./messages.js";

/**
 * Runtime event product data is separate from the sessiond-owned wire cursor.
 * Worker IPC carries RuntimeEventData; browser/sessiond streams carry RuntimeEvent.
 */
const eventDataBase = {
  sessionId: NonEmptyStringSchema,
  ts: z.number().int().nonnegative().optional(),
};
const eventCursor = { eventId: EventIdSchema, epoch: EpochSchema };

export const AgentStartEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("agent_start") });
export const AgentEndEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("agent_end") });
export const AgentSettledEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("agent_settled") });
export const PromptDoneEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("prompt_done") });
export const PromptErrorEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("prompt_error"),
  errorMessage: z.string(),
  error: ProtocolErrorSchema.optional(),
});
export const MessageStartEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("message_start"),
  streamId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema,
  message: StreamingAgentMessageSchema,
});
export const MessageUpdateEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("message_update"),
  streamId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema,
  delta: StreamingMessageDeltaSchema,
});
export const MessageEndEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("message_end"),
  streamId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema,
  message: AgentMessageSchema,
});
export const StreamingMessageLifecycleSchema = z
  .array(z.union([MessageStartEventDataSchema, MessageUpdateEventDataSchema, MessageEndEventDataSchema]))
  .min(2)
  .superRefine((events, ctx) => {
    const start = events[0];
    if (start?.type !== "message_start") {
      ctx.addIssue({ code: "custom", path: [0], message: "stream lifecycle must start with exactly one message_start" });
      return;
    }

    let ended = false;
    for (let index = 1; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.sessionId !== start.sessionId) {
        ctx.addIssue({ code: "custom", path: [index, "sessionId"], message: "stream sessionId mismatch" });
      }
      if (event.streamId !== start.streamId || event.messageId !== start.messageId) {
        ctx.addIssue({ code: "custom", path: [index], message: "stream/message id mismatch" });
      }
      if (ended) {
        ctx.addIssue({ code: "custom", path: [index], message: "no stream event is allowed after message_end" });
        continue;
      }
      if (event.type === "message_start") {
        ctx.addIssue({ code: "custom", path: [index], message: "stream lifecycle permits exactly one message_start" });
      } else if (event.type === "message_update") {
        if (event.delta.role !== start.message.role) {
          ctx.addIssue({ code: "custom", path: [index, "delta", "role"], message: "stream update role must match message_start role" });
        }
      } else {
        ended = true;
        if (event.message.role !== start.message.role) {
          ctx.addIssue({ code: "custom", path: [index, "message", "role"], message: "message_end role must match message_start role" });
        }
      }
    }

    if (!ended) {
      ctx.addIssue({ code: "custom", path: [events.length - 1], message: "stream lifecycle requires exactly one message_end" });
    }
  });

export const ToolExecutionStartEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("tool_execution_start"),
  toolCallId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
  args: z.unknown().optional(),
});
export const ToolExecutionUpdateEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("tool_execution_update"),
  toolCallId: NonEmptyStringSchema,
  toolName: z.string().optional(),
  partialResult: z.unknown().optional(),
});
export const ToolExecutionEndEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("tool_execution_end"),
  toolCallId: NonEmptyStringSchema,
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  result: z.unknown().optional(),
  writtenFiles: z.array(z.string()).optional(),
});
export const QueueUpdateEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("queue_update"),
  steering: QueuedMessagesSchema.shape.steering.optional(),
  followUp: QueuedMessagesSchema.shape.followUp.optional(),
});
export const RetryStartEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("retry_start"),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  errorMessage: z.string().optional(),
});
export const RetryEndEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("retry_end"),
  success: z.boolean().optional(),
});
export const AutoRetryStartEventDataSchema = RetryStartEventDataSchema.extend({ type: z.literal("auto_retry_start") });
export const AutoRetryEndEventDataSchema = RetryEndEventDataSchema.extend({ type: z.literal("auto_retry_end") });
export const CompactionStartEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("compaction_start"),
  reason: z.string().optional(),
});
export const CompactionEndEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("compaction_end"),
  aborted: z.boolean().optional(),
  errorMessage: z.string().optional(),
  reason: z.string().optional(),
  result: z.unknown().optional(),
});
export const AutoCompactionStartEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("auto_compaction_start") });
export const AutoCompactionEndEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("auto_compaction_end"),
  aborted: z.boolean().optional(),
  errorMessage: z.string().optional(),
  result: z.unknown().optional(),
});
export const BashUpdateEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("bash_update"),
  command: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().int().optional(),
  cancelled: z.boolean().optional(),
  truncated: z.boolean().optional(),
  fullOutputPath: z.string().optional(),
  excludeFromContext: z.boolean().optional(),
});
export const ExtensionErrorEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("extension_error"),
  error: z.string(),
  details: z.unknown().optional(),
});

export { ExtensionUiRequestMethodSchema, ExtensionUiRequestSchema } from "./extension.js";
export type { ExtensionUiRequestMethod } from "./extension.js";

export const ExtensionUiRequestEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("extension_ui_request"),
  request: ExtensionUiRequestSchema,
});
export type ExtensionUiRequestEventData = z.infer<typeof ExtensionUiRequestEventDataSchema>;

export const ExtensionStatusesEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("extension_statuses"),
  statuses: z.array(ExtensionStatusItemSchema),
});
export const ExtensionWidgetsEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("extension_widgets"),
  widgets: z.array(ExtensionWidgetItemSchema),
});
export const SessionTitleEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("session_title"), name: z.string() });
export const RuntimeStateChangedEventDataSchema = z.strictObject({ ...eventDataBase, type: z.literal("runtime_state_changed") });
export const RuntimeCapabilitiesChangedEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("runtime_capabilities_changed"),
  capabilities: RuntimeCapabilitySetSchema,
});
export const RuntimeClosedEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("runtime_closed"),
  reason: RuntimeCloseReasonSchema,
});
export const SessionChangedEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("session_changed"),
  cwd: NonEmptyStringSchema,
  sessionFile: z.string().optional(),
  leafId: NonEmptyStringSchema.optional(),
});
export const WorkerCrashedEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("worker_crashed"),
  error: ProtocolErrorSchema.optional(),
});
export const RunningSessionsChangedEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("running_sessions_changed"),
  sessionIds: z.array(NonEmptyStringSchema),
});
export const RuntimeUnavailableEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("runtime_unavailable"),
  error: ProtocolErrorSchema,
});
export const RuntimeErrorEventDataSchema = z.strictObject({
  ...eventDataBase,
  type: z.literal("runtime_error"),
  error: ProtocolErrorSchema,
});

const runtimeEventDataOptions = [
  AgentStartEventDataSchema, AgentEndEventDataSchema, AgentSettledEventDataSchema,
  PromptDoneEventDataSchema, PromptErrorEventDataSchema, MessageStartEventDataSchema,
  MessageUpdateEventDataSchema, MessageEndEventDataSchema, ToolExecutionStartEventDataSchema,
  ToolExecutionUpdateEventDataSchema, ToolExecutionEndEventDataSchema, QueueUpdateEventDataSchema,
  RetryStartEventDataSchema, RetryEndEventDataSchema, AutoRetryStartEventDataSchema,
  AutoRetryEndEventDataSchema, CompactionStartEventDataSchema, CompactionEndEventDataSchema,
  AutoCompactionStartEventDataSchema, AutoCompactionEndEventDataSchema, BashUpdateEventDataSchema,
  ExtensionErrorEventDataSchema, ExtensionUiRequestEventDataSchema, ExtensionStatusesEventDataSchema,
  ExtensionWidgetsEventDataSchema, SessionTitleEventDataSchema, RuntimeStateChangedEventDataSchema,
  RuntimeCapabilitiesChangedEventDataSchema, RuntimeClosedEventDataSchema, SessionChangedEventDataSchema,
  WorkerCrashedEventDataSchema, RunningSessionsChangedEventDataSchema, RuntimeUnavailableEventDataSchema,
  RuntimeErrorEventDataSchema,
] as const;

export const RuntimeEventDataSchema = z.discriminatedUnion("type", runtimeEventDataOptions);
export type RuntimeEventData = z.infer<typeof RuntimeEventDataSchema>;

const wire = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.extend(eventCursor);
export const AgentStartEventSchema = wire(AgentStartEventDataSchema);
export const AgentEndEventSchema = wire(AgentEndEventDataSchema);
export const AgentSettledEventSchema = wire(AgentSettledEventDataSchema);
export const PromptDoneEventSchema = wire(PromptDoneEventDataSchema);
export const PromptErrorEventSchema = wire(PromptErrorEventDataSchema);
export const MessageStartEventSchema = wire(MessageStartEventDataSchema);
export const MessageUpdateEventSchema = wire(MessageUpdateEventDataSchema);
export const MessageEndEventSchema = wire(MessageEndEventDataSchema);
export const ToolExecutionStartEventSchema = wire(ToolExecutionStartEventDataSchema);
export const ToolExecutionUpdateEventSchema = wire(ToolExecutionUpdateEventDataSchema);
export const ToolExecutionEndEventSchema = wire(ToolExecutionEndEventDataSchema);
export const QueueUpdateEventSchema = wire(QueueUpdateEventDataSchema);
export const RetryStartEventSchema = wire(RetryStartEventDataSchema);
export const RetryEndEventSchema = wire(RetryEndEventDataSchema);
export const AutoRetryStartEventSchema = wire(AutoRetryStartEventDataSchema);
export const AutoRetryEndEventSchema = wire(AutoRetryEndEventDataSchema);
export const CompactionStartEventSchema = wire(CompactionStartEventDataSchema);
export const CompactionEndEventSchema = wire(CompactionEndEventDataSchema);
export const AutoCompactionStartEventSchema = wire(AutoCompactionStartEventDataSchema);
export const AutoCompactionEndEventSchema = wire(AutoCompactionEndEventDataSchema);
export const BashUpdateEventSchema = wire(BashUpdateEventDataSchema);
export const ExtensionErrorEventSchema = wire(ExtensionErrorEventDataSchema);
export const ExtensionUiRequestEventSchema = wire(ExtensionUiRequestEventDataSchema);
export const ExtensionStatusesEventSchema = wire(ExtensionStatusesEventDataSchema);
export const ExtensionWidgetsEventSchema = wire(ExtensionWidgetsEventDataSchema);
export const SessionTitleEventSchema = wire(SessionTitleEventDataSchema);
export const RuntimeStateChangedEventSchema = wire(RuntimeStateChangedEventDataSchema);
export const RuntimeCapabilitiesChangedEventSchema = wire(RuntimeCapabilitiesChangedEventDataSchema);
export const RuntimeClosedEventSchema = wire(RuntimeClosedEventDataSchema);
export const SessionChangedEventSchema = wire(SessionChangedEventDataSchema);
export const WorkerCrashedEventSchema = wire(WorkerCrashedEventDataSchema);
export const RunningSessionsChangedEventSchema = wire(RunningSessionsChangedEventDataSchema);
export const RuntimeUnavailableEventSchema = wire(RuntimeUnavailableEventDataSchema);
export const RuntimeErrorEventSchema = wire(RuntimeErrorEventDataSchema);

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  AgentStartEventSchema, AgentEndEventSchema, AgentSettledEventSchema,
  PromptDoneEventSchema, PromptErrorEventSchema, MessageStartEventSchema,
  MessageUpdateEventSchema, MessageEndEventSchema, ToolExecutionStartEventSchema,
  ToolExecutionUpdateEventSchema, ToolExecutionEndEventSchema, QueueUpdateEventSchema,
  RetryStartEventSchema, RetryEndEventSchema, AutoRetryStartEventSchema, AutoRetryEndEventSchema,
  CompactionStartEventSchema, CompactionEndEventSchema, AutoCompactionStartEventSchema,
  AutoCompactionEndEventSchema, BashUpdateEventSchema, ExtensionErrorEventSchema,
  ExtensionUiRequestEventSchema, ExtensionStatusesEventSchema, ExtensionWidgetsEventSchema,
  SessionTitleEventSchema, RuntimeStateChangedEventSchema, RuntimeCapabilitiesChangedEventSchema,
  RuntimeClosedEventSchema, SessionChangedEventSchema, WorkerCrashedEventSchema,
  RunningSessionsChangedEventSchema, RuntimeUnavailableEventSchema, RuntimeErrorEventSchema,
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export function parseRuntimeEvent(input: unknown): RuntimeEvent { return RuntimeEventSchema.parse(input); }
export function safeParseRuntimeEvent(input: unknown) { return RuntimeEventSchema.safeParse(input); }
