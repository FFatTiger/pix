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
 * Canonical questionnaire bounds. Protocol mirrors Runtime Core
 * (`QUESTIONNAIRE_LIMITS`); cross-package tests prove numeric parity.
 * Oversized input is rejected, never truncated.
 */
export const QUESTIONNAIRE_LIMITS = {
  minQuestions: 1,
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 4,
  maxHeaderChars: 16,
  maxLabelChars: 60,
  maxQuestionChars: 16_384,
  maxDescriptionChars: 8_192,
  maxPreviewChars: 65_536,
  maxCustomAnswerChars: 65_536,
  maxBytes: 524_288,
  timeoutMs: 900_000,
} as const;

export type QuestionnaireLimits = typeof QUESTIONNAIRE_LIMITS;

export const QuestionnaireOptionSchema = z.strictObject({
  label: z.string().max(QUESTIONNAIRE_LIMITS.maxLabelChars),
  description: z.string().max(QUESTIONNAIRE_LIMITS.maxDescriptionChars),
  preview: z.string().max(QUESTIONNAIRE_LIMITS.maxPreviewChars).optional(),
});
export type QuestionnaireOption = z.infer<typeof QuestionnaireOptionSchema>;

export const QuestionnaireQuestionSchema = z.strictObject({
  header: z.string().max(QUESTIONNAIRE_LIMITS.maxHeaderChars),
  question: z.string().max(QUESTIONNAIRE_LIMITS.maxQuestionChars),
  options: z.array(QuestionnaireOptionSchema).min(QUESTIONNAIRE_LIMITS.minOptions).max(QUESTIONNAIRE_LIMITS.maxOptions),
  multiSelect: z.boolean(),
});
export type QuestionnaireQuestion = z.infer<typeof QuestionnaireQuestionSchema>;

export const QuestionnaireAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("option"),
    questionIndex: z.number().int().nonnegative().safe(),
    optionIndex: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    kind: z.literal("multi"),
    questionIndex: z.number().int().nonnegative().safe(),
    optionIndices: z.array(z.number().int().nonnegative().safe()),
  }),
  z.strictObject({
    kind: z.literal("custom"),
    questionIndex: z.number().int().nonnegative().safe(),
    text: z.string().max(QUESTIONNAIRE_LIMITS.maxCustomAnswerChars),
  }),
]);
export type QuestionnaireAnswer = z.infer<typeof QuestionnaireAnswerSchema>;

function utf8Bytes(text: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
  return new TextEncoder().encode(text).length;
}

function questionnaireDataBytes(questions: readonly QuestionnaireQuestion[]): number {
  return utf8Bytes(JSON.stringify(questions));
}

function addQuestionnaireAnswerIssues(
  questions: readonly QuestionnaireQuestion[],
  answers: readonly QuestionnaireAnswer[],
  ctx: z.RefinementCtx,
  answersPath: Array<string | number>,
): void {
  if (answers.length !== questions.length) {
    ctx.addIssue({
      code: "custom",
      path: answersPath,
      message: "answers must cover every question exactly once",
    });
    return;
  }
  const seen = new Set<number>();
  for (let index = 0; index < answers.length; index += 1) {
    const answer = answers[index]!;
    const questionIndex = answer.questionIndex;
    if (questionIndex < 0 || questionIndex >= questions.length) {
      ctx.addIssue({
        code: "custom",
        path: [...answersPath, index, "questionIndex"],
        message: "questionIndex is out of range",
      });
      continue;
    }
    if (seen.has(questionIndex)) {
      ctx.addIssue({
        code: "custom",
        path: [...answersPath, index, "questionIndex"],
        message: "duplicate answer for question",
      });
      continue;
    }
    seen.add(questionIndex);
    const question = questions[questionIndex]!;
    const optionCount = question.options.length;
    if (answer.kind === "option") {
      if (question.multiSelect) {
        ctx.addIssue({
          code: "custom",
          path: [...answersPath, index, "kind"],
          message: "multi-select question requires a multi answer",
        });
      } else if (answer.optionIndex < 0 || answer.optionIndex >= optionCount) {
        ctx.addIssue({
          code: "custom",
          path: [...answersPath, index, "optionIndex"],
          message: "optionIndex is out of range",
        });
      }
      continue;
    }
    if (answer.kind === "multi") {
      if (!question.multiSelect) {
        ctx.addIssue({
          code: "custom",
          path: [...answersPath, index, "kind"],
          message: "single-select question does not allow a multi answer",
        });
        continue;
      }
      const unique = new Set<number>();
      for (let optionPos = 0; optionPos < answer.optionIndices.length; optionPos += 1) {
        const optionIndex = answer.optionIndices[optionPos]!;
        if (optionIndex < 0 || optionIndex >= optionCount) {
          ctx.addIssue({
            code: "custom",
            path: [...answersPath, index, "optionIndices", optionPos],
            message: "optionIndex is out of range",
          });
        } else if (unique.has(optionIndex)) {
          ctx.addIssue({
            code: "custom",
            path: [...answersPath, index, "optionIndices", optionPos],
            message: "optionIndices must be unique",
          });
        } else {
          unique.add(optionIndex);
        }
      }
      continue;
    }
    // kind "custom": numeric custom text is explicit intent, never inferred as a selection.
  }
  if (seen.size !== questions.length) {
    ctx.addIssue({
      code: "custom",
      path: answersPath,
      message: "answers must cover every question exactly once",
    });
  }
}

/**
 * Strict optional canonical close marker. A close tombstone is a normal
 * `extension_ui_request` event whose `request` carries `closed: true` (never
 * `false`); the pure projection removes that requestId and never stores the
 * tombstone. Only `true` is a valid value — fail-closed against `false` being
 * misread as a normal upsert.
 */
const closedMarker = { closed: z.literal(true).optional() };

const QuestionnaireRequestFieldsSchema = z.strictObject({
  id: NonEmptyStringSchema,
  method: z.literal("questionnaire"),
  questions: z.array(QuestionnaireQuestionSchema)
    .min(QUESTIONNAIRE_LIMITS.minQuestions)
    .max(QUESTIONNAIRE_LIMITS.maxQuestions),
  ...requestTiming,
  ...closedMarker,
}).superRefine((value, ctx) => {
  if (questionnaireDataBytes(value.questions) > QUESTIONNAIRE_LIMITS.maxBytes) {
    ctx.addIssue({
      code: "custom",
      path: ["questions"],
      message: `questionnaire payload exceeds ${QUESTIONNAIRE_LIMITS.maxBytes} UTF-8 bytes`,
    });
  }
});

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
  QuestionnaireRequestFieldsSchema,
]);
export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequestSchema>;
export const ExtensionUiRequestMethodSchema = z.enum([
  "select", "confirm", "input", "editor", "notify", "setStatus",
  "setWidget", "setTitle", "set_editor_text", "custom", "questionnaire",
]);

/**
 * Interactive methods (the only ones that produce a client response or
 * incremental input). notify/setStatus/setWidget/setTitle/set_editor_text are
 * events/state, not user-response requests. Questionnaire is final-response-only.
 */
export const ExtensionUiInteractiveMethodSchema = z.enum([
  "select", "confirm", "input", "editor", "custom", "questionnaire",
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
  z.strictObject({
    ...extensionCommandBase,
    id: NonEmptyStringSchema,
    method: z.literal("questionnaire"),
    responseKind: z.literal("questionnaire"),
    answers: z.array(QuestionnaireAnswerSchema),
  }),
  z.strictObject({ ...extensionCommandBase, id: NonEmptyStringSchema, method: z.enum(["select", "confirm", "input", "editor", "custom", "questionnaire"]), responseKind: z.literal("cancelled"), cancelled: z.literal(true) }),
]);
export type ExtensionUiResponseCommand = z.infer<typeof ExtensionUiResponseCommandSchema>;

/**
 * Incremental input is valid for input/editor/custom (E15: custom UI panels
 * stream raw key data — terminal bytes like `\x1b[A`, characters, `\x03`);
 * select/confirm/questionnaire are final-response-only and never accept incremental input.
 */
export const ExtensionUiInputCommandSchema = z.discriminatedUnion("method", [
  z.strictObject({ commandId: NonEmptyStringSchema, type: z.literal("extension_ui_input"), id: NonEmptyStringSchema, method: z.literal("input"), data: z.string() }),
  z.strictObject({ commandId: NonEmptyStringSchema, type: z.literal("extension_ui_input"), id: NonEmptyStringSchema, method: z.literal("editor"), data: z.string() }),
  z.strictObject({ commandId: NonEmptyStringSchema, type: z.literal("extension_ui_input"), id: NonEmptyStringSchema, method: z.literal("custom"), data: z.string() }),
]);
export type ExtensionUiInputCommand = z.infer<typeof ExtensionUiInputCommandSchema>;

/**
 * Authoritative request→command validation for R2 Mapper/Controller boundaries.
 * Callers MUST load the pending authoritative request and parse this exchange;
 * parsing the client command alone cannot prove request id/method correlation.
 * Questionnaire answers are validated against the pending request's questions;
 * invalid replies must leave the request pending.
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
    if (command.responseKind === "questionnaire") {
      if (request.method !== "questionnaire") {
        ctx.addIssue({ code: "custom", path: ["command", "responseKind"], message: "questionnaire response requires a questionnaire request" });
        return;
      }
      addQuestionnaireAnswerIssues(request.questions, command.answers, ctx, ["command", "answers"]);
    }
  });
export type ExtensionUiResponseExchange = z.infer<typeof ExtensionUiResponseExchangeSchema>;

/**
 * See ExtensionUiResponseExchangeSchema; input/editor/custom accept incremental
 * input (select/confirm/questionnaire and non-interactive methods never do).
 */
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
  z.strictObject({
    id: NonEmptyStringSchema,
    method: z.literal("questionnaire"),
    responseKind: z.literal("questionnaire"),
    answers: z.array(QuestionnaireAnswerSchema),
  }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.enum(["select", "confirm", "input", "editor", "custom", "questionnaire"]), responseKind: z.literal("cancelled"), cancelled: z.literal(true) }),
]);
export type ExtensionUiResponsePayload = z.infer<typeof ExtensionUiResponsePayloadSchema>;

/**
 * Streaming input updates are valid for input/editor/custom (E15 custom panels
 * stream raw key data); select/confirm/questionnaire are final-response-only.
 */
export const ExtensionUiInputPayloadSchema = z.discriminatedUnion("method", [
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("input"), data: z.string() }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("editor"), data: z.string() }),
  z.strictObject({ id: NonEmptyStringSchema, method: z.literal("custom"), data: z.string() }),
]);
export type ExtensionUiInputPayload = z.infer<typeof ExtensionUiInputPayloadSchema>;
