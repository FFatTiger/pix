import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_QUESTIONNAIRE_CUSTOM,
  ASK_USER_QUESTION_TOOL_NAME,
  mapQuestionnaireAnswersToPackageResult,
  normalizeAskLineTerminators,
  projectAskQuestions,
  wrapExactBundledAskQuestionnaire,
} from "../src/internal/ask-questionnaire-bridge.js";
import { bundledPluginRoots, resourceLoaderOptionsForBuiltIns } from "../src/internal/curated-plugins.js";

const questions = [{
  question: "Which auth?",
  header: "Auth",
  options: [
    { label: "OAuth", description: "Browser login", preview: "code" },
    { label: "Token", description: "Static token" },
  ],
}];

describe("ask questionnaire bridge", () => {
  it("projects 2.11.0 CRLF/lone-CR normalization onto known fields only", () => {
    assert.equal(normalizeAskLineTerminators("a\r\nb\rc"), "a\nbc");
    const projected = projectAskQuestions({
      questions: [{
        question: "Which\r auth?",
        header: "Au\rth",
        options: [{ label: "OAu\rth", description: "Browser\r\nlogin", preview: "pre\rview" }, { label: "Token", description: "Static" }],
        extra: "ignored",
      }],
    });
    assert.deepEqual(projected, [{
      header: "Auth",
      question: "Which auth?",
      options: [
        { label: "OAuth", description: "Browser\nlogin", preview: "preview" },
        { label: "Token", description: "Static" },
      ],
      multiSelect: false,
    }]);
  });

  it("maps accepted indices onto authoritative labels/preview/custom text", () => {
    const mapped = mapQuestionnaireAnswersToPackageResult(projectAskQuestions({ questions: [{ ...questions[0], multiSelect: true }] })!, [
      { kind: "multi", questionIndex: 0, optionIndices: [0] },
    ]);
    assert.equal(mapped.cancelled, false);
    assert.deepEqual(mapped.answers[0]?.selected, ["OAuth"]);
    const custom = mapQuestionnaireAnswersToPackageResult(projectAskQuestions({ questions })!, [
      { kind: "custom", questionIndex: 0, text: "3" },
    ]);
    assert.equal(custom.answers[0]?.answer, "3");
    const option = mapQuestionnaireAnswersToPackageResult(projectAskQuestions({ questions })!, [
      { kind: "option", questionIndex: 0, optionIndex: 0 },
    ]);
    assert.equal(option.answers[0]?.preview, "code");
    assert.equal(option.answers[0]?.answer, "OAuth");
  });

  it("wraps only the exact bundled ask path+tool and leaves replacements/unrelated tools unchanged", () => {
    const ask = bundledPluginRoots().find((item) => item.id === "ask_user_question")!;
    const original = async () => ({ wrapped: false });
    const foreignExecute = async () => ({ wrapped: false });
    const wrapped = wrapExactBundledAskQuestionnaire({
      extensions: [
        {
          path: ask.entry,
          resolvedPath: ask.entry,
          tools: new Map([[ASK_USER_QUESTION_TOOL_NAME, { definition: { name: ASK_USER_QUESTION_TOOL_NAME, execute: original }, sourceInfo: { origin: "bundled" } }]]),
        },
        {
          path: "/tmp/user/ask/index.ts",
          resolvedPath: "/tmp/user/ask/index.ts",
          tools: new Map([[ASK_USER_QUESTION_TOOL_NAME, { definition: { name: ASK_USER_QUESTION_TOOL_NAME, execute: foreignExecute }, sourceInfo: { origin: "user" } }]]),
        },
        {
          path: "/project/other.ts",
          resolvedPath: "/project/other.ts",
          tools: new Map([["other", { definition: { name: "other", execute: foreignExecute }, sourceInfo: { origin: "user" } }]]),
        },
      ],
      errors: [],
      runtime: {},
    });
    const bundled = wrapped.extensions[0]!.tools!.get(ASK_USER_QUESTION_TOOL_NAME) as { definition: { execute: unknown } };
    const foreign = wrapped.extensions[1]!.tools!.get(ASK_USER_QUESTION_TOOL_NAME) as { definition: { execute: unknown } };
    const other = wrapped.extensions[2]!.tools!.get("other") as { definition: { execute: unknown } };
    assert.notEqual(bundled.definition.execute, original);
    assert.equal(foreign.definition.execute, foreignExecute);
    assert.equal(other.definition.execute, foreignExecute);
  });

  it("go/no-go: pinned SDK loader execute issues one native questionnaire custom, no TUI factory, no RPC walker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-ask-bridge-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeFile(join(agentDir, "pix-builtins.json"), `${JSON.stringify({
      version: 1,
      subagents: false,
      todo: false,
      ask_user_question: true,
      side_chat: false,
    }, null, 2)}\n`, { mode: 0o600 });
    let factoryInvoked = false;
    let walkerSelects = 0;
    let customCalls = 0;
    let marked = false;
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        ...resourceLoaderOptionsForBuiltIns(agentDir),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      const ask = bundledPluginRoots().find((item) => item.id === "ask_user_question")!;
      const extension = loaded.extensions.find((item) => item.resolvedPath === ask.entry || item.path === ask.entry || item.resolvedPath === ask.root);
      assert.ok(extension, "exact bundled ask extension must load");
      const tool = extension.tools.get(ASK_USER_QUESTION_TOOL_NAME);
      assert.ok(tool, "ask_user_question must be registered");
      const ctx = {
        hasUI: true,
        mode: "rpc",
        cwd,
        isProjectTrusted: () => true,
        ui: {
          custom: async (factory: unknown, options: Record<symbol | string, unknown>) => {
            customCalls += 1;
            marked = ASK_QUESTIONNAIRE_CUSTOM in options;
            if (typeof factory === "function") {
              // Driver createUiContext must ignore this factory; invoking it would load TUI.
            }
            return { answers: [{ questionIndex: 0, question: "Which auth?", kind: "option", answer: "OAuth", preview: "code" }], cancelled: false };
          },
          select: async () => {
            walkerSelects += 1;
            return "OAuth";
          },
          input: async () => {
            walkerSelects += 1;
            return "typed";
          },
          notify: () => {},
          onTerminalInput: () => () => {},
        },
      };
      const result = await (tool.definition.execute as (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>)("call-1", { questions }, undefined, undefined, ctx) as {
        content: Array<{ text: string }>;
        details: { cancelled: boolean; answers: Array<{ answer?: string | null; preview?: string }> };
      };
      assert.equal(customCalls, 1);
      assert.equal(marked, true);
      assert.equal(factoryInvoked, false);
      assert.equal(walkerSelects, 0);
      assert.equal(result.details.cancelled, false);
      assert.equal(result.details.answers[0]?.answer, "OAuth");
      assert.match(result.content[0]!.text, /User has answered your questions/);

      const aborted = new AbortController();
      aborted.abort();
      let abortedCustom = 0;
      const abortedCtx = {
        ...ctx,
        ui: {
          ...ctx.ui,
          custom: async () => {
            abortedCustom += 1;
            throw new Error("custom must not run after abort");
          },
        },
      };
      await assert.rejects(
        () => (tool.definition.execute as (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>)("call-abort", { questions }, aborted.signal, undefined, abortedCtx),
        (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "interrupted",
      );
      assert.equal(abortedCustom, 0, "pre-abort must not publish UI via custom()");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
