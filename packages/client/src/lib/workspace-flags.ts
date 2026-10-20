import { useCallback, useContext, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMutationOptions } from "@/api/mutations";
import { WorkspaceFlagsDocumentSchema } from "@/api/schemas";
import { useHttpClient } from "@/app/http-context";
import { CapabilityContext } from "@/features/capability/CapabilityProvider";

/**
 * Unified organization-state hook (round 5 redo).
 *
 * Single source: sessiond-owned workspace state (`GET /v1/workspace-flags`,
 * revision + sessions/projects flag maps). Writes go through
 * `PATCH /v1/workspace-flags` with an optimistic local patch of the flags
 * query cache and a snapshot rollback + honest error on failure. Multi-device
 * sync rides the sessions_changed WS push: AppShell invalidates this query on
 * every bump, so another device's change refetches without user action.
 *
 * Device-local UI state (project expand/collapse) stays out of this module —
 * see sidebar-item-state.
 */

export const WORKSPACE_FLAGS_QUERY_KEY = ["pix", "workspace-flags"] as const;

export interface WorkspaceFlagsMaps {
  readonly revision: number;
  readonly sessions: Readonly<Record<string, { pinned?: boolean | undefined; archived?: boolean | undefined }>>;
  readonly projects: Readonly<Record<string, { pinned?: boolean | undefined; archived?: boolean | undefined }>>;
}

interface WorkspaceFlagsDocument extends WorkspaceFlagsMaps {}

const EMPTY: WorkspaceFlagsMaps = { revision: 0, sessions: {}, projects: {} };

export type WorkspaceFlagKind = "session" | "project";

export interface WorkspaceFlagsState {
  pinnedSessions: string[];
  archivedSessions: string[];
  pinnedProjects: string[];
  archivedProjects: string[];
}

function derive(maps: WorkspaceFlagsMaps): WorkspaceFlagsState {
  const pinnedSessions: string[] = [];
  const archivedSessions: string[] = [];
  for (const [key, flags] of Object.entries(maps.sessions)) {
    if (flags.pinned === true) pinnedSessions.push(key);
    if (flags.archived === true) archivedSessions.push(key);
  }
  const pinnedProjects: string[] = [];
  const archivedProjects: string[] = [];
  for (const [key, flags] of Object.entries(maps.projects)) {
    if (flags.pinned === true) pinnedProjects.push(key);
    if (flags.archived === true) archivedProjects.push(key);
  }
  return { pinnedSessions, archivedSessions, pinnedProjects, archivedProjects };
}

export function useWorkspaceFlags(): WorkspaceFlagsState & {
  setSessionFlags: (sessionId: string, patch: { pinned?: boolean; archived?: boolean }) => void;
  setProjectFlags: (projectRoot: string, patch: { pinned?: boolean; archived?: boolean }) => void;
  flagError: string | null;
  flagsLoaded: boolean;
} {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const capabilityCtx = useContext(CapabilityContext);
  const can = capabilityCtx?.can ?? (() => false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const inflight = useRef(0);

  const query = useQuery({
    queryKey: WORKSPACE_FLAGS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<WorkspaceFlagsDocument> =>
      http.get("/v1/workspace-flags", { schema: WorkspaceFlagsDocumentSchema, ...(signal === undefined ? {} : { signal }) }),
    staleTime: 30_000,
    retry: false,
  });

  const save = useMutation({
    ...createMutationOptions(http, queryClient).workspace.setFlags(),
  });

  const write = useCallback((kind: WorkspaceFlagKind, key: string, patch: { pinned?: boolean; archived?: boolean }, optimisticErrorKey: string) => {
    if (!can("session.write")) {
      setFlagError("desktop.workspaceFlagsUnavailable");
      return;
    }
    setFlagError(null);
    inflight.current += 1;
    const snapshot = queryClient.getQueryData<WorkspaceFlagsDocument>(WORKSPACE_FLAGS_QUERY_KEY);
    // Optimistic: patch the flags document so every consumer updates now.
    queryClient.setQueryData(WORKSPACE_FLAGS_QUERY_KEY, (current: WorkspaceFlagsDocument | undefined): WorkspaceFlagsDocument => {
      const base = current ?? EMPTY;
      const map = kind === "session" ? base.sessions : base.projects;
      return {
        ...base,
        revision: base.revision + 1,
        [kind === "session" ? "sessions" : "projects"]: {
          ...map,
          [key]: { ...(map[key] ?? {}), ...patch },
        },
      } as WorkspaceFlagsDocument;
    });
    save.mutate({ kind, key, flags: patch }, {
      onSuccess: () => {
        inflight.current -= 1;
        if (inflight.current === 0) setFlagError(null);
      },
      onError: () => {
        // Roll back to the pre-patch snapshot (never a fake success).
        if (snapshot !== undefined) queryClient.setQueryData(WORKSPACE_FLAGS_QUERY_KEY, snapshot);
        inflight.current -= 1;
        setFlagError(optimisticErrorKey);
      },
    });
  }, [can, queryClient, save]);

  const state = derive(query.data ?? EMPTY);

  const setSessionFlags = useCallback((sessionId: string, patch: { pinned?: boolean; archived?: boolean }) => {
    write("session", sessionId, patch, "desktop.workspaceFlagsSaveFailed");
  }, [write]);
  const setProjectFlags = useCallback((projectRoot: string, patch: { pinned?: boolean; archived?: boolean }) => {
    write("project", projectRoot, patch, "desktop.workspaceFlagsSaveFailed");
  }, [write]);

  return { ...state, setSessionFlags, setProjectFlags, flagError, flagsLoaded: query.isSuccess };
}

/**
 * One-time localStorage → server migration (round 5 redo): uploads legacy
 * session AND project pin/archive prefs additively (a flag the server already
 * carries stays as the server has it), then strips the migrated arrays from
 * the local key. Device-local project EXPANSION is untouched.
 */
export interface WorkspaceFlagsMigrationDeps {
  setFlags: (kind: WorkspaceFlagKind, key: string, flags: Record<string, boolean>) => Promise<unknown>;
  getWorkspaceFlags: () => Promise<WorkspaceFlagsMaps>;
}

export async function migrateLocalOrganizationPrefsToServer(deps: WorkspaceFlagsMigrationDeps): Promise<void> {
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
  const localPinnedSessions = Array.isArray(parsed.pinnedSessions) ? parsed.pinnedSessions.filter((id): id is string => typeof id === "string") : [];
  const localArchivedSessions = Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions.filter((id): id is string => typeof id === "string") : [];
  const localPinnedProjects = Array.isArray(parsed.pinnedProjects) ? parsed.pinnedProjects.filter((id): id is string => typeof id === "string") : [];
  const localArchivedProjects = Array.isArray(parsed.archivedProjects) ? parsed.archivedProjects.filter((id): id is string => typeof id === "string") : [];
  if (localPinnedSessions.length === 0 && localArchivedSessions.length === 0
    && localPinnedProjects.length === 0 && localArchivedProjects.length === 0) return;

  const server = await deps.getWorkspaceFlags().catch(() => null);
  if (server !== null) {
    const uploads: Array<[WorkspaceFlagKind, string, Record<string, boolean>]> = [];
    for (const id of localPinnedSessions) {
      if (server.sessions[id]?.pinned === true) continue; // server wins
      uploads.push(["session", id, { pinned: true }]);
    }
    for (const id of localArchivedSessions) {
      if (server.sessions[id]?.archived === true) continue;
      uploads.push(["session", id, { archived: true }]);
    }
    for (const root of localPinnedProjects) {
      if (server.projects[root]?.pinned === true) continue;
      uploads.push(["project", root, { pinned: true }]);
    }
    for (const root of localArchivedProjects) {
      if (server.projects[root]?.archived === true) continue;
      uploads.push(["project", root, { archived: true }]);
    }
    for (const [kind, key, flags] of uploads) {
      await deps.setFlags(kind, key, flags).catch(() => undefined);
    }
  }
  // Strip the migrated arrays even on partial failure: the server is the
  // authority now; a retry would race with the user's own changes.
  const next: Record<string, unknown> = { ...parsed };
  delete next.pinnedSessions;
  delete next.archivedSessions;
  delete next.pinnedProjects;
  delete next.archivedProjects;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("pi-sidebar-item-state-change"));
  } catch {
    // Preference write failures stay silent.
  }
}
