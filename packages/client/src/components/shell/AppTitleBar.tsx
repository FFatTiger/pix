import { SidebarSimple } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";
import { WorkspaceTabBar } from "@/features/workspace/tabs/WorkspaceTabBar";
import type { WorkspaceTab } from "@/features/workspace/tabs/workspace-tab-state";

interface AppTitleBarProps {
  /** Whether the right-side file browser panel is open (drives button state). */
  fileBrowserOpen: boolean;
  onToggleFileBrowser: () => void;
  /** Honest gate — the file browser button is disabled when the host cannot browse files. */
  canFiles: boolean;
  /** The unified top-level tab strip (session + file tabs). */
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Live session labels resolved from the shared sessions-list query cache. */
  sessionLabels: Record<string, string>;
  runningSessionIds: ReadonlySet<string>;
}

/**
 * Full-width app title bar — the topmost 36px chrome: sidebar toggle →
 * horizontally scrollable unified workspace tab strip → file browser button.
 *
 * pix ships the browser variant: the Electron-only window controls, the macOS
 * traffic-light spacer and the drag-region affordances are conditional in the
 * source and never render outside Electron, so they are not ported. The old
 * centered single session title, theme toggle, settings gear and
 * project/worktree controls are intentionally NOT restored — the unified tab
 * strip replaces the centered title and settings stays in the sidebar footer.
 */
export function AppTitleBar({
  fileBrowserOpen,
  onToggleFileBrowser,
  canFiles,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  sessionLabels,
  runningSessionIds,
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
      {/* Unified workspace tab strip — fills the title bar, scrolls horizontally. */}
      <div className="app-title-tabs" style={{ flex: 1, minWidth: 0, height: "100%", alignSelf: "stretch" }}>
        <WorkspaceTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          sessionLabels={sessionLabels}
          runningSessionIds={runningSessionIds}
        />
      </div>

      {/* File browser toggle (top-right). The right panel holds the single
          ExplorerPanel instance; the button is disabled when the host does not
          advertise file browsing. */}
      <button
        className="app-no-drag"
        onClick={onToggleFileBrowser}
        disabled={!canFiles}
        title={fileBrowserOpen ? translate("desktop.hideFileBrowser") : translate("desktop.showFileBrowser")}
        aria-label={fileBrowserOpen ? translate("desktop.hideFileBrowser") : translate("desktop.showFileBrowser")}
        aria-pressed={fileBrowserOpen}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: fileBrowserOpen ? "var(--bg-selected)" : "none", border: "none",
          color: fileBrowserOpen ? "var(--text)" : (canFiles ? "var(--text-muted)" : "var(--text-dim)"),
          cursor: canFiles ? "pointer" : "not-allowed", flexShrink: 0, transition: "background 0.12s, color 0.12s",
          opacity: canFiles ? 1 : 0.5,
        }}
        onMouseEnter={(e) => { if (!canFiles) return; e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { if (!canFiles) return; e.currentTarget.style.background = fileBrowserOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = fileBrowserOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <SidebarSimple size={16} aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
      </button>
    </div>
  );
}
