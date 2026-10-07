import { useEffect, useRef, useState } from "react";
import { Archive, ChatCenteredText, Cpu, FileJs, Monitor, Plug, Robot, ShieldCheck, Stack, Wrench, X } from "@phosphor-icons/react";
import { ArchiveConfig } from "@/features/settings/ArchiveConfig";
import { BuiltInCapabilitiesConfig } from "@/features/settings/BuiltInCapabilitiesConfig";
import { ChatConfig } from "@/features/settings/ChatConfig";
import { DisplayConfig } from "@/features/settings/DisplayConfig";
import { SettingsFileConfig } from "@/features/settings/SettingsFileConfig";
import { ModelsSettingsTab, PluginsSettingsTab, SkillsSettingsTab } from "@/features/settings/CatalogTabs";
import { SecurityConfig } from "@/features/settings/SecurityConfig";
import { ToolsConfig } from "@/features/settings/ToolsConfig";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";

export type SettingsTab = "display" | "chat" | "agents" | "tools" | "models" | "config" | "skills" | "plugins" | "security" | "archive";

interface SettingsModalProps {
  initialTab?: SettingsTab;
  onCloseAction: () => void;
}

const GLOBAL_TABS = new Set<SettingsTab>(["models", "agents", "tools", "config", "skills", "plugins", "security"]);
const LOCAL_TABS = new Set<SettingsTab>(["display", "archive"]);

const tabs: { id: SettingsTab; labelKey: string; Icon: typeof Cpu }[] = [
  { id: "display", labelKey: "desktop.display", Icon: Monitor },
  { id: "chat", labelKey: "desktop.chat", Icon: ChatCenteredText },
  { id: "agents", labelKey: "desktop.agentFeatures", Icon: Robot },
  { id: "tools", labelKey: "desktop.toolsSettingsTab", Icon: Wrench },
  { id: "models", labelKey: "desktop.models", Icon: Cpu },
  { id: "config", labelKey: "desktop.settingsFileTab", Icon: FileJs },
  { id: "skills", labelKey: "desktop.skills", Icon: Stack },
  { id: "plugins", labelKey: "desktop.plugins", Icon: Plug },
  { id: "security", labelKey: "desktop.security", Icon: ShieldCheck },
  { id: "archive", labelKey: "desktop.archiveSettings", Icon: Archive },
];

/**
 * Settings modal. Every tab is always available: catalogs are the global
 * on-disk agent-dir sources, never a selected folder or live session.
 */
export function SettingsModal({
  initialTab = "models",
  onCloseAction,
}: SettingsModalProps) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const scopeLabel = GLOBAL_TABS.has(activeTab)
    ? t("desktop.global")
    : LOCAL_TABS.has(activeTab)
      ? t("desktop.localPreferences")
      : null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseAction();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCloseAction();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("desktop.settings")}
        style={{
          width: isMobile ? "calc(100vw / var(--app-ui-scale, 1) - 16px)" : 1000,
          maxWidth: "calc(100vw / var(--app-ui-scale, 1) - 16px)",
          height: isMobile ? "calc(100dvh / var(--app-ui-scale, 1) - 16px)" : "calc(80vh / var(--app-ui-scale, 1))",
          maxHeight: "calc(100dvh / var(--app-ui-scale, 1) - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {t(tabs.find((tab) => tab.id === activeTab)?.labelKey ?? "desktop.settings")}
            </span>
            {scopeLabel ? (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {scopeLabel}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCloseAction}
            title={t("desktop.closeSettings")}
            aria-label={t("desktop.closeSettings")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", minHeight: 0, overflow: "hidden" }}>
          <nav
            aria-label={t("desktop.settingsSections")}
            style={{
              display: "flex",
              flexDirection: isMobile ? "row" : "column",
              gap: 4,
              width: isMobile ? "100%" : 150,
              padding: 8,
              flexShrink: 0,
              background: "var(--bg-panel)",
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
            }}
          >
            {tabs.map(({ id, labelKey, Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  data-testid={`settings-tab-${id}`}
                  aria-current={active ? "page" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flex: isMobile ? 1 : undefined,
                    width: isMobile ? undefined : "100%",
                    padding: "8px 10px",
                    border: "none",
                    borderRadius: 6,
                    background: active ? "var(--bg-selected)" : "none",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    textAlign: "left",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(event) => {
                    if (!active) {
                      event.currentTarget.style.background = "var(--bg-hover)";
                      event.currentTarget.style.color = "var(--text)";
                    }
                  }}
                  onMouseLeave={(event) => {
                    if (!active) {
                      event.currentTarget.style.background = "none";
                      event.currentTarget.style.color = "var(--text-muted)";
                    }
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{t(labelKey)}</span>
                </button>
              );
            })}
          </nav>

          <div style={{ display: activeTab === "display" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <DisplayConfig />
          </div>
          <div style={{ display: activeTab === "chat" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <ChatConfig />
          </div>
          <div style={{ display: activeTab === "agents" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <BuiltInCapabilitiesConfig />
          </div>
          <div style={{ display: activeTab === "tools" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <ToolsConfig />
          </div>
          <div style={{ display: activeTab === "models" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <ModelsSettingsTab onCloseAction={onCloseAction} />
          </div>
          <div style={{ display: activeTab === "config" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <SettingsFileConfig />
          </div>
          <div style={{ display: activeTab === "skills" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <SkillsSettingsTab />
          </div>
          <div style={{ display: activeTab === "plugins" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <PluginsSettingsTab />
          </div>
          <div style={{ display: activeTab === "security" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <SecurityConfig />
          </div>
          <div style={{ display: activeTab === "archive" ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
            <ArchiveConfig />
          </div>
        </div>
      </section>
    </div>
  );
}
