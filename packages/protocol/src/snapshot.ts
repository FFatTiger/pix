import { z } from "zod";
import {
  ContextUsageSchema,
  ExtensionStatusItemSchema,
  ExtensionWidgetItemSchema,
  ModelRefSchema,
  NonEmptyStringSchema,
  ThinkingLevelSchema,
  ToolInfoSchema,
} from "./common.js";
import { QueuedMessagesSchema, RuntimeCapabilitySetSchema } from "./domain.js";
import { ExtensionUiRequestSchema } from "./extension.js";
import { AgentMessageSchema, StreamingAgentMessageSchema } from "./messages.js";

export const PendingExtensionUiSchema = ExtensionUiRequestSchema;
export type PendingExtensionUi = z.infer<typeof PendingExtensionUiSchema>;
export const BashProjectionSchema = z.strictObject({ command: z.string(), output: z.string(), excludeFromContext: z.boolean(), truncated: z.boolean(), cancelled: z.boolean(), completed: z.boolean(), exitCode: z.number().int().optional(), fullOutputPath: z.string().optional(), updateCount: z.number().int().nonnegative().safe() });
export type BashProjection = z.infer<typeof BashProjectionSchema>;
export const CompactionProjectionSchema = z.strictObject({ reason: z.enum(["manual", "auto"]), status: z.enum(["running", "aborting"]), customInstructions: z.string().optional(), startedAt: z.number() });
export type CompactionProjection = z.infer<typeof CompactionProjectionSchema>;

export const RuntimeStateSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  sessionFile: z.string().optional(),
  leafId: NonEmptyStringSchema.optional(),
  isStreaming: z.boolean(),
  isPromptRunning: z.boolean(),
  isBashRunning: z.boolean(),
  isCompacting: z.boolean(),
  bash: BashProjectionSchema.optional(),
  compaction: CompactionProjectionSchema.optional(),
  autoCompactionEnabled: z.boolean().optional(),
  autoRetryEnabled: z.boolean().optional(),
  model: ModelRefSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  pendingMessageCount: z.number().int().nonnegative().optional(),
  queuedMessages: QueuedMessagesSchema.optional(),
  contextUsage: ContextUsageSchema.nullable().optional(),
  systemPrompt: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  thinkingLevelPinned: z.boolean().optional(),
  tools: z.array(ToolInfoSchema).optional(),
  extensionStatuses: z.array(ExtensionStatusItemSchema).optional(),
  extensionWidgets: z.array(ExtensionWidgetItemSchema).optional(),
  pendingExtensionUi: z.array(PendingExtensionUiSchema).optional(),
  sessionName: z.string().optional(),
  writtenFiles: z.array(z.string()).optional(),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const StreamingProjectionSchema = z.strictObject({
  active: z.boolean(),
  streamId: NonEmptyStringSchema.optional(),
  messageId: NonEmptyStringSchema.optional(),
  partialMessage: StreamingAgentMessageSchema.optional(),
  toolCallIds: z.array(NonEmptyStringSchema).optional(),
  phase: z.enum(["idle", "waiting_model", "streaming", "running_tools", "compacting", "bash", "retrying"]).optional(),
});
export type StreamingProjection = z.infer<typeof StreamingProjectionSchema>;

const hasRecoverablePartial = (
  message: z.infer<typeof StreamingAgentMessageSchema>,
): boolean => {
  switch (message.role) {
    case "user":
      return message.content !== undefined;
    case "assistant":
      return (
        (message.content?.length ?? 0) > 0 ||
        message.model !== undefined ||
        message.provider !== undefined ||
        message.stopReason !== undefined ||
        message.errorMessage !== undefined ||
        message.usage !== undefined ||
        (message.writtenFiles?.length ?? 0) > 0
      );
    case "toolResult":
      return (
        message.toolCallId !== undefined ||
        message.toolName !== undefined ||
        (message.content?.length ?? 0) > 0 ||
        message.isError !== undefined ||
        message.details !== undefined
      );
    case "custom":
      return (
        message.customType !== undefined ||
        message.content !== undefined ||
        message.display !== undefined ||
        message.details !== undefined
      );
    case "bashExecution":
      return (
        message.command !== undefined ||
        message.output !== undefined ||
        message.exitCode !== undefined ||
        message.cancelled !== undefined ||
        message.truncated !== undefined ||
        message.fullOutputPath !== undefined ||
        message.excludeFromContext !== undefined
      );
  }
};

export const RuntimeSnapshotSchema = z
  .strictObject({
    sessionId: NonEmptyStringSchema,
    cwd: NonEmptyStringSchema,
    projectRoot: NonEmptyStringSchema,
    state: RuntimeStateSchema,
    capabilities: RuntimeCapabilitySetSchema,
    streaming: StreamingProjectionSchema.optional(),
    messages: z.array(AgentMessageSchema).optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.sessionId !== snapshot.state.sessionId) {
      ctx.addIssue({ code: "custom", path: ["state", "sessionId"], message: "state.sessionId must match snapshot.sessionId" });
    }
    const stream = snapshot.streaming;
    const bashRunning = snapshot.state.isBashRunning;
    const compacting = snapshot.state.isCompacting;
    const operationRunning = bashRunning || compacting;
    if (snapshot.state.isStreaming) {
      if (!stream?.active || stream.streamId === undefined || stream.messageId === undefined || stream.partialMessage === undefined || !hasRecoverablePartial(stream.partialMessage) || stream.phase === undefined || ["idle", "bash", "compacting"].includes(stream.phase)) {
        ctx.addIssue({ code: "custom", path: ["streaming"], message: "active message streaming requires ids, message phase and recoverable partial message" });
      }
    } else if (operationRunning) {
      if (!stream?.active || stream.streamId !== undefined || stream.messageId !== undefined || stream.partialMessage !== undefined) {
        ctx.addIssue({ code: "custom", path: ["streaming"], message: "active operation phase requires no stale message stream ids or partial message" });
      }
    } else if (stream !== undefined && (stream.active || stream.streamId !== undefined || stream.messageId !== undefined || stream.partialMessage !== undefined || (stream.phase !== undefined && stream.phase !== "idle"))) {
      ctx.addIssue({ code: "custom", path: ["streaming"], message: "inactive streaming cannot retain ids, partial message or active phase" });
    }
    if (bashRunning && compacting) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "bash and compaction are mutually exclusive runtime operations" });
    }
    if (bashRunning) {
      if (snapshot.state.bash === undefined || snapshot.state.bash.completed) {
        ctx.addIssue({ code: "custom", path: ["state", "bash"], message: "running bash requires an incomplete bash projection" });
      }
    } else if (snapshot.state.bash !== undefined && !snapshot.state.bash.completed) {
      ctx.addIssue({ code: "custom", path: ["state", "bash"], message: "settled bash projection must be completed" });
    }
    if (compacting !== (snapshot.state.compaction !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["state", "compaction"], message: "isCompacting must match compaction projection presence" });
    }

    const phase = stream?.phase;
    if (bashRunning && phase !== "bash") {
      ctx.addIssue({ code: "custom", path: ["streaming", "phase"], message: "running bash requires streaming.phase=\"bash\"" });
    }
    if (!bashRunning && phase === "bash") {
      ctx.addIssue({ code: "custom", path: ["streaming", "phase"], message: "streaming.phase=\"bash\" requires a running bash projection" });
    }
    if (compacting && phase !== "compacting") {
      ctx.addIssue({ code: "custom", path: ["streaming", "phase"], message: "running compaction requires streaming.phase=\"compacting\"" });
    }
    if (!compacting && phase === "compacting") {
      ctx.addIssue({ code: "custom", path: ["streaming", "phase"], message: "streaming.phase=\"compacting\" requires a compaction projection" });
    }
    if (phase === "streaming" && (bashRunning || compacting)) {
      ctx.addIssue({ code: "custom", path: ["streaming", "phase"], message: "message streaming cannot overlap bash or compaction" });
    }
  });
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
export function parseRuntimeSnapshot(input: unknown): RuntimeSnapshot { return RuntimeSnapshotSchema.parse(input); }
export function safeParseRuntimeSnapshot(input: unknown) { return RuntimeSnapshotSchema.safeParse(input); }
