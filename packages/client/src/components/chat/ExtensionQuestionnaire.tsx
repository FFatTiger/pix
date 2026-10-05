import { useId, useState } from "react";
import { QUESTIONNAIRE_LIMITS, type ExtensionUiRequest, type QuestionnaireAnswer } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";

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
  const questions = request.questions;
  const lastIndex = Math.max(0, questions.length - 1);
  const current = questions[questionIndex] ?? questions[0];
  const draft = drafts[questionIndex] ?? emptyDraft();
  const showNav = questions.length > 1;
  const isLast = questionIndex >= lastIndex;

  const updateDraft = (patch: Partial<QuestionDraft>) => {
    setDrafts((prev) => prev.map((item, index) => (index === questionIndex ? { ...item, ...patch } : item)));
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
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={promptId}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <h2 id={titleId} style={{ margin: 0, color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{t("desktop.extensionRequest")}</h2>
        </div>

        <div style={{ minHeight: 0, overflowY: "auto", padding: 14 }}>
          {showNav ? (
            <p style={{ margin: "0 0 10px", color: "var(--text-muted)", fontSize: 12 }}>
              {t("desktop.questionnaire.progress", { current: questionIndex + 1, total: questions.length })}
            </p>
          ) : null}
          <p style={{ margin: "0 0 8px", color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{current.header}</p>
          <p id={promptId} style={{ margin: "0 0 12px", color: "var(--text)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{current.question}</p>

          {draft.mode === "options" ? (
            <div role={current.multiSelect ? "group" : "radiogroup"} aria-label={current.multiSelect ? t("desktop.questionnaire.optionsMulti") : t("desktop.questionnaire.options")} style={{ display: "grid", gap: 8 }}>
              {current.options.map((option, optionIndex) => {
                const checked = draft.selected.includes(optionIndex);
                return (
                  <label
                    key={`${optionIndex}:${option.label}`}
                    style={{
                      display: "grid",
                      gap: 4,
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: "1px solid var(--border)",
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <input
                        type={current.multiSelect ? "checkbox" : "radio"}
                        name={`${titleId}-q${questionIndex}`}
                        checked={checked}
                        onChange={() => updateDraft({ mode: "options", selected: toggleIndex(draft.selected, optionIndex, current.multiSelect) })}
                      />
                      <span>
                        <span style={{ fontWeight: 600 }}>{option.label}</span>
                        <span style={{ display: "block", color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{option.description}</span>
                      </span>
                    </span>
                    {option.preview ? (
                      <span style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{option.preview}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ) : (
            <textarea
              autoFocus
              aria-label={t("desktop.questionnaire.customAnswer")}
              maxLength={QUESTIONNAIRE_LIMITS.maxCustomAnswerChars}
              value={draft.text}
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
              style={{
                width: "100%",
                minHeight: 120,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}

          <button
            type="button"
            onClick={() => updateDraft({ mode: draft.mode === "custom" ? "options" : "custom" })}
            style={{
              marginTop: 10,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {draft.mode === "custom" ? t("desktop.questionnaire.chooseOptions") : t("desktop.questionnaire.useCustom")}
          </button>
          {missing ? (
            <p role="alert" style={{ margin: "10px 0 0", color: "var(--danger, #c44)", fontSize: 12 }}>{t("desktop.questionnaire.incomplete")}</p>
          ) : null}
        </div>

        <div style={{ display: "flex", flexShrink: 0, justifyContent: "space-between", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", gap: 8 }}>
            {showNav ? (
              <>
                <button
                  type="button"
                  disabled={questionIndex === 0}
                  onClick={() => { setQuestionIndex((index) => Math.max(0, index - 1)); setMissing(false); }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    cursor: questionIndex === 0 ? "default" : "pointer",
                  }}
                >
                  {t("desktop.questionnaire.previous")}
                </button>
                {!isLast ? (
                  <button
                    type="button"
                    onClick={() => { setQuestionIndex((index) => Math.min(lastIndex, index + 1)); setMissing(false); }}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {t("desktop.questionnaire.next")}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => onRespond(request, { cancelled: true })}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {t("desktop.cancel")}
            </button>
            {isLast ? (
              <button
                type="button"
                onClick={submit}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--accent)",
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                {t("desktop.submit")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
