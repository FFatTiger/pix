import { useI18n } from "@/hooks/useI18n";
import { useUiScale } from "@/hooks/useUiScale";
import { useTheme } from "@/hooks/useTheme";
import { useProcessDisplayMode } from "@/components/chat/useProcessDisplayMode";
import { SegmentedControl, SettingsRow, SettingsSection, SettingsSelect } from "@/features/settings/settings-ui";
import type { ThemeMode } from "@/lib/theme";

const FONT_SCALES = [0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.35] as const;

/**
 * Appearance settings (this device). One flat list of rows — theme is owned
 * by `useTheme`, text size by `useUiScale`, language by useI18n, the process
 * layout mode by useProcessDisplayMode.
 */
export function AppearanceConfig() {
  const { fontScale, setFontScale } = useUiScale();
  const { locale: language, setLocale: setLanguage, t } = useI18n();
  const { themeMode, setThemeMode } = useTheme();
  const { displayMode, setDisplayMode } = useProcessDisplayMode();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection>
        <SettingsRow label={t("desktop.theme")} description={t("desktop.themeOptionsHint")}>
          <SegmentedControl
            ariaLabel={t("desktop.theme")}
            value={themeMode}
            onChange={(mode) => setThemeMode(mode as ThemeMode)}
            options={[
              { value: "dark", label: t("desktop.themeDark") },
              { value: "light", label: t("desktop.themeLight") },
              { value: "system", label: t("desktop.themeSystem") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("desktop.processDisplay")} description={t("desktop.processDisplayDescription")}>
          <SegmentedControl
            ariaLabel={t("desktop.processDisplay")}
            value={displayMode}
            onChange={setDisplayMode}
            options={[
              { value: "timeline", label: t("desktop.processTimelineMode") },
              { value: "tabs", label: t("desktop.processTabMode") },
              { value: "codex", label: t("desktop.processCodexMode") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("desktop.textSize")} description={t("desktop.textSizeDescription")}>
          <SettingsSelect
            aria-label={t("desktop.textSize")}
            value={String(fontScale)}
            onChange={(value) => setFontScale(Number(value))}
            options={FONT_SCALES.map((scale) => ({ value: String(scale), label: `${Math.round(scale * 100)}%` }))}
            style={{ minWidth: 110 }}
          />
        </SettingsRow>
        <SettingsRow label={t("desktop.language")} description={t("desktop.languageDescription")}>
          <SegmentedControl
            ariaLabel={t("desktop.language")}
            value={language === "zh-CN" ? "zh-CN" : "en"}
            onChange={(value) => setLanguage(value === "zh-CN" ? "zh-CN" : "en")}
            options={[
              { value: "en", label: t("desktop.english") },
              { value: "zh-CN", label: t("desktop.chinese") },
            ]}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
