import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { SettingToggle } from "@/components/SettingToggle";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { useSettingsDraft } from "./settings-draft";
import { SettingsButton, SettingsSaveBar, SettingsSection } from "./settings-ui";

/**
 * Tool palette: presentation choices only; saved names outside this palette
 * remain editable switches. Grouped by what the tools do — the raw tool id
 * is secondary information on each row.
 */
const TOOL_CATEGORIES: readonly { readonly labelKey: string; readonly names: readonly string[] }[] = [
  {
    labelKey: "desktop.toolCategory.files",
    names: ["read", "write", "edit", "ls"],
  },
  {
    labelKey: "desktop.toolCategory.search",
    names: ["grep", "find", "tool_search"],
  },
  {
    labelKey: "desktop.toolCategory.commands",
    names: ["bash", "powershell"],
  },
  {
    labelKey: "desktop.toolCategory.code",
    names: ["codemode"],
  },
  {
    labelKey: "desktop.toolCategory.subagents",
    names: ["Agent", "SendMessage", "TaskOutput", "TaskStop"],
  },
  {
    labelKey: "desktop.toolCategory.interaction",
    names: ["todo", "ask_user_question"],
  },
];

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
 * Global "Tools" settings page.
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
  const unknownNames = visibleNames.filter((name) => !VISIBLE_TOOLS.some((tool) => tool.name === name));

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

  const reloadSaved = async () => {
    const result = await query.refetch();
    if (result.isSuccess) {
      setDraft(null);
      setErrorKey(null);
    }
  };

  useSettingsDraft("tools", {
    isDirty: () => draft !== null,
    discard: () => void reloadSaved(),
  });

  const renderToolRow = (name: string) => {
    const tool = VISIBLE_TOOLS.find((candidate) => candidate.name === name);
    return (
      <SettingToggle
        key={name}
        label={tool ? t(tool.labelKey) : t("desktop.toolsSettingsUnknownTool", { name })}
        description={name}
        monoDescription
        checked={selectedNames.includes(name)}
        onChange={(enabled) => toggleTool(name, enabled)}
        disabled={busy}
      />
    );
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
        {TOOL_CATEGORIES.map(({ labelKey, names }) => {
          const categoryNames = names.filter((name) => visibleNames.includes(name));
          if (categoryNames.length === 0) return null;
          return (
            <div key={labelKey} className="settings-tool-category">
              <div className="settings-tool-category-title">{t(labelKey)}</div>
              {categoryNames.map(renderToolRow)}
            </div>
          );
        })}
        {unknownNames.length > 0 ? (
          <div className="settings-tool-category">
            <div className="settings-tool-category-title">{t("desktop.toolCategory.saved")}</div>
            {unknownNames.map(renderToolRow)}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.toolsSettings")} description={t("desktop.toolsSettingsDescription")}>
          {content}
          {query.isError && query.data ? <div className="workspace-hint workspace-hint--error" role="alert">{t("desktop.toolsSettingsUnavailable")}</div> : null}
        </SettingsSection>
      </div>
      <SettingsSaveBar
        dirty={editing}
        busy={busy}
        saving={save.isPending}
        error={errorKey ? t(errorKey) : null}
        saved={save.isSuccess && !editing && !errorKey}
        onSave={() => {
          if (draft) void persist(draft.toolNames, draft.expectedRevision);
        }}
        onDiscard={() => void reloadSaved()}
      />
    </div>
  );
}
