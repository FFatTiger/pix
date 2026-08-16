import { useEffect, useState } from "react";
import { Gear, List, Moon, SidebarSimple, Sun } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";

interface AppTitleBarProps {
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  isDark: boolean;
  toggleTheme: (origin?: { x: number; y: number }) => void;
  rightPanelOpen: boolean;
  onToggleFilePanel: () => void;
  onOpenSettings: () => void;
  sessionTitle: string | null;
  /** True while the selected session's title is being regenerated. */
  titleGenerating?: boolean;
  /** Portal host for the workspace (project/worktree) controls. */
  onWorkspaceControlsHostChange?: (node: HTMLDivElement | null) => void;
}

/**
 * Full-width app title bar (source: upstream desktop app components/AppTitleBar.tsx).
 *
 * pix ships the browser variant: the Electron-only window controls, the macOS
 * traffic-light spacer and the drag-region affordances are conditional in the
 * source and never render outside Electron, so they are not ported. The
 * topbar surface is exactly: sidebar toggle → workspace controls portal →
 * centered sessionTitle → ThemeToggle → right-panel toggle → Settings gear.
 */

/** Renders a placeholder icon until mounted, then the correct theme icon.
 *  Avoids SSR hydration mismatch caused by the server always defaulting
 *  to dark mode while the client inline script restores a stored preference. */
function ThemeToggleButton({
  isDark,
  toggleTheme,
  translate,
}: {
  isDark: boolean;
  toggleTheme: (origin?: { x: number; y: number }) => void;
  translate: (key: string) => string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const title = mounted
    ? (isDark ? translate("desktop.switchToLight") : translate("desktop.switchToDark"))
    : translate("desktop.switchToLight"); // SSR default: dark mode

  return (
    <button
      className="app-no-drag"
      suppressHydrationWarning
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      title={title}
      aria-label={title}
      aria-pressed={mounted ? isDark : true}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", border: "none",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      {mounted
        ? (isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />)
        : <Sun size={16} aria-hidden="true" />
      }
    </button>
  );
}

export function AppTitleBar({
  sidebarOpen,
  onSidebarToggle,
  isDark,
  toggleTheme,
  rightPanelOpen,
  onToggleFilePanel,
  onOpenSettings,
  sessionTitle,
  titleGenerating = false,
  onWorkspaceControlsHostChange,
}: AppTitleBarProps) {
  const { t: translate } = useI18n();

  return (
    <div
      className="app-title-bar"
      style={{
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        height: 36,
        background: "var(--bg-panel)",
        position: "relative",
        zIndex: 600,
      }}
    >
      {/* Sidebar toggle */}
      <button
        className="app-no-drag"
        onClick={onSidebarToggle}
        title={sidebarOpen ? translate("desktop.hideSidebar") : translate("desktop.showSidebar")}
        aria-label={sidebarOpen ? translate("desktop.hideSidebar") : translate("desktop.showSidebar")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: sidebarOpen ? "var(--bg-selected)" : "none", border: "none",
          color: sidebarOpen ? "var(--text)" : "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = sidebarOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = sidebarOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        {sidebarOpen ? <SidebarSimple size={16} aria-hidden="true" /> : <List size={16} aria-hidden="true" />}
      </button>

      <div
        className="app-no-drag"
        ref={onWorkspaceControlsHostChange}
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          maxWidth: "min(calc(52vw / var(--app-ui-scale, 1)), 560px)",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 8px 0 0",
          overflow: "visible",
        }}
      />

      {/* Flexible title spacer — the centered session title. */}
      <div
        className="app-title-drag"
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          minWidth: 0,
          padding: "0 12px",
          userSelect: "none",
        }}
      >
        {sessionTitle && (
          <span
            className={titleGenerating ? "session-title-generating" : undefined}
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {sessionTitle}
          </span>
        )}
      </div>

      {/* Theme toggle — defer render until client mount to avoid
          SSR hydration mismatch on icon and attributes. */}
      <ThemeToggleButton isDark={isDark} toggleTheme={toggleTheme} translate={translate} />

      {/* File panel toggle */}
      <button
        className="app-no-drag"
        onClick={onToggleFilePanel}
        title={rightPanelOpen ? translate("desktop.hideFilePanel") : translate("desktop.showFilePanel")}
        aria-label={rightPanelOpen ? translate("desktop.hideFilePanel") : translate("desktop.showFilePanel")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: rightPanelOpen ? "var(--bg-selected)" : "none", border: "none",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = rightPanelOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <SidebarSimple size={16} aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
      </button>

      {/* Settings */}
      <button
        className="app-no-drag"
        type="button"
        onClick={onOpenSettings}
        title={translate("desktop.settings")}
        aria-label={translate("desktop.settings")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: "none", border: "none",
          color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <Gear size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
