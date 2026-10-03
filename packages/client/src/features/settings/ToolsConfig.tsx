import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { SettingToggle } from "@/components/SettingToggle";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { useSelectedRuntime } from "@/runtime";
import { SettingsButton, SettingsSection } from "./settings-ui";

type SelectedRuntime = NonNullable<ReturnType<typeof useSelectedRuntime>>;

interface PendingApply {
  /** Exact selectable names to apply to the captured session (may be empty). */
  names: string[];
  runtime: SelectedRuntime | null;
  epoch: string | null;
}

/**
 * Global "Tools" settings tab.
 *
 * The SAVED truth is the global `pixDefaultTools` selection (all / custom
 * allowlist / native Pi `defaultTools`); it is the default for newly started
 * sessions and is applied to the currently attached session after saving. The
 * editable row list is ONLY the attached selected runtime's authoritative
 * snapshot (`snapshot.state.tools`) — never a background attach or `getTools`
 * call, and never a fabricated full registry. Saved names that are not in the
 * current registry stay persisted (shown as unavailable) and are never dropped.
 */
export function ToolsConfig() {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const runtime = useSelectedRuntime();
  // Live view for the post-save identity check: the async save closure must
  // re-verify the captured session is still the selected, attached one.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const configurable = can("settings.configure");
  const query = useQuery({
    ...createQueryOptions(http).settingsFile.tools(),
    enabled: configurable,
  });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveTools());
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [applyFailed, setApplyFailed] = useState<PendingApply | null>(null);
  // One explicit async state covering save + apply; every control is disabled
  // while it is in flight.
  const [busy, setBusy] = useState(false);

  const attachedTools = runtime !== null && runtime.available && runtime.attached && runtime.snapshot?.state.tools !== undefined
    ? runtime.snapshot.state.tools
    : null;
  const registryNames = attachedTools?.map((tool) => tool.name) ?? [];
  const activeNames = new Set(attachedTools?.filter((tool) => tool.active).map((tool) => tool.name) ?? []);
  const selection = query.data?.selection;
  const savedNames = selection !== undefined && selection.mode !== "all" ? selection.toolNames : [];
  const unavailableSaved = savedNames.filter((name) => !registryNames.includes(name));

  /** Exact names the current registry would receive for a selection. */
  const applyNamesFor = (toolNames: string[] | null): string[] => {
    if (toolNames === null) return [...registryNames];
    const registry = new Set(registryNames);
    return toolNames.filter((name) => registry.has(name));
  };

  /** Apply the exact names to the captured session; only while it is still the current attached one. */
  const applyToCapturedSession = async (apply: PendingApply): Promise<boolean> => {
    const captured = apply.runtime;
    if (captured === null || !captured.available || !captured.attached) return true;
    const current = runtimeRef.current;
    if (
      current === null
      || current.sessionId !== captured.sessionId
      || current.epoch !== apply.epoch
      || !current.available
      || !current.attached
    ) {
      // Switched away / re-attached: the global save stands on its own.
      return true;
    }
    if (!captured.capabilities?.capabilities.includes("runtime.tools.write")) {
      return true;
    }
    try {
      await captured.setTools(apply.names, { includeExtensionTools: false });
      return true;
    } catch {
      return false;
    }
  };

  const persist = async (toolNames: string[] | null): Promise<void> => {
    const current = query.data;
    if (!current || busy) return;
    setErrorKey(null);
    setApplyFailed(null);
    setBusy(true);
    const captured: PendingApply = {
      names: applyNamesFor(toolNames),
      runtime,
      epoch: runtime?.epoch ?? null,
    };
    try {
      // Explicit await chain: the observer does NOT await per-call async
      // callbacks passed to `mutate`, so a mutation-lifecycle onSettled would
      // clear `busy` while the session apply is still pending. Awaiting
      // mutateAsync + apply here keeps ONE busy state covering save AND apply,
      // cleared exactly once in this function's finally.
      try {
        await save.mutateAsync({ expectedRevision: current.revision, toolNames });
      } catch (error) {
        const conflict = error instanceof HttpError && error.code === "CONFLICT";
        if (conflict) void query.refetch();
        setErrorKey(conflict ? "desktop.toolsSettingsChanged" : "desktop.toolsSettingsSaveFailed");
        return;
      }
      if (!(await applyToCapturedSession(captured))) setApplyFailed(captured);
    } finally {
      setBusy(false);
    }
  };

  const retryApply = async () => {
    if (applyFailed === null) return;
    setErrorKey(null);
    const pending = applyFailed;
    setApplyFailed(null);
    setBusy(true);
    try {
      if (!(await applyToCapturedSession(pending))) setApplyFailed(pending);
    } finally {
      setBusy(false);
    }
  };

  /** Toggle one row against the SAVED allowlist (unknown/unloaded names preserved). */
  const toggleTool = (name: string, enabled: boolean) => {
    if (selection === undefined) return;
    const base = selection.mode === "all"
      // All → custom: seed with the current eligible registry list.
      ? [...registryNames]
      // custom/native → custom: keep the full saved list (unavailable included).
      : [...new Set(selection.toolNames)];
    const next = enabled
      ? [...new Set([...base, name])]
      : base.filter((candidate) => candidate !== name);
    void persist(next);
  };

  const isChecked = (name: string): boolean => {
    if (selection === undefined) return activeNames.has(name);
    if (selection.mode === "all") return true;
    // Native inherits the Pi configuration: show the RUNNING active flags.
    if (selection.mode === "native") return activeNames.has(name);
    return selection.toolNames.includes(name);
  };

  let content;
  if (!configurable) {
    content = <div className="workspace-hint">{t("desktop.toolsSettingsUnavailable")}</div>;
  } else if (query.isPending) {
    content = <div className="workspace-hint" aria-busy="true">{t("desktop.loading")}</div>;
  } else if (query.isError || !query.data) {
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
        {attachedTools === null
          ? <div className="workspace-hint" data-testid="tools-no-session">{t("desktop.toolsSettingsNoSession")}</div>
          : attachedTools.map((tool) => (
            <SettingToggle
              key={tool.name}
              checked={isChecked(tool.name)}
              onChange={(enabled) => toggleTool(tool.name, enabled)}
              label={tool.name}
              disabled={busy}
            />
          ))}
        {unavailableSaved.length > 0
          ? <div className="workspace-hint" data-testid="tools-unavailable-names">{t("desktop.toolsSettingsUnavailableNames")}: {unavailableSaved.join(", ")}</div>
          : null}
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection
        title={t("desktop.toolsSettings")}
        description={t("desktop.toolsSettingsDescription")}
        action={applyFailed !== null
          ? <SettingsButton size="sm" variant="primary" disabled={busy} onClick={() => { void retryApply(); }}>{t("desktop.toolsSettingsRetryApply")}</SettingsButton>
          : undefined}
      >
        {content}
        {applyFailed !== null
          ? <div className="workspace-hint workspace-hint--error" role="alert" data-testid="tools-apply-failed">{t("desktop.toolsSettingsApplyFailed")}</div>
          : null}
        {errorKey ? <div className="workspace-hint workspace-hint--error" role="alert">{t(errorKey)}</div> : null}
      </SettingsSection>
    </div>
  );
}
