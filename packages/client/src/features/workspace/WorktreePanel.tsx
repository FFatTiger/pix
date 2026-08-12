import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";

export interface WorktreePanelProps {
  /** Workspace project root (the current cwd). Undefined ⇒ panel is idle. */
  cwd: string | undefined;
  /** Honest capability gate — when false the panel never requests the API. */
  canWorktree: boolean;
}

/**
 * Fixed worktree error copy. Never renders body/stack/path/secret/raw host
 * messages — maps known codes, falls back to a generic sentence.
 */
export function describeWorktreeError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "CWD_REQUIRED":
      case "INVALID_PATH":
      case "INVALID_INPUT":
        return "Invalid project path.";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "Project path is outside the allowed roots.";
      case "PATH_NOT_FOUND":
        return "Project path was not found.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to load worktrees.";
    if (error.kind === "timeout") return "Request timed out — unable to load worktrees.";
  }
  return "Unable to load worktrees.";
}

/**
 * Read-only Git worktree topology for the current workspace cwd.
 *
 * Strictly list-only: no create/remove/force/open/switch/promote/session
 * controls, and never imports mutation options. Requests fire only when the
 * `worktree` capability is negotiated and a cwd is set.
 */
export function WorktreePanel({ cwd, canWorktree }: WorktreePanelProps) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const queryClient = useQueryClient();

  const list = useQuery({
    ...options.worktrees.list(cwd ?? ""),
    enabled: canWorktree && Boolean(cwd),
  });

  if (!canWorktree) {
    return <p className="workspace-hint">Worktrees are not available on this host.</p>;
  }
  if (!cwd) {
    return <p className="workspace-hint">Open a project to view its worktrees.</p>;
  }

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.list(cwd) });
  };

  if (list.isLoading) {
    return <p className="workspace-hint">Loading worktrees…</p>;
  }
  if (list.isError) {
    return (
      <div className="worktree-panel" aria-label="Worktrees">
        <p className="workspace-hint workspace-hint--error" role="alert">
          {describeWorktreeError(list.error)}
        </p>
        <button type="button" className="text-btn" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  const data = list.data;
  if (!data) return null;

  if (!data.isGit) {
    return (
      <div className="worktree-panel" aria-label="Worktrees">
        <div className="git-summary">
          <span className="git-summary-label">Not a git repository</span>
          <span className="git-summary-sub" title={data.projectRoot}>
            No repository found at or above this project.
          </span>
        </div>
      </div>
    );
  }

  const worktrees = data.worktrees;

  return (
    <div className="worktree-panel" aria-label="Worktrees">
      <div className="git-summary">
        <span className="git-summary-label">Project root</span>
        <span className="git-summary-sub" title={data.projectRoot}>
          {data.projectRoot}
        </span>
        <span className="git-summary-stats">
          {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"}
          {data.isTopLevel ? " · current is top-level" : ""}
        </span>
      </div>

      <div className="files-toolbar">
        <span className="files-count">
          {worktrees.length} entr{worktrees.length === 1 ? "y" : "ies"}
        </span>
        <button
          type="button"
          className="text-btn"
          onClick={refresh}
          disabled={list.isFetching}
          title="Refresh worktrees"
        >
          ↻ Refresh
        </button>
      </div>

      {worktrees.length === 0 ? (
        <p className="workspace-hint">No worktrees reported for this repository.</p>
      ) : (
        <ul className="worktree-list" role="list" aria-label="Git worktrees">
          {worktrees.map((item) => {
            const branchLabel = item.branch ?? "Detached";
            const roleLabel = item.isMain ? "main" : "linked";
            const authLabel = item.authorized ? "authorized" : "External · not authorized";
            return (
              <li key={item.path} className="worktree-row" title={item.path}>
                <div className="worktree-row-main">
                  <span className={`catalog-chip${item.isMain ? " catalog-chip--accent" : ""}`}>
                    {roleLabel}
                  </span>
                  <span className="worktree-branch" title={branchLabel}>
                    {branchLabel}
                  </span>
                  <span
                    className={`catalog-chip${item.authorized ? " catalog-chip--ok" : ""}`}
                    title={
                      item.authorized
                        ? "Path is inside AllowedRoot"
                        : "Path is outside AllowedRoot — read-only view only"
                    }
                  >
                    {authLabel}
                  </span>
                </div>
                <div className="worktree-path" title={item.path}>
                  {item.path}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
