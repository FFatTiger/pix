import { z } from "zod";

/**
 * Non-empty string id: at least one non-whitespace character.
 * Value is preserved as-is (no trim / rewrite of IDs).
 */
export const NonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => /[^\s]/.test(value), {
    message: "must contain at least one non-whitespace character",
  });

/** Non-blank user text (prompt message, bash command). Preserves original value. */
export const NonBlankTextSchema = NonEmptyStringSchema;

export const IsoTimestampSchema = NonEmptyStringSchema;

/**
 * Event sequence id on the wire: positive safe integer, monotonic per (sessionId, epoch).
 */
export const EventIdSchema = z.number().int().positive().safe();

/**
 * Resume cursor: nonnegative safe integer. `0` means no events yet.
 */
export const LastEventIdSchema = z.number().int().nonnegative().safe();

/**
 * Session epoch token. Opaque non-blank string (not a number).
 * Changes when the runtime instance is recreated.
 */
export const EpochSchema = NonEmptyStringSchema;

/**
 * Structured protocol error codes.
 * Transport/adapters map local failures into these codes; never leak SDK Error classes.
 */
export const ProtocolErrorCodeSchema = z.enum([
  "protocol_mismatch",
  "invalid_request",
  "invalid_command",
  "invalid_input",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "epoch_changed",
  "gap",
  "runtime_unavailable",
  "worker_unavailable",
  "session_busy",
  "command_rejected",
  "command_duplicate",
  "interrupted",
  "unsupported_capability",
  "timeout",
  "external",
  "unavailable",
  "internal",
]);

export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const ProtocolErrorSchema = z.strictObject({
  code: ProtocolErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  cause: z
    .strictObject({
      kind: z.enum(["auth", "network", "file", "model", "tool", "backend", "unknown"]),
      detail: z.string().optional(),
    })
    .optional(),
  details: z.unknown().optional(),
});

export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

/** Thinking / reasoning levels used by the runtime (no SDK ThinkingLevel type). */
export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** Normalized model identity — id + provider only; no SDK Model object. */
export const ModelRefSchema = z.strictObject({
  id: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Create/set-model payload uses provider + modelId (wire names). */
export const ModelSelectorSchema = z.strictObject({
  provider: NonEmptyStringSchema,
  modelId: NonEmptyStringSchema,
});

export type ModelSelector = z.infer<typeof ModelSelectorSchema>;

export const ContextUsageSchema = z.strictObject({
  percent: z.number(),
  contextWindow: z.number().optional(),
  tokens: z.number().optional(),
});

export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const MAX_IMAGE_BASE64_LENGTH = 14_000_000;
export const MAX_IMAGE_URL_LENGTH = 8_192;

export const SupportedImageMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export type SupportedImageMediaType = z.infer<
  typeof SupportedImageMediaTypeSchema
>;

/** Canonical padded base64; rejects malformed quartets and excessive payloads. */
export const ImageBase64Schema = z.string().superRefine((value, ctx) => {
  if (value.length < 4) ctx.addIssue({ code: "too_small", origin: "string", minimum: 4, inclusive: true });
  if (value.length > MAX_IMAGE_BASE64_LENGTH) {
    ctx.addIssue({ code: "too_big", origin: "string", maximum: MAX_IMAGE_BASE64_LENGTH, inclusive: true });
    return;
  }
  if (value.length % 4 !== 0) ctx.addIssue({ code: "custom", message: "base64 length must be a multiple of 4" });
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
    if (!valid) { ctx.addIssue({ code: "custom", message: "invalid base64 character" }); return; }
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const quartet = value.slice(-4);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const canonicalTail =
    padding === 0 ||
    (padding === 1 && /[A-Za-z0-9+/]{3}=$/.test(quartet) && (alphabet.indexOf(quartet[2] ?? "") & 3) === 0) ||
    (padding === 2 && /[A-Za-z0-9+/]{2}==$/.test(quartet) && (alphabet.indexOf(quartet[1] ?? "") & 15) === 0);
  if (value.slice(0, value.length - padding).includes("=") || !canonicalTail) {
    ctx.addIssue({ code: "custom", message: "invalid canonical base64 padding" });
  }
});

export const HttpImageUrlSchema = z
  .string()
  .min(1)
  .max(MAX_IMAGE_URL_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname.length > 0 &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    } catch {
      return false;
    }
  }, { message: "image URL must be an absolute http(s) URL without credentials" });

/**
 * Image attachment on prompt/steer/follow_up.
 * Protocol shape uses type:"image" + canonical base64 data + supported mimeType.
 */
export const ImageAttachmentSchema = z.strictObject({
  type: z.literal("image"),
  data: ImageBase64Schema,
  mimeType: SupportedImageMediaTypeSchema,
});

export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;

export const StreamingBehaviorSchema = z.enum(["steer", "followUp"]);

export type StreamingBehavior = z.infer<typeof StreamingBehaviorSchema>;

export const WorkerStatusSchema = z.enum([
  "idle",
  "starting",
  "ready",
  "busy",
  "stopping",
  "stopped",
  "crashed",
  "unavailable",
]);

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const ExtensionStatusItemSchema = z.strictObject({
  key: NonEmptyStringSchema,
  text: z.string(),
});

export type ExtensionStatusItem = z.infer<typeof ExtensionStatusItemSchema>;

export const ExtensionWidgetPlacementSchema = z.enum([
  "aboveEditor",
  "belowEditor",
]);

export type ExtensionWidgetPlacement = z.infer<
  typeof ExtensionWidgetPlacementSchema
>;

export const ExtensionWidgetItemSchema = z.strictObject({
  key: NonEmptyStringSchema,
  lines: z.array(z.string()),
  placement: ExtensionWidgetPlacementSchema,
});

export type ExtensionWidgetItem = z.infer<typeof ExtensionWidgetItemSchema>;

export const ToolInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  active: z.boolean(),
});

export type ToolInfo = z.infer<typeof ToolInfoSchema>;

export const SlashCommandSourceSchema = z.enum([
  "extension",
  "prompt",
  "skill",
]);

export type SlashCommandSource = z.infer<typeof SlashCommandSourceSchema>;

export const SlashCommandInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  source: SlashCommandSourceSchema,
  sourceInfo: z.unknown().optional(),
});

export type SlashCommandInfo = z.infer<typeof SlashCommandInfoSchema>;

export const EmptyObjectSchema = z.strictObject({});
