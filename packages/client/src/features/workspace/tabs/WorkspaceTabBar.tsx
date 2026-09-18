import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChatCircle, X } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";
import { getFileIcon } from "@/components/files/FileIcons";
import { useContextMenu, type ContextMenuEntry } from "@/components/ContextMenu";
import type { WorkspaceTab } from "./workspace-tab-state";

export interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /**
   * Live session labels resolved from the shared sessions-list query cache
   * (sessionId → title, firstMessage, or short id). Session tabs never store a
   * stale label; the tab bar always renders the freshest cached label and
   * falls back to a short id while the cache has not loaded the session.
   */
  sessionLabels?: Record<string, string> | undefined;
  runningSessionIds?: ReadonlySet<string> | undefined;
  /** Right-click → close every tab except the clicked one. */
  onCloseOtherTabs?: ((id: string) => void) | undefined;
  /** Right-click → close every tab to the right of the clicked one. */
  onCloseTabsToRight?: ((id: string) => void) | undefined;
  /** Right-click → close every tab. */
  onCloseAllTabs?: (() => void) | undefined;
}

/**
 * Top-level workspace tab strip rendered inside the app title bar.
 *
 * ARIA tabs pattern with roving tabindex: the strip is a `tablist`, each tab
 * is a `tab` with `aria-selected` and `tabIndex` 0/-1, and the tablist owns
 * the keyboard (Left/Right/Home/End move focus; Delete/Backspace close).
 * Tabs scroll horizontally when they overflow and the active tab is scrolled
 * into view when the active content changes. Right-click opens the shared
 * ContextMenu with browser-style bulk-close actions.
 */
export function WorkspaceTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  sessionLabels,
  runningSessionIds,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
}: WorkspaceTabBarProps) {
  const { t } = useI18n();
  const { openMenu } = useContextMenu();
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedTabId, setFocusedTabId] = useState<string | null>(null);
  const focusedTabIdRef = useRef<string | null>(null);
  focusedTabIdRef.current = focusedTabId;

  // Browser-style right-click menu: close this tab / others / to the right /
  // all. Bulk actions are honest about no-ops (disabled, never hidden).
  const handleTabContextMenu = (event: React.MouseEvent, tab: WorkspaceTab): void => {
    event.preventDefault();
    event.stopPropagation();
    const index = tabs.findIndex((candidate) => candidate.id === tab.id);
    const entries: ContextMenuEntry[] = [
      { label: t("desktop.tabClose"), onSelect: () => onCloseTab(tab.id) },
    ];
    if (onCloseOtherTabs !== undefined) {
      entries.push({
        label: t("desktop.tabCloseOthers"),
        disabled: tabs.length <= 1,
        onSelect: () => onCloseOtherTabs(tab.id),
      });
    }
    if (onCloseTabsToRight !== undefined) {
      entries.push({
        label: t("desktop.tabCloseRight"),
        disabled: index === -1 || index >= tabs.length - 1,
        onSelect: () => onCloseTabsToRight(tab.id),
      });
    }
    if (onCloseAllTabs !== undefined) {
      entries.push({ type: "separator" });
      entries.push({ label: t("desktop.tabCloseAll"), onSelect: () => onCloseAllTabs() });
    }
    openMenu(event.clientX, event.clientY, entries);
  };

  // Scroll the active tab into view whenever the active content changes (tab
  // switches, file opens, URL/back-forward navigation).
  useEffect(() => {
    if (activeTabId === null || tabs.length === 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${escapeSelector(activeTabId)}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs]);

  // Focus + reveal a tab by index (roving tabindex target).
  const focusTab = (index: number): void => {
    if (tabs.length === 0) return;
    const clamped = Math.max(0, Math.min(tabs.length - 1, index));
    const tab = tabs[clamped];
    if (!tab) return;
    setFocusedTabId(tab.id);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${escapeSelector(tab.id)}"]`);
    el?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (tabs.length === 0) return;
    const current = focusedTabIdRef.current ?? activeTabId;
    const currentIndex = tabs.findIndex((tab) => tab.id === current);
    const index = currentIndex === -1 ? Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId)) : currentIndex;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(index - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab(index + 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusTab(tabs.length - 1);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const target = tabs[Math.max(0, index)];
      if (!target) return;
      const removedIndex = index;
      onCloseTab(target.id);
      // Keep focus on the tab that takes the closed tab's place (its right
      // neighbor, else its left neighbor), per the close fallback order.
      const next = tabs[removedIndex + 1] ?? tabs[removedIndex - 1];
      setFocusedTabId(next ? next.id : null);
      if (next) {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${escapeSelector(next.id)}"]`);
        el?.focus();
      }
      return;
    }
  };

  return (
    <div
      ref={listRef}
      className="workspace-tab-bar"
      role="tablist"
      aria-label={t("desktop.workspaceTabs")}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isFocused = tab.id === focusedTabId;
        const label = tab.kind === "session"
          ? (sessionLabels?.[tab.sessionId] ?? tab.sessionId.slice(0, 12))
          : tab.label;
        const tooltip = tab.kind === "file" ? tab.filePath : label;
        const isRunning = tab.kind === "session" && runningSessionIds?.has(tab.sessionId) === true;
        return (
          <div
            key={tab.id}
            role="tab"
            data-tab-id={tab.id}
            aria-selected={isActive}
            data-running={isRunning ? "true" : undefined}
            tabIndex={isFocused || (focusedTabId === null && isActive) ? 0 : -1}
            className={`workspace-tab${isActive ? " workspace-tab--active" : ""}`}
            title={tooltip}
            aria-label={label}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(event) => handleTabContextMenu(event, tab)}
            onFocus={() => setFocusedTabId(tab.id)}
          >
            <span className="workspace-tab-icon" aria-hidden="true">
              {tab.kind === "session" ? (
                <ChatCircle size={13} weight={isActive ? "fill" : "regular"} />
              ) : (
                getFileIcon(tab.label, 13)
              )}
            </span>
            <span className="workspace-tab-label">{label}</span>
            {isRunning ? <span className="workspace-tab-running-dot" aria-label={t("desktop.sessionRunning")} /> : null}
            <button
              type="button"
              className="workspace-tab-close"
              title={t("desktop.closeTab")}
              aria-label={t("desktop.closeTabWithLabel", { label })}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** CSS.escape fallback for data-tab-id selectors (ids contain `:` and `/`). */
function escapeSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
