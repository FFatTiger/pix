import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createGateApi } from "./gate";
import { createModelsApi } from "./models";
import { createResourcesApi } from "./resources";
import { createSessionsApi } from "./sessions";
import { createConfigurationApi } from "./configuration";
import { BootstrapResponseSchema, CapabilitiesResponseSchema, HealthResponseSchema } from "./schemas";
import { urls } from "./urls";

export const queryKeys = {
  root: ["pi-web"] as const,
  gate: { all: ["pi-web", "gate"] as const, status: () => ["pi-web", "gate", "status"] as const },
  capabilities: { all: ["pi-web", "capabilities"] as const, host: () => ["pi-web", "capabilities", "host"] as const, health: () => ["pi-web", "capabilities", "health"] as const, bootstrap: () => ["pi-web", "bootstrap"] as const },
  sessions: {
    all: ["pi-web", "sessions"] as const,
    lists: ["pi-web", "sessions", "list"] as const,
    list: (cwd?: string) => ["pi-web", "sessions", "list", cwd ?? null] as const,
    byId: (id: string) => ["pi-web", "sessions", "session", id] as const,
    detail: (id: string) => ["pi-web", "sessions", "session", id, "detail"] as const,
    context: (id: string) => ["pi-web", "sessions", "session", id, "context"] as const,
    thinking: (id: string, entryId: string) => ["pi-web", "sessions", "session", id, "thinking", entryId] as const,
    bash: (id: string, entryId: string) => ["pi-web", "sessions", "session", id, "bash", entryId] as const,
  },
  models: { all: ["pi-web", "models"] as const, lists: ["pi-web", "models", "list"] as const, list: (cwd?: string) => ["pi-web", "models", "list", cwd ?? null] as const, config: () => ["pi-web", "models", "config"] as const, catalog: (input?: object) => ["pi-web", "models", "catalog", input ?? {}] as const },
  files: { all: ["pi-web", "files"] as const, list: (path: string) => ["pi-web", "files", "list", path] as const, meta: (path: string) => ["pi-web", "files", "meta", path] as const, read: (path: string) => ["pi-web", "files", "read", path] as const, indexRoot: (cwd: string) => ["pi-web", "files", "index", cwd] as const, index: (cwd: string, q?: string) => ["pi-web", "files", "index", cwd, q ?? ""] as const },
  git: { all: ["pi-web", "git"] as const, status: (cwd: string) => ["pi-web", "git", "status", cwd] as const, diff: (cwd: string, path: string) => ["pi-web", "git", "diff", cwd, path] as const },
  cwd: { all: ["pi-web", "cwd"] as const, browse: (path?: string) => ["pi-web", "cwd", "browse", path ?? null] as const, roots: () => ["pi-web", "cwd", "roots"] as const },
  worktrees: { all: ["pi-web", "worktrees"] as const, list: (cwd: string) => ["pi-web", "worktrees", "list", cwd] as const },
  skills: { all: ["pi-web", "skills"] as const, list: (cwd?: string) => ["pi-web", "skills", "list", cwd ?? null] as const, search: (q: string) => ["pi-web", "skills", "search", q] as const },
  plugins: { all: ["pi-web", "plugins"] as const, list: (cwd?: string) => ["pi-web", "plugins", "list", cwd ?? null] as const },
  auth: { all: ["pi-web", "auth"] as const, providers: () => ["pi-web", "auth", "providers"] as const, statuses: () => ["pi-web", "auth", "statuses"] as const },
} as const;

export function createQueryOptions(http: HttpClient) {
  const gate = createGateApi(http);
  const sessions = createSessionsApi(http);
  const models = createModelsApi(http);
  const resources = createResourcesApi(http);
  const configuration = createConfigurationApi(http);
  return {
    gate: { status: () => queryOptions({ queryKey: queryKeys.gate.status(), queryFn: ({ signal }) => gate.status(signal), staleTime: 30_000, retry: false }) },
    capabilities: {
      host: () => queryOptions({ queryKey: queryKeys.capabilities.host(), queryFn: ({ signal }) => http.get(urls.capabilities(), { schema: CapabilitiesResponseSchema, signal }), staleTime: 15_000, retry: false }),
      health: () => queryOptions({ queryKey: queryKeys.capabilities.health(), queryFn: ({ signal }) => http.get(urls.health(), { schema: HealthResponseSchema, signal }), staleTime: 15_000, retry: false }),
      bootstrap: () => queryOptions({ queryKey: queryKeys.capabilities.bootstrap(), queryFn: ({ signal }) => http.get(urls.bootstrap(), { schema: BootstrapResponseSchema, signal }), staleTime: 15_000, retry: false }),
    },
    sessions: {
      list: (cwd?: string) => queryOptions({ queryKey: queryKeys.sessions.list(cwd), queryFn: ({ signal }) => sessions.list({ ...(cwd === undefined ? {} : { cwd }), signal }) }),
      detail: (id: string) => queryOptions({ queryKey: queryKeys.sessions.detail(id), queryFn: ({ signal }) => sessions.detail(id, signal), enabled: Boolean(id) }),
      context: (id: string) => queryOptions({ queryKey: queryKeys.sessions.context(id), queryFn: ({ signal }) => sessions.context(id, signal), enabled: Boolean(id) }),
      thinking: (id: string, entryId: string) => queryOptions({ queryKey: queryKeys.sessions.thinking(id, entryId), queryFn: ({ signal }) => sessions.thinking(id, entryId, signal), enabled: Boolean(id && entryId) }),
      bash: (id: string, entryId: string) => queryOptions({ queryKey: queryKeys.sessions.bash(id, entryId), queryFn: ({ signal }) => sessions.bashOutput(id, entryId, signal), enabled: Boolean(id && entryId) }),
    },
    models: {
      list: (cwd?: string) => queryOptions({ queryKey: queryKeys.models.list(cwd), queryFn: ({ signal }) => models.list(cwd, signal) }),
      config: () => queryOptions({ queryKey: queryKeys.models.config(), queryFn: ({ signal }) => models.config(signal) }),
      catalog: (input?: { q?: string; provider?: string; baseUrl?: string; limit?: number }) => queryOptions({ queryKey: queryKeys.models.catalog(input), queryFn: ({ signal }) => models.catalog({ ...input, signal }) }),
    },
    files: {
      list: (path: string) => queryOptions({ queryKey: queryKeys.files.list(path), queryFn: ({ signal }) => resources.files.list(path, signal), enabled: Boolean(path) }),
      meta: (path: string) => queryOptions({ queryKey: queryKeys.files.meta(path), queryFn: ({ signal }) => resources.files.meta(path, signal), enabled: Boolean(path) }),
      read: (path: string) => queryOptions({ queryKey: queryKeys.files.read(path), queryFn: ({ signal }) => resources.files.read(path, signal), enabled: Boolean(path) }),
      index: (cwd: string, q?: string) => queryOptions({ queryKey: queryKeys.files.index(cwd, q), queryFn: ({ signal }) => resources.files.index(cwd, q, signal), enabled: Boolean(cwd) }),
    },
    git: {
      status: (cwd: string) => queryOptions({ queryKey: queryKeys.git.status(cwd), queryFn: ({ signal }) => resources.git.status(cwd, signal), enabled: Boolean(cwd) }),
      diff: (cwd: string, path: string) => queryOptions({ queryKey: queryKeys.git.diff(cwd, path), queryFn: ({ signal }) => resources.git.diff(cwd, path, signal), enabled: Boolean(cwd && path) }),
    },
    cwd: {
      browse: (path?: string) => queryOptions({ queryKey: queryKeys.cwd.browse(path), queryFn: ({ signal }) => resources.cwd.browse(path, signal) }),
      roots: () => queryOptions({ queryKey: queryKeys.cwd.roots(), queryFn: ({ signal }) => resources.cwd.roots(signal) }),
    },
    worktrees: { list: (cwd: string) => queryOptions({ queryKey: queryKeys.worktrees.list(cwd), queryFn: ({ signal }) => resources.worktrees.list(cwd, signal), enabled: Boolean(cwd) }) },
    skills: {
      list: (cwd?: string) => queryOptions({ queryKey: queryKeys.skills.list(cwd), queryFn: ({ signal }) => configuration.skills.list(cwd, signal) }),
      search: (q: string) => queryOptions({ queryKey: queryKeys.skills.search(q), queryFn: ({ signal }) => configuration.skills.search(q, signal), enabled: Boolean(q) }),
    },
    plugins: { list: (cwd?: string) => queryOptions({ queryKey: queryKeys.plugins.list(cwd), queryFn: ({ signal }) => configuration.plugins.list(cwd, signal) }) },
    auth: {
      providers: () => queryOptions({ queryKey: queryKeys.auth.providers(), queryFn: ({ signal }) => configuration.auth.providers(signal) }),
      statuses: () => queryOptions({ queryKey: queryKeys.auth.statuses(), queryFn: ({ signal }) => configuration.auth.statuses(signal) }),
    },
  };
}

export async function invalidateResourceMutation(queryClient: QueryClient, groups: readonly (readonly unknown[])[]) {
  await Promise.all(groups.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
