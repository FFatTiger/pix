import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { SettingToggle } from "@/components/SettingToggle";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { SettingsButton, SettingsSection } from "./settings-ui";

// Presentation choices only; saved names outside this palette remain editable.
const VISIBLE_TOOLS = [
  { name: "read", labelKey: "desktop.tool.read" },
  { name: "write", labelKey: "desktop.tool.write" },
  { name: "edit", labelKey: "desktop.tool.edit" },
  { name: "bash", labelKey: "desktop.tool.bash" },
  { name: "powershell", labelKey: "desktop.tool.powershell" },
  { name: "grep", labelKey: "desktop.tool.grep" },
  { name: "find", labelKey: "desktop.tool.find" },
  { name: "ls", labelKey: "desktop.tool.ls" },
  { name: "codemode", labelKey: "desktop.tool.codemode" },
  { name: "tool_search", labelKey: "desktop.tool.tool_search" },
  { name: "Agent", labelKey: "desktop.tool.Agent" },
  { name: "SendMessage", labelKey: "desktop.tool.SendMessage" },
  { name: "TaskOutput", labelKey: "desktop.tool.TaskOutput" },
  { name: "TaskStop", labelKey: "desktop.tool.TaskStop" },
  { name: "todo", labelKey: "desktop.tool.todo" },
  { name: "ask_user_question", labelKey: "desktop.tool.ask_user_question" },
];

/**
 * Global "Tools" settings tab.
 *
 * The SAVED truth is the global `pixDefaultTools` selection (all / custom
 * allowlist / native Pi `defaultTools`). The switches edit a persisted name list
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
  const [draft, setDraft] = useState<{ toolNames: string[]; expectedRevision: string } | null>(null);

  const selection = query.data?.selection;
  const savedNames = selection !== undefined && selection.mode !== "all" ? selection.toolNames : [];
  const editing = draft !== null;
  const selectedNames = draft?.toolNames ?? (selection?.mode === "all" ? VISIBLE_TOOLS.map(({ name }) => name) : savedNames);
  const visibleNames = [...new Set([...VISIBLE_TOOLS.map(({ name }) => name), ...savedNames, ...(draft?.toolNames ?? [])])];

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

  const toggleTool = (name: string, enabled: boolean) => {
    if (!query.data || busy) return;
    const toolNames = [...new Set(selectedNames)];
    setDraft({
      toolNames: enabled ? [...toolNames, name] : toolNames.filter((candidate) => candidate !== name),
      expectedRevision: draft?.expectedRevision ?? query.data.revision,
    });
  };

  const saveCustom = () => {
    if (draft) void persist(draft.toolNames, draft.expectedRevision);
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
          {editing || selection?.mode === "custom"
            ? t("desktop.toolsSettingsModeCustomNote")
            : selection?.mode === "native"
              ? t("desktop.toolsSettingsModeNativeNote")
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
        {visibleNames.map((name) => {
          const tool = VISIBLE_TOOLS.find((candidate) => candidate.name === name);
          return (
            <SettingToggle
              key={name}
              label={tool ? t(tool.labelKey) : t("desktop.toolsSettingsUnknownTool", { name })}
              description={t("desktop.toolsSettingsToolName", { name })}
              checked={selectedNames.includes(name)}
              onChange={(enabled) => toggleTool(name, enabled)}
              disabled={busy}
            />
          );
        })}
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
