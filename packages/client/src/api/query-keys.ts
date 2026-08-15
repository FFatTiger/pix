import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createGateApi } from "./gate";
import { createModelsApi } from "./models";
import { createThemesApi } from "./themes";
import { createResourcesApi } from "./resources";
import { createSessionsApi } from "./sessions";
import { createConfigurationApi } from "./configuration";
import { BootstrapResponseSchema, CapabilitiesResponseSchema, HealthResponseSchema } from "./schemas";
import { urls } from "./urls";

const CATALOG_STALE_MS = 15_000;

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
  models: {
    all: ["pix", "models"] as const,
    lists: ["pix", "models", "list"] as const,
    list: (cwd: string) => ["pix", "models", "list", cwd] as const,
  },
  themes: {
    all: ["pix", "themes"] as const,
    lists: ["pix", "themes", "list"] as const,
    list: () => ["pix", "themes", "list"] as const,
    resolve: (name: string, mode: "dark" | "light") => ["pix", "themes", "resolve", name, mode] as const,
  },
  files: { all: ["pix", "files"] as const, list: (path: string) => ["pix", "files", "list", path] as const, meta: (path: string) => ["pix", "files", "meta", path] as const, read: (path: string) => ["pix", "files", "read", path] as const, indexRoot: (cwd: string) => ["pix", "files", "index", cwd] as const, index: (cwd: string, q?: string) => ["pix", "files", "index", cwd, q ?? ""] as const },
  git: { all: ["pix", "git"] as const, status: (cwd: string) => ["pix", "git", "status", cwd] as const, diff: (cwd: string, path: string) => ["pix", "git", "diff", cwd, path] as const },
  cwd: { all: ["pix", "cwd"] as const, browse: (path?: string) => ["pix", "cwd", "browse", path ?? null] as const, roots: () => ["pix", "cwd", "roots"] as const },
  worktrees: { all: ["pix", "worktrees"] as const, list: (cwd: string) => ["pix", "worktrees", "list", cwd] as const },
  skills: {
    all: ["pix", "skills"] as const,
    list: (cwd: string) => ["pix", "skills", "list", cwd] as const,
  },
  plugins: {
    all: ["pix", "plugins"] as const,
    list: (cwd: string) => ["pix", "plugins", "list", cwd] as const,
  },
  commands: {
    all: ["pix", "commands"] as const,
    list: (cwd: string) => ["pix", "commands", "list", cwd] as const,
  },
  trust: {
    all: ["pix", "trust"] as const,
    get: (cwd: string) => ["pix", "trust", "get", cwd] as const,
  },
  auth: {
    all: ["pix", "auth"] as const,
    providers: () => ["pix", "auth", "providers"] as const,
    providerStatus: (providerId: string) => ["pix", "auth", "provider-status", providerId] as const,
  },
} as const;

export function createQueryOptions(http: HttpClient) {
  const gate = createGateApi(http);
  const sessions = createSessionsApi(http);
  const models = createModelsApi(http);
  const resources = createResourcesApi(http);
  const configuration = createConfigurationApi(http);
  const themes = createThemesApi(http);
  return {
    gate: { status: () => queryOptions({ queryKey: queryKeys.gate.status(), queryFn: ({ signal }) => gate.status(signal), staleTime: 30_000, retry: false }) },
    capabilities: {
      host: () => queryOptions({ queryKey: queryKeys.capabilities.host(), queryFn: ({ signal }) => http.get(urls.capabilities(), { schema: CapabilitiesResponseSchema, signal }), staleTime: 15_000, retry: false }),
      health: () => queryOptions({ queryKey: queryKeys.capabilities.health(), queryFn: ({ signal }) => http.get(urls.health(), { schema: HealthResponseSchema, signal }), staleTime: 15_000, retry: false }),
      bootstrap: () => queryOptions({ queryKey: queryKeys.capabilities.bootstrap(), queryFn: ({ signal }) => http.get(urls.bootstrap(), { schema: BootstrapResponseSchema, signal }), staleTime: 15_000, retry: false }),
    },
    sessions: {
      // 30s staleTime matches the server-side per-store list cache TTL: mount
      // / window-focus refetches of the (heavy, all-project) session list are
      // served from the cache instead of re-running a full SessionManager scan
      // per request. The cold-open all-project request still fires on first mount.
      list: (cwd?: string) => queryOptions({ queryKey: queryKeys.sessions.list(cwd), queryFn: ({ signal }) => sessions.list({ ...(cwd === undefined ? {} : { cwd }), signal }), staleTime: 30_000 }),
      detail: (id: string) => queryOptions({ queryKey: queryKeys.sessions.detail(id), queryFn: ({ signal }) => sessions.detail(id, signal), enabled: Boolean(id) }),
      context: (id: string) => queryOptions({ queryKey: queryKeys.sessions.context(id), queryFn: ({ signal }) => sessions.context(id, signal), enabled: Boolean(id) }),
      thinking: (id: string, entryId: string) => queryOptions({ queryKey: queryKeys.sessions.thinking(id, entryId), queryFn: ({ signal }) => sessions.thinking(id, entryId, signal), enabled: Boolean(id && entryId) }),
      bash: (id: string, entryId: string) => queryOptions({ queryKey: queryKeys.sessions.bash(id, entryId), queryFn: ({ signal }) => sessions.bashOutput(id, entryId, signal), enabled: Boolean(id && entryId) }),
    },
    models: {
      list: (cwd: string) =>
        queryOptions({
          queryKey: queryKeys.models.list(cwd),
          queryFn: ({ signal }) => models.list(cwd, signal),
          enabled: Boolean(cwd),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
    },
    themes: {
      // Pre-Host degradation is deliberate: the query surfaces the failure to
      // the caller (undefined data) and the settings UI falls back to the
      // built-in/default theme sets — no raw error reaches the DOM.
      list: (cwd?: string) =>
        queryOptions({
          queryKey: queryKeys.themes.list(),
          queryFn: ({ signal }) => themes.list(cwd, signal),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
      resolve: (name: string, mode: "dark" | "light") =>
        queryOptions({
          queryKey: queryKeys.themes.resolve(name, mode),
          queryFn: ({ signal }) => themes.resolve(name, mode, signal),
          enabled: Boolean(name),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
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
      list: (cwd: string) =>
        queryOptions({
          queryKey: queryKeys.skills.list(cwd),
          queryFn: ({ signal }) => configuration.skills.list(cwd, signal),
          enabled: Boolean(cwd),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
    },
    plugins: {
      list: (cwd: string) =>
        queryOptions({
          queryKey: queryKeys.plugins.list(cwd),
          queryFn: ({ signal }) => configuration.plugins.list(cwd, signal),
          enabled: Boolean(cwd),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
    },
    commands: {
      list: (cwd: string) =>
        queryOptions({
          queryKey: queryKeys.commands.list(cwd),
          queryFn: ({ signal }) => configuration.commands.list(cwd, signal),
          enabled: Boolean(cwd),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
    },
    trust: {
      get: (cwd: string) =>
        queryOptions({
          queryKey: queryKeys.trust.get(cwd),
          queryFn: ({ signal }) => configuration.trust.get(cwd, signal),
          enabled: Boolean(cwd),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
    },
    auth: {
      providers: () =>
        queryOptions({
          queryKey: queryKeys.auth.providers(),
          queryFn: ({ signal }) => configuration.auth.providers(signal),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
      providerStatus: (providerId: string) =>
        queryOptions({
          queryKey: queryKeys.auth.providerStatus(providerId),
          queryFn: ({ signal }) => configuration.auth.providerStatus(providerId, signal),
          enabled: Boolean(providerId),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
    },
  };
}

export async function invalidateResourceMutation(queryClient: QueryClient, groups: readonly (readonly unknown[])[]) {
  await Promise.all(groups.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
