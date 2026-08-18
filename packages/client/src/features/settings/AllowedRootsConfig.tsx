import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder } from "@phosphor-icons/react";
import { useHttpClient } from "@/app/http-context";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { SettingsSection, inputStyle } from "@/features/settings/settings-ui";
import { useI18n } from "@/hooks/useI18n";
import { isAbsoluteClientPath } from "@/lib/file-paths";
import { describeOpenProjectError } from "@/lib/open-project-error";

/**
 * Lists the Host AllowedRoots for this process and expands another absolute
 * directory through POST /v1/cwd/validate. Expansion is memory-only until
 * Host restarts; this is not a durable trusted-roots editor.
 */
export function AllowedRootsConfig() {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const options = createQueryOptions(http);
  const rootsQuery = useQuery(options.cwd.roots());
  const validate = useMutation(createMutationOptions(http, queryClient).cwd.validate());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const roots = rootsQuery.data?.roots ?? [];
  const defaultCwd = rootsQuery.data?.defaultCwd ?? null;

  const submit = async () => {
    const path = draft.trim();
    if (!path) return;
    if (!isAbsoluteClientPath(path)) {
      setError(t("desktop.enterAbsoluteProjectPath"));
      return;
    }
    setError(null);
    try {
      const authorized = await validate.mutateAsync(path);
      setDraft("");
      setError(null);
      void authorized.cwd;
    } catch (cause) {
      setError(t(describeOpenProjectError(cause)));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.allowedRootsTitle")} description={t("desktop.allowedRootsDescription")}>
        {rootsQuery.isError ? (
          <div role="alert" style={{ color: "var(--status-danger)", fontSize: 12 }}>
            {t("desktop.allowedRootsLoadFailed")}
          </div>
        ) : roots.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("desktop.allowedRootsEmpty")}</div>
        ) : (
          <ul data-testid="allowed-roots-list" style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {roots.map((root) => (
              <li
                key={root}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  background: "var(--bg)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  overflowWrap: "anywhere",
                }}
              >
                <Folder size={14} aria-hidden="true" />
                <span>{root}</span>
                {defaultCwd === root ? (
                  <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{t("desktop.allowedRootsStartup")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title={t("desktop.allowedRootsAddTitle")} description={t("desktop.allowedRootsAddDescription")}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            data-testid="allowed-roots-path"
            value={draft}
            disabled={validate.isPending}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
            placeholder={t("desktop.projectPathPlaceholder")}
            style={inputStyle}
          />
          <button
            type="button"
            data-testid="allowed-roots-add"
            disabled={validate.isPending || draft.trim() === ""}
            onClick={() => { void submit(); }}
            style={{
              height: "var(--control-height)",
              padding: "0 12px",
              border: "1px solid var(--accent)",
              borderRadius: "var(--control-radius)",
              background: "var(--accent)",
              color: "white",
              fontSize: 12,
              fontWeight: 600,
              cursor: validate.isPending ? "wait" : "pointer",
              opacity: validate.isPending || draft.trim() === "" ? 0.6 : 1,
            }}
          >
            {validate.isPending ? t("desktop.authorizingProject") : t("desktop.authorizeProject")}
          </button>
        </div>
        {error ? (
          <div role="alert" data-testid="allowed-roots-error" style={{ marginTop: 8, color: "var(--status-danger)", fontSize: 12 }}>
            {error}
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}
