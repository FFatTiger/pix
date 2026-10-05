import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUESTIONNAIRE_LIMITS as CORE_LIMITS,
  validateQuestionnaireAnswers,
  validateQuestionnaireQuestions,
  type QuestionnaireAnswer as CoreAnswer,
  type QuestionnaireQuestion as CoreQuestion,
} from "@fffattiger/pix-runtime-core";
import {
  ExtensionUiRequestSchema,
  ExtensionUiResponseCommandSchema,
  ExtensionUiResponseExchangeSchema,
  QUESTIONNAIRE_LIMITS as WIRE_LIMITS,
  QuestionnaireAnswerSchema,
  QuestionnaireQuestionSchema,
} from "@fffattiger/pix-protocol";

test("questionnaire limits match canonical Runtime Core", () => {
  assert.deepEqual(WIRE_LIMITS, CORE_LIMITS);
});

test("protocol accepts the exact canonical questionnaire request/answer shapes", () => {
  const questions: CoreQuestion[] = [
    {
      header: "Auth",
      question: "Which auth?",
      options: [
        { label: "OAuth", description: "Browser login", preview: "```ts\noauth()\n```" },
        { label: "Token", description: "Static token" },
      ],
      multiSelect: false,
    },
    {
      header: "Features",
      question: "Which features?",
      options: [
        { label: "A", description: "Feature A" },
        { label: "B", description: "Feature B" },
      ],
      multiSelect: true,
    },
  ];
  const answers: CoreAnswer[] = [
    { kind: "custom", questionIndex: 0, text: "2" },
    { kind: "multi", questionIndex: 1, optionIndices: [] },
  ];
  assert.equal(validateQuestionnaireQuestions(questions).ok, true);
  assert.equal(validateQuestionnaireAnswers(questions, answers).ok, true);
  assert.deepEqual(QuestionnaireQuestionSchema.parse(questions[0]), questions[0]);
  assert.deepEqual(QuestionnaireAnswerSchema.parse(answers[0]), answers[0]);
  const request = ExtensionUiRequestSchema.parse({
    id: "q1",
    method: "questionnaire",
    questions,
    timeout: WIRE_LIMITS.timeoutMs,
  });
  const command = ExtensionUiResponseCommandSchema.parse({
    commandId: "c1",
    type: "extension_ui_response",
    id: "q1",
    method: "questionnaire",
    responseKind: "questionnaire",
    answers,
  });
  assert.equal(ExtensionUiResponseExchangeSchema.safeParse({ request, command }).success, true);
  assert.equal(ExtensionUiResponseExchangeSchema.safeParse({
    request,
    command: { ...command, answers: [{ kind: "option", questionIndex: 0, optionIndex: 0 }] },
  }).success, false);
});
