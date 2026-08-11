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
  root: ["pix"] as const,
  gate: { all: ["pix", "gate"] as const, status: () => ["pix", "gate", "status"] as const },
  capabilities: { all: ["pix", "capabilities"] as const, host: () => ["pix", "capabilities", "host"] as const, health: () => ["pix", "capabilities", "health"] as const, bootstrap: () => ["pix", "bootstrap"] as const },
  sessions: {
    all: ["pix", "sessions"] as const,
    lists: ["pix", "sessions", "list"] as const,
    list: (cwd?: string) => ["pix", "sessions", "list", cwd ?? null] as const,
    byId: (id: string) => ["pix", "sessions", "session", id] as const,
    detail: (id: string) => ["pix", "sessions", "session", id, "detail"] as const,
    context: (id: string) => ["pix", "sessions", "session", id, "context"] as const,
    thinking: (id: string, entryId: string) => ["pix", "sessions", "session", id, "thinking", entryId] as const,
    bash: (id: string, entryId: string) => ["pix", "sessions", "session", id, "bash", entryId] as const,
  },
  models: { all: ["pix", "models"] as const, lists: ["pix", "models", "list"] as const, list: (cwd?: string) => ["pix", "models", "list", cwd ?? null] as const, config: () => ["pix", "models", "config"] as const, catalog: (input?: object) => ["pix", "models", "catalog", input ?? {}] as const },
  files: { all: ["pix", "files"] as const, list: (path: string) => ["pix", "files", "list", path] as const, meta: (path: string) => ["pix", "files", "meta", path] as const, read: (path: string) => ["pix", "files", "read", path] as const, indexRoot: (cwd: string) => ["pix", "files", "index", cwd] as const, index: (cwd: string, q?: string) => ["pix", "files", "index", cwd, q ?? ""] as const },
  git: { all: ["pix", "git"] as const, status: (cwd: string) => ["pix", "git", "status", cwd] as const, diff: (cwd: string, path: string) => ["pix", "git", "diff", cwd, path] as const },
  cwd: { all: ["pix", "cwd"] as const, browse: (path?: string) => ["pix", "cwd", "browse", path ?? null] as const, roots: () => ["pix", "cwd", "roots"] as const },
  worktrees: { all: ["pix", "worktrees"] as const, list: (cwd: string) => ["pix", "worktrees", "list", cwd] as const },
  skills: { all: ["pix", "skills"] as const, list: (cwd?: string) => ["pix", "skills", "list", cwd ?? null] as const, search: (q: string) => ["pix", "skills", "search", q] as const },
  plugins: { all: ["pix", "plugins"] as const, list: (cwd?: string) => ["pix", "plugins", "list", cwd ?? null] as const },
  auth: { all: ["pix", "auth"] as const, providers: () => ["pix", "auth", "providers"] as const, statuses: () => ["pix", "auth", "statuses"] as const },
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
