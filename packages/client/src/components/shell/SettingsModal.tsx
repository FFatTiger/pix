import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Brain,
  ChatCircleText,
  Cpu,
  FileJs,
  Info,
  Keyboard,
  Monitor,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  UsersThree,
  Wrench,
  X,
  ArrowsClockwise,

} from "@phosphor-icons/react";
import { ArchiveConfig } from "@/features/settings/ArchiveConfig";
import { AboutConfig } from "@/features/settings/AboutConfig";
import { CompactionConfig } from "@/features/settings/CompactionConfig";
import { AppearanceConfig } from "@/features/settings/AppearanceConfig";
import { CapabilitiesConfig } from "@/features/settings/CapabilitiesConfig";
import { InputConfig } from "@/features/settings/InputConfig";
import { MemoryConfig } from "@/features/settings/MemoryConfig";
import { ModelsSettingsTab } from "@/features/settings/ModelsConfig";
import { PluginsConfig } from "@/features/settings/PluginsConfig";
import { SessionConfig } from "@/features/settings/SessionConfig";
import { SettingsFileConfig } from "@/features/settings/SettingsFileConfig";
import { SecurityConfig } from "@/features/settings/SecurityConfig";
import { SkillsConfig } from "@/features/settings/SkillsConfig";
import { SubagentSettingsConfig } from "@/features/settings/SubagentSettingsConfig";
import { ToolsConfig } from "@/features/settings/ToolsConfig";
import { SettingsDraftContext, type SettingsDraftApi, type SettingsDraftHandle } from "@/features/settings/settings-draft";
import type { SettingsPageId } from "@/features/settings/settings-page";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";

/**
 * Pages of the Settings dialog, grouped by scope. The group itself expresses
 * the effect range (this device / every session / extensions / system) — no
 * per-page scope chip. Every page keeps exactly one responsibility.
 */
export type { SettingsPageId };

/** @deprecated Renamed to {@link SettingsPageId}; kept for call-site migration. */
export type SettingsTab = SettingsPageId;

interface PageMeta {
  id: SettingsPageId;
  labelKey: string;
  descKey?: string;
  Icon: typeof Cpu;
  render: () => ReactNode;
}

interface NavGroup {
  id: string;
  labelKey: string;
  pages: PageMeta[];
}

/**
 * Settings modal. Every page is always available: catalogs are the global
 * on-disk agent-dir sources, never a selected folder or live session.
 * Desktop shows the grouped nav beside the page; mobile shows a list →
 * detail flow with a back button.
 */
export function SettingsModal({
  initialTab = "providers",
  onCloseAction,
}: {
  initialTab?: SettingsPageId;
  onCloseAction: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [activePage, setActivePage] = useState<SettingsPageId>(initialTab);
  const [mobileNavOpen, setMobileNavOpen] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    setActivePage(initialTab);
  }, [initialTab]);

  // ── Dirty-draft guard ────────────────────────────────────────────────
  const draftHandles = useRef(new Map<string, SettingsDraftHandle>());
  const register = useCallback<SettingsDraftApi["register"]>((id, handle) => {
    draftHandles.current.set(id, handle);
    return () => {
      draftHandles.current.delete(id);
    };
  }, []);
  const draftApi = useMemo<SettingsDraftApi>(() => ({ register }), [register]);

  const [pendingAction, setPendingAction] = useState<null | (() => void)>(null);
  /** Runs the action, or opens the discard guard when a draft is dirty. */
  const runOrGuard = useCallback((action: () => void) => {
    const dirty = [...draftHandles.current.values()].filter((handle) => handle.isDirty());
    if (dirty.length === 0) {
      action();
      return;
    }
    setPendingAction(() => () => {
      for (const handle of dirty) handle.discard();
      action();
    });
  }, []);

  const selectPage = useCallback((id: SettingsPageId) => {
    if (id === activePage && !isMobile) return;
    runOrGuard(() => {
      setActivePage(id);
      if (isMobile) setMobileNavOpen(false);
    });
  }, [activePage, isMobile, runOrGuard]);

  const requestClose = useCallback(() => {
    runOrGuard(onCloseAction);
  }, [onCloseAction, runOrGuard]);

  const groups = useMemo<NavGroup[]>(() => [
    {
      id: "device",
      labelKey: "desktop.settingsNav.device",
      pages: [
        { id: "appearance", labelKey: "desktop.settingsPage.appearance", descKey: "desktop.settingsPage.appearanceDesc", Icon: Monitor, render: () => <AppearanceConfig /> },
        { id: "input", labelKey: "desktop.settingsPage.input", descKey: "desktop.settingsPage.inputDesc", Icon: Keyboard, render: () => <InputConfig /> },
        { id: "archive", labelKey: "desktop.settingsPage.archive", descKey: "desktop.settingsPage.archiveDesc", Icon: Archive, render: () => <ArchiveConfig /> },
      ],
    },
    {
      id: "agent",
      labelKey: "desktop.settingsNav.agent",
      pages: [
        { id: "providers", labelKey: "desktop.settingsPage.providers", descKey: "desktop.settingsPage.providersDesc", Icon: Cpu, render: () => <ModelsSettingsTab /> },
        { id: "capabilities", labelKey: "desktop.settingsPage.capabilities", descKey: "desktop.settingsPage.capabilitiesDesc", Icon: SlidersHorizontal, render: () => <CapabilitiesConfig onOpenPage={selectPage} /> },
        { id: "memory", labelKey: "desktop.settingsPage.memory", descKey: "desktop.settingsPage.memoryDesc", Icon: Brain, render: () => <MemoryConfig /> },
        { id: "subagents", labelKey: "desktop.settingsPage.subagents", descKey: "desktop.settingsPage.subagentsDesc", Icon: UsersThree, render: () => <SubagentSettingsConfig /> },
        { id: "tools", labelKey: "desktop.settingsPage.tools", descKey: "desktop.settingsPage.toolsDesc", Icon: Wrench, render: () => <ToolsConfig /> },
        { id: "compaction", labelKey: "desktop.settingsPage.compaction", descKey: "desktop.settingsPage.compactionDesc", Icon: ArrowsClockwise, render: () => <CompactionConfig /> },
        { id: "session", labelKey: "desktop.settingsPage.session", descKey: "desktop.settingsPage.sessionDesc", Icon: ChatCircleText, render: () => <SessionConfig /> },
      ],
    },
    {
      id: "extensions",
      labelKey: "desktop.settingsNav.extensions",
      pages: [
        { id: "skills", labelKey: "desktop.settingsPage.skills", descKey: "desktop.settingsPage.skillsDesc", Icon: Stack, render: () => <SkillsConfig /> },
        { id: "plugins", labelKey: "desktop.settingsPage.plugins", descKey: "desktop.settingsPage.pluginsDesc", Icon: Plug, render: () => <PluginsConfig /> },
      ],
    },
    {
      id: "system",
      labelKey: "desktop.settingsNav.system",
      pages: [
        { id: "access", labelKey: "desktop.settingsPage.access", descKey: "desktop.settingsPage.accessDesc", Icon: ShieldCheck, render: () => <SecurityConfig /> },
        { id: "advanced", labelKey: "desktop.settingsPage.advanced", descKey: "desktop.settingsPage.advancedDesc", Icon: FileJs, render: () => <SettingsFileConfig /> },
        { id: "about", labelKey: "desktop.settingsPage.about", descKey: "desktop.settingsPage.aboutDesc", Icon: Info, render: () => <AboutConfig /> },
      ],
    },
  ], [requestClose, selectPage]);

  const allPages = useMemo(() => groups.flatMap((group) => group.pages), [groups]);
  const activeMeta = allPages.find((page) => page.id === activePage) ?? allPages[0]!;

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
        if (event.target === event.currentTarget) requestClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") requestClose();
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
          position: "relative",
          width: isMobile ? "calc(100vw / var(--app-ui-scale, 1) - 16px)" : 1000,
          maxWidth: "calc(100vw / var(--app-ui-scale, 1) - 16px)",
          height: isMobile ? "calc(100dvh / var(--app-ui-scale, 1) - 16px)" : "calc(80vh / var(--app-ui-scale, 1))",
          maxHeight: "calc(100dvh / var(--app-ui-scale, 1) - 16px)",
          background: "var(--surface-content)",
          border: "1px solid var(--surface-hairline)",
          borderRadius: 14,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <SettingsDraftContext.Provider value={draftApi}>
          {isMobile ? (
          <div className="settings-topbar">
            <div className="settings-page-header">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="settings-page-header-heading">
                  {isMobile && !mobileNavOpen ? (
                    <button
                      type="button"
                      className="settings-page-back"
                      onClick={() => runOrGuard(() => setMobileNavOpen(true))}
                      aria-label={t("desktop.settingsBack")}
                    >
                      <ArrowLeft size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                  <h2 className="settings-page-title">
                    {isMobile && mobileNavOpen ? t("desktop.settings") : t(activeMeta.labelKey)}
                  </h2>
                </div>
                {activeMeta.descKey && !(isMobile && mobileNavOpen) ? (
                  <p className="settings-page-desc">{t(activeMeta.descKey)}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={requestClose}
                title={t("desktop.closeSettings")}
                aria-label={t("desktop.closeSettings")}
                style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex", flexShrink: 0 }}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
          ) : null}
          <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
            <nav
              aria-label={t("desktop.settingsSections")}
              className="settings-nav"
              style={isMobile ? { display: mobileNavOpen ? "flex" : "none" } : undefined}
            >
              {isMobile ? null : <div className="settings-nav-title">{t("desktop.settings")}</div>}
              {groups.map((group) => (
                <div key={group.id} className="settings-nav-group">
                  <div className="settings-nav-group-label">{t(group.labelKey)}</div>
                  {group.pages.map(({ id, labelKey, Icon }) => {
                    const active = activePage === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => selectPage(id)}
                        data-testid={`settings-tab-${id}`}
                        aria-current={active ? "page" : undefined}
                        className={active ? "settings-nav-item is-active" : "settings-nav-item"}
                      >
                        <Icon size={15} aria-hidden="true" />
                        <span>{t(labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>

            <div
              className="settings-content"
              style={isMobile ? { display: mobileNavOpen ? "none" : "flex" } : undefined}
            >
              {isMobile ? null : (
                <header className="settings-page-hero">
                  <div style={{ minWidth: 0 }}>
                    <h2 className="settings-page-title">{t(activeMeta.labelKey)}</h2>
                    {activeMeta.descKey ? <p className="settings-page-desc">{t(activeMeta.descKey)}</p> : null}
                  </div>
                  <button
                    type="button"
                    className="settings-close"
                    onClick={requestClose}
                    title={t("desktop.closeSettings")}
                    aria-label={t("desktop.closeSettings")}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </header>
              )}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
                {allPages.map((page) => (
                  <div
                    key={page.id}
                    style={{ display: activePage === page.id ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}
                  >
                    {page.render()}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {pendingAction ? (
            <div className="settings-guard-backdrop" role="dialog" aria-modal="true" aria-label={t("desktop.settingsGuardTitle")}>
              <div className="settings-guard-card">
                <h3 className="settings-guard-title">{t("desktop.settingsGuardTitle")}</h3>
                <p className="settings-guard-body">{t("desktop.settingsGuardBody")}</p>
                <div className="settings-guard-actions">
                  <button type="button" className="settings-nav-item" onClick={() => setPendingAction(null)} style={{ border: "1px solid var(--border)", borderRadius: "var(--control-radius)" }}>
                    {t("desktop.settingsGuardKeep")}
                  </button>
                  <button
                    type="button"
                    className="settings-nav-item"
                    style={{ border: "1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)", borderRadius: "var(--control-radius)", color: "var(--status-danger)" }}
                    onClick={() => {
                      const action = pendingAction;
                      setPendingAction(null);
                      action?.();
                    }}
                  >
                    {t("desktop.settingsGuardDiscard")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </SettingsDraftContext.Provider>
      </section>
    </div>
  );
}
