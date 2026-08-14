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
   * still be rejected authoritatively by the server with a fixed 409.
   */
  liveSessionId?: string | null;
  /**
   * D4 delete-navigation callback. AppShell is the single navigation owner:
   * it clears only the `session` search param (preserving `cwd`) when the
   * deleted session equals the URL-selected session. Non-selected deletions
   * never navigate.
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

/** Fixed warning copy for the row-local irreversible confirmation. */
const DELETE_WARNING = "Deleting this session is permanent and cannot be undone.";

export function Sidebar({ open, search, liveSessionId = null, onSessionDeleted }: SidebarProps) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { canBrowseSessions, canDeleteSessions } = useCapabilities();
  // The session list is only requested when the host actually serves it
  // (sessiond connected). M1 wires no session catalog, so this stays disabled
  // and avoids an unconditional 404 against the unimplemented /v1/sessions.
  const sessions = useQuery({ ...createQueryOptions(http).sessions.list(search.cwd), enabled: canBrowseSessions });
  // D4 delete mutation: existing `remove` option owns the standard list+byId
  // invalidation; the UI adds only gated navigation/error handling on top.
  const removeMutation = useMutation(createMutationOptions(http, queryClient).sessions.remove());

  // D4 row-local delete state: one confirmation + one delete at a time.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ sessionId: string; message: string } | null>(null);

  // Identity for race-safe late settles: mount generation + capability gate,
  // read from refs so an in-flight async continuation observes the LATEST view.
  const mountedRef = useRef(true);
  const requestGenRef = useRef(0);
  const canDeleteRef = useRef(canDeleteSessions);
  // Synchronous singleflight: React state updates are async, so a second click
  // in the same tick cannot see `busy`/isPending yet. This ref guarantees exactly
  // one in-flight delete across the whole list.
  const busyRef = useRef<string | null>(null);
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

  // Capability revoke / cwd switch / URL session selection change: keep the
  // gate ref current and drop all pending delete UI so stale state can never
  // leak into the new context. A later re-grant does NOT resurrect it.
  useLayoutEffect(() => {
    canDeleteRef.current = canDeleteSessions;
    requestGenRef.current += 1;
    busyRef.current = null;
    setBusy(null);
    setConfirmId(null);
    setDeleteError(null);
  }, [search.cwd, search.session, canDeleteSessions]);

  // Default/returned focus favors Cancel (safe escape) when a row-local
  // confirmation appears.
  useLayoutEffect(() => {
    if (confirmId === null) return;
    cancelButtonRefs.current.get(confirmId)?.focus();
  }, [confirmId]);

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

  /** Identity guard uses only refs — a late settle must fail closed. */
  const isCurrentRequest = (gen: number): boolean =>
    mountedRef.current && gen === requestGenRef.current && canDeleteRef.current;

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
        // (a newer delete may have taken over after a cap/cwd/selection change).
        if (busyRef.current === id) busyRef.current = null;
        if (isCurrentRequest(gen)) setBusy(null);
      });
  };

  const handleCancelDelete = (session: SessionHeader): void => {
    restoreFocusRef.current = session.sessionId;
    setConfirmId(null);
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
