import { useId, useState } from "react";
import { QUESTIONNAIRE_LIMITS, type ExtensionUiRequest, type QuestionnaireAnswer } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";
import "./ExtensionQuestionnaire.css";

export type ExtensionQuestionnaireRequest = Extract<ExtensionUiRequest, { method: "questionnaire" }>;

export type ExtensionQuestionnaireResponse =
  | { answers: readonly QuestionnaireAnswer[] }
  | { cancelled: true };

interface QuestionDraft {
  mode: "options" | "custom";
  selected: number[];
  text: string;
}

function emptyDraft(): QuestionDraft {
  return { mode: "options", selected: [], text: "" };
}

function isComposing(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

function toggleIndex(selected: readonly number[], optionIndex: number, multiSelect: boolean): number[] {
  if (!multiSelect) return [optionIndex];
  return selected.includes(optionIndex)
    ? selected.filter((index) => index !== optionIndex)
    : [...selected, optionIndex].sort((a, b) => a - b);
}

function answerFor(questionIndex: number, question: ExtensionQuestionnaireRequest["questions"][number], draft: QuestionDraft): QuestionnaireAnswer | null {
  if (draft.mode === "custom") {
    return { kind: "custom", questionIndex, text: draft.text };
  }
  if (question.multiSelect) {
    return { kind: "multi", questionIndex, optionIndices: draft.selected };
  }
  const optionIndex = draft.selected[0];
  if (optionIndex === undefined) return null;
  return { kind: "option", questionIndex, optionIndex };
}

function collectAnswers(request: ExtensionQuestionnaireRequest, drafts: readonly QuestionDraft[]): QuestionnaireAnswer[] | null {
  const answers: QuestionnaireAnswer[] = [];
  for (const [questionIndex, question] of request.questions.entries()) {
    const answer = answerFor(questionIndex, question, drafts[questionIndex] ?? emptyDraft());
    if (answer === null) return null;
    answers.push(answer);
  }
  return answers;
}

function questionHasPreviews(question: ExtensionQuestionnaireRequest["questions"][number]): boolean {
  return question.options.some((option) => option.preview);
}

function previewCopy(option: ExtensionQuestionnaireRequest["questions"][number]["options"][number] | undefined): string | undefined {
  if (option === undefined) return undefined;
  return option.preview ?? option.description;
}

/** Native whole-questionnaire dialog. Navigation is local; only Cancel/Submit leave the component. */
export function ExtensionQuestionnaire({
  request,
  onRespond,
}: {
  request: ExtensionQuestionnaireRequest;
  onRespond: (request: ExtensionQuestionnaireRequest, response: ExtensionQuestionnaireResponse) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const promptId = `${titleId}-prompt`;
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => request.questions.map(() => emptyDraft()));
  const [missing, setMissing] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const questions = request.questions;
  const lastIndex = Math.max(0, questions.length - 1);
  const current = questions[questionIndex] ?? questions[0];
  const draft = drafts[questionIndex] ?? emptyDraft();
  const showNav = questions.length > 1;
  const isLast = questionIndex >= lastIndex;
  const showPreviewPane = current !== undefined && questionHasPreviews(current);
  const previewOption = current?.options[previewIndex] ?? current?.options[0];
  const previewText = previewCopy(previewOption);
  const optionsActive = draft.mode === "options";
  const customActive = draft.mode === "custom";

  const updateDraft = (patch: Partial<QuestionDraft>) => {
    setDrafts((prev) => prev.map((item, index) => (index === questionIndex ? { ...item, ...patch } : item)));
    setMissing(false);
  };

  const navigate = (index: number) => {
    setQuestionIndex(index);
    setPreviewIndex(0);
    setMissing(false);
  };

  const submit = () => {
    const answers = collectAnswers(request, drafts);
    if (answers === null) {
      setMissing(true);
      return;
    }
    onRespond(request, { answers });
  };

  if (current === undefined) return null;

  return (
    <div className="questionnaire-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={promptId}
        className={`questionnaire-dialog${showPreviewPane ? " questionnaire-dialog--split" : " questionnaire-dialog--compact"}`}
      >
        <header className="questionnaire-heading">
          <div className="questionnaire-eyebrow">
            <h2 id={titleId}>{t("desktop.extensionRequest")}</h2>
            {showNav ? (
              <span className="questionnaire-step">{t("desktop.questionnaire.progress", { current: questionIndex + 1, total: questions.length })}</span>
            ) : null}
          </div>
          <p className="questionnaire-scope">{current.header}</p>
          <p className="questionnaire-question" id={promptId}>{current.question}</p>
        </header>

        <div className="questionnaire-body">
          <div className={`questionnaire-choice-layout${showPreviewPane ? " is-split" : ""}`}>
            <div
              className="questionnaire-options"
              role={current.multiSelect ? "group" : "radiogroup"}
              aria-label={current.multiSelect ? t("desktop.questionnaire.optionsMulti") : t("desktop.questionnaire.options")}
            >
              {current.options.map((option, optionIndex) => {
                const checked = optionsActive && draft.selected.includes(optionIndex);
                const previewed = showPreviewPane && previewIndex === optionIndex;
                return (
                  <div
                    key={`${optionIndex}:${option.label}`}
                    className={`questionnaire-option${checked ? " is-selected" : ""}${previewed ? " is-previewed" : ""}`}
                  >
                    <label
                      className="questionnaire-option-label"
                      onMouseEnter={() => {
                        if (showPreviewPane) setPreviewIndex(optionIndex);
                      }}
                    >
                      <input
                        type={current.multiSelect ? "checkbox" : "radio"}
                        name={`${titleId}-q${questionIndex}`}
                        checked={checked}
                        onFocus={() => {
                          if (showPreviewPane) setPreviewIndex(optionIndex);
                        }}
                        onChange={() => {
                          if (showPreviewPane) setPreviewIndex(optionIndex);
                          updateDraft({
                            mode: "options",
                            selected: toggleIndex(draft.selected, optionIndex, current.multiSelect),
                          });
                        }}
                      />
                      <span className="questionnaire-option-copy">
                        <span className="questionnaire-option-title">{option.label}</span>
                        <span className="questionnaire-description">{option.description}</span>
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
            {showPreviewPane ? (
              <aside className="questionnaire-preview-panel" aria-live="polite">
                {previewOption !== undefined ? (
                  <>
                    <div className="questionnaire-preview-eyebrow">{t("desktop.questionnaire.preview")}</div>
                    <h3>{previewOption.label}</h3>
                    {previewText ? <div className="questionnaire-preview-lines">{previewText}</div> : null}
                  </>
                ) : null}
              </aside>
            ) : null}
          </div>
        </div>

        <div className="questionnaire-custom-block">
          <label className={`questionnaire-custom${customActive ? " is-active" : ""}`}>
            <span className="questionnaire-custom-indicator" aria-hidden="true" />
            <input
              type="text"
              aria-label={t("desktop.questionnaire.customAnswer")}
              placeholder={t("desktop.questionnaire.customAnswer")}
              maxLength={QUESTIONNAIRE_LIMITS.maxCustomAnswerChars}
              value={draft.text}
              onFocus={() => updateDraft({ mode: "custom" })}
              onChange={(event) => {
                const text = event.target.value;
                if (text.length > QUESTIONNAIRE_LIMITS.maxCustomAnswerChars) return;
                updateDraft({ mode: "custom", text });
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onRespond(request, { cancelled: true });
                  return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  if (isComposing(event)) return;
                  event.preventDefault();
                  if (isLast) submit();
                }
              }}
            />
          </label>
          {missing ? (
            <p role="alert" className="questionnaire-error">{t("desktop.questionnaire.incomplete")}</p>
          ) : null}
        </div>

        <footer className="questionnaire-footer">
          <div className="questionnaire-navigation">
            {showNav ? (
              <>
                <button
                  type="button"
                  className="questionnaire-button"
                  disabled={questionIndex === 0}
                  onClick={() => navigate(Math.max(0, questionIndex - 1))}
                >
                  {t("desktop.questionnaire.previous")}
                </button>
                {!isLast ? (
                  <button
                    type="button"
                    className="questionnaire-button"
                    onClick={() => navigate(Math.min(lastIndex, questionIndex + 1))}
                  >
                    {t("desktop.questionnaire.next")}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="questionnaire-actions">
            <button
              type="button"
              className="questionnaire-button is-quiet"
              onClick={() => onRespond(request, { cancelled: true })}
            >
              {t("desktop.cancel")}
            </button>
            {isLast ? (
              <button type="button" className="questionnaire-button is-primary" onClick={submit}>
                {t("desktop.submit")}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
