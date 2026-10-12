import { useCallback, useEffect, useState } from "react";
import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";
import { getStreamingSendMode, setStreamingSendMode, type StreamingSendMode } from "@/lib/chat-input-preferences";
import { SettingToggle } from "@/components/SettingToggle";
import { SegmentedControl, SettingsRow, SettingsSection } from "@/features/settings/settings-ui";
import { useI18n } from "@/hooks/useI18n";

export type InputShortcut = "enter" | "ctrl-enter";

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

/**
 * Input settings (this device): send shortcut, what Enter does while the
 * agent is running, and Markdown list continuation. All instant-apply
 * device preferences — no draft, no save button.
 */
export function InputConfig() {
  const { t } = useI18n();
  const [shortcut, setShortcut] = useState<InputShortcut>(getStoredShortcut);
  const [streamingSendMode, setStreamingSendModeState] = useState<StreamingSendMode>(getStreamingSendMode);
  const [markdownList, setMarkdownList] = useState<boolean>(getStoredMarkdownList);

  useEffect(() => {
    const handler = () => {
      setShortcut(getStoredShortcut());
      setStreamingSendModeState(getStreamingSendMode());
      setMarkdownList(getStoredMarkdownList());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setShortcutAndPersist = useCallback((value: InputShortcut) => {
    setShortcut(value);
    persistSetting(STORAGE_KEY, value);
  }, []);

  const setStreamingSendModeAndPersist = useCallback((value: StreamingSendMode) => {
    setStreamingSendModeState(value);
    setStreamingSendMode(value);
  }, []);

  const setMarkdownListAndPersist = useCallback((checked: boolean) => {
    setMarkdownList(checked);
    persistSetting(MARKDOWN_LIST_KEY, checked ? "on" : "off");
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.inputShortcut")} description={t("desktop.inputShortcutDescription")}>
        <SettingsRow label={t("desktop.sendKeyLabel")} description={shortcut === "enter" ? t("desktop.useEnterDescription") : t("desktop.useCtrlEnterDescription")}>
          <SegmentedControl
            ariaLabel={t("desktop.inputShortcut")}
            value={shortcut}
            onChange={setShortcutAndPersist}
            options={[
              { value: "enter", label: t("desktop.sendKeyEnter") },
              { value: "ctrl-enter", label: t("desktop.sendKeyCtrlEnter") },
            ]}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("desktop.streamingSendMode")} description={t("desktop.streamingSendModeDescription")}>
        <SettingsRow label={t("desktop.streamingSendModeLabel")}>
          <SegmentedControl
            ariaLabel={t("desktop.streamingSendMode")}
            value={streamingSendMode}
            onChange={(value) => setStreamingSendModeAndPersist(value === "steer" ? "steer" : "follow-up")}
            options={[
              { value: "follow-up", label: t("desktop.streamingSendModeFollowUpShort") },
              { value: "steer", label: t("desktop.streamingSendModeSteerShort") },
            ]}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("desktop.markdownListContinue")} description={t("desktop.markdownListContinueDescription")}>
        <SettingToggle
          checked={markdownList}
          onChange={setMarkdownListAndPersist}
          label={t("desktop.markdownListContinueLabel")}
        />
      </SettingsSection>
    </div>
  );
}
