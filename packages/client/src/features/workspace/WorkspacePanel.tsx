import { useEffect, useMemo, useState } from "react";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { FilesPanel } from "./FilesPanel";
import { GitPanel } from "./GitPanel";
import { WorktreePanel } from "./WorktreePanel";

export type WorkspaceTab = "files" | "git" | "worktrees";

export interface WorkspacePanelProps {
  /** Workspace project root (the current cwd), shared with the main session. */
  cwd: string | undefined;
  /** Whether the panel is docked open. */
  open: boolean;
  /** Close the docked panel (chat reclaims the full width). */
  onClose: () => void;
}

const TAB_ORDER: readonly WorkspaceTab[] = ["files", "git", "worktrees"];

const TAB_LABEL: Record<WorkspaceTab, string> = {
  files: "Files",
  git: "Git",
  worktrees: "Worktrees",
};

/**
 * Capability-gated Files/Git/Worktrees workspace. Only tabs backed by an
 * honestly negotiated host capability are offered, and a panel with no
 * capability at all renders nothing — it never issues an API request.
 *
 * Tabs are independent read-only surfaces that share the workspace `cwd`; the
 * main chat session remains fully usable underneath. Inactive tabs are not
 * mounted and therefore never fetch.
 */
export function WorkspacePanel({ cwd, open, onClose }: WorkspacePanelProps) {
  const { can } = useCapabilities();
  const canFiles = can("files");
  const canGit = can("git");
  const canWorktree = can("worktree");

  const availableTabs = useMemo(() => {
    const tabs: WorkspaceTab[] = [];
    if (canFiles) tabs.push("files");
    if (canGit) tabs.push("git");
    if (canWorktree) tabs.push("worktrees");
    return tabs;
  }, [canFiles, canGit, canWorktree]);

  const defaultTab = availableTabs[0] ?? "files";
  const [tab, setTab] = useState<WorkspaceTab>(defaultTab);

  // Keep the active tab valid as capabilities change (e.g. host goes away or
  // shrinks the surface). Prefer the current tab when still available; otherwise
  // fall back to the first remaining tab.
  useEffect(() => {
    if (availableTabs.length === 0) return;
    if (!availableTabs.includes(tab)) setTab(availableTabs[0]!);
  }, [tab, availableTabs]);

  if (availableTabs.length === 0) return null;
  if (!open) return null;

  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0]!;

  return (
    <aside className={`workspace-panel`} aria-label="Workspace">
      <div className="workspace-panel-tabs" role="tablist">
        {TAB_ORDER.filter((id) => availableTabs.includes(id)).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`workspace-panel-tab${activeTab === id ? " workspace-panel-tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {TAB_LABEL[id]}
          </button>
        ))}
        <button
          type="button"
          className="icon-btn workspace-panel-close"
          aria-label="Close workspace panel"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="workspace-panel-body">
        {activeTab === "files" && canFiles ? <FilesPanel cwd={cwd} canFiles={canFiles} /> : null}
        {activeTab === "git" && canGit ? <GitPanel cwd={cwd} canGit={canGit} /> : null}
        {activeTab === "worktrees" && canWorktree ? (
          <WorktreePanel cwd={cwd} canWorktree={canWorktree} />
        ) : null}
      </div>
    </aside>
  );
}
