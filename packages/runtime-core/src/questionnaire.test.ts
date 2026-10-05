import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUESTIONNAIRE_LIMITS,
  questionnaireDataBytes,
  validateQuestionnaireAnswers,
  validateQuestionnaireQuestions,
  type QuestionnaireQuestion,
} from "./questionnaire.js";

function option(label: string, extra: { description?: string; preview?: string } = {}) {
  return { label, description: extra.description ?? `${label} description`, ...(extra.preview === undefined ? {} : { preview: extra.preview }) };
}

function question(overrides: Partial<QuestionnaireQuestion> = {}): QuestionnaireQuestion {
  return {
    header: "Header",
    question: "Which option?",
    options: [option("Alpha"), option("Beta")],
    multiSelect: false,
    ...overrides,
  };
}

test("QUESTIONNAIRE_LIMITS are the frozen product bounds", () => {
  assert.deepEqual(QUESTIONNAIRE_LIMITS, {
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
  });
});

test("valid questionnaire is accepted; oversized fields and arrays are rejected, not truncated", () => {
  assert.equal(validateQuestionnaireQuestions([question()]).ok, true);
  assert.equal(validateQuestionnaireQuestions([]).ok, false);
  assert.equal(validateQuestionnaireQuestions([question(), question(), question(), question(), question()]).ok, false);
  assert.equal(validateQuestionnaireQuestions([question({ header: "x".repeat(17) })]).ok, false);
  assert.equal(validateQuestionnaireQuestions([question({ options: [option("A")] })]).ok, false);
  const tooManyOptions = question({ options: [option("A"), option("B"), option("C"), option("D"), option("E")] });
  assert.equal(validateQuestionnaireQuestions([tooManyOptions]).ok, false);
  assert.equal(validateQuestionnaireQuestions([question({ question: "q".repeat(QUESTIONNAIRE_LIMITS.maxQuestionChars + 1) })]).ok, false);
});

test("answers require complete coverage, allow empty multi, and keep numeric custom text as custom", () => {
  const questions: QuestionnaireQuestion[] = [
    question(),
    question({ multiSelect: true, options: [option("One"), option("Two"), option("Three")] }),
  ];
  assert.equal(validateQuestionnaireAnswers(questions, [
    { kind: "option", questionIndex: 0, optionIndex: 1 },
    { kind: "multi", questionIndex: 1, optionIndices: [] },
  ]).ok, true);
  assert.equal(validateQuestionnaireAnswers(questions, [
    { kind: "custom", questionIndex: 0, text: "3" },
    { kind: "multi", questionIndex: 1, optionIndices: [0, 2] },
  ]).ok, true);
  assert.equal(validateQuestionnaireAnswers(questions, [
    { kind: "option", questionIndex: 0, optionIndex: 1 },
  ]).ok, false, "incomplete answers must reject");
  assert.equal(validateQuestionnaireAnswers(questions, [
    { kind: "multi", questionIndex: 0, optionIndices: [0] },
    { kind: "option", questionIndex: 1, optionIndex: 0 },
  ]).ok, false, "single/multi mismatch must reject");
  assert.equal(validateQuestionnaireAnswers(questions, [
    { kind: "option", questionIndex: 0, optionIndex: 9 },
    { kind: "multi", questionIndex: 1, optionIndices: [] },
  ]).ok, false, "out-of-range option must reject");
  assert.equal(validateQuestionnaireAnswers(questions, [
    { kind: "option", questionIndex: 0, optionIndex: 0 },
    { kind: "multi", questionIndex: 1, optionIndices: [1, 1] },
  ]).ok, false, "duplicate option indices must reject");
});

test("aggregate UTF-8 ceiling rejects before publication", () => {
  const hugePreview = "p".repeat(QUESTIONNAIRE_LIMITS.maxPreviewChars);
  const questions: QuestionnaireQuestion[] = [
    question({ options: [option("A", { preview: hugePreview }), option("B", { preview: hugePreview })] }),
    question({ options: [option("C", { preview: hugePreview }), option("D", { preview: hugePreview })] }),
    question({ options: [option("E", { preview: hugePreview }), option("F", { preview: hugePreview })] }),
    question({ options: [option("G", { preview: hugePreview }), option("H", { preview: hugePreview })] }),
  ];
  assert.ok(questionnaireDataBytes(questions) > QUESTIONNAIRE_LIMITS.maxBytes);
  assert.equal(validateQuestionnaireQuestions(questions).ok, false);
});
