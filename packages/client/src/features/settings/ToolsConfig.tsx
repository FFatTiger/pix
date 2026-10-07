import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { SettingsButton, SettingsSection, SettingsTextarea } from "./settings-ui";

function namesFromText(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const name = line.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function textFromNames(names: readonly string[]): string {
  return names.join("\n");
}

/**
 * Global "Tools" settings tab.
 *
 * The SAVED truth is the global `pixDefaultTools` selection (all / custom
 * allowlist / native Pi `defaultTools`). The editor is a persisted name list
 * only — never a runtime snapshot, registry scan, or live session apply.
 */
export function ToolsConfig() {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const configurable = can("settings.configure");
  const query = useQuery({
    ...createQueryOptions(http).settingsFile.tools(),
    enabled: configurable,
    refetchOnReconnect: false,
  });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveTools());
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; expectedRevision: string } | null>(null);

  const selection = query.data?.selection;
  const savedNames = selection !== undefined && selection.mode !== "all" ? selection.toolNames : [];
  const savedText = textFromNames(savedNames);
  const editing = draft !== null;
  const text = draft?.text ?? savedText;

  const busy = save.isPending || query.isFetching;

  const persist = async (toolNames: string[] | null, expectedRevision = query.data?.revision): Promise<void> => {
    if (!expectedRevision || busy) return;
    setErrorKey(null);
    try {
      await save.mutateAsync({ expectedRevision, toolNames });
      setDraft(null);
    } catch (error) {
      const conflict = error instanceof HttpError && error.code === "CONFLICT";
      if (conflict) void query.refetch();
      setErrorKey(conflict ? "desktop.toolsSettingsChanged" : "desktop.toolsSettingsSaveFailed");
    }
  };

  const saveCustom = () => {
    if (draft) void persist(namesFromText(draft.text), draft.expectedRevision);
  };

  const reloadSaved = async () => {
    const result = await query.refetch();
    if (result.isSuccess) {
      setDraft(null);
      setErrorKey(null);
    }
  };

  let content;
  if (!configurable) {
    content = <div className="workspace-hint">{t("desktop.toolsSettingsUnavailable")}</div>;
  } else if (query.isPending) {
    content = <div className="workspace-hint" aria-busy="true">{t("desktop.loading")}</div>;
  } else if (!query.data) {
    content = <div className="workspace-hint workspace-hint--error" role="alert">{t("desktop.toolsSettingsUnavailable")}</div>;
  } else {
    content = (
      <>
        <div className="workspace-hint" data-testid="tools-selection-mode">
          {selection?.mode === "native"
            ? t("desktop.toolsSettingsModeNativeNote")
            : selection?.mode === "custom"
              ? t("desktop.toolsSettingsModeCustomNote")
              : t("desktop.toolsSettingsModeAllNote")}
        </div>
        <div style={{ display: "flex", gap: 8, margin: "8px 0 12px" }}>
          <SettingsButton size="sm" variant="primary" disabled={busy} onClick={() => { void persist(null); }}>
            {t("desktop.toolsSettingsEnableAll")}
          </SettingsButton>
          <SettingsButton size="sm" disabled={busy} onClick={() => { void persist([]); }}>
            {t("desktop.toolsSettingsDisableAll")}
          </SettingsButton>
        </div>
        <label htmlFor="tools-custom-names" style={{ display: "block", fontSize: 11, color: "var(--text-muted)", fontWeight: 500, marginBottom: 4 }}>
          {t("desktop.toolsSettingsCustomNames")}
        </label>
        <SettingsTextarea
          id="tools-custom-names"
          name="tools-custom-names"
          value={text}
          onChange={(text) => setDraft((current) => ({
            text,
            expectedRevision: current?.expectedRevision ?? query.data!.revision,
          }))}
          placeholder={t("desktop.toolsSettingsCustomNamesPlaceholder")}
          mono
          disabled={busy}
        />
        <p className="workspace-hint">{t("desktop.toolsSettingsCustomNamesHelp")}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <SettingsButton size="sm" disabled={busy || !editing} onClick={() => { void reloadSaved(); }}>
            {t("desktop.toolsSettingsReloadSaved")}
          </SettingsButton>
          <SettingsButton size="sm" variant="primary" disabled={busy || !editing} onClick={saveCustom}>
            {t("desktop.modelsSave")}
          </SettingsButton>
        </div>
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.toolsSettings")} description={t("desktop.toolsSettingsDescription")}>
        {content}
        {query.isError && query.data ? <div className="workspace-hint workspace-hint--error" role="alert">{t("desktop.toolsSettingsUnavailable")}</div> : null}
        {errorKey ? <div className="workspace-hint workspace-hint--error" role="alert">{t(errorKey)}</div> : null}
      </SettingsSection>
    </div>
  );
}
