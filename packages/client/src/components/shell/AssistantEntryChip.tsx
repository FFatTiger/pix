import { ArrowRightIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";

export type AssistantEntryChipState = "idle" | "selected" | "hidden";

export interface AssistantEntryChipProps {
  /**
   * `idle`: the entry invitation (no project selected). `selected`: the
   * new-session page is in assistant state (picker hidden, assistant copy).
   * `hidden`: a project is selected — the chip collapses with a short fade.
   */
  state: AssistantEntryChipState;
  /** Enter assistant state / open the assistant conversation. */
  onActivate: () => void;
  /** Leave assistant state (keeps the draft). */
  onDismiss: () => void;
}

/**
 * The assistant entry on the new-session page: a small tab attached to the
 * composer's top-left edge, in the same visual language as the status tab
 * that grows out of the input (open bottom, composer surface fill, no hair
 * line). Always mounted while the home composer is; `hidden` only collapses
 * it (CSS fade) so selecting/clearing a project animates instead of popping.
 */
export function AssistantEntryChip({ state, onActivate, onDismiss }: AssistantEntryChipProps) {
  const { t } = useI18n();
  return (
    <div className="assistant-entry-tab" data-testid="assistant-entry-tab" data-state={state}>
      {state === "selected" ? (
        <div className="assistant-entry-chip assistant-entry-chip--selected" data-testid="assistant-entry-chip-selected">
          <SparkleIcon size={13} weight="regular" aria-hidden="true" />
          <span className="assistant-entry-chip-label">{t("desktop.assistantNav")}</span>
          <button
            type="button"
            className="assistant-entry-chip-dismiss"
            data-testid="assistant-entry-chip-dismiss"
            aria-label={t("desktop.assistant")}
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
          >
            <XIcon size={11} weight="bold" aria-hidden="true" />
          </button>
        </div>
      ) : state === "idle" ? (
        <button
          type="button"
          className="assistant-entry-chip"
          data-testid="assistant-entry-chip-activate"
          onClick={onActivate}
        >
          <SparkleIcon size={13} weight="regular" aria-hidden="true" />
          <span className="assistant-entry-chip-label">{t("desktop.assistantEntryChip")}</span>
          <ArrowRightIcon size={12} weight="regular" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
