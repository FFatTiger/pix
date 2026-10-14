import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY_CATALOG, CAPABILITY_CATALOG_TOOL_NAMES, type CapabilityCatalogEntry } from "@fffattiger/pix-protocol";
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
 * Editable tool palette: presentation choices only; saved names outside this
 * palette remain editable switches. Capability-owned tools are NOT part of
 * the palette — they are listed under their capability and switch with it.
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
];

const EDITABLE_TOOLS = [
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
];

const CAPABILITY_TOOL_SET = new Set<string>(CAPABILITY_CATALOG_TOOL_NAMES);

/**
 * Global "Tools" settings page.
 *
 * The SAVED truth is the global `pixDefaultTools` selection (all / custom
 * allowlist / native Pi `defaultTools`). The switches edit a persisted name list
 * only — never a runtime snapshot, registry scan, or live session apply.
 * Capability-contributed tools (from the capability catalog) are shown grouped
 * under their capability with no individual switch: they are active exactly
 * when their capability is on, so a capability that is off simply has no group
 * here and needs no explanation.
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
  // Capability switches decide which capability groups are listed.
  const builtIns = useQuery({
    ...createQueryOptions(http).settingsFile.builtIns(),
    enabled: configurable && can("builtins.configure"),
  });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveTools());
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ toolNames: string[]; expectedRevision: string } | null>(null);

  const selection = query.data?.selection;
  // Capability-owned names are never palette switches; strips them from the
  // editable view of the saved list (their activity follows the capability).
  const editableSavedNames = selection !== undefined && selection.mode !== "all"
    ? selection.toolNames.filter((name) => !CAPABILITY_TOOL_SET.has(name))
    : [];
  const editing = draft !== null;
  const selectedNames = draft?.toolNames ?? (selection?.mode === "all" ? EDITABLE_TOOLS.map(({ name }) => name) : editableSavedNames);
  const visibleNames = [...new Set([...EDITABLE_TOOLS.map(({ name }) => name), ...editableSavedNames, ...(draft?.toolNames ?? [])])];
  const unknownNames = visibleNames.filter((name) => !EDITABLE_TOOLS.some((tool) => tool.name === name));

  // Absent built-ins data reads as on — the server default for a missing
  // pix-builtins.json.
  const builtinEnabled = (id: string) =>
    builtIns.data?.capabilities.find((row) => row.id === id)?.enabled !== false;
  const capabilityGroups: readonly CapabilityCatalogEntry[] = CAPABILITY_CATALOG
    .filter((entry) => entry.tools.length > 0)
    .filter((entry) => entry.control !== "builtin" || builtinEnabled(entry.id));

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
    const tool = EDITABLE_TOOLS.find((candidate) => candidate.name === name);
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

  const renderCapabilityGroup = (entry: CapabilityCatalogEntry) => (
    <div key={entry.id} className="settings-tool-category" data-testid={`tools-capability-${entry.id}`}>
      <div className="settings-tool-category-title">{t(entry.labelKey)}</div>
      {entry.tools.map((name) => (
        <div key={name} className="settings-capability-tool">{name}</div>
      ))}
    </div>
  );

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
        <div style={{ display: "flex", gap: 8, margin: "0 0 12px" }}>
          <SettingsButton size="sm" disabled={busy} onClick={() => { void persist(null); }}>
            {t("desktop.toolsSettingsEnableAll")}
          </SettingsButton>
          <SettingsButton size="sm" disabled={busy} onClick={() => { void persist([]); }}>
            {t("desktop.toolsSettingsDisableAll")}
          </SettingsButton>
        </div>
        {capabilityGroups.map(renderCapabilityGroup)}
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection>
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
