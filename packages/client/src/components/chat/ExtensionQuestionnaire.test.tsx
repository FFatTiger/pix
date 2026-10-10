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

function customInput(): HTMLInputElement {
  return screen.getByLabelText("Custom answer") as HTMLInputElement;
}

function activateCustom(value?: string) {
  const input = customInput();
  fireEvent.focus(input);
  if (value !== undefined) fireEvent.change(input, { target: { value } });
  return input;
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
    activateCustom("typed 123");
    rerender(
      <I18nProvider>
        <ExtensionQuestionnaire request={structuredClone(request)} onRespond={onRespond} />
      </I18nProvider>,
    );
    expect(customInput().value).toBe("typed 123");
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
    activateCustom("draft-one");
    fireEvent.click(screen.getByRole("radio", { name: /One/ }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /A/ }));
    activateCustom("42");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    expect(customInput().value).toBe("draft-one");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(customInput().value).toBe("42");
    expect((screen.getByRole("checkbox", { name: /A/ }) as HTMLInputElement).checked).toBe(false);
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
    expect((screen.getByRole("checkbox", { name: /A/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.mouseEnter(screen.getByRole("checkbox", { name: /A/ }).closest("label")!);
    expect(screen.getByText("preview-A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    activateCustom("007");
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
    expect(customInput().maxLength).toBe(QUESTIONNAIRE_LIMITS.maxCustomAnswerChars);
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
    const input = activateCustom("ime");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(second).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, keyCode: 229 });
    expect(second).not.toHaveBeenCalled();
    const escaped = fireEvent.keyDown(input, { key: "Escape", keyCode: 27 });
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
    expect(customInput()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a custom answer" })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("radio", { name: /One/ }).closest("label")!);
    expect(screen.getByText("Preview")).toBeTruthy();
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
    expect(screen.getByLabelText("自定义回答")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "使用自定义回答" })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("radio", { name: /One/ }).closest("label")!);
    expect(screen.getByText("预览")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("shows the custom field without a toggle and hides the preview pane when no option has a preview", () => {
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([
          question({
            header: "H",
            question: "Q?",
            multiSelect: false,
            options: [
              { label: "One", description: "first" },
              { label: "Two", description: "second" },
            ],
          }),
        ])}
        onRespond={makeRespond()}
      />,
    );
    expect(customInput()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a custom answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose options" })).toBeNull();
    expect(document.querySelector(".questionnaire-preview-panel")).toBeNull();
    expect(document.querySelector(".questionnaire-dialog--compact")).toBeTruthy();
  });

  it("treats custom focus as the active answer, keeps empty custom valid, and restores option submit after choosing again", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Q?", multiSelect: false })])}
        onRespond={onRespond}
      />,
    );
    expect(document.querySelector(".questionnaire-custom-indicator")).toBeNull();
    expect(document.querySelector(".questionnaire-choice-layout.is-inactive")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /One/ }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.focus(customInput());
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector(".questionnaire-custom.is-active")).toBeTruthy();
    expect(document.querySelector(".questionnaire-choice-layout.is-inactive")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith(expect.anything(), {
      answers: [{ kind: "custom", questionIndex: 0, text: "" }],
    });
    cleanup();
    const second = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Q?", multiSelect: false })])}
        onRespond={second}
      />,
    );
    activateCustom("keep-me");
    expect(document.querySelector(".questionnaire-choice-layout.is-inactive")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Two/ }));
    expect(document.querySelector(".questionnaire-choice-layout.is-inactive")).toBeNull();
    expect((screen.getByRole("radio", { name: /Two/ }) as HTMLInputElement).checked).toBe(true);
    expect(customInput().value).toBe("keep-me");
    expect(document.querySelector(".questionnaire-custom.is-active")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(second).toHaveBeenCalledWith(expect.anything(), {
      answers: [{ kind: "option", questionIndex: 0, optionIndex: 1 }],
    });
  });

  it("updates the preview on hover/focus without changing the answer, and resets preview on next question", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([
          question({ header: "H1", question: "Color?", multiSelect: false }),
          question({
            header: "H2",
            question: "More?",
            multiSelect: false,
            options: [
              { label: "A", description: "alpha", preview: "preview-A" },
              { label: "B", description: "beta", preview: "preview-B" },
            ],
          }),
        ])}
        onRespond={onRespond}
      />,
    );
    expect(document.querySelector(".questionnaire-preview-lines")?.textContent).toBe("preview-one");
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: /One/ }));
    expect(document.querySelector(".questionnaire-preview-lines")?.textContent).toBe("preview-one");
    fireEvent.mouseEnter(screen.getByRole("radio", { name: /Two/ }).closest("label")!);
    expect(document.querySelector(".questionnaire-preview-lines")?.textContent).toBe("second");
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /Two/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.focus(screen.getByRole("radio", { name: /Two/ }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    activateCustom("still-custom");
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.mouseEnter(screen.getByRole("radio", { name: /Two/ }).closest("label")!);
    fireEvent.focus(screen.getByRole("radio", { name: /Two/ }));
    expect((screen.getByRole("radio", { name: /One/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: /Two/ }) as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector(".questionnaire-custom.is-active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(document.querySelector(".questionnaire-preview-lines")?.textContent).toBe("preview-A");
    expect((screen.getByRole("radio", { name: /A/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.mouseEnter(screen.getByRole("radio", { name: /B/ }).closest("label")!);
    expect(document.querySelector(".questionnaire-preview-lines")?.textContent).toBe("preview-B");
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("starts multi-select from the visible unchecked state when leaving a custom answer", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Tools?", multiSelect: true })])}
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /One/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
    activateCustom("saved custom");
    expect((screen.getByRole("checkbox", { name: /One/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /Two/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /One/ }));
    expect((screen.getByRole("checkbox", { name: /One/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Two/ }) as HTMLInputElement).checked).toBe(false);
    expect(customInput().value).toBe("saved custom");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith(expect.anything(), {
      answers: [{ kind: "multi", questionIndex: 0, optionIndices: [0] }],
    });
  });

  it("keeps custom input single-line, ignores plain Enter, and blocks Ctrl/Cmd+Enter during IME", () => {
    const onRespond = makeRespond();
    wrap(
      <ExtensionQuestionnaire
        request={questionnaireRequest([question({ header: "H", question: "Q?", multiSelect: false })])}
        onRespond={onRespond}
      />,
    );
    const input = customInput();
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("text");
    expect(input.maxLength).toBe(QUESTIONNAIRE_LIMITS.maxCustomAnswerChars);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "keep" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, keyCode: 229 });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onRespond).toHaveBeenCalledWith(expect.anything(), {
      answers: [{ kind: "custom", questionIndex: 0, text: "keep" }],
    });
  });
});
