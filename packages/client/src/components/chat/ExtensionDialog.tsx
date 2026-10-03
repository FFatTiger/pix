import { useEffect, useId, useState } from "react";
import type { ExtensionUiRequest } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";

export type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

/** Shared extension request dialog with compact chrome and a separate prompt. */
export function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: ExtensionDialogResponse) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const promptId = `${titleId}-prompt`;
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  /**
   * IME-composition guard: while the browser is committing a composition
   * (nativeEvent.isComposing or the legacy 229 keyCode), Enter / Ctrl+Enter
   * must NEVER submit — the keydown is the composition commit itself and the
   * value is not final. Real submits and Escape still preventDefault so they
   * can never double-fire through the default action.
   */
  const isComposing = (event: React.KeyboardEvent): boolean =>
    event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;

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
          <p id={promptId} style={{ margin: "0 0 12px", color: "var(--text)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</p>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && isComposing(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitValue();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  onRespond(request, { cancelled: true });
                }
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onRespond(request, { cancelled: true });
                  return;
                }
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  if (isComposing(e)) return;
                  e.preventDefault();
                  submitValue();
                }
              }}
              style={{
                width: "100%",
                minHeight: 220,
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
        </div>

        <div style={{ display: "flex", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
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
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {t("desktop.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
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
  );
}
