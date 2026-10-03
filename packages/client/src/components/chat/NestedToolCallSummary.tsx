import type { NestedToolCalls } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";

/** Nested calls are summaries within their parent result, never separate messages. */
export function NestedToolCallSummary({ value }: { value: NestedToolCalls | undefined }) {
  const { t } = useI18n();
  if (value === undefined) return null;
  return (
    <section className="codex-tool-detail-section" aria-label={t("desktop.nestedToolCalls")}>
      <div className="codex-tool-detail-label">{t("desktop.nestedToolCalls")}</div>
      {!value.complete && <p>{t("desktop.nestedToolCallsIncomplete")}</p>}
      <ul>
        {value.calls.map((call) => (
          <li key={call.id}>
            <span>{call.name} · {t(call.status === "ok" ? "desktop.nestedToolCallOk" : call.status === "error" ? "desktop.nestedToolCallError" : "desktop.nestedToolCallUnfinished")}</span>
            {call.arguments !== undefined && <pre>{JSON.stringify(call.arguments, null, 2)}</pre>}
            {call.error && <pre>{call.error}</pre>}
          </li>
        ))}
      </ul>
    </section>
  );
}
