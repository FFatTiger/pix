import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { relativePath } from "./paths";

export interface GitPanelProps {
  /** Workspace project root (the current cwd). Undefined ⇒ panel is idle. */
  cwd: string | undefined;
  /** Honest capability gate — when false the panel never requests the API. */
  canGit: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  conflict: "Conflict",
};

/**
 * Fixed git error copy. Never renders body/stack/path/secret/raw host
 * messages — maps known codes, then kind for network/timeout, then falls back
 * to a generic sentence scoped to the operation (status vs diff).
 */
export function describeGitError(error: unknown, operation: "status" | "diff"): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "CWD_REQUIRED":
      case "GIT_INPUT_REQUIRED":
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
    if (error.kind === "network") {
      return operation === "diff"
        ? "Network error — unable to load diff."
        : "Network error — unable to load git status.";
    }
    if (error.kind === "timeout") {
      return operation === "diff"
        ? "Request timed out — unable to load diff."
        : "Request timed out — unable to load git status.";
    }
  }
  return operation === "diff" ? "Unable to load diff." : "Unable to load git status.";
}

function describeStatus(code: string): string {
  return STATUS_LABEL[code] ?? code;
}

/** Two-char XY porcelain badge (staged index status · working-tree status). */
function porcelainBadge(indexStatus: string, worktreeStatus: string): string {
  const idx = indexStatus === " " ? "·" : indexStatus;
  const wt = worktreeStatus === " " ? "·" : worktreeStatus;
  return `${idx}${wt}`;
}

export function GitPanel({ cwd, canGit }: GitPanelProps) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const status = useQuery({
    ...options.git.status(cwd ?? ""),
    enabled: canGit && Boolean(cwd),
  });
  const diff = useQuery({
    ...options.git.diff(cwd ?? "", selectedPath ?? ""),
    enabled: canGit && Boolean(cwd) && Boolean(selectedPath),
  });

  if (!canGit) {
    return <p className="workspace-hint">Git status is not available on this host.</p>;
  }
  if (!cwd) {
    return <p className="workspace-hint">Open a project to view its git status.</p>;
  }

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.git.all });
  };

  if (status.isLoading) {
    return <p className="workspace-hint">Loading git status…</p>;
  }
  if (status.isError) {
    return (
      <div className="git-panel" aria-label="Git">
        <p className="workspace-hint workspace-hint--error" role="alert">
          {describeGitError(status.error, "status")}
        </p>
        <button type="button" className="text-btn" onClick={refresh}>Retry</button>
      </div>
    );
  }

  const data = status.data;
  if (!data) return null;

  if (!data.isGitRepository) {
    return (
      <div className="git-panel" aria-label="Git">
        <div className="git-summary">
          <span className="git-summary-label">Not a git repository</span>
          <span className="git-summary-sub">No repository found at or above this project.</span>
        </div>
      </div>
    );
  }

  const repoRoot = data.repositoryRoot ?? cwd;
  const files = data.files;

  return (
    <div className="git-panel" aria-label="Git">
      <div className="git-summary">
        <span className="git-summary-label" title={repoRoot}>Repository</span>
        <span className="git-summary-sub">{repoRoot}</span>
        <span className="git-summary-stats">
          {files.length} changed · +{data.additions} / −{data.deletions}
        </span>
      </div>
      <div className="files-toolbar">
        <span className="files-count">{files.length} file{files.length === 1 ? "" : "s"}</span>
        <button
          type="button"
          className="text-btn"
          onClick={refresh}
          disabled={status.isFetching}
          title="Refresh git status"
        >
          ↻ Refresh
        </button>
      </div>

      {files.length === 0 ? (
        <p className="workspace-hint">Working tree is clean — no changes.</p>
      ) : (
        <div className="git-split">
          <ul className="git-file-list" role="listbox" aria-label="Changed files">
            {files.map((file) => {
              const active = selectedPath === file.filePath;
              return (
                <li key={file.filePath}>
                  <button
                    type="button"
                    className={`git-file-row${active ? " git-file-row--active" : ""}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => setSelectedPath(file.filePath)}
                    title={file.filePath}
                  >
                    <span className={`git-status-badge git-status-badge--${file.status}`} title={describeStatus(file.status)}>
                      {porcelainBadge(file.indexStatus, file.worktreeStatus)}
                    </span>
                    <span className="git-file-path">{relativePath(repoRoot, file.filePath)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selectedPath ? (
            <section className="git-diff" aria-label="Diff">
              <div className="git-diff-header">
                <span className="git-diff-name" title={selectedPath}>{relativePath(repoRoot, selectedPath)}</span>
                <button type="button" className="icon-btn" aria-label="Close diff" onClick={() => setSelectedPath(null)}>×</button>
              </div>
              {diff.isLoading ? <p className="workspace-hint">Loading diff…</p> : null}
              {diff.isError ? (
                <p className="workspace-hint workspace-hint--error" role="alert">
                  {describeGitError(diff.error, "diff")}
                </p>
              ) : null}
              {diff.data ? (
                diff.data.supported ? (
                  <pre className="files-preview git-diff-patch" aria-label="Diff patch"><code>{diff.data.patch}</code></pre>
                ) : (
                  <p className="workspace-hint">No text diff available for this change.</p>
                )
              ) : null}
            </section>
          ) : (
            <p className="workspace-hint git-diff-empty">Select a file to view its diff.</p>
          )}
        </div>
      )}
    </div>
  );
}
