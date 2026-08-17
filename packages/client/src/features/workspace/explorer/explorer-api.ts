import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";

/**
 * pix workspace domain helper.
 *
 * Directory listings, git status/diff, reads/meta and search/index are owned
 * by React Query (queryKeys/createQueryOptions) so FileExplorer/QuickChanges/
 * Viewer share one remote-state authority. This file only keeps the small
 * shared MAPPERS that translate schema-shaped query data onto the domain types
 * the explorer surfaces consume — a single definition both panels use, so the
 * shared git.status(cwd) query is rendered identically everywhere.
 */

/** Schema-shaped git status payload (as returned by queryKeys.git.status). */
export interface ExplorerGitStatusPayload {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: Array<{
    filePath: string;
    status: string;
    code: string;
    indexStatus: string;
    worktreeStatus: string;
  }>;
  additions: number;
  deletions: number;
}

/**
 * Map the Host git-status payload onto the shared GitStatusResponse shape.
 * `status`/`code` are cast to the known domain kinds (the Host only emits
 * those) and `ignoredPaths` is an empty list — pix does not surface ignored
 * paths (yet), so the tree's dimming of ignored entries simply never triggers
 * instead of guessing client-side.
 */
export function mapExplorerGitStatus(data: ExplorerGitStatusPayload): GitStatusResponse {
  return {
    isGitRepository: data.isGitRepository,
    repositoryRoot: data.repositoryRoot,
    files: data.files.map((file): GitFileStatus => ({
      filePath: file.filePath,
      status: file.status as GitFileStatusKind,
      code: file.code as GitFileStatus["code"],
      indexStatus: file.indexStatus,
      worktreeStatus: file.worktreeStatus,
    })),
    additions: data.additions,
    deletions: data.deletions,
    ignoredPaths: [],
  };
}
