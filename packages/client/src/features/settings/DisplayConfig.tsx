import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useUiScale } from "@/hooks/useUiScale";
import { SettingsSection } from "@/features/settings/settings-ui";

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
 * Display settings. pix ships a fixed dark appearance (html.dark is applied
 * permanently by the index.html bootstrap), so the only user-adjustable
 * display preferences are Text Size and Language. Text Size is owned by the
 * dedicated `useUiScale` hook (pi-font-scale persistence + --app-ui-scale
 * apply); Language is owned by useI18n (pi-locale).
 */
export function DisplayConfig() {
  const { fontScale, setFontScale } = useUiScale();
  const { locale: language, setLocale: setLanguage, t } = useI18n();
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>

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
