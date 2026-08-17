import type { QueryClient } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createGateApi, type GateLoginInput } from "./gate";
import { createResourcesApi, type UploadInput } from "./resources";
import { createSessionsApi } from "./sessions";
import { createConfigurationApi } from "./configuration";
import { queryKeys } from "./query-keys";

async function invalidate(queryClient: QueryClient, ...keys: readonly (readonly unknown[])[]) {
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/**
 * Post-upload invalidation: an upload can rewrite any directory, the search
 * index, git status, git diffs and the read/meta state of open viewer tabs, so
 * the whole files + git domains refresh from the one remote-state authority.
 * Shared by the upload mutation and the explorer's progress-capable transport.
 */
export async function invalidateFileWorkspace(queryClient: QueryClient): Promise<void> {
  await invalidate(queryClient, queryKeys.files.all, queryKeys.git.all);
}

function isQueryKeyPrefix(key: readonly unknown[], prefix: readonly unknown[]): boolean {
  return key.length >= prefix.length && prefix.every((part, index) => key[index] === part);
}

/**
 * D4 rename success cache primer: immediately update the already-cached session
 * list/detail titles for the renamed session (exact session id, current query
 * scopes only) BEFORE the mutation invalidates + refetches. This closes the
 * visual rollback window where a stale catalog read (server-side list cache
 * TTL / in-flight GET) could momentarily show the old title over the new one.
 *
 * Only the `title` field is written — path/id/timestamps/counts are preserved,
 * never synthesized. Un-cached scopes are skipped; the subsequent invalidation
 * covers them.
 */
function primeSessionTitle(queryClient: QueryClient, id: string, title: string): void {
  const listPrefix = queryKeys.sessions.lists;
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    if (isQueryKeyPrefix(key, listPrefix)) {
      const data = query.state.data as { sessions?: ReadonlyArray<{ sessionId: string; title?: string }> } | undefined;
      if (data && Array.isArray(data.sessions)) {
        const sessions = data.sessions.map((session) =>
          session.sessionId === id ? { ...session, title } : session,
        );
        queryClient.setQueryData(key, { ...data, sessions });
      }
      continue;
    }
    // Exact detail scope for this id: ["pix", "sessions", "session", id, "detail"].
    if (
      key.length === 5 &&
      key[0] === "pix" &&
      key[1] === "sessions" &&
      key[2] === "session" &&
      key[3] === id &&
      key[4] === "detail"
    ) {
      const data = query.state.data as { session?: { sessionId: string; title?: string } } | undefined;
      if (data && data.session && data.session.sessionId === id) {
        queryClient.setQueryData(key, { ...data, session: { ...data.session, title } });
      }
    }
  }
}

/**
 * Mutation options. D3B catalog domains (models / skills / plugins / auth
 * provider mutations) are intentionally absent — Host does not mount those
 * routes and Client must not offer a callable surface for them. The ONE
 * mounted catalog mutation is trust set-trusted (POST /v1/trust, gated by the
 * `project.trust` capability at the call site).
 *
 * Gate login/logout and non-catalog workspace mutations remain.
 */
export function createMutationOptions(http: HttpClient, queryClient: QueryClient) {
  const gate = createGateApi(http);
  const resources = createResourcesApi(http);
  const sessions = createSessionsApi(http);
  const configuration = createConfigurationApi(http);
  return {
    sessions: {
      // D4 rename: prime the cached list/detail titles for the exact session id
      // across current query scopes FIRST, then invalidate the relevant
      // list/detail so a stale refetch can never visually roll the title back.
      rename: () => ({
        mutationKey: ["pix", "sessions", "rename"] as const,
        mutationFn: (input: { id: string; name: string }) => sessions.rename(input.id, input.name),
        onSuccess: (_data: unknown, input: { id: string; name: string }) => {
          primeSessionTitle(queryClient, input.id, input.name);
          return invalidate(queryClient, queryKeys.sessions.lists, queryKeys.sessions.byId(input.id));
        },
      }),
      remove: () => ({ mutationKey: ["pix", "sessions", "remove"] as const, mutationFn: (id: string) => sessions.remove(id), onSuccess: (_data: unknown, id: string) => invalidate(queryClient, queryKeys.sessions.lists, queryKeys.sessions.byId(id)) }),
      autoName: () => ({ mutationKey: ["pix", "sessions", "auto-name"] as const, mutationFn: (id: string) => sessions.autoName(id), onSuccess: (_data: unknown, id: string) => invalidate(queryClient, queryKeys.sessions.lists, queryKeys.sessions.byId(id)) }),
    },
    gate: {
      login: () => ({ mutationKey: ["pix", "gate", "login"] as const, mutationFn: (input: GateLoginInput) => gate.login(input), onSuccess: () => invalidate(queryClient, queryKeys.gate.all, queryKeys.capabilities.all) }),
      logout: () => ({ mutationKey: ["pix", "gate", "logout"] as const, mutationFn: () => gate.logout(), onSuccess: () => invalidate(queryClient, queryKeys.gate.all, queryKeys.capabilities.all) }),
    },
    files: {
      upload: () => ({ mutationKey: ["pix", "files", "upload"] as const, mutationFn: (input: UploadInput) => resources.files.upload(input), onSuccess: () => invalidateFileWorkspace(queryClient) }),
    },
    cwd: {
      validate: () => ({ mutationKey: ["pix", "cwd", "validate"] as const, mutationFn: (cwd: string) => resources.cwd.validate(cwd), onSuccess: () => invalidate(queryClient, queryKeys.cwd.all) }),
      createDefault: () => ({ mutationKey: ["pix", "cwd", "default"] as const, mutationFn: () => resources.cwd.createDefault(), onSuccess: () => invalidate(queryClient, queryKeys.cwd.all) }),
    },
    worktrees: {
      create: () => ({ mutationKey: ["pix", "worktrees", "create"] as const, mutationFn: (input: { cwd: string; branch: string }) => resources.worktrees.create(input), onSuccess: (_data: unknown, input: { cwd: string }) => invalidate(queryClient, queryKeys.worktrees.list(input.cwd), queryKeys.cwd.roots()) }),
      remove: () => ({ mutationKey: ["pix", "worktrees", "remove"] as const, mutationFn: (input: { cwd: string; path: string; force?: boolean }) => resources.worktrees.remove(input), onSuccess: (_data: unknown, input: { cwd: string }) => invalidate(queryClient, queryKeys.worktrees.list(input.cwd), queryKeys.cwd.roots()) }),
    },
    trust: {
      /**
       * Set-project-trusted (D3B trust-mutation slice). A trust flip changes
       * every project-scoped trust-gated catalog, so success invalidates the
       * trust summary PLUS skills/plugins/commands (resource seam, gated by
       * trust) and ALL theme queries (project themes become readable — the
       * theme list key carries no cwd, so the whole domain is invalidated).
       */
      setTrusted: () => ({
        mutationKey: ["pix", "trust", "set-trusted"] as const,
        mutationFn: (input: { cwd: string }) => configuration.trust.setTrusted(input.cwd),
        onSuccess: (_data: unknown, input: { cwd: string }) =>
          invalidate(
            queryClient,
            queryKeys.trust.get(input.cwd),
            queryKeys.skills.list(input.cwd),
            queryKeys.plugins.list(input.cwd),
            queryKeys.commands.list(input.cwd),
            queryKeys.themes.all,
          ),
      }),
    },
  };
}
