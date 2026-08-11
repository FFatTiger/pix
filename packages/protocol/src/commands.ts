import { z } from "zod";
import {
  ExtensionUiInputCommandSchema,
  ExtensionUiResponseCommandSchema,
} from "./extension.js";
import {
  ImageAttachmentSchema,
  NonBlankTextSchema,
  NonEmptyStringSchema,
  StreamingBehaviorSchema,
  ThinkingLevelSchema,
} from "./common.js";

/**
 * Every runtime command carries `commandId` for at-most-once delivery.
 * Clients must mint unique commandIds; host/sessiond dedupe by (sessionId, commandId).
 */
const commandBase = {
  commandId: NonEmptyStringSchema,
};

export const PromptCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("prompt"),
  message: NonBlankTextSchema,
  images: z.array(ImageAttachmentSchema).optional(),
  streamingBehavior: StreamingBehaviorSchema.optional(),
});

export const AbortCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("abort"),
});

export const GetStateCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("get_state"),
});

export const SetModelCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("set_model"),
  provider: NonEmptyStringSchema,
  modelId: NonEmptyStringSchema,
});

export const ForkCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("fork"),
  entryId: NonEmptyStringSchema,
});

export const NavigateTreeCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("navigate_tree"),
  targetId: NonEmptyStringSchema,
});

export const SetThinkingLevelCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("set_thinking_level"),
  level: ThinkingLevelSchema,
});

export const CompactCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("compact"),
  customInstructions: z.string().optional(),
});

export const SetSessionNameCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("set_session_name"),
  name: NonEmptyStringSchema,
});

export const GetSessionStatsCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("get_session_stats"),
});

export const GetLastAssistantTextCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("get_last_assistant_text"),
});

export const SetAutoCompactionCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("set_auto_compaction"),
  enabled: z.boolean(),
});

export const ClearQueueCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("clear_queue"),
});

export const SteerCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("steer"),
  message: NonBlankTextSchema,
  images: z.array(ImageAttachmentSchema).optional(),
});

export const FollowUpCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("follow_up"),
  message: NonBlankTextSchema,
  images: z.array(ImageAttachmentSchema).optional(),
});

export const GetToolsCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("get_tools"),
});

export const GetCommandsCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("get_commands"),
});

export const SetToolsCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("set_tools"),
  toolNames: z.array(NonEmptyStringSchema),
  includeExtensionTools: z.boolean().optional(),
});

export const ReloadCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("reload"),
});

export const AbortCompactionCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("abort_compaction"),
});

export { ExtensionUiResponseCommandSchema, ExtensionUiInputCommandSchema } from "./extension.js";

export const SetAutoRetryCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("set_auto_retry"),
  enabled: z.boolean(),
});

export const BashCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("bash"),
  command: NonBlankTextSchema,
  excludeFromContext: z.boolean().optional(),
});

export const AbortBashCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("abort_bash"),
});

/**
 * Generate a session title from conversation content (26th command; was HTTP-only).
 */
export const GenerateSessionTitleCommandSchema = z.strictObject({
  ...commandBase,
  type: z.literal("generate_session_title"),
});

/**
 * All 26 RuntimeCommand variants.
 * extension_ui_response is a 3-way union nested inside the outer type union.
 */
export const RuntimeCommandSchema = z.union([
  z.discriminatedUnion("type", [
    PromptCommandSchema,
    AbortCommandSchema,
    GetStateCommandSchema,
    SetModelCommandSchema,
    ForkCommandSchema,
    NavigateTreeCommandSchema,
    SetThinkingLevelCommandSchema,
    CompactCommandSchema,
    SetSessionNameCommandSchema,
    GetSessionStatsCommandSchema,
    GetLastAssistantTextCommandSchema,
    SetAutoCompactionCommandSchema,
    ClearQueueCommandSchema,
    SteerCommandSchema,
    FollowUpCommandSchema,
    GetToolsCommandSchema,
    GetCommandsCommandSchema,
    SetToolsCommandSchema,
    ReloadCommandSchema,
    AbortCompactionCommandSchema,
    SetAutoRetryCommandSchema,
    BashCommandSchema,
    AbortBashCommandSchema,
    GenerateSessionTitleCommandSchema,
  ]),
  ExtensionUiResponseCommandSchema,
  ExtensionUiInputCommandSchema,
]);

export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;

export const RUNTIME_COMMAND_TYPES = [
  "prompt",
  "abort",
  "get_state",
  "set_model",
  "fork",
  "navigate_tree",
  "set_thinking_level",
  "compact",
  "set_session_name",
  "get_session_stats",
  "get_last_assistant_text",
  "set_auto_compaction",
  "clear_queue",
  "steer",
  "follow_up",
  "get_tools",
  "get_commands",
  "set_tools",
  "reload",
  "abort_compaction",
  "extension_ui_response",
  "extension_ui_input",
  "set_auto_retry",
  "bash",
  "abort_bash",
  "generate_session_title",
] as const;

export type RuntimeCommandType = (typeof RUNTIME_COMMAND_TYPES)[number];

export function parseRuntimeCommand(input: unknown): RuntimeCommand {
  return RuntimeCommandSchema.parse(input);
}

export function safeParseRuntimeCommand(input: unknown) {
  return RuntimeCommandSchema.safeParse(input);
}
