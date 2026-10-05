import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QUESTIONNAIRE_LIMITS } from "@fffattiger/pix-protocol";
import { I18nProvider } from "@/hooks/useI18n";
import { ExtensionQuestionnaire, type ExtensionQuestionnaireRequest, type ExtensionQuestionnaireResponse } from "./ExtensionQuestionnaire";

function wrap(node: React.ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

function question(overrides: Partial<ExtensionQuestionnaireRequest["questions"][number]> & Pick<ExtensionQuestionnaireRequest["questions"][number], "header" | "question" | "multiSelect">): ExtensionQuestionnaireRequest["questions"][number] {
  return {
    options: overrides.options ?? [
      { label: "One", description: "first", preview: "preview-one" },
      { label: "Two", description: "second" },
    ],
    ...overrides,
  };
}

function questionnaireRequest(questions: ExtensionQuestionnaireRequest["questions"], id = "q1"): ExtensionQuestionnaireRequest {
  return { id, method: "questionnaire", questions };
}

function makeRespond() {
  return vi.fn((_request: ExtensionQuestionnaireRequest, _response: ExtensionQuestionnaireResponse) => undefined);
}

describe("ExtensionQuestionnaire — native whole questionnaire", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem("pi-locale");
  });

  it("keeps drafts across structuredClone refreshes while typing custom text", () => {
    const onRespond = makeRespond();
    const request = questionnaireRequest([question({ header: "H1", question: "Q1?", multiSelect: false })]);
    const { rerender } = wrap(<ExtensionQuestionnaire request={request} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    fireEvent.change(screen.getByLabelText("Custom answer"), { target: { value: "typed 123" } });
    rerender(
      <I18nProvider>
        <ExtensionQuestionnaire request={structuredClone(request)} onRespond={onRespond} />
      </I18nProvider>,
    );
    expect((screen.getByLabelText("Custom answer") as HTMLTextAreaElement).value).toBe("typed 123");
    rerender(
      <I18nProvider>
        <ExtensionQuestionnaire request={structuredClone(request)} onRespond={onRespond} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0]![1]).toEqual({
      answers: [{ kind: "custom", questionIndex: 0, text: "typed 123" }],
    });
  });

  it("keeps per-question selection and unfinished custom text across Prev/Next and mode switches", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([
          question({ header: "H1", question: "Color?", multiSelect: false }),
          question({
            header: "H2",
            question: "Tools?",
            multiSelect: true,
            options: [
              { label: "A", description: "alpha", preview: "preview-A" },
              { label: "B", description: "beta" },
            ],
          }),
        ])}
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /One/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    fireEvent.change(screen.getByLabelText("Custom answer"), { target: { value: "draft-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose options" }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    fireEvent.change(screen.getByLabelText("Custom answer"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    expect((screen.getByLabelText("Custom answer") as HTMLTextAreaElement).value).toBe("draft-one");
    fireEvent.click(screen.getByRole("button", { name: "Choose options" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Custom answer") as HTMLTextAreaElement).value).toBe("42");
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("submits multi, numeric custom, and preview-bearing options in one final payload", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([
          question({
            header: "H1",
            question: "Tools?",
            multiSelect: true,
            options: [
              { label: "A", description: "alpha", preview: "preview-A" },
              { label: "B", description: "beta" },
            ],
          }),
          question({ header: "H2", question: "Count?", multiSelect: false }),
        ])}
        onRespond={onRespond}
      />,
    );
    expect(screen.getByText("preview-A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    fireEvent.change(screen.getByLabelText("Custom answer"), { target: { value: "007" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0]![1]).toEqual({
      answers: [
        { kind: "multi", questionIndex: 0, optionIndices: [] },
        { kind: "custom", questionIndex: 1, text: "007" },
      ],
    });
  });

  it("does not show extra navigation for a single question and blocks submit until a single-select answer exists", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "Only", question: "Pick?", multiSelect: false })])}
        onRespond={onRespond}
      />,
    );
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Choose an option before submitting.");
    fireEvent.click(screen.getByRole("radio", { name: /Two/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith(expect.anything(), {
      answers: [{ kind: "option", questionIndex: 0, optionIndex: 1 }],
    });
  });

  it("caps custom answers at QUESTIONNAIRE_LIMITS.maxCustomAnswerChars", () => {
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Q?", multiSelect: false })])}
        onRespond={makeRespond()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    const textarea = screen.getByLabelText("Custom answer") as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(QUESTIONNAIRE_LIMITS.maxCustomAnswerChars);
  });

  it("cancels from the footer and from custom Escape, and never submits while IME is composing", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Q?", multiSelect: false })])}
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRespond).toHaveBeenCalledWith(expect.anything(), { cancelled: true });
    cleanup();
    const second = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Q?", multiSelect: false })])}
        onRespond={second}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a custom answer" }));
    const textarea = screen.getByLabelText("Custom answer");
    fireEvent.change(textarea, { target: { value: "ime" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(second).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, keyCode: 229 });
    expect(second).not.toHaveBeenCalled();
    const escaped = fireEvent.keyDown(textarea, { key: "Escape", keyCode: 27 });
    expect(escaped).toBe(false);
    expect(second).toHaveBeenCalledWith(expect.anything(), { cancelled: true });
  });

  it("translates fixed chrome in en and zh-CN while keeping question copy verbatim", () => {
    window.localStorage.setItem("pi-locale", "en");
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([
          question({ header: "Hdr", question: "原文问题", multiSelect: false }),
          question({ header: "Hdr2", question: "Second", multiSelect: false }),
        ])}
        onRespond={makeRespond()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Your response" })).toBeTruthy();
    expect(screen.getByText("Hdr")).toBeTruthy();
    expect(screen.getByText("原文问题")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a custom answer" })).toBeTruthy();
    cleanup();
    window.localStorage.setItem("pi-locale", "zh-CN");
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([
          question({ header: "Hdr", question: "原文问题", multiSelect: false }),
          question({ header: "Hdr2", question: "Second", multiSelect: false }),
        ])}
        onRespond={makeRespond()}
      />,
    );
    expect(screen.getByRole("heading", { name: "需要你的回答" })).toBeTruthy();
    expect(screen.getByText("原文问题")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一题" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一题" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用自定义回答" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });
});
