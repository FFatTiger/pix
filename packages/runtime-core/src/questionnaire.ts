/**
 * Canonical native questionnaire model and limits.
 *
 * Independent of Protocol, Pi SDK, and Zod. Oversized or malformed input is
 * rejected (never truncated) before a request may be published.
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

export interface QuestionnaireOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionnaireQuestion {
  header: string;
  question: string;
  options: readonly QuestionnaireOption[];
  multiSelect: boolean;
}

export type QuestionnaireAnswer =
  | { kind: "option"; questionIndex: number; optionIndex: number }
  | { kind: "multi"; questionIndex: number; optionIndices: readonly number[] }
  | { kind: "custom"; questionIndex: number; text: string };

export type QuestionnaireValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

/** UTF-8 size of the serialized questionnaire payload (questions only). */
export function questionnaireDataBytes(questions: readonly QuestionnaireQuestion[]): number {
  return utf8Bytes(JSON.stringify(questions));
}

export function validateQuestionnaireQuestions(
  questions: unknown,
): QuestionnaireValidationResult {
  if (!Array.isArray(questions)) return { ok: false, reason: "questions must be an array" };
  const { minQuestions, maxQuestions, minOptions, maxOptions } = QUESTIONNAIRE_LIMITS;
  if (questions.length < minQuestions || questions.length > maxQuestions) {
    return { ok: false, reason: `questions length must be ${minQuestions}..${maxQuestions}` };
  }
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const question = questions[questionIndex];
    if (!isObject(question)) return { ok: false, reason: `question ${questionIndex} must be an object` };
    if (!isBoundedString(question.header, QUESTIONNAIRE_LIMITS.maxHeaderChars)) {
      return { ok: false, reason: `question ${questionIndex} header exceeds ${QUESTIONNAIRE_LIMITS.maxHeaderChars} chars` };
    }
    if (!isBoundedString(question.question, QUESTIONNAIRE_LIMITS.maxQuestionChars)) {
      return { ok: false, reason: `question ${questionIndex} text exceeds ${QUESTIONNAIRE_LIMITS.maxQuestionChars} chars` };
    }
    if (typeof question.multiSelect !== "boolean") {
      return { ok: false, reason: `question ${questionIndex} multiSelect must be a boolean` };
    }
    if (!Array.isArray(question.options)) {
      return { ok: false, reason: `question ${questionIndex} options must be an array` };
    }
    if (question.options.length < minOptions || question.options.length > maxOptions) {
      return { ok: false, reason: `question ${questionIndex} options length must be ${minOptions}..${maxOptions}` };
    }
    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
      const option = question.options[optionIndex];
      if (!isObject(option)) {
        return { ok: false, reason: `question ${questionIndex} option ${optionIndex} must be an object` };
      }
      if (!isBoundedString(option.label, QUESTIONNAIRE_LIMITS.maxLabelChars)) {
        return { ok: false, reason: `question ${questionIndex} option ${optionIndex} label exceeds ${QUESTIONNAIRE_LIMITS.maxLabelChars} chars` };
      }
      if (!isBoundedString(option.description, QUESTIONNAIRE_LIMITS.maxDescriptionChars)) {
        return { ok: false, reason: `question ${questionIndex} option ${optionIndex} description exceeds ${QUESTIONNAIRE_LIMITS.maxDescriptionChars} chars` };
      }
      if (option.preview !== undefined && !isBoundedString(option.preview, QUESTIONNAIRE_LIMITS.maxPreviewChars)) {
        return { ok: false, reason: `question ${questionIndex} option ${optionIndex} preview exceeds ${QUESTIONNAIRE_LIMITS.maxPreviewChars} chars` };
      }
    }
  }
  if (questionnaireDataBytes(questions as QuestionnaireQuestion[]) > QUESTIONNAIRE_LIMITS.maxBytes) {
    return { ok: false, reason: `questionnaire payload exceeds ${QUESTIONNAIRE_LIMITS.maxBytes} UTF-8 bytes` };
  }
  return { ok: true };
}

export function validateQuestionnaireAnswers(
  questions: readonly QuestionnaireQuestion[],
  answers: unknown,
): QuestionnaireValidationResult {
  if (!Array.isArray(answers)) return { ok: false, reason: "answers must be an array" };
  if (answers.length !== questions.length) {
    return { ok: false, reason: "answers must cover every question exactly once" };
  }
  const seen = new Set<number>();
  for (let index = 0; index < answers.length; index += 1) {
    const answer = answers[index];
    if (!isObject(answer) || typeof answer.kind !== "string" || !isFiniteInt(answer.questionIndex)) {
      return { ok: false, reason: `answer ${index} is malformed` };
    }
    const questionIndex = answer.questionIndex;
    if (questionIndex < 0 || questionIndex >= questions.length) {
      return { ok: false, reason: `answer ${index} questionIndex is out of range` };
    }
    if (seen.has(questionIndex)) {
      return { ok: false, reason: `duplicate answer for question ${questionIndex}` };
    }
    seen.add(questionIndex);
    const question = questions[questionIndex]!;
    const optionCount = question.options.length;
    if (answer.kind === "option") {
      if (question.multiSelect) return { ok: false, reason: `question ${questionIndex} requires a multi answer` };
      if (!isFiniteInt(answer.optionIndex) || answer.optionIndex < 0 || answer.optionIndex >= optionCount) {
        return { ok: false, reason: `answer ${index} optionIndex is out of range` };
      }
      continue;
    }
    if (answer.kind === "multi") {
      if (!question.multiSelect) return { ok: false, reason: `question ${questionIndex} does not allow a multi answer` };
      if (!Array.isArray(answer.optionIndices)) {
        return { ok: false, reason: `answer ${index} optionIndices must be an array` };
      }
      const unique = new Set<number>();
      for (const optionIndex of answer.optionIndices) {
        if (!isFiniteInt(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) {
          return { ok: false, reason: `answer ${index} optionIndices contains an out-of-range index` };
        }
        if (unique.has(optionIndex)) {
          return { ok: false, reason: `answer ${index} optionIndices must be unique` };
        }
        unique.add(optionIndex);
      }
      continue;
    }
    if (answer.kind === "custom") {
      if (!isBoundedString(answer.text, QUESTIONNAIRE_LIMITS.maxCustomAnswerChars)) {
        return { ok: false, reason: `answer ${index} custom text exceeds ${QUESTIONNAIRE_LIMITS.maxCustomAnswerChars} chars` };
      }
      continue;
    }
    return { ok: false, reason: `answer ${index} has unknown kind` };
  }
  if (seen.size !== questions.length) {
    return { ok: false, reason: "answers must cover every question exactly once" };
  }
  return { ok: true };
}
