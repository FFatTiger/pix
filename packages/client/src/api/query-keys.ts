import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createGateApi } from "./gate";
import { createPreferencesApi } from "./preferences";
import { createModelsApi } from "./models";
import { createResourcesApi } from "./resources";
import { createSessionsApi } from "./sessions";
import { createConfigurationApi } from "./configuration";
import { BootstrapResponseSchema, CapabilitiesResponseSchema, HealthResponseSchema } from "./schemas";
import { urls } from "./urls";
import { createProjectPageQueryOptions, createSessionPageQueryOptions } from "./session-list";

const CATALOG_STALE_MS = 15_000;

export const queryKeys = {
  root: ["pix"] as const,
  gate: { all: ["pix", "gate"] as const, status: () => ["pix", "gate", "status"] as const },
  preferences: { all: ["pix", "preferences"] as const, map: () => ["pix", "preferences", "map"] as const },
  capabilities: { all: ["pix", "capabilities"] as const, host: () => ["pix", "capabilities", "host"] as const, health: () => ["pix", "capabilities", "health"] as const, bootstrap: () => ["pix", "bootstrap"] as const },
  projects: {
    all: ["pix", "projects"] as const,
    pages: ["pix", "projects", "page"] as const,
    page: (page: number, pageSize: number) => ["pix", "projects", "page", page, pageSize] as const,
  },
  sessions: {
    all: ["pix", "sessions"] as const,
    lists: ["pix", "sessions", "page"] as const,
    page: (page: number, pageSize: number, cwd?: string, projectRoot?: string) => ["pix", "sessions", "page", page, pageSize, cwd ?? null, projectRoot ?? null] as const,
    byId: (id: string) => ["pix", "sessions", "session", id] as const,
    detail: (id: string) => ["pix", "sessions", "session", id, "detail"] as const,
    context: (id: string) => ["pix", "sessions", "session", id, "context"] as const,
    /**
     * Protocol v2 transcript history: keyed by (session, historyGeneration,
     * anchor leaf) so a fresh attach/rebase invalidates and refetches the
     * first page. Older pages use the pinned resolved leaf + `before` cursor.
     */
    history: (id: string, generation: number, anchor: string | null) => ["pix", "sessions", "session", id, "history", generation, anchor ?? null] as const,
    tree: (id: string) => ["pix", "sessions", "session", id, "tree"] as const,
    thinking: (id: string, entryId: string, blockIndex: number) => ["pix", "sessions", "session", id, "thinking", entryId, blockIndex] as const,
    bash: (id: string, entryId: string) => ["pix", "sessions", "session", id, "bash", entryId] as const,
  },
  models: {
    all: ["pix", "models"] as const,
    lists: ["pix", "models", "list"] as const,
    list: () => ["pix", "models", "list"] as const,
    config: () => ["pix", "models", "config"] as const,
  },
  settingsConfig: {
    /** Editable global settings.json raw text. */
    file: () => ["pix", "settings", "config"] as const,
  },

  files: {
    all: ["pix", "files"] as const,
    list: (path: string) => ["pix", "files", "list", path] as const,
    /** Read/meta keys carry the optional session scope (full request identity). */
    meta: (path: string, sessionId?: string | null) => ["pix", "files", "meta", path, sessionId ?? null] as const,
    read: (path: string, sessionId?: string | null) => ["pix", "files", "read", path, sessionId ?? null] as const,
    indexRoot: (cwd: string) => ["pix", "files", "index", cwd] as const, index: (cwd: string, q?: string) => ["pix", "files", "index", cwd, q ?? ""] as const,
  },
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
  settings: {
    all: ["pix", "settings"] as const,
    sessionIdleTimeout: () => ["pix", "settings", "session-idle-timeout"] as const,
  },
} as const;

export function createQueryOptions(http: HttpClient) {
  const gate = createGateApi(http);
  const preferences = createPreferencesApi(http);
  const sessions = createSessionsApi(http);
  const models = createModelsApi(http);
  const resources = createResourcesApi(http);
  const configuration = createConfigurationApi(http);
  return {
    gate: { status: () => queryOptions({ queryKey: queryKeys.gate.status(), queryFn: ({ signal }) => gate.status(signal), staleTime: 30_000, retry: false }) },
    preferences: { map: () => queryOptions({ queryKey: queryKeys.preferences.map(), queryFn: ({ signal }) => preferences.get(signal), staleTime: Infinity, retry: 1 }) },
    capabilities: {
      host: () => queryOptions({ queryKey: queryKeys.capabilities.host(), queryFn: ({ signal }) => http.get(urls.capabilities(), { schema: CapabilitiesResponseSchema, signal }), staleTime: 15_000, retry: false }),
      health: () => queryOptions({ queryKey: queryKeys.capabilities.health(), queryFn: ({ signal }) => http.get(urls.health(), { schema: HealthResponseSchema, signal }), staleTime: 15_000, retry: false }),
      bootstrap: () => queryOptions({ queryKey: queryKeys.capabilities.bootstrap(), queryFn: ({ signal }) => http.get(urls.bootstrap(), { schema: BootstrapResponseSchema, signal }), staleTime: 15_000, retry: false }),
    },
    projects: {
      page: (page: number, pageSize: number, enabled = true) => createProjectPageQueryOptions({
        http,
        page,
        pageSize,
        enabled,
        queryKey: queryKeys.projects.page(page, pageSize),
      }),
    },
    sessions: {
      page: (page: number, pageSize: number, input: { cwd?: string; projectRoot?: string; enabled?: boolean } = {}) => createSessionPageQueryOptions({
        http,
        page,
        pageSize,
        enabled: input.enabled ?? true,
        queryKey: queryKeys.sessions.page(page, pageSize, input.cwd, input.projectRoot),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      }),
      detail: (id: string) => queryOptions({ queryKey: queryKeys.sessions.detail(id), queryFn: ({ signal }) => sessions.detail(id, signal), enabled: Boolean(id) }),
      context: (id: string) => queryOptions({ queryKey: queryKeys.sessions.context(id), queryFn: ({ signal }) => sessions.context(id, { signal }), enabled: Boolean(id) }),
      // Branch tree: isolated per-session key (never shared with context/list),
      // history-mode read only — live leaf selection happens client-side.
      tree: (id: string) => queryOptions({ queryKey: queryKeys.sessions.tree(id), queryFn: ({ signal }) => sessions.tree(id, signal), enabled: Boolean(id) }),
      thinking: (id: string, entryId: string, blockIndex: number) => queryOptions({ queryKey: queryKeys.sessions.thinking(id, entryId, blockIndex), queryFn: ({ signal }) => sessions.thinking(id, entryId, blockIndex, signal), enabled: Boolean(id && entryId) }),
      bash: (id: string, entryId: string) => queryOptions({ queryKey: queryKeys.sessions.bash(id, entryId), queryFn: ({ signal }) => sessions.bashOutput(id, entryId, signal), enabled: Boolean(id && entryId) }),
    },
    models: {
      // Global read-only catalog: always enabled at this layer; callers gate
      // on the `models` capability (and their own surface rules).
      list: () =>
        queryOptions({
          queryKey: queryKeys.models.list(),
          queryFn: ({ signal }) => models.list(signal),
          staleTime: CATALOG_STALE_MS,
          retry: false,
        }),
      config: () =>
        queryOptions({
          queryKey: queryKeys.models.config(),
          queryFn: ({ signal }) => models.config(signal),
          staleTime: 0,
          retry: false,
        }),
    },
    settingsFile: {
      // Editable global settings.json text: always enabled at this layer;
      // callers gate on `settings.configure`.
      config: () =>
        queryOptions({
          queryKey: queryKeys.settingsConfig.file(),
          queryFn: ({ signal }) => configuration.settingsFile.get(signal),
          staleTime: 0,
          retry: false,
        }),
    },
    files: {
      list: (path: string) => queryOptions({ queryKey: queryKeys.files.list(path), queryFn: ({ signal }) => resources.files.list(path, signal), enabled: Boolean(path) }),
      meta: (path: string, sessionId?: string | null) => queryOptions({ queryKey: queryKeys.files.meta(path, sessionId), queryFn: ({ signal }) => resources.files.meta(path, sessionId, signal), enabled: Boolean(path) }),
      read: (path: string, sessionId?: string | null) => queryOptions({ queryKey: queryKeys.files.read(path, sessionId), queryFn: ({ signal }) => resources.files.read(path, sessionId, signal), enabled: Boolean(path) }),
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
    settings: {
      sessionIdleTimeout: () =>
        queryOptions({
          queryKey: queryKeys.settings.sessionIdleTimeout(),
          queryFn: ({ signal }) => configuration.sessionSettings.get(signal),
          staleTime: 15_000,
          retry: false,
        }),
    },
  };
}

export async function invalidateResourceMutation(queryClient: QueryClient, groups: readonly (readonly unknown[])[]) {
  await Promise.all(groups.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
