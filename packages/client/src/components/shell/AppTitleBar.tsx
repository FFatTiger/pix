import { WorkspaceTabBar } from "@/features/workspace/tabs/WorkspaceTabBar";
import type { WorkspaceTab } from "@/features/workspace/tabs/workspace-tab-state";

interface AppTitleBarProps {
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
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  sessionLabels,
  runningSessionIds,
}: AppTitleBarProps) {
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
    </div>
  );
}
