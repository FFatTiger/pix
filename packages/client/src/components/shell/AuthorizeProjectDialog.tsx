import { FolderLock } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";

/**
 * Local-mode AllowedRoot expansion prompt. Confirm runs cwd.validate;
 * cancel leaves the current workspace unchanged.
 */
export function AuthorizeProjectDialog({
  path,
  busy = false,
  error,
  onCancelAction,
  onConfirmAction,
}: {
  path: string;
  busy?: boolean;
  error: string | null;
  onCancelAction: () => void;
  onConfirmAction: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      role="presentation"
      data-testid="authorize-project-dialog"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0, 0, 0, 0.4)",
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancelAction();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="authorize-project-title"
        style={{
          width: 440,
          maxWidth: "100%",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0, 0, 0, 0.24)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: 12, padding: "18px 18px 14px" }}>
          <FolderLock size={21} weight="duotone" color="var(--accent-orange)" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <h2 id="authorize-project-title" style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {t("desktop.authorizeProjectTitle")}
            </h2>
            <p style={{ margin: "7px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}>
              {t("desktop.authorizeProjectBody")}
            </p>
            <code
              style={{
                display: "block",
                marginTop: 10,
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                overflowWrap: "anywhere",
              }}
            >
              {path}
            </code>
            {error ? (
              <div role="alert" data-testid="authorize-project-error" style={{ marginTop: 10, color: "var(--status-danger)", fontSize: 12, lineHeight: 1.5 }}>
                {error}
              </div>
            ) : null}
          </div>
        </div>
        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onCancelAction}
            disabled={busy}
            style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: busy ? "not-allowed" : "pointer", fontSize: 12 }}
          >
            {t("desktop.cancel")}
          </button>
          <button
            type="button"
            data-testid="authorize-project-confirm"
            onClick={onConfirmAction}
            disabled={busy}
            style={{ height: 32, padding: "0 12px", border: "1px solid var(--accent)", borderRadius: 5, background: "var(--accent)", color: "white", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1, fontSize: 12, fontWeight: 600 }}
          >
            {busy ? t("desktop.authorizingProject") : t("desktop.authorizeProject")}
          </button>
        </footer>
      </section>
    </div>
  );
}
