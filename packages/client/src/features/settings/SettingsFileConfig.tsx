import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { useSettingsDraft } from "./settings-draft";
import { SettingsSaveBar, SettingsSection } from "./settings-ui";

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
 * Advanced page: raw-text editor for the global `<agentDir>/settings.json`
 * (shared with the pi CLI). The user's bytes are edited and saved verbatim;
 * the server validates and CAS-fences the write.
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

  useSettingsDraft("settings-file", {
    isDirty: () => loaded && revision !== null && query.data !== undefined && text !== query.data.content,
    discard: () => {
      if (query.data) {
        setRevision(query.data.revision);
        setText(query.data.content);
      }
    },
  });

  if (!can("settings.configure")) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.settingsFileTitle")} description={t("desktop.settingsFileDescription")}>
          <p className="workspace-hint">{t("desktop.settingsFileUnavailable")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (query.isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.settingsFileTitle")} description={t("desktop.settingsFileDescription")}>
          <p className="workspace-hint">{t("desktop.modelsLoading")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.settingsFileTitle")} description={t("desktop.settingsFileDescription")}>
          <p className="workspace-hint workspace-hint--error" role="alert">{describeSettingsConfigError(query.error, t)}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!loaded || revision === null) return null;

  const dirty = text !== query.data?.content;
  const reset = (next: { revision: string; content: string }) => {
    setRevision(next.revision);
    setText(next.content);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <div className="settings-warning-banner" role="note">{t("desktop.settingsFileWarning")}</div>
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
      <SettingsSaveBar
        dirty={dirty}
        busy={save.isPending}
        saving={save.isPending}
        error={save.isError ? describeSettingsConfigError(save.error, t) : null}
        saved={save.isSuccess && !dirty}
        onSave={() => save.mutate({ expectedRevision: revision!, content: text }, { onSuccess: reset })}
        onDiscard={() => reset({ revision: query.data!.revision, content: query.data!.content })}
      />
    </div>
  );
}
