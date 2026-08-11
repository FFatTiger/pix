const API_ROOT = "/v1";

function encodedSegment(value: string): string {
  return encodeURIComponent(value);
}

function resource(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${API_ROOT}/${path.replace(/^\/+/, "")}`, "http://pix.local");
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function v1Url(...segments: string[]): string {
  return segments.length === 0 ? API_ROOT : resource(segments.map(encodedSegment).join("/"));
}

export const urls = {
  root: API_ROOT,
  health: () => resource("health"),
  capabilities: () => resource("capabilities"),
  bootstrap: () => resource("bootstrap"),
  gate: {
    status: () => resource("gate/status"),
    login: () => resource("gate/login"),
    logout: () => resource("gate/logout"),
  },
  sessions: {
    list: (cwd?: string) => resource("sessions", { cwd }),
    byId: (id: string) => resource(`sessions/${encodedSegment(id)}`),
    context: (id: string) => resource(`sessions/${encodedSegment(id)}/context`),
    thinking: (id: string, entryId: string) => resource(`sessions/${encodedSegment(id)}/entries/${encodedSegment(entryId)}/thinking`),
    bashOutput: (id: string, entryId: string) => resource(`sessions/${encodedSegment(id)}/entries/${encodedSegment(entryId)}/bash-output`),
    export: (id: string, format?: string) => resource(`sessions/${encodedSegment(id)}/export`, { format }),
    autoName: (id: string) => resource(`sessions/${encodedSegment(id)}/auto-name`),
  },
  models: {
    list: (cwd?: string) => resource("models", { cwd }),
    config: () => resource("models-config"),
    catalog: (input?: { q?: string; provider?: string; baseUrl?: string; limit?: number }) => resource("models-config/catalog", input),
    discover: () => resource("models-config/discover"),
    test: () => resource("models-config/test"),
  },
  files: {
    resource: (path: string, op?: "list" | "meta" | "read" | "preview" | "raw" | "download") => resource("files", { path, op }),
    upload: (path: string, conflict?: "error" | "overwrite" | "skip") => resource("files", { path, conflict }),
    index: (cwd: string, q?: string) => resource("file-index", { cwd, q }),
  },
  git: {
    status: (cwd: string) => resource("git/status", { cwd }),
    diff: (cwd: string, path: string) => resource("git/diff", { cwd, path }),
  },
  cwd: {
    validate: () => resource("cwd/validate"),
    browse: (path?: string) => resource("cwd/browse", { path }),
    roots: () => resource("cwd/roots"),
    default: () => resource("cwd/default"),
  },
  worktrees: {
    list: (cwd: string) => resource("worktrees", { cwd }),
    mutate: () => resource("worktrees"),
  },
  skills: {
    list: (cwd?: string) => resource("skills", { cwd }),
    search: (q: string) => resource("skills/search", { q }),
    install: () => resource("skills/install"),
    update: () => resource("skills/update"),
    toggle: () => resource("skills"),
  },
  plugins: {
    list: (cwd?: string) => resource("plugins", { cwd }),
    mutate: () => resource("plugins"),
  },
  auth: {
    providers: () => resource("auth/providers"),
    allProviders: () => resource("auth/all-providers"),
    apiKey: (provider: string) => resource(`auth/api-key/${encodedSegment(provider)}`),
    login: (provider: string) => resource(`auth/login/${encodedSegment(provider)}`),
    logout: (provider: string) => resource(`auth/logout/${encodedSegment(provider)}`),
  },
  runtime: { ws: () => resource("runtime") },
} as const;

export function assertV1Path(path: string): void {
  if (!path.startsWith("/")) throw new Error(`Only /v1 same-origin paths are allowed, got: ${path}`);
  const parsed = new URL(path, "http://pix.local");
  if (parsed.origin !== "http://pix.local" || (parsed.pathname !== API_ROOT && !parsed.pathname.startsWith(`${API_ROOT}/`))) {
    throw new Error(`Only /v1 same-origin paths are allowed, got: ${path}`);
  }
}
