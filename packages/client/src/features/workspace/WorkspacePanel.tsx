import { useEffect, useState } from "react";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { FilesPanel } from "./FilesPanel";
import { GitPanel } from "./GitPanel";

export type WorkspaceTab = "files" | "git";

export interface WorkspacePanelProps {
  /** Workspace project root (the current cwd), shared with the main session. */
  cwd: string | undefined;
  /** Whether the panel is docked open. */
  open: boolean;
  /** Close the docked panel (chat reclaims the full width). */
  onClose: () => void;
}

/**
 * Capability-gated Files/Git workspace. Only tabs backed by an honestly
 * negotiated host capability are offered, and a panel with no capability at all
 * renders nothing — it never issues an API request.
 *
 * The two tabs are independent read-only surfaces that share the workspace
 * `cwd`; the main chat session remains fully usable underneath.
 */
export function WorkspacePanel({ cwd, open, onClose }: WorkspacePanelProps) {
  const { can } = useCapabilities();
  const canFiles = can("files");
  const canGit = can("git");

  const [tab, setTab] = useState<WorkspaceTab>(canFiles ? "files" : "git");

  // Keep the active tab valid as capabilities change (e.g. host goes away).
  useEffect(() => {
    if (tab === "files" && !canFiles && canGit) setTab("git");
    if (tab === "git" && !canGit && canFiles) setTab("files");
  }, [tab, canFiles, canGit]);

  if (!canFiles && !canGit) return null;
  if (!open) return null;

  return (
    <aside className={`workspace-panel`} aria-label="Workspace">
      <div className="workspace-panel-tabs" role="tablist">
        {canFiles ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={`workspace-panel-tab${tab === "files" ? " workspace-panel-tab--active" : ""}`}
            onClick={() => setTab("files")}
          >
            Files
          </button>
        ) : null}
        {canGit ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "git"}
            className={`workspace-panel-tab${tab === "git" ? " workspace-panel-tab--active" : ""}`}
            onClick={() => setTab("git")}
          >
            Git
          </button>
        ) : null}
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
        {tab === "files" && canFiles ? <FilesPanel cwd={cwd} canFiles={canFiles} /> : null}
        {tab === "git" && canGit ? <GitPanel cwd={cwd} canGit={canGit} /> : null}
      </div>
    </aside>
  );
}
