import type { QueryClient } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createGateApi, type GateLoginInput } from "./gate";
import { createResourcesApi, type UploadInput } from "./resources";
import { createSessionsApi } from "./sessions";
import { queryKeys } from "./query-keys";

async function invalidate(queryClient: QueryClient, ...keys: readonly (readonly unknown[])[]) {
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/**
 * Mutation options. D3B catalog domains (models / skills / plugins / auth
 * provider mutations) are intentionally absent — Host does not mount those
 * routes and Client must not offer a callable surface for them.
 *
 * Gate login/logout and non-catalog workspace mutations remain.
 */
export function createMutationOptions(http: HttpClient, queryClient: QueryClient) {
  const gate = createGateApi(http);
  const resources = createResourcesApi(http);
  const sessions = createSessionsApi(http);
  return {
    sessions: {
      rename: () => ({ mutationKey: ["pix", "sessions", "rename"] as const, mutationFn: (input: { id: string; name: string }) => sessions.rename(input.id, input.name), onSuccess: (_data: unknown, input: { id: string }) => invalidate(queryClient, queryKeys.sessions.lists, queryKeys.sessions.byId(input.id)) }),
      remove: () => ({ mutationKey: ["pix", "sessions", "remove"] as const, mutationFn: (id: string) => sessions.remove(id), onSuccess: (_data: unknown, id: string) => invalidate(queryClient, queryKeys.sessions.lists, queryKeys.sessions.byId(id)) }),
      autoName: () => ({ mutationKey: ["pix", "sessions", "auto-name"] as const, mutationFn: (id: string) => sessions.autoName(id), onSuccess: (_data: unknown, id: string) => invalidate(queryClient, queryKeys.sessions.lists, queryKeys.sessions.byId(id)) }),
    },
    gate: {
      login: () => ({ mutationKey: ["pix", "gate", "login"] as const, mutationFn: (input: GateLoginInput) => gate.login(input), onSuccess: () => invalidate(queryClient, queryKeys.gate.all, queryKeys.capabilities.all) }),
      logout: () => ({ mutationKey: ["pix", "gate", "logout"] as const, mutationFn: () => gate.logout(), onSuccess: () => invalidate(queryClient, queryKeys.gate.all, queryKeys.capabilities.all) }),
    },
    files: {
      upload: () => ({ mutationKey: ["pix", "files", "upload"] as const, mutationFn: (input: UploadInput) => resources.files.upload(input), onSuccess: (_data: unknown, input: UploadInput) => invalidate(queryClient, queryKeys.files.list(input.directory), queryKeys.files.indexRoot(input.directory), queryKeys.git.status(input.directory)) }),
    },
    cwd: {
      validate: () => ({ mutationKey: ["pix", "cwd", "validate"] as const, mutationFn: (cwd: string) => resources.cwd.validate(cwd), onSuccess: () => invalidate(queryClient, queryKeys.cwd.all) }),
      createDefault: () => ({ mutationKey: ["pix", "cwd", "default"] as const, mutationFn: () => resources.cwd.createDefault(), onSuccess: () => invalidate(queryClient, queryKeys.cwd.all) }),
    },
    worktrees: {
      create: () => ({ mutationKey: ["pix", "worktrees", "create"] as const, mutationFn: (input: { cwd: string; branch: string }) => resources.worktrees.create(input), onSuccess: (_data: unknown, input: { cwd: string }) => invalidate(queryClient, queryKeys.worktrees.list(input.cwd), queryKeys.cwd.roots()) }),
      remove: () => ({ mutationKey: ["pix", "worktrees", "remove"] as const, mutationFn: (input: { cwd: string; path: string; force?: boolean }) => resources.worktrees.remove(input), onSuccess: (_data: unknown, input: { cwd: string }) => invalidate(queryClient, queryKeys.worktrees.list(input.cwd), queryKeys.cwd.roots()) }),
    },
  };
}
