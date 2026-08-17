import { List, SidebarSimple } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";
import { WorkspaceTabBar } from "@/features/workspace/tabs/WorkspaceTabBar";
import type { WorkspaceTab } from "@/features/workspace/tabs/workspace-tab-state";

interface AppTitleBarProps {
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
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
 * Chat-column title bar: sidebar toggle → horizontally scrollable unified
 * workspace tab strip. The file-browser toggle lives on the file panel itself.
 */
export function AppTitleBar({
  sidebarOpen,
  onSidebarToggle,
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
      {/* Sidebar toggle — first control of the title bar. */}
      <button
        className="app-no-drag"
        onClick={onSidebarToggle}
        title={sidebarOpen ? translate("desktop.hideSidebar") : translate("desktop.showSidebar")}
        aria-label={sidebarOpen ? translate("desktop.hideSidebar") : translate("desktop.showSidebar")}
        aria-pressed={sidebarOpen}
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
    </div>
  );
}
