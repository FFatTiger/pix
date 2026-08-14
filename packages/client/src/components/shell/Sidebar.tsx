import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { WorkspaceSearch } from "@/lib/search-params";
import { formatCwdLabel } from "@/lib/search-params";
import { createQueryOptions } from "@/api/query-keys";
import { createMutationOptions } from "@/api/mutations";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { TrustBadge } from "@/features/catalog/TrustBadge";
import type { SessionHeader } from "@fffattiger/pix-protocol";

export interface SidebarProps {
  open: boolean;
  search: WorkspaceSearch;
  /**
   * The currently attached/live runtime session id (AppShell knows it). The
   * D4 delete control is never shown for this session; other live sessions may
   * still be rejected authoritatively by the server with a fixed 409. Rename,
   * unlike delete, is available for live AND history rows (the D4 rename lane
   * serves live set_session_name) — only the `session.write` capability gates it.
   */
  liveSessionId?: string | null;
  /**
   * D4 delete-navigation callback. AppShell is the single navigation owner:
   * it clears only the `session` search param (preserving `cwd`) when the
   * deleted session equals the URL-selected session. Non-selected deletions
   * never navigate. Rename never navigates at all.
   */
  onSessionDeleted?: (sessionId: string) => void;
}

/**
 * Resolve the most recent usable activity instant for a session.
 *
 * Preference order is `updatedAt → lastMessageAt → createdAt`. Each candidate
 * is only consumed when it is a finite number that maps to a representable
 * `Date`; an undefined or unrepresentable candidate is skipped so a later
 * candidate can still win, and so the row never renders `Invalid Date`.
 * Returns the ISO-8601 instant (for `<time dateTime>`) plus the source epoch-ms
 * (for the localized label), or `undefined` when no candidate is usable.
 */
function activityTime(session: SessionHeader): { iso: string; ms: number } | undefined {
  for (const value of [session.updatedAt, session.lastMessageAt, session.createdAt]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const instant = new Date(value);
    const time = instant.getTime();
    // getTime() is NaN for out-of-range instants (e.g. 1e30); skip those.
    if (!Number.isFinite(time)) continue;
    return { iso: instant.toISOString(), ms: value };
  }
  return undefined;
}

/**
 * Fixed D4 delete error copy. Code/status-first, transport-kind fallback; NEVER
 * renders the Host raw message/title/path/JSON. Unknown codes collapse to a
 * fixed fallback sentence.
 */
export function describeSessionDeleteError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.isUnauthorized) return "You are not authorized for this action.";
    switch (error.code) {
      case "SESSION_IN_USE":
        return "This session is currently in use.";
      case "SESSION_NOT_FOUND":
        return "This session no longer exists.";
      case "SESSIONS_UNAVAILABLE":
      case "MUTATION_UNAVAILABLE":
        return "Session deletion is temporarily unavailable.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to reach the host.";
    if (error.kind === "timeout") return "Request timed out — try again.";
    if (error.kind === "aborted") return "The action was cancelled.";
  }
  return "Unable to delete this session.";
}

/**
 * Fixed D4 rename error copy. Code/status-first, transport-kind fallback; NEVER
 * renders the Host raw message, the submitted name, or any id/path/secret.
 * Unknown codes collapse to a fixed fallback sentence.
 */
export function describeSessionRenameError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.isUnauthorized) return "You are not authorized for this action.";
    switch (error.code) {
      case "SESSION_IN_USE":
        return "This session is currently in use.";
      case "SESSION_NOT_FOUND":
        return "This session no longer exists.";
      case "INVALID_NAME":
      case "INVALID_INPUT":
        return "That session name is not allowed.";
      case "SESSIONS_UNAVAILABLE":
      case "MUTATION_UNAVAILABLE":
        return "Session renaming is temporarily unavailable.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to reach the host.";
    if (error.kind === "timeout") return "Request timed out — try again.";
    if (error.kind === "aborted") return "The action was cancelled.";
  }
  return "Unable to rename this session.";
}

/**
 * Client-side validation that mirrors the Host canonicalize rule (§44/§51):
 * outer whitespace trimmed, blank rejected, at most 200 UTF-16 JS code units,
 * and NUL / C0 (U+0000–U+001F) / DEL (U+007F) rejected. Internal spaces,
 * Unicode and emoji are allowed. Returns the canonical trimmed name on success
 * or a fixed row-local error message — no request is issued on invalid input.
 */
export function validateSessionName(
  raw: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, message: "Enter a session name." };
  if (trimmed.length > 200) return { ok: false, message: "Session names are limited to 200 characters." };
  for (let index = 0; index < trimmed.length; index++) {
    const code = trimmed.charCodeAt(index);
    if (code === 0 || code < 0x20 || code === 0x7f) {
      return { ok: false, message: "Session names cannot contain control characters." };
    }
  }
  return { ok: true, name: trimmed };
}

/** Fixed warning copy for the row-local irreversible confirmation. */
const DELETE_WARNING = "Deleting this session is permanent and cannot be undone.";

export function Sidebar({ open, search, liveSessionId = null, onSessionDeleted }: SidebarProps) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { canBrowseSessions, canDeleteSessions, canWriteSessions } = useCapabilities();
  // The session list is only requested when the host actually serves it
  // (sessiond connected). M1 wires no session catalog, so this stays disabled
  // and avoids an unconditional 404 against the unimplemented /v1/sessions.
  const sessions = useQuery({ ...createQueryOptions(http).sessions.list(search.cwd), enabled: canBrowseSessions });
  // D4 delete + rename mutations: existing options own the standard list+byId
  // invalidation (rename additionally primes the cached titles first). The UI
  // adds only gated navigation/error handling on top.
  const removeMutation = useMutation(createMutationOptions(http, queryClient).sessions.remove());
  const renameMutation = useMutation(createMutationOptions(http, queryClient).sessions.rename());

  // D4 row-local state: one confirmation + one rename editor + one mutation at
  // a time. Rename and delete share the same `busy`/`busyRef` singleflight.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ sessionId: string; message: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<{ sessionId: string; message: string } | null>(null);

  // Identity for race-safe late settles: mount generation + capability gates +
  // edited row id + visible row set, read from refs so an in-flight async
  // continuation observes the LATEST view.
  const mountedRef = useRef(true);
  const requestGenRef = useRef(0);
  const canDeleteRef = useRef(canDeleteSessions);
  const canWriteRef = useRef(canWriteSessions);
  // Synchronous singleflight: React state updates are async, so a second click
  // in the same tick cannot see `busy`/isPending yet. This ref guarantees exactly
  // one in-flight row mutation (rename OR delete) across the whole list.
  const busyRef = useRef<string | null>(null);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const cancelButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusRef = useRef<string | null>(null);
  const renameButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameRestoreFocusRef = useRef<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  // Current visible row ids (re-read at settle time for row-disappearance).
  const visibleSessionIdsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenRef.current += 1; // invalidate any in-flight UI settle
    };
  }, []);

  // Capability revoke / cwd switch / URL session selection change: keep the
  // gate refs current and drop ALL pending delete/rename UI so stale state can
  // never leak into the new context. A later re-grant does NOT resurrect it.
  useLayoutEffect(() => {
    canDeleteRef.current = canDeleteSessions;
    canWriteRef.current = canWriteSessions;
    requestGenRef.current += 1;
    busyRef.current = null;
    setBusy(null);
    setConfirmId(null);
    setDeleteError(null);
    setEditingId(null);
    setRenameDraft("");
    setRenameError(null);
  }, [search.cwd, search.session, canDeleteSessions, canWriteSessions]);

  // Keep the edited-row identity synchronous for late-settle checks.
  useLayoutEffect(() => {
    editingIdRef.current = editingId;
  }, [editingId]);

  // Default/returned focus favors Cancel (safe escape) when a row-local
  // confirmation appears.
  useLayoutEffect(() => {
    if (confirmId === null) return;
    cancelButtonRefs.current.get(confirmId)?.focus();
  }, [confirmId]);

  // When a rename editor opens: focus + select the prefilled input so the user
  // can type over the current title immediately.
  useLayoutEffect(() => {
    if (editingId === null) return;
    const input = renameInputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [editingId]);

  // After a cancel or a failure, return focus to the original delete control
  // once the row re-mounts it — the button is unmounted while the confirmation
  // is open, so it cannot be focused synchronously.
  useEffect(() => {
    if (confirmId !== null) return;
    const id = restoreFocusRef.current;
    if (id === null) return;
    restoreFocusRef.current = null;
    deleteButtonRefs.current.get(id)?.focus();
  }, [confirmId]);

  // After the rename editor closes (success / cancel / escape), return focus to
  // the Rename control once it re-mounts.
  useEffect(() => {
    if (editingId !== null) return;
    const id = renameRestoreFocusRef.current;
    if (id === null) return;
    renameRestoreFocusRef.current = null;
    renameButtonRefs.current.get(id)?.focus();
  }, [editingId]);

  // Honesty / fail-closed: when the sessions capability is retracted the visible
  // list is pinned empty regardless of cache state or any in-flight response.
  // The query is disabled so no request is issued; gating every derived flag on
  // the live capability additionally hides stale cache, stale loading/error and
  // late-arriving results — the sidebar can never display history it is no
  // longer entitled to.
  const visibleSessions = canBrowseSessions ? (sessions.data?.sessions ?? []) : [];
  const showLoading = canBrowseSessions && sessions.isLoading;
  const showError = canBrowseSessions && sessions.isError;
  const showEmpty =
    canBrowseSessions && !sessions.isLoading && !sessions.isError && (sessions.data?.sessions.length ?? 0) === 0;

  // Row-disappearance guard for late-settle identity: a settle for a row that is
  // no longer in the visible list must be inert. Written on every render so the
  // async continuation reads the LATEST list via the ref, never a stale closure.
  visibleSessionIdsRef.current = new Set(visibleSessions.map((session) => session.sessionId));

  /** Identity guard uses only refs — a late settle must fail closed. */
  const isCurrentRequest = (gen: number): boolean =>
    mountedRef.current && gen === requestGenRef.current && canDeleteRef.current;

  /** Alive (unmounted/gen-check) — used to release the shared busy slot. */
  const isAliveRequest = (gen: number): boolean =>
    mountedRef.current && gen === requestGenRef.current;

  /** Rename identity: mount + gen + rename capability + edited row + row present. */
  const isCurrentRenameRequest = (gen: number, id: string): boolean =>
    mountedRef.current &&
    gen === requestGenRef.current &&
    canWriteRef.current &&
    editingIdRef.current === id &&
    visibleSessionIdsRef.current.has(id);

  const runDelete = (session: SessionHeader): void => {
    if (busyRef.current !== null || busy !== null || removeMutation.isPending || !canDeleteSessions) return;
    const id = session.sessionId;
    const selectedAtSubmit = search.session;
    const wasSelected = selectedAtSubmit === id;
    const gen = ++requestGenRef.current;
    busyRef.current = id;
    setBusy(id);
    setConfirmId(null);
    setDeleteError(null);
    void removeMutation
      .mutateAsync(id)
      .then(() => {
        if (!isCurrentRequest(gen)) return;
        // If the deleted row equals the URL-selected session, AppShell clears
        // only `session` while preserving `cwd`. Non-selected deletions leave
        // the URL untouched.
        if (wasSelected) onSessionDeleted?.(id);
      }, (cause: unknown) => {
        if (!isCurrentRequest(gen)) return;
        setDeleteError({ sessionId: id, message: describeSessionDeleteError(cause) });
        restoreFocusRef.current = id;
      })
      .finally(() => {
        // Clear the synchronous singleflight slot only while we still own it
        // (a newer mutation may have taken over after a cap/cwd/selection change).
        if (busyRef.current === id) busyRef.current = null;
        if (isCurrentRequest(gen)) setBusy(null);
      });
  };

  const handleCancelDelete = (session: SessionHeader): void => {
    restoreFocusRef.current = session.sessionId;
    setConfirmId(null);
  };

  /** Open the row-local rename editor (one at a time; closes any delete confirm). */
  const openRename = (session: SessionHeader): void => {
    if (busyRef.current !== null || busy !== null || !canWriteSessions) return;
    setConfirmId(null);
    setDeleteError(null);
    setRenameError(null);
    setRenameDraft(session.title ?? "");
    setEditingId(session.sessionId);
  };

  const handleCancelRename = (session: SessionHeader): void => {
    renameRestoreFocusRef.current = session.sessionId;
    setEditingId(null);
    setRenameDraft("");
    setRenameError(null);
  };

  const runRename = (session: SessionHeader): void => {
    if (busyRef.current !== null || busy !== null || renameMutation.isPending || !canWriteSessions) return;
    const id = session.sessionId;
    const validation = validateSessionName(renameDraft);
    if (!validation.ok) {
      setRenameError({ sessionId: id, message: validation.message });
      return;
    }
    const trimmed = validation.name;
    // Unchanged canonical title is a safe no-op: close the editor, restore
    // focus and never issue a request (the Host would just echo the same name).
    if (session.title !== undefined && trimmed === session.title) {
      renameRestoreFocusRef.current = id;
      setEditingId(null);
      setRenameError(null);
      return;
    }
    const gen = ++requestGenRef.current;
    busyRef.current = id;
    setBusy(id);
    setRenameError(null);
    void renameMutation
      .mutateAsync({ id, name: trimmed })
      .then(() => {
        if (!isCurrentRenameRequest(gen, id)) return;
        // Success: the mutation already primed the cached list/detail titles
        // before invalidation, so this row now shows the new name. Close the
        // editor and return focus to the Rename control. URL/cwd/session and
        // the runtime attachment are never touched.
        setEditingId(null);
        renameRestoreFocusRef.current = id;
        setRenameError(null);
      }, (cause: unknown) => {
        if (!isCurrentRenameRequest(gen, id)) return;
        // Server failure: keep the editor open, preserve the draft and keep
        // focus on the input so the user can retry.
        setRenameError({ sessionId: id, message: describeSessionRenameError(cause) });
        renameInputRef.current?.focus();
      })
      .finally(() => {
        // Release the shared synchronous singleflight slot + busy state while
        // still owning this request generation.
        if (busyRef.current === id) busyRef.current = null;
        if (isAliveRequest(gen)) setBusy(null);
      });
  };

  return (
    <aside className={`sidebar${open ? "" : " sidebar--collapsed"}`} aria-hidden={!open} aria-label="Sessions">
      <div className="sidebar-section">
        <div className="sidebar-section-title">Project</div>
        <div className="sidebar-cwd" title={search.cwd ?? ""}>{formatCwdLabel(search.cwd)}</div>
        <div className="sidebar-trust">
          <TrustBadge cwd={search.cwd} variant="badge" />
        </div>
      </div>
      <div className="sidebar-section sidebar-section--grow">
        <div className="sidebar-section-title">Sessions</div>
        <ul className="session-list">
          {visibleSessions.map((session) => {
            const active = search.session === session.sessionId;
            const activity = activityTime(session);
            const messages = session.messageCount;
            const label = session.title || "Untitled session";
            // D4 delete: capability-gated, hidden for the attached/live session
            // (the server rejects live sessions authoritatively anyway), and one
            // delete at a time across the whole list.
            const canDeleteRow =
              canDeleteSessions && session.sessionId !== liveSessionId;
            const rowBusy = busy === session.sessionId;
            const confirmOpen = confirmId === session.sessionId;
            const renameOpen = editingId === session.sessionId && canWriteSessions;
            return (
              <li key={session.sessionId}>
                <div className="session-row-flex">
                  <Link
                    to="/"
                    search={{ session: session.sessionId, ...(search.cwd === undefined ? {} : { cwd: search.cwd }) }}
                    className={`session-row${active ? " session-row--active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="session-row-title">{label}</span>
                    <span className="session-row-id">{session.sessionId}</span>
                    <span className="session-row-id">{formatCwdLabel(session.cwd)}</span>
                    {activity === undefined ? null : (
                      <time className="session-row-id" dateTime={activity.iso}>
                        {new Date(activity.ms).toLocaleString()}
                      </time>
                    )}
                    {messages === undefined ? null : (
                      <span className="session-row-id">{messages} {messages === 1 ? "message" : "messages"}</span>
                    )}
                    {session.parentSessionId === undefined ? null : (
                      <span className="session-row-id">Fork</span>
                    )}
                  </Link>
                  {canWriteSessions && !renameOpen ? (
                    <button
                      type="button"
                      className="text-btn session-rename-btn"
                      ref={(el) => {
                        if (el) renameButtonRefs.current.set(session.sessionId, el);
                        else renameButtonRefs.current.delete(session.sessionId);
                      }}
                      onClick={(event) => {
                        // Prevent any Link navigation/propagation from this
                        // row-local control.
                        event.preventDefault();
                        event.stopPropagation();
                        openRename(session);
                      }}
                      disabled={busy !== null}
                      aria-label={`Rename session ${label}`}
                    >
                      Rename
                    </button>
                  ) : null}
                  {canDeleteRow && !confirmOpen ? (
                    <button
                      type="button"
                      className="text-btn session-delete-btn"
                      ref={(el) => {
                        if (el) deleteButtonRefs.current.set(session.sessionId, el);
                        else deleteButtonRefs.current.delete(session.sessionId);
                      }}
                      onClick={(event) => {
                        // Prevent any Link navigation/propagation from this
                        // row-local control.
                        event.preventDefault();
                        event.stopPropagation();
                        // A delete confirm and a rename editor never coexist:
                        // opening the confirm closes any open editor.
                        setEditingId(null);
                        setRenameDraft("");
                        setRenameError(null);
                        setConfirmId(session.sessionId);
                      }}
                      disabled={busy !== null}
                      aria-busy={rowBusy}
                      aria-label={`Delete session ${label}`}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
                {renameOpen ? (
                  <form
                    className="session-rename-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      runRename(session);
                    }}
                  >
                    <input
                      type="text"
                      className="session-rename-input"
                      value={renameDraft}
                      onChange={(event) => {
                        setRenameDraft(event.target.value);
                        if (renameError !== null && renameError.sessionId === session.sessionId) {
                          setRenameError(null);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          handleCancelRename(session);
                        } else if (event.key === "Enter") {
                          // Enter saves (explicit; prevents the implicit form
                          // submit so the singleflight sees exactly one path).
                          event.preventDefault();
                          runRename(session);
                        }
                      }}
                      aria-label={`New name for ${label}`}
                      maxLength={200}
                      autoComplete="off"
                      spellCheck={false}
                      ref={renameInputRef}
                    />
                    <div className="session-rename-actions">
                      <button
                        type="submit"
                        className="text-btn"
                        disabled={busy !== null}
                        aria-busy={rowBusy}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="text-btn"
                        onClick={(event) => {
                          event.preventDefault();
                          handleCancelRename(session);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {renameError !== null && renameError.sessionId === session.sessionId ? (
                      <p className="session-rename-error" role="alert">
                        {renameError.message}
                      </p>
                    ) : null}
                  </form>
                ) : null}
                {confirmOpen ? (
                  <div
                    className="session-delete-confirm"
                    role="alert"
                    aria-label={`Confirm deleting ${label}`}
                  >
                    <p className="session-delete-confirm-warning">{DELETE_WARNING}</p>
                    <div className="session-delete-confirm-actions">
                      <button
                        type="button"
                        className="text-btn session-delete-btn"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          runDelete(session);
                        }}
                        disabled={busy !== null}
                        aria-busy={rowBusy}
                        aria-label={`Confirm delete ${label}`}
                      >
                        Delete session
                      </button>
                      <button
                        type="button"
                        className="text-btn"
                        ref={(el) => {
                          if (el) cancelButtonRefs.current.set(session.sessionId, el);
                          else cancelButtonRefs.current.delete(session.sessionId);
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleCancelDelete(session);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {deleteError !== null && deleteError.sessionId === session.sessionId ? (
                  <p className="session-delete-error" role="alert">
                    {deleteError.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {showLoading ? <p className="sidebar-hint">Loading sessions…</p> : null}
        {showError ? <p className="sidebar-hint">Sessions unavailable. Read-only shell remains usable.</p> : null}
        {showEmpty ? <p className="sidebar-hint">No sessions</p> : null}
        {!canBrowseSessions ? <p className="sidebar-hint">Session history unavailable until the runtime connects.</p> : null}
      </div>
    </aside>
  );
}
