import { List, SidebarSimple } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";

interface AppTitleBarProps {
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  sessionTitle: string | null;
  /** True while the selected session's title is being regenerated. */
  titleGenerating?: boolean;
}

/**
 * Full-width app title bar (source: upstream desktop app components/AppTitleBar.tsx).
 *
 * pix ships the browser variant: the Electron-only window controls, the macOS
 * traffic-light spacer and the drag-region affordances are conditional in the
 * source and never render outside Electron, so they are not ported. The
 * topbar surface is just: sidebar toggle → centered sessionTitle.
 */
export function AppTitleBar({
  sidebarOpen,
  onSidebarToggle,
  sessionTitle,
  titleGenerating = false,
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
    </div>
  );
}
