import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useUiScale } from "@/hooks/useUiScale";
import { useTheme } from "@/hooks/useTheme";
import { useProcessDisplayMode } from "@/components/chat/useProcessDisplayMode";
import { SettingsSection } from "@/features/settings/settings-ui";
import type { ThemeMode } from "@/lib/theme";

// ── Tag / chip helpers ───────────────────────────────────────────────────────

const tagGroupStyle: React.CSSProperties = {
  display: "flex", gap: 6, flexWrap: "wrap",
};

function tagStyle(active: boolean, hovered: boolean): React.CSSProperties {
  const borderColor = active
    ? "var(--accent)"
    : hovered
      ? "var(--border-hover)"
      : "var(--border)";
  const bg = active
    ? "color-mix(in srgb, var(--accent) 12%, var(--bg))"
    : hovered
      ? "var(--bg-hover)"
      : "var(--bg-card)";
  const color = active ? "var(--accent)" : hovered ? "var(--text)" : "var(--text-muted)";

  return {
    display: "inline-flex", alignItems: "center", gap: 7,
    padding: "7px 14px",
    border: `1px solid ${borderColor}`,
    borderRadius: 8,
    background: bg,
    color,
    fontSize: 13, fontWeight: active ? 600 : 400,
    cursor: "pointer",
    opacity: 1,
    transition: "border-color 0.15s, background 0.15s, color 0.15s",
    outline: "none", whiteSpace: "nowrap",
  };
}

/**
 * Display settings. The theme mode (dark / light / follow system), Text Size
 * and Language are the user-adjustable display preferences. Theme is owned by
 * the dedicated `useTheme` hook (pi-theme-mode persistence + html.dark
 * application); Text Size by `useUiScale`; Language by useI18n; the workflow
 * (process-group) layout mode by useProcessDisplayMode.
 */
export function DisplayConfig() {
  const { fontScale, setFontScale } = useUiScale();
  const { locale: language, setLocale: setLanguage, t } = useI18n();
  const { themeMode, setThemeMode } = useTheme();
  const { displayMode, setDisplayMode } = useProcessDisplayMode();
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>

      {/* ── Theme ── */}
      <SettingsSection title={t("desktop.theme")} description={t("desktop.themeDescription")}>
        <div style={tagGroupStyle}>
          {(["dark", "light", "system"] as const).map((mode) => {
            const active = themeMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setThemeMode(mode as ThemeMode)}
                style={tagStyle(active, hoveredTag === `theme:${mode}`)}
                onMouseEnter={() => setHoveredTag(`theme:${mode}`)}
                onMouseLeave={() => setHoveredTag(null)}
              >
                {mode === "dark" ? t("desktop.themeDark") : mode === "light" ? t("desktop.themeLight") : t("desktop.themeSystem")}
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {/* ── Workflow (process-group) display mode ── */}
      <SettingsSection title={t("desktop.processDisplay")} description={t("desktop.processDisplayDescription")}>
        <div style={tagGroupStyle}>
          <button
            type="button"
            onClick={() => setDisplayMode("timeline")}
            style={tagStyle(displayMode === "timeline", hoveredTag === `process:timeline`)}
            onMouseEnter={() => setHoveredTag("process:timeline")}
            onMouseLeave={() => setHoveredTag(null)}
          >
            {t("desktop.processTimelineMode")}
          </button>
          <button
            type="button"
            onClick={() => setDisplayMode("tabs")}
            style={tagStyle(displayMode === "tabs", hoveredTag === `process:tabs`)}
            onMouseEnter={() => setHoveredTag("process:tabs")}
            onMouseLeave={() => setHoveredTag(null)}
          >
            {t("desktop.processTabMode")}
          </button>
          <button
            type="button"
            onClick={() => setDisplayMode("codex")}
            style={tagStyle(displayMode === "codex", hoveredTag === `process:codex`)}
            onMouseEnter={() => setHoveredTag("process:codex")}
            onMouseLeave={() => setHoveredTag(null)}
          >
            {t("desktop.processCodexMode")}
          </button>
        </div>
      </SettingsSection>

      {/* ── Text Size ── */}
      <SettingsSection title={t("desktop.textSize")} description={t("desktop.textSizeDescription")}>
        <div style={tagGroupStyle}>
          {[0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.35].map((s) => {
            const active = fontScale === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setFontScale(s)}
                style={tagStyle(active, hoveredTag === `scale:${s}`)}
                onMouseEnter={() => setHoveredTag(`scale:${s}`)}
                onMouseLeave={() => setHoveredTag(null)}
              >
                {Math.round(s * 100)}%
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {/* ── Language ── */}
      <SettingsSection title={t("desktop.language")} description={t("desktop.languageDescription")}>
        <div style={tagGroupStyle}>
          {(["en", "zh-CN"] as const).map((lang) => {
            const active = (lang === "zh-CN") ? language === "zh-CN" : language !== "zh-CN";
            return (
              <button
                key={lang} type="button"
                onClick={() => setLanguage(lang === "zh-CN" ? "zh-CN" : "en")}
                style={tagStyle(active, hoveredTag === `lang:${lang}`)}
                onMouseEnter={() => setHoveredTag(`lang:${lang}`)}
                onMouseLeave={() => setHoveredTag(null)}
              >
                {lang === "en" ? t("desktop.english") : t("desktop.chinese")}
              </button>
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}
