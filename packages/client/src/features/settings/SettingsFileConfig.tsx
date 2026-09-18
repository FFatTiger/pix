import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { SettingsButton, SettingsSection } from "@/features/settings/settings-ui";
import { useI18n } from "@/hooks/useI18n";

function describeSettingsConfigError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof HttpError) {
    if (error.code === "CONFLICT") return t("desktop.settingsFileChanged");
    if (error.code === "INVALID_INPUT" || error.code === "INVALID_SETTINGS_CONFIG") return t("desktop.settingsFileInvalid");
    if (error.kind === "network") return t("desktop.settingsFileNetwork");
    if (error.kind === "timeout") return t("desktop.settingsFileTimeout");
  }
  return t("desktop.settingsFileUnavailable");
}

/**
 * Raw-text editor for the global `<agentDir>/settings.json` (shared with the
 * pi CLI). The user's bytes are edited and saved verbatim — comments and
 * formatting are preserved; the server validates and CAS-fences the write.
 */
export function SettingsFileConfig() {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const query = useQuery({
    ...createQueryOptions(http).settingsFile.config(),
    enabled: can("settings.configure"),
    // Editable form: a reconnect refetch must not replace in-progress edits.
    refetchOnReconnect: false,
  });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveConfigFile());
  const [revision, setRevision] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (query.data) {
      setRevision(query.data.revision);
      setText(query.data.content);
      setLoaded(true);
    }
  }, [query.data]);

  if (!can("settings.configure")) {
    return <p className="workspace-hint">{t("desktop.settingsFileUnavailable")}</p>;
  }
  if (query.isLoading) return <p className="workspace-hint">{t("desktop.modelsLoading")}</p>;
  if (query.isError) {
    return <p className="workspace-hint workspace-hint--error" role="alert">{describeSettingsConfigError(query.error, t)}</p>;
  }
  if (!loaded || revision === null) return null;

  const dirty = text !== query.data?.content;
  const reset = (next: { revision: string; content: string }) => {
    setRevision(next.revision);
    setText(next.content);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.settingsFileTitle")} description={t("desktop.settingsFileDescription")}>
          <textarea
            className="settings-json-editor"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            wrap="off"
            aria-label={t("desktop.settingsFileTitle")}
          />
        </SettingsSection>
      </div>
      <footer className="models-config-footer">
        <span role={save.isError ? "alert" : undefined} className="models-save-status">
          {save.isError ? describeSettingsConfigError(save.error, t) : save.isSuccess && !dirty ? t("desktop.modelsSaved") : ""}
        </span>
        <SettingsButton disabled={!dirty || save.isPending} onClick={() => reset({ revision: query.data!.revision, content: query.data!.content })}>
          {t("desktop.cancel")}
        </SettingsButton>
        <SettingsButton
          variant="primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ expectedRevision: revision!, content: text }, { onSuccess: reset })}
          style={{ minWidth: 92 }}
        >
          {save.isPending ? t("desktop.modelsSaving") : t("desktop.modelsSave")}
        </SettingsButton>
      </footer>
    </div>
  );
}
