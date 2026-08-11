import { z } from "zod";
import {
  HttpImageUrlSchema,
  ImageBase64Schema,
  ModelRefSchema,
  NonEmptyStringSchema,
  SupportedImageMediaTypeSchema,
} from "./common.js";

export const TextContentSchema = z.strictObject({ type: z.literal("text"), text: z.string() });
export type TextContent = z.infer<typeof TextContentSchema>;

export const ImageContentSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("base64"), media_type: SupportedImageMediaTypeSchema, data: ImageBase64Schema }),
  z.strictObject({ type: z.literal("url"), url: HttpImageUrlSchema, media_type: SupportedImageMediaTypeSchema.optional() }),
]);
export type ImageContentSource = z.infer<typeof ImageContentSourceSchema>;
export const ImageContentSchema = z.strictObject({ type: z.literal("image"), source: ImageContentSourceSchema });
export type ImageContent = z.infer<typeof ImageContentSchema>;
export const ThinkingContentSchema = z.strictObject({ type: z.literal("thinking"), thinking: z.string(), deferred: z.boolean().optional() });
export type ThinkingContent = z.infer<typeof ThinkingContentSchema>;
export const ToolCallContentSchema = z.strictObject({ type: z.literal("toolCall"), toolCallId: NonEmptyStringSchema, toolName: NonEmptyStringSchema, input: z.unknown() });
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;
export const AssistantContentBlockSchema = z.discriminatedUnion("type", [TextContentSchema, ImageContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
export type AssistantContentBlock = z.infer<typeof AssistantContentBlockSchema>;
export const UserContentSchema = z.union([z.string(), z.array(z.union([TextContentSchema, ImageContentSchema]))]);
export type UserContent = z.infer<typeof UserContentSchema>;

export const TokenUsageCostSchema = z.strictObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() });
export const TokenUsageSchema = z.strictObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), cost: TokenUsageCostSchema });
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const UserMessageSchema = z.strictObject({ role: z.literal("user"), content: UserContentSchema, timestamp: z.number().optional() });
export type UserMessage = z.infer<typeof UserMessageSchema>;
export const AssistantMessageSchema = z.strictObject({ role: z.literal("assistant"), content: z.array(AssistantContentBlockSchema), model: z.string(), provider: z.string(), stopReason: z.string().optional(), errorMessage: z.string().optional(), timestamp: z.number().optional(), usage: TokenUsageSchema.optional(), writtenFiles: z.array(z.string()).optional() });
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export const ToolResultMessageSchema = z.strictObject({ role: z.literal("toolResult"), toolCallId: NonEmptyStringSchema, toolName: z.string().optional(), content: z.array(z.union([TextContentSchema, ImageContentSchema])), isError: z.boolean().optional(), details: z.unknown().optional(), timestamp: z.number().optional() });
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export const CustomMessageSchema = z.strictObject({ role: z.literal("custom"), customType: NonEmptyStringSchema, content: UserContentSchema, display: z.boolean(), details: z.unknown().optional(), timestamp: z.number().optional() });
export type CustomMessage = z.infer<typeof CustomMessageSchema>;
export const BashExecutionMessageSchema = z.strictObject({ role: z.literal("bashExecution"), command: z.string(), output: z.string(), exitCode: z.number().optional(), cancelled: z.boolean().optional(), truncated: z.boolean().optional(), fullOutputPath: z.string().optional(), excludeFromContext: z.boolean().optional(), timestamp: z.number().optional() });
export type BashExecutionMessage = z.infer<typeof BashExecutionMessageSchema>;
export const AgentMessageSchema = z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema, ToolResultMessageSchema, CustomMessageSchema, BashExecutionMessageSchema]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Base partial streaming DTO remains backwards compatible; updates use strict deltas below. */
export const StreamingUserMessageSchema = z.strictObject({ role: z.literal("user"), content: UserContentSchema.optional(), timestamp: z.number().optional() });
export const StreamingAssistantMessageSchema = z.strictObject({ role: z.literal("assistant"), content: z.array(AssistantContentBlockSchema).optional(), model: z.string().optional(), provider: z.string().optional(), stopReason: z.string().optional(), errorMessage: z.string().optional(), timestamp: z.number().optional(), usage: TokenUsageSchema.optional(), writtenFiles: z.array(z.string()).optional() });
export const StreamingToolResultMessageSchema = z.strictObject({ role: z.literal("toolResult"), toolCallId: NonEmptyStringSchema.optional(), toolName: z.string().optional(), content: z.array(z.union([TextContentSchema, ImageContentSchema])).optional(), isError: z.boolean().optional(), details: z.unknown().optional(), timestamp: z.number().optional() });
export const StreamingCustomMessageSchema = z.strictObject({ role: z.literal("custom"), customType: NonEmptyStringSchema.optional(), content: UserContentSchema.optional(), display: z.boolean().optional(), details: z.unknown().optional(), timestamp: z.number().optional() });
export const StreamingBashExecutionMessageSchema = z.strictObject({ role: z.literal("bashExecution"), command: z.string().optional(), output: z.string().optional(), exitCode: z.number().optional(), cancelled: z.boolean().optional(), truncated: z.boolean().optional(), fullOutputPath: z.string().optional(), excludeFromContext: z.boolean().optional(), timestamp: z.number().optional() });
export const StreamingAgentMessageSchema = z.discriminatedUnion("role", [StreamingUserMessageSchema, StreamingAssistantMessageSchema, StreamingToolResultMessageSchema, StreamingCustomMessageSchema, StreamingBashExecutionMessageSchema]);
export type StreamingAgentMessage = z.infer<typeof StreamingAgentMessageSchema>;

/** Strict role-specific incremental deltas. */
export const AssistantTextDeltaSchema = z.strictObject({ role: z.literal("assistant"), delta: z.strictObject({ type: z.literal("text"), text: z.string().min(1) }) });
export const AssistantThinkingDeltaSchema = z.strictObject({ role: z.literal("assistant"), delta: z.strictObject({ type: z.literal("thinking"), thinking: z.string().min(1) }) });
export const AssistantToolCallDeltaSchema = z.strictObject({ role: z.literal("assistant"), delta: z.strictObject({ type: z.literal("toolCall"), toolCallId: NonEmptyStringSchema, toolName: NonEmptyStringSchema, input: z.unknown() }) });
export const ToolResultDeltaSchema = z.strictObject({ role: z.literal("toolResult"), toolCallId: NonEmptyStringSchema, delta: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("text"), text: z.string().min(1) }), z.strictObject({ type: z.literal("image"), image: ImageContentSchema })]) });
export const CustomMessageDeltaSchema = z.strictObject({ role: z.literal("custom"), customType: NonEmptyStringSchema, delta: z.strictObject({ type: z.literal("text"), text: z.string().min(1) }) });
export const BashExecutionDeltaSchema = z.strictObject({ role: z.literal("bashExecution"), delta: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("output"), output: z.string().min(1) }), z.strictObject({ type: z.literal("status"), exitCode: z.number().int().optional(), cancelled: z.boolean().optional(), truncated: z.boolean().optional() }).refine((value) => value.exitCode !== undefined || value.cancelled !== undefined || value.truncated !== undefined, { message: "bash status delta requires a status field" })]) });
export const StreamingMessageDeltaSchema = z.union([AssistantTextDeltaSchema, AssistantThinkingDeltaSchema, AssistantToolCallDeltaSchema, ToolResultDeltaSchema, CustomMessageDeltaSchema, BashExecutionDeltaSchema]);
export type StreamingMessageDelta = z.infer<typeof StreamingMessageDeltaSchema>;

export const ModelChangeSchema = ModelRefSchema;
