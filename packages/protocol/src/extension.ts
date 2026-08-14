import { z } from "zod";
import {
  ExtensionWidgetPlacementSchema,
  NonEmptyStringSchema,
} from "./common.js";

const requestTiming = {
  timeout: z.number().nonnegative().optional(),
  expiresAt: z.number().optional(),
};

/**
 * Strict optional canonical close marker. A close tombstone is a normal
 * `extension_ui_request` event whose `request` carries `closed: true` (never
 * `false`); the pure projection removes that requestId and never stores the
 * tombstone. Only `true` is a valid value — fail-closed against `false` being
 * misread as a normal upsert.
 */
const closedMarker = { closed: z.literal(true).optional() };

/** Strict method-discriminated extension request; cross-method fields reject. */
export const ExtensionUiRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("select"), title: z.string(), options: z.array(z.string()).min(1), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("confirm"), title: z.string(), message: z.string(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("input"), title: z.string(), placeholder: z.string().optional(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("editor"), title: z.string(), prefill: z.string().optional(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("notify"), message: z.string(), notifyType: z.enum(["info", "warning", "error"]), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("setStatus"), statusKey: NonEmptyStringSchema, statusText: z.string().optional(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("setWidget"), widgetKey: NonEmptyStringSchema, widgetLines: z.array(z.string()).optional(), widgetPlacement: ExtensionWidgetPlacementSchema.optional(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("setTitle"), title: z.string(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("set_editor_text"), text: z.string(), ...requestTiming, ...closedMarker }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("custom"), lines: z.array(z.string()), ...requestTiming, ...closedMarker }),
]);
export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequestSchema>;
export const ExtensionUiRequestMethodSchema = z.enum([
  "select", "confirm", "input", "editor", "notify", "setStatus",
  "setWidget", "setTitle", "set_editor_text", "custom",
]);

/**
 * Interactive methods (the only ones that produce a client response or
 * incremental input). notify/setStatus/setWidget/setTitle/set_editor_text are
 * events/state, not user-response requests.
 */
export const ExtensionUiInteractiveMethodSchema = z.enum([
  "select", "confirm", "input", "editor", "custom",
]);

export type ExtensionUiInteractiveMethod = z.infer<typeof ExtensionUiInteractiveMethodSchema>;
export type ExtensionUiRequestMethod = z.infer<typeof ExtensionUiRequestMethodSchema>;

const extensionCommandBase = {
  commandId: NonEmptyStringSchema,
  type: z.literal("extension_ui_response"),
};

/** Method-bound final responses. Non-interactive request methods never produce these commands. */
export const ExtensionUiResponseCommandSchema = z.union([
  z.strictObject({ ...extensionCommandBase, id: NonEmptyStringSchema, method: z.literal("select"), responseKind: z.literal("selected"), selected: z.string() }),
  z.strictObject({ ...extensionCommandBase, id: NonEmptyStringSchema, method: z.literal("confirm"), responseKind: z.literal("confirmed"), confirmed: z.boolean() }),
  z.strictObject({ ...extensionCommandBase, id: NonEmptyStringSchema, method: z.enum(["input", "editor", "custom"]), responseKind: z.literal("value"), value: z.string() }),
  z.strictObject({ ...extensionCommandBase, id: NonEmptyStringSchema, method: z.enum(["select", "confirm", "input", "editor", "custom"]), responseKind: z.literal("cancelled"), cancelled: z.literal(true) }),
]);
export type ExtensionUiResponseCommand = z.infer<typeof ExtensionUiResponseCommandSchema>;

/** Incremental input is frozen to input/editor; custom only permits a final response. */
export const ExtensionUiInputCommandSchema = z.discriminatedUnion("method", [
  z.strictObject({ commandId: NonEmptyStringSchema, type: z.literal("extension_ui_input"), id: NonEmptyStringSchema, method: z.literal("input"), data: z.string() }),
  z.strictObject({ commandId: NonEmptyStringSchema, type: z.literal("extension_ui_input"), id: NonEmptyStringSchema, method: z.literal("editor"), data: z.string() }),
]);
export type ExtensionUiInputCommand = z.infer<typeof ExtensionUiInputCommandSchema>;

/**
 * Authoritative request→command validation for R2 Mapper/Controller boundaries.
 * Callers MUST load the pending authoritative request and parse this exchange;
 * parsing the client command alone cannot prove request id/method correlation.
 */
export const ExtensionUiResponseExchangeSchema = z
  .strictObject({ request: ExtensionUiRequestSchema, command: ExtensionUiResponseCommandSchema })
  .superRefine(({ request, command }, ctx) => {
    if (request.id !== command.id) {
      ctx.addIssue({ code: "custom", path: ["command", "id"], message: "extension response request id mismatch" });
    }
    if (request.method !== command.method) {
      ctx.addIssue({ code: "custom", path: ["command", "method"], message: "extension response request method mismatch" });
    }
  });
export type ExtensionUiResponseExchange = z.infer<typeof ExtensionUiResponseExchangeSchema>;

/** See ExtensionUiResponseExchangeSchema; only input/editor accept incremental input. */
export const ExtensionUiInputExchangeSchema = z
  .strictObject({ request: ExtensionUiRequestSchema, command: ExtensionUiInputCommandSchema })
  .superRefine(({ request, command }, ctx) => {
    if (request.id !== command.id) {
      ctx.addIssue({ code: "custom", path: ["command", "id"], message: "extension input request id mismatch" });
    }
    if (request.method !== command.method) {
      ctx.addIssue({ code: "custom", path: ["command", "method"], message: "extension input request method mismatch" });
    }
  });
export type ExtensionUiInputExchange = z.infer<typeof ExtensionUiInputExchangeSchema>;

/**
 * Only interactive methods produce client responses. Method is retained on the
 * wire for request-kind validation; Worker mapper may drop it for Runtime Core.
 */
export const ExtensionUiResponsePayloadSchema = z.discriminatedUnion("responseKind", [
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("select"), responseKind: z.literal("selected"), selected: z.string() }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("confirm"), responseKind: z.literal("confirmed"), confirmed: z.boolean() }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.enum(["input", "editor", "custom"]), responseKind: z.literal("value"), value: z.string() }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.enum(["select", "confirm", "input", "editor", "custom"]), responseKind: z.literal("cancelled"), cancelled: z.literal(true) }),
]);
export type ExtensionUiResponsePayload = z.infer<typeof ExtensionUiResponsePayloadSchema>;

/** Streaming input updates are only valid for input/editor requests. */
export const ExtensionUiInputPayloadSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("input"), data: z.string() }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("editor"), data: z.string() }),
]);
export type ExtensionUiInputPayload = z.infer<typeof ExtensionUiInputPayloadSchema>;
