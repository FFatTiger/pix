import type { QueryClient } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createConfigurationApi } from "./configuration";
import { createGateApi, type GateLoginInput } from "./gate";
import { createModelsApi } from "./models";
import { createResourcesApi, type UploadInput } from "./resources";
import { createSessionsApi } from "./sessions";
import { queryKeys } from "./query-keys";

async function invalidate(queryClient: QueryClient, ...keys: readonly (readonly unknown[])[]) {
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export function createMutationOptions(http: HttpClient, queryClient: QueryClient) {
  const gate = createGateApi(http);
  const models = createModelsApi(http);
  const resources = createResourcesApi(http);
  const configuration = createConfigurationApi(http);
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
    models: {
      saveConfig: () => ({ mutationKey: ["pix", "models", "save-config"] as const, mutationFn: (input: Record<string, unknown>) => models.saveConfig(input), onSuccess: () => invalidate(queryClient, queryKeys.models.all) }),
      discover: () => ({ mutationKey: ["pix", "models", "discover"] as const, mutationFn: (input: Record<string, unknown>) => models.discover(input) }),
      test: () => ({ mutationKey: ["pix", "models", "test"] as const, mutationFn: (input: Record<string, unknown>) => models.test(input) }),
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
    skills: {
      install: () => ({ mutationKey: ["pix", "skills", "install"] as const, mutationFn: (input: Record<string, unknown>) => configuration.skills.install(input), onSuccess: () => invalidate(queryClient, queryKeys.skills.all) }),
      update: () => ({ mutationKey: ["pix", "skills", "update"] as const, mutationFn: (input: Record<string, unknown>) => configuration.skills.update(input), onSuccess: () => invalidate(queryClient, queryKeys.skills.all) }),
      toggle: () => ({ mutationKey: ["pix", "skills", "toggle"] as const, mutationFn: (input: { name: string; enabled: boolean; cwd?: string }) => configuration.skills.toggle(input), onSuccess: () => invalidate(queryClient, queryKeys.skills.all) }),
    },
    plugins: {
      mutate: () => ({ mutationKey: ["pix", "plugins", "mutate"] as const, mutationFn: (input: Record<string, unknown>) => configuration.plugins.mutate(input), onSuccess: () => invalidate(queryClient, queryKeys.plugins.all) }),
    },
    auth: {
      apiKey: () => ({ mutationKey: ["pix", "auth", "api-key"] as const, mutationFn: (input: { provider: string; apiKey: string }) => configuration.auth.apiKey(input.provider, input.apiKey), onSuccess: () => invalidate(queryClient, queryKeys.auth.statuses(), queryKeys.models.lists) }),
      startLogin: () => ({ mutationKey: ["pix", "auth", "start"] as const, mutationFn: (provider: string) => configuration.auth.startLogin(provider) }),
      finishLogin: () => ({ mutationKey: ["pix", "auth", "finish"] as const, mutationFn: (input: { provider: string; code: string }) => configuration.auth.finishLogin(input.provider, input.code), onSuccess: () => invalidate(queryClient, queryKeys.auth.statuses(), queryKeys.models.lists) }),
      logout: () => ({ mutationKey: ["pix", "auth", "logout"] as const, mutationFn: (provider: string) => configuration.auth.logout(provider), onSuccess: () => invalidate(queryClient, queryKeys.auth.statuses(), queryKeys.models.lists) }),
    },
  };
}
