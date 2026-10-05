/**
 * Native questionnaire bridge for the exact bundled `@juicesharp/rpiv-ask-user-question@2.11.0`
 * registration, composed into the public SDK `extensionsOverride` hook.
 *
 * Characterized against Pi SDK 1.0.0 + ask 2.11.0:
 * wrap only the exact bundled path + `ask_user_question` tool, keep the original
 * execute (validation, TUI import, envelope builder), and divert `ui.custom`
 * through an Adapter-private symbol. Removal condition: the dependency upgrade
 * that adopts an upstream structured questionnaire responder API.
 */
import { resolve } from "node:path";
import {
  makeRuntimeError,
  QUESTIONNAIRE_LIMITS,
  validateQuestionnaireQuestions,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
} from "@fffattiger/pix-runtime-core";
import { bundledPluginRoots, isExactBundledPath, type ExtensionLike, type LoadExtensionsLike } from "./curated-plugins.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** Adapter-private in-process marker. Never serialized into Core or Protocol. */
export const ASK_QUESTIONNAIRE_CUSTOM = Symbol("pix.askQuestionnaireCustom");

export interface AskQuestionnaireCustomPayload {
  questions: readonly QuestionnaireQuestion[];
  signal?: AbortSignal | undefined;
}

export interface AskQuestionnaireCustomOptions {
  overlay?: boolean;
  overlayOptions?: unknown;
  onHandle?: unknown;
  [ASK_QUESTIONNAIRE_CUSTOM]?: AskQuestionnaireCustomPayload;
}

type RegisteredToolLike = {
  definition: {
    name?: string;
    execute: (...args: never[]) => unknown;
    [key: string]: unknown;
  };
  sourceInfo: unknown;
};

function isRegisteredTool(value: unknown): value is RegisteredToolLike {
  return typeof value === "object"
    && value !== null
    && "definition" in value
    && typeof (value as { definition?: { execute?: unknown } }).definition?.execute === "function";
}

function defineGetter<T extends object, K extends keyof T>(target: T, source: T, key: K): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor !== undefined) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get: () => source[key],
  });
}

/**
 * Field projection matching ask 2.11.0 `normalizeLineTerminators`:
 * CRLF → LF, then delete remaining CR. Limited to the known user-facing strings.
 */
export function normalizeAskLineTerminators(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function normalizeStringField<T extends object>(obj: T, key: keyof T): T {
  const value = obj[key];
  if (typeof value !== "string") return obj;
  return { ...obj, [key]: normalizeAskLineTerminators(value) };
}

export function projectAskQuestions(params: unknown): QuestionnaireQuestion[] | undefined {
  if (typeof params !== "object" || params === null || !("questions" in params) || !Array.isArray((params as { questions: unknown }).questions)) {
    return undefined;
  }
  const questions: QuestionnaireQuestion[] = [];
  for (const raw of (params as { questions: unknown[] }).questions) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const question = raw as Record<string, unknown>;
    if (typeof question.question !== "string" || typeof question.header !== "string" || !Array.isArray(question.options)) {
      return undefined;
    }
    const options: Array<QuestionnaireQuestion["options"][number]> = [];
    for (const rawOption of question.options) {
      if (typeof rawOption !== "object" || rawOption === null) return undefined;
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string" || typeof option.description !== "string") return undefined;
      const projected = {
        label: normalizeAskLineTerminators(option.label),
        description: normalizeAskLineTerminators(option.description),
        ...(typeof option.preview === "string" ? { preview: normalizeAskLineTerminators(option.preview) } : {}),
      };
      options.push(projected);
    }
    questions.push({
      header: normalizeAskLineTerminators(question.header),
      question: normalizeAskLineTerminators(question.question),
      options,
      multiSelect: question.multiSelect === true,
    });
  }
  return questions;
}

export function isAskQuestionnaireCustomOptions(value: unknown): value is AskQuestionnaireCustomOptions {
  return typeof value === "object" && value !== null && ASK_QUESTIONNAIRE_CUSTOM in value;
}

export function deriveAskExecuteContext<T extends { mode?: string; ui: { custom: (...args: never[]) => unknown } }>(
  ctx: T,
  questions: readonly QuestionnaireQuestion[],
  signal: AbortSignal | undefined,
): T {
  const originalCustom = ctx.ui.custom.bind(ctx.ui);
  const derivedUi = Object.create(ctx.ui) as T["ui"];
  derivedUi.custom = ((factory: unknown, options?: AskQuestionnaireCustomOptions) => {
    if (signal?.aborted) {
      return Promise.reject(makeRuntimeError("interrupted", "questionnaire was interrupted"));
    }
    const copied: AskQuestionnaireCustomOptions = { ...(options ?? {}) };
    copied[ASK_QUESTIONNAIRE_CUSTOM] = { questions, ...(signal === undefined ? {} : { signal }) };
    return originalCustom(factory as never, copied as never);
  }) as T["ui"]["custom"];
  const derived = Object.create(Object.getPrototypeOf(ctx)) as T;
  Object.assign(derived, ctx);
  derived.mode = "tui";
  derived.ui = derivedUi;
  for (const key of ["hasUI", "cwd", "sessionManager", "modelRegistry", "model", "scopedModels", "thinkingLevel", "signal"] as const) {
    if (key in ctx) defineGetter(derived, ctx, key as keyof T);
  }
  for (const key of ["isIdle", "isProjectTrusted", "abort", "hasPendingMessages", "shutdown", "getContextUsage", "compact", "getSystemPrompt"] as const) {
    if (typeof (ctx as Record<string, unknown>)[key] === "function") {
      (derived as Record<string, unknown>)[key] = (ctx as Record<string, unknown>)[key];
    }
  }
  return derived;
}

export function mapQuestionnaireAnswersToPackageResult(
  questions: readonly QuestionnaireQuestion[],
  answers: readonly QuestionnaireAnswer[],
): {
  answers: Array<{
    questionIndex: number;
    question: string;
    kind: "option" | "custom" | "multi";
    answer: string | null;
    selected?: string[];
    preview?: string;
  }>;
  cancelled: false;
} {
  const mapped = answers.map((answer) => {
    const question = questions[answer.questionIndex]!;
    if (answer.kind === "option") {
      const option = question.options[answer.optionIndex]!;
      return {
        questionIndex: answer.questionIndex,
        question: question.question,
        kind: "option" as const,
        answer: option.label,
        ...(option.preview === undefined ? {} : { preview: option.preview }),
      };
    }
    if (answer.kind === "multi") {
      return {
        questionIndex: answer.questionIndex,
        question: question.question,
        kind: "multi" as const,
        answer: null,
        selected: answer.optionIndices.map((index) => question.options[index]!.label),
      };
    }
    return {
      questionIndex: answer.questionIndex,
      question: question.question,
      kind: "custom" as const,
      answer: answer.text,
    };
  });
  return { answers: mapped, cancelled: false };
}

function wrapAskRegistration(tool: RegisteredToolLike): RegisteredToolLike {
  const originalExecute = tool.definition.execute as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { mode?: string; ui: { custom: (...args: never[]) => unknown } },
  ) => Promise<unknown>;
  return {
    ...tool,
    definition: {
      ...tool.definition,
      async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { mode?: string; ui: { custom: (...args: never[]) => unknown } }) {
        const abortSignal = signal;
        if (abortSignal?.aborted) {
          throw makeRuntimeError("interrupted", "questionnaire was interrupted");
        }
        const questions = projectAskQuestions(params);
        if (questions === undefined || validateQuestionnaireQuestions(questions).ok === false) {
          return originalExecute(toolCallId, params, abortSignal, onUpdate, ctx);
        }
        const derived = deriveAskExecuteContext(ctx, questions, abortSignal);
        return originalExecute(toolCallId, params, abortSignal, onUpdate, derived);
      },
    },
  };
}

function isExactBundledAskExtension(extension: ExtensionLike): boolean {
  const ask = bundledPluginRoots().find((root) => root.id === "ask_user_question");
  if (ask === undefined) return false;
  return isExactBundledPath(extension.resolvedPath ?? extension.path, ask);
}

export function wrapExactBundledAskQuestionnaire<T extends ExtensionLike, R>(
  base: LoadExtensionsLike<T, R>,
): LoadExtensionsLike<T, R> {
  return {
    ...base,
    extensions: base.extensions.map((extension) => {
      if (!isExactBundledAskExtension(extension) || extension.tools === undefined) return extension;
      const tools = new Map(extension.tools);
      const registered = tools.get(ASK_USER_QUESTION_TOOL_NAME);
      if (!isRegisteredTool(registered)) return extension;
      tools.set(ASK_USER_QUESTION_TOOL_NAME, wrapAskRegistration(registered));
      return { ...extension, tools };
    }),
  };
}

export function createAskQuestionnaireExtensionsOverride(inner: <T extends ExtensionLike, R>(base: LoadExtensionsLike<T, R>) => LoadExtensionsLike<T, R>) {
  return <T extends ExtensionLike, R>(base: LoadExtensionsLike<T, R>): LoadExtensionsLike<T, R> =>
    wrapExactBundledAskQuestionnaire(inner(base));
}
