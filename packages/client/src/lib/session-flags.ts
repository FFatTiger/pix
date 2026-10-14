import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { createSessionsApi } from "@/api/sessions";
import { createMutationOptions } from "@/api/mutations";
import { useHttpClient } from "@/app/http-context";
import { CapabilityContext } from "@/features/capability/CapabilityProvider";

/**
 * Server-backed session pin/archive flags (round 5).
 *
 * Truth: `pinned`/`archived` on the session header (durable JSONL
 * `pix-session-flags` entry via PATCH /v1/sessions/:id). This module derives
 * the flag sets from the cached session pages and writes through the API with
 * an optimistic cache patch that rolls back (and surfaces an error) on
 * failure. Multi-device sync rides the sessions_changed WS push: AppShell
 * invalidates the list queries, and the next read here reflects the server.
 */

interface ListPageShape {
  sessions?: SessionHeader[];
}

function* cachedPages(queryClient: ReturnType<typeof useQueryClient>): Generator<{ key: readonly unknown[]; page: ListPageShape | undefined }> {
  for (const query of queryClient.getQueriesData<ListPageShape>({ queryKey: ["pix", "sessions", "page"] })) {
    yield { key: query[0], page: query[1] };
  }
}

type FlagPatch = { pinned?: boolean; archived?: boolean };

/** Snapshot/restore helper for optimistic rollback. */
interface CacheSnapshot {
  key: readonly unknown[];
  page: ListPageShape | undefined;
}

function applyFlagToPages(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  patch: FlagPatch,
): CacheSnapshot[] {
  const snapshots: CacheSnapshot[] = [];
  for (const { key, page } of cachedPages(queryClient)) {
    if (page === undefined || page.sessions === undefined) continue;
    if (!page.sessions.some((row) => row.sessionId === sessionId)) continue;
    snapshots.push({ key, page });
    queryClient.setQueryData(key, {
      ...page,
      sessions: page.sessions.map((row) => row.sessionId === sessionId ? { ...row, ...patch } : row),
    });
  }
  return snapshots;
}

export interface SessionFlagsState {
  pinnedSessions: string[];
  archivedSessions: string[];
}

export function useSessionFlags(): SessionFlagsState & {
  setSessionFlags: (sessionId: string, patch: FlagPatch) => void;
  flagError: string | null;
} {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  // Optional capability context: preference-sync trees mount this hook without
  // a provider; reads still work, writes fail with the honest unavailable copy.
  const capabilityCtx = useContext(CapabilityContext);
  const can = capabilityCtx?.can ?? (() => false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const inflight = useRef(0);

  const save = useMutation(createMutationOptions(http, queryClient).sessions.setFlags());

  const derive = useCallback((): SessionFlagsState => {
    const pinned: string[] = [];
    const archived: string[] = [];
    for (const { page } of cachedPages(queryClient)) {
      for (const row of page?.sessions ?? []) {
        if (row.pinned === true) pinned.push(row.sessionId);
        if (row.archived === true) archived.push(row.sessionId);
      }
    }
    return {
      pinnedSessions: [...new Set(pinned)],
      archivedSessions: [...new Set(archived)],
    };
  }, [queryClient]);

  // Reactive: re-derive on every session-page cache write (optimistic patch,
  // invalidation refetch, sessions_changed-driven refetch).
  const [derived, setDerived] = useState<SessionFlagsState>(derive);
  useEffect(() => {
    setDerived(derive());
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" || event.type === "removed" || event.type === "added") {
        if (event.query.queryKey[0] === "pix" && event.query.queryKey[1] === "sessions") {
          setDerived(derive());
        }
      }
    });
  }, [derive, queryClient]);

  const setSessionFlags = useCallback((sessionId: string, patch: FlagPatch) => {
    if (!can("session.write")) {
      setFlagError("desktop.sessionFlagsUnavailable");
      return;
    }
    setFlagError(null);
    inflight.current += 1;
    const snapshots = applyFlagToPages(queryClient, sessionId, patch);
    save.mutate({ id: sessionId, flags: patch }, {
      onSuccess: () => {
        inflight.current -= 1;
        if (inflight.current === 0) setFlagError(null);
      },
      onError: () => {
        // Roll back every touched page to its pre-patch snapshot.
        for (const snapshot of snapshots) queryClient.setQueryData(snapshot.key, snapshot.page);
        inflight.current -= 1;
        setFlagError("desktop.sessionFlagsSaveFailed");
      },
    });
  }, [can, queryClient, save]);

  return { ...derived, setSessionFlags, flagError };
}

/**
 * One-time localStorage → server migration (round 5). Uploads legacy local
 * pinned/archived SESSION ids additively: a flag the server already carries
 * stays as the server has it (server wins); only unset flags are set. On
 * success the legacy session arrays are stripped from the local key so this
 * never runs twice. Project arrays are untouched (projects stay local).
 */
export interface SessionFlagsMigrationDeps {
  setFlags: (id: string, flags: Record<string, boolean>) => Promise<unknown>;
  listSessions: (signal?: AbortSignal) => Promise<readonly { sessionId: string; pinned?: boolean; archived?: boolean }[]>;
}

export async function migrateLocalSessionFlagsToServer(deps: SessionFlagsMigrationDeps): Promise<void> {
  if (typeof window === "undefined") return;
  const STORAGE_KEY = "pi-sidebar-item-state";
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const localPinned = Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions.filter((id): id is string => typeof id === "string") : [];
  const localArchived = Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions.filter((id): id is string => typeof id === "string") : [];
  if (localPinned.length === 0 && localArchived.length === 0) return;

  const rows = await deps.listSessions().catch(() => null);
  if (rows !== null) {
    for (const id of localPinned) {
      const row = rows.find((candidate) => candidate.sessionId === id);
      if (row === undefined || row.pinned === true) continue; // unknown id or server already set: server wins
      await deps.setFlags(id, { pinned: true }).catch(() => undefined);
    }
    for (const id of localArchived) {
      const row = rows.find((candidate) => candidate.sessionId === id);
      if (row === undefined || row.archived === true) continue;
      await deps.setFlags(id, { archived: true }).catch(() => undefined);
    }
  }
  // Strip the migrated arrays (keep projects/expanded). Even on partial
  // upload failure the local session lists are abandoned: the server is the
  // authority now, and a retry would race with the user's own changes.
  const next: Record<string, unknown> = { ...parsed };
  delete next.pinnedSessions;
  delete next.archivedSessions;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("pi-sidebar-item-state-change"));
  } catch {
    // Preference write failures stay silent.
  }
}

/** Migration deps over the typed transport (AppShell wiring). */
export function sessionFlagsMigrationDeps(
  http: ReturnType<typeof useHttpClient>,
  listSessions: (signal?: AbortSignal) => Promise<readonly { sessionId: string; pinned?: boolean; archived?: boolean }[]>,
): SessionFlagsMigrationDeps {
  return {
    setFlags: (id, flags) => createSessionsApi(http).setFlags(id, flags),
    listSessions,
  };
}
