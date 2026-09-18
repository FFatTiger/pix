import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHttpClient } from "@/app/http-context";
import { createQueryOptions } from "@/api/query-keys";
import { createMutationOptions } from "@/api/mutations";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { SettingToggle } from "@/components/SettingToggle";
import { SettingsSection, SettingsSelect } from "@/features/settings/settings-ui";
import { useI18n } from "@/hooks/useI18n";
import {
  getTitleAutoEnabled,
  getTitleModel,
  setTitleAutoEnabled,
  setTitleModel,
  clearTitleModel,
} from "@/lib/title-settings";

export type InputShortcut = "enter" | "ctrl-enter";

/** Session idle-reclamation timeout options (value = ms, 0 = disabled). */
export const SESSION_IDLE_TIMEOUT_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "0", labelKey: "desktop.sessionIdleTimeoutNever" },
  { value: "1800000", labelKey: "desktop.sessionIdleTimeout30m" },
  { value: "3600000", labelKey: "desktop.sessionIdleTimeout1h" },
  { value: "21600000", labelKey: "desktop.sessionIdleTimeout6h" },
  { value: "43200000", labelKey: "desktop.sessionIdleTimeout12h" },
  { value: "86400000", labelKey: "desktop.sessionIdleTimeout1d" },
  { value: "259200000", labelKey: "desktop.sessionIdleTimeout3d" },
  { value: "604800000", labelKey: "desktop.sessionIdleTimeout7d" },
];

const STORAGE_KEY = "pi-input-shortcut";
const MARKDOWN_LIST_KEY = "pi-markdown-list-continue";

function getStoredShortcut(): InputShortcut {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "ctrl-enter" ? "ctrl-enter" : "enter";
  } catch {
    return "enter";
  }
}

function getStoredMarkdownList(): boolean {
  try {
    return localStorage.getItem(MARKDOWN_LIST_KEY) !== "off";
  } catch {
    return true;
  }
}

function persistSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    reportPreferenceWrite(key, value);
    // Broadcast so other windows/panels (and the chat input) pick it up.
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  } catch {
    // Ignore storage errors.
  }
}

interface ModelOption {
  provider: string;
  modelId: string;
  label: string;
}

export function ChatConfig() {
  const { t } = useI18n();
  const [shortcut, setShortcut] = useState<InputShortcut>(getStoredShortcut);
  const [markdownList, setMarkdownList] = useState<boolean>(getStoredMarkdownList);
  const [titleAuto, setTitleAuto] = useState<boolean>(getTitleAutoEnabled);
  const [titleModel, setTitleModelState] = useState<{ provider: string; modelId: string } | null>(getTitleModel);

  // pix adapter: the configured/visible model list for the title-model picker
  // comes from the GLOBAL GET /v1/models catalog through the api layer. The
  // query is gated on the negotiated `models` capability (clients degrade by
  // capability, never by guessing); without it — or on query failure — the
  // picker simply has no options; no model mutation surface exists and none
  // is faked.
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { can, canConfigureSessionSettings } = useCapabilities();
  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(),
    enabled: can("models"),
  });
  const idleTimeoutQuery = useQuery({
    ...createQueryOptions(http).settings.sessionIdleTimeout(),
    enabled: canConfigureSessionSettings,
  });
  const setIdleTimeout = useMutation(
    createMutationOptions(http, queryClient).settings.sessionIdleTimeout(),
  );
  const modelOptions: ModelOption[] = useMemo(() => {
    const list = modelsQuery.data?.models ?? [];
    return list
      .filter((m) => m.id && m.provider)
      .map((m) => ({
        provider: m.provider,
        modelId: m.id,
        label: `${m.displayName || m.id} · ${m.provider}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [modelsQuery.data]);

  useEffect(() => {
    const handler = () => {
      setShortcut(getStoredShortcut());
      setMarkdownList(getStoredMarkdownList());
      setTitleAuto(getTitleAutoEnabled());
      setTitleModelState(getTitleModel());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setShortcutAndPersist = useCallback((value: InputShortcut) => {
    setShortcut(value);
    persistSetting(STORAGE_KEY, value);
  }, []);

  const setMarkdownListAndPersist = useCallback((checked: boolean) => {
    setMarkdownList(checked);
    persistSetting(MARKDOWN_LIST_KEY, checked ? "on" : "off");
  }, []);

  const setTitleAutoAndPersist = useCallback((checked: boolean) => {
    setTitleAuto(checked);
    setTitleAutoEnabled(checked);
  }, []);

  const setTitleModelAndPersist = useCallback((value: string) => {
    if (!value) {
      clearTitleModel();
      setTitleModelState(null);
      return;
    }
    const sep = value.indexOf(":");
    const provider = value.slice(0, sep);
    const modelId = value.slice(sep + 1);
    setTitleModel(provider, modelId);
    setTitleModelState({ provider, modelId });
  }, []);

  const selectedTitleModelValue = titleModel
    ? `${titleModel.provider}:${titleModel.modelId}`
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.sessionTitle")} description={t("desktop.sessionTitleDescription")}>
        <SettingToggle
          checked={titleAuto}
          onChange={setTitleAutoAndPersist}
          label={t("desktop.titleAutoGenerate")}
          description={t("desktop.titleAutoGenerateDescription")}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", margin: "0 -14px" }}>
          <span style={{ flex: 1, fontSize: 13, color: "var(--text)" }}>{t("desktop.titleModel")}</span>
          <SettingsSelect
            value={selectedTitleModelValue}
            onChange={setTitleModelAndPersist}
            options={modelOptions.map((opt) => ({ value: `${opt.provider}:${opt.modelId}`, label: opt.label }))}
            emptyLabel={t("desktop.titleModelNone")}
            style={{ width: "auto", maxWidth: 260 }}
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t("desktop.inputShortcut")} description={t("desktop.inputShortcutDescription")}>
        <SettingToggle
          checked={shortcut === "ctrl-enter"}
          onChange={(checked) => setShortcutAndPersist(checked ? "ctrl-enter" : "enter")}
          label={t("desktop.useCtrlEnter")}
          description={t("desktop.useCtrlEnterDescription")}
        />
      </SettingsSection>
      <SettingsSection title={t("desktop.markdownListContinue")} description={t("desktop.markdownListContinueDescription")}>
        <SettingToggle
          checked={markdownList}
          onChange={setMarkdownListAndPersist}
          label={t("desktop.markdownListContinueLabel")}
        />
      </SettingsSection>
      <SettingsSection title={t("desktop.sessionIdleTimeout")} description={t("desktop.sessionIdleTimeoutDescription")}>
        {!canConfigureSessionSettings || idleTimeoutQuery.isError ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("desktop.sessionIdleTimeoutUnavailable")}</div>
        ) : idleTimeoutQuery.data?.idleTimeoutMs === undefined ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("desktop.sessionIdleTimeoutLoading")}</div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", margin: "0 -14px" }}>
            <span style={{ flex: 1, fontSize: 13, color: "var(--text)" }}>{t("desktop.sessionIdleTimeoutLabel")}</span>
            <SettingsSelect
              value={String(idleTimeoutQuery.data.idleTimeoutMs)}
              onChange={(v) => setIdleTimeout.mutate(Number(v))}
              options={SESSION_IDLE_TIMEOUT_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
              style={{ width: "auto" }}
            />
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
