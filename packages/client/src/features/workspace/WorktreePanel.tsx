import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { createMutationOptions } from "@/api/mutations";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { validateBranchName } from "./worktree-branch";

export interface WorktreePanelProps {
  /** Workspace project root (the current cwd). Undefined ⇒ panel is idle. */
  cwd: string | undefined;
  /** Honest capability gate — when false the panel never requests the API. */
  canWorktree: boolean;
  /**
   * Honest `worktree.write` gate. The ENTIRE workflow (create, open/switch
   * controls, delete) is gated on this token; with only `worktree` the panel
   * stays byte/behavior-equivalent list-only. Capability revoke hides the
   * controls immediately.
   */
  canWorktreeWrite?: boolean;
  /**
   * Client URL cwd navigation only — never Git checkout, never creates /
   * attaches / stops / moves a Session, never touches a server endpoint.
   * Navigation clears old `session` search state (AppShell owns it).
   */
  onOpenWorktree?: ((path: string) => void) | undefined;
}

/** Strict list row shape (GET /v1/worktrees), `managedByPix` is live authority. */
interface WorktreeRow {
  path: string;
  branch: string | null;
  isMain: boolean;
  authorized: boolean;
  managedByPix: boolean;
}

/** One honest mutation at a time across create/delete/force. */
type Busy = null | { op: "create" } | { op: "delete"; path: string };

/** Human label for a row: branch when present, else the path basename. */
function rowLabel(row: WorktreeRow): string {
  if (row.branch) return row.branch;
  const base = row.path.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return base || row.path;
}

/** Fixed worktree error copy for the read-only list. Never echoes host text. */
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
 * Fixed mutation error copy. Code-first + transport-kind fallback; NEVER
 * renders the Host raw message/path/branch/JSON. Unknown codes collapse to a
 * fixed fallback sentence.
 */
export function describeWorktreeMutationError(
  error: unknown,
  op: "create" | "delete",
): string {
  if (error instanceof HttpError) {
    if (error.isUnauthorized) return "You are not authorized for this action.";
    switch (error.code) {
      case "INVALID_BRANCH":
        return "Invalid branch name.";
      case "WORKTREE_EXISTS":
        return "A worktree for this branch already exists.";
      case "WORKTREE_DIRTY":
        return "This worktree has modified or untracked files.";
      case "WORKTREE_BUSY":
        return "This worktree has an active Agent session.";
      case "WORKTREE_NOT_MANAGED":
        return "Only Pix-managed worktrees can be removed.";
      case "MAIN_WORKTREE":
        return "The main worktree cannot be removed.";
      case "WORKTREE_NOT_FOUND":
        return "This worktree no longer exists.";
      case "NOT_PROJECT_WORKTREE":
        return "This path is not a worktree of the current project.";
      case "REPOSITORY_REPLACED":
        return "The repository changed — refresh and try again.";
      case "WORKTREE_CREATE_FAILED":
        return "Failed to create the worktree.";
      case "WORKTREE_COMMIT_UNSTABLE":
        return "The worktree could not be created reliably — try again.";
      case "WORKTREE_DELETE_FAILED":
        return "Failed to remove the worktree.";
      case "WORKTREE_DELETE_COMMIT_INCOMPLETE":
        return "The worktree was removed, but cleanup could not be completed.";
      case "MUTATION_UNAVAILABLE":
      case "BUSY_PREFLIGHT_UNAVAILABLE":
      case "WORKTREE_MANAGED_UNAVAILABLE":
        return "This action is temporarily unavailable.";
      case "MUTATION_ABORTED":
      case "PROCESS_ABORTED":
        return "The action was cancelled.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to reach the host.";
    if (error.kind === "timeout") return "Request timed out — try again.";
    if (error.kind === "aborted") return "The action was cancelled.";
  }
  return op === "create" ? "Unable to create the worktree." : "Unable to remove the worktree.";
}

/** Exact 409 dirty marker — the ONLY condition that offers force delete.
 * Requires a real HttpError carrying BOTH status 409 and code WORKTREE_DIRTY
 * (frozen spec: only an exact 409 reveals the force confirmation). */
function isWorktreeDirty(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.code === "WORKTREE_DIRTY"
  );
}

/** Fixed warning shown in the row-local irreversible confirmation. */
const DELETE_DIRTY_WARNING =
  "This worktree has modified or untracked files. Deleting it is permanent and cannot be undone.";

/**
 * Managed-worktree vertical slice UI. With `worktree.write` it offers:
 *  - create: free-text branch only (client validates against Host `safeBranch`
 *    exactly), navigates to the returned path on success;
 *  - open/switch: Client URL cwd navigation only, for authorized non-current
 *    rows;
 *  - delete: managed non-main rows only; initial force:false; exact 409
 *    WORKTREE_DIRTY reveals a row-local irreversible confirmation with an
 *    explicit force delete (WORKTREE_BUSY never offers force).
 *
 * All mutation handling is singleflight and identity-gated (generation +
 * current cwd + current write-capability refs) so mid-flight capability revoke
 * / cwd change / unmount can never navigate or surface a late error into the
 * new context.
 */
export function WorktreePanel({
  cwd,
  canWorktree,
  canWorktreeWrite = false,
  onOpenWorktree,
}: WorktreePanelProps) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const queryClient = useQueryClient();
  // Existing mutation options: their onSuccess drives the standard query
  // invalidation (worktrees list + cwd roots) — the UI adds only gated
  // navigation/error handling on top, never a second mutation path.
  const mutationOptions = createMutationOptions(http, queryClient);
  const createMutation = useMutation(mutationOptions.worktrees.create());
  const removeMutation = useMutation(mutationOptions.worktrees.remove());

  const [busy, setBusy] = useState<Busy>(null);
  const [createDraft, setCreateDraft] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ path: string; message: string } | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<string | null>(null);

  // Identity for race-safe late settles (SessionActions-style): mount
  // generation + current cwd + current write-capability, read from refs so an
  // in-flight async continuation observes the LATEST gate, never a stale
  // render-scope value.
  const mountedRef = useRef(true);
  const requestGenRef = useRef(0);
  const gateRef = useRef({ canWrite: canWorktreeWrite, cwd: cwd ?? null });
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const cancelButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenRef.current += 1; // invalidate any in-flight UI settle
    };
  }, []);

  // cwd change OR write-capability revoke: keep the gate ref current and drop
  // all pending mutation UI (busy, confirmation, error, status) so stale
  // state can never leak into the new context. Re-grant does NOT resurrect it.
  useLayoutEffect(() => {
    gateRef.current = { canWrite: canWorktreeWrite, cwd: cwd ?? null };
    requestGenRef.current += 1;
    setBusy(null);
    setCreateDraft("");
    setCreateError(null);
    setCreateStatus(null);
    setDeleteConfirmPath(null);
    setDeleteError(null);
    setDeleteStatus(null);
  }, [cwd, canWorktreeWrite]);

  // Default/returned focus favors Cancel (safe escape) when a row-local
  // confirmation appears.
  useLayoutEffect(() => {
    if (deleteConfirmPath === null) return;
    cancelButtonRefs.current.get(deleteConfirmPath)?.focus();
  }, [deleteConfirmPath]);

  // After a cancel, return focus to the original delete control once the row
  // re-mounts it (post-commit) — the button is unmounted while the
  // confirmation is open, so it cannot be focused synchronously.
  useEffect(() => {
    if (deleteConfirmPath !== null) return;
    const path = restoreFocusRef.current;
    if (path === null) return;
    restoreFocusRef.current = null;
    deleteButtonRefs.current.get(path)?.focus();
  }, [deleteConfirmPath]);

  const list = useQuery({
    ...options.worktrees.list(cwd ?? ""),
    enabled: canWorktree && Boolean(cwd),
  });

  /** Identity guard uses only refs — a late settle must fail closed. */
  const isCurrentRequest = (gen: number): boolean =>
    mountedRef.current &&
    gen === requestGenRef.current &&
    gateRef.current.canWrite &&
    gateRef.current.cwd !== null;

  if (!canWorktree) {
    return <p className="workspace-hint">Worktrees are not available on this host.</p>;
  }
  if (!cwd) {
    return <p className="workspace-hint">Open a project to view its worktrees.</p>;
  }

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.list(cwd) });
  };

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy !== null || createMutation.isPending || !canWorktreeWrite || !cwd) return;
    const branch = createDraft;
    const invalid = validateBranchName(branch);
    if (invalid !== null) {
      setCreateError(invalid);
      return;
    }
    const cwdAtSubmit = cwd;
    const gen = ++requestGenRef.current;
    setBusy({ op: "create" });
    setCreateError(null);
    setCreateStatus("Creating worktree…");
    void createMutation
      .mutateAsync({ cwd: cwdAtSubmit, branch })
      .then(
        (data) => {
          if (!isCurrentRequest(gen)) return;
          setCreateStatus(null);
          setCreateDraft("");
          // Navigate the returned path (clears session search state). Only on
          // success — never on error, capability revoke, cwd change, or a
          // stale/late completion.
          onOpenWorktree?.(data.path);
        },
        (cause) => {
          if (!isCurrentRequest(gen)) return;
          setCreateStatus(null);
          setCreateError(describeWorktreeMutationError(cause, "create"));
        },
      )
      .finally(() => {
        if (isCurrentRequest(gen)) setBusy(null);
      });
  };

  /** Run a delete (initial force:false, or the confirmed force:true). */
  const runDelete = (row: WorktreeRow, force: boolean): void => {
    if (busy !== null || removeMutation.isPending || !canWorktreeWrite || !cwd) return;
    const cwdAtSubmit = cwd;
    const gen = ++requestGenRef.current;
    setBusy({ op: "delete", path: row.path });
    setDeleteConfirmPath(null);
    setDeleteError(null);
    setDeleteStatus("Removing worktree…");
    void removeMutation
      .mutateAsync({ cwd: cwdAtSubmit, path: row.path, force })
      .then(
        (data) => {
          if (!isCurrentRequest(gen)) return;
          setDeleteStatus(null);
          // If the deleted path IS the current cwd, navigate the authoritative
          // fallback cwd (clears session); otherwise keep the current cwd.
          if (row.path === cwdAtSubmit) {
            onOpenWorktree?.(data.fallbackCwd);
          }
        },
        (cause) => {
          if (!isCurrentRequest(gen)) return;
          setDeleteStatus(null);
          if (!force && isWorktreeDirty(cause)) {
            // Exact 409 dirty on the initial (force:false) delete reveals the
            // row-local confirmation. WORKTREE_BUSY and every other code never
            // offer force.
            setDeleteConfirmPath(row.path);
            return;
          }
          setDeleteError({ path: row.path, message: describeWorktreeMutationError(cause, "delete") });
        },
      )
      .finally(() => {
        if (isCurrentRequest(gen)) setBusy(null);
      });
  };

  const handleCancelDelete = (row: WorktreeRow): void => {
    restoreFocusRef.current = row.path;
    setDeleteConfirmPath(null);
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

      {canWorktreeWrite ? (
        <form className="worktree-create" onSubmit={handleCreateSubmit}>
          <label className="worktree-create-label" htmlFor="worktree-branch">
            New worktree branch
          </label>
          <div className="worktree-create-row">
            <input
              id="worktree-branch"
              type="text"
              value={createDraft}
              onChange={(event) => {
                setCreateDraft(event.target.value);
                if (createError) setCreateError(null);
              }}
              placeholder="feature/branch-name"
              autoComplete="off"
              spellCheck={false}
              maxLength={255}
              disabled={busy !== null}
              aria-invalid={createError !== null}
              aria-describedby={createError ? "worktree-create-error" : undefined}
            />
            <button
              type="submit"
              className="text-btn"
              disabled={busy !== null || createDraft.length === 0}
              aria-busy={busy?.op === "create"}
            >
              Create
            </button>
          </div>
          {createError ? (
            <p id="worktree-create-error" className="worktree-create-error" role="alert">
              {createError}
            </p>
          ) : null}
          {createStatus ? (
            <p className="worktree-status" role="status">
              {createStatus}
            </p>
          ) : null}
        </form>
      ) : null}

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

      {deleteStatus ? (
        <p className="worktree-status" role="status">
          {deleteStatus}
        </p>
      ) : null}

      {worktrees.length === 0 ? (
        <p className="workspace-hint">No worktrees reported for this repository.</p>
      ) : (
        <ul className="worktree-list" role="list" aria-label="Git worktrees">
          {worktrees.map((item) => {
            const branchLabel = item.branch ?? "Detached";
            const roleLabel = item.isMain ? "main" : "linked";
            const authLabel = item.authorized ? "authorized" : "External · not authorized";
            const label = rowLabel(item);
            const isCurrent = item.path === cwd;
            // Open: authorized + non-current rows only (Client URL navigation).
            const canOpen =
              canWorktreeWrite && typeof onOpenWorktree === "function" && item.authorized && !isCurrent;
            // Delete: managed non-main rows only — never external/manual/
            // planted/legacy/unmanaged/main.
            const canDelete = canWorktreeWrite && item.managedByPix && !item.isMain;
            const rowBusy = busy?.op === "delete" && busy.path === item.path;
            const confirmOpen = deleteConfirmPath === item.path;
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
                {canOpen || canDelete ? (
                  <div className="worktree-row-actions">
                    {canOpen ? (
                      <button
                        type="button"
                        className="text-btn"
                        onClick={() => onOpenWorktree?.(item.path)}
                        disabled={busy !== null}
                        aria-label={`Open worktree ${label}`}
                      >
                        Open
                      </button>
                    ) : null}
                    {canDelete && !confirmOpen ? (
                      <button
                        type="button"
                        className="text-btn worktree-btn--danger"
                        ref={(el) => {
                          if (el) deleteButtonRefs.current.set(item.path, el);
                          else deleteButtonRefs.current.delete(item.path);
                        }}
                        onClick={() => runDelete(item, false)}
                        disabled={busy !== null}
                        aria-busy={rowBusy}
                        aria-label={`Delete worktree ${label}`}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {confirmOpen ? (
                  <div
                    className="worktree-delete-confirm"
                    role="alert"
                    aria-label={`Confirm deleting ${label}`}
                  >
                    <p className="worktree-delete-confirm-warning">{DELETE_DIRTY_WARNING}</p>
                    <div className="worktree-delete-confirm-actions">
                      <button
                        type="button"
                        className="text-btn worktree-btn--danger"
                        onClick={() => runDelete(item, true)}
                        disabled={busy !== null}
                        aria-busy={rowBusy}
                        aria-label={`Delete worktree ${label} anyway`}
                      >
                        Delete anyway
                      </button>
                      <button
                        type="button"
                        className="text-btn"
                        ref={(el) => {
                          if (el) cancelButtonRefs.current.set(item.path, el);
                          else cancelButtonRefs.current.delete(item.path);
                        }}
                        onClick={() => handleCancelDelete(item)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {deleteError !== null && deleteError.path === item.path ? (
                  <p className="worktree-row-error" role="alert">
                    {deleteError.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
