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
  /** Right-click bulk-close handlers forwarded to the tab strip. */
  onCloseOtherTabs?: ((id: string) => void) | undefined;
  onCloseTabsToRight?: ((id: string) => void) | undefined;
  onCloseAllTabs?: (() => void) | undefined;
  /** Live session labels resolved from the shared sessions-list query cache. */
  sessionLabels: Record<string, string>;
  runningSessionIds: ReadonlySet<string>;
}

/**
 * Chat-column title bar: sidebar toggle → unified workspace tab strip. The
 * right-pane toggle is NOT here: AppShell pins it to the window's top-right
 * corner (see `RightPaneToggle`).
 */
export function AppTitleBar({
  sidebarOpen,
  onSidebarToggle,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
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
        height: "calc(36px + env(safe-area-inset-top, 0px))",
        paddingTop: "env(safe-area-inset-top, 0px)",
        // Reserves the pinned right-pane toggle's column (AppShell renders
        // it outside this box) so the tab strip never slides underneath it.
        paddingRight: 36,
      }}
    >
      {/* Sidebar toggle — first control, left of the tab strip. */}
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
          onCloseOtherTabs={onCloseOtherTabs}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseAllTabs={onCloseAllTabs}
          sessionLabels={sessionLabels}
          runningSessionIds={runningSessionIds}
        />
      </div>
    </div>
  );
}

export interface RightPaneToggleProps {
  open: boolean;
  /** Honest gate — the button is disabled when no right-pane view is available. */
  available: boolean;
  onToggle: () => void;
}

/** Pinned window-level toggle for the shared Files / Agents / Side chat pane. */
export function RightPaneToggle({ open, available, onToggle }: RightPaneToggleProps) {
  const { t: translate } = useI18n();

  return (
    <button
      className="app-no-drag"
      onClick={onToggle}
      disabled={!available}
      data-testid="right-pane-toggle"
      title={open ? translate("desktop.hideRightPane") : translate("desktop.showRightPane")}
      aria-label={open ? translate("desktop.hideRightPane") : translate("desktop.showRightPane")}
      aria-pressed={open}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: open ? "var(--bg-selected)" : "none", border: "none",
        color: open ? "var(--text)" : (available ? "var(--text-muted)" : "var(--text-dim)"),
        cursor: available ? "pointer" : "not-allowed", flexShrink: 0, transition: "background 0.12s, color 0.12s",
        opacity: available ? 1 : 0.5,
      }}
      onMouseEnter={(e) => { if (!available) return; e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { if (!available) return; e.currentTarget.style.background = open ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
    >
      <SidebarSimple size={16} aria-hidden="true" style={{ transform: "scaleX(-1)" }} />
    </button>
  );
}

/** @deprecated Use RightPaneToggle; retained for source compatibility. */
export const FileBrowserToggle = RightPaneToggle;
export type FileBrowserToggleProps = RightPaneToggleProps;
