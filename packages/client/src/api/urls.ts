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
    /** Project-scoped model catalog. Host requires absolute authorized cwd. */
    list: (cwd: string) => resource("models", { cwd }),
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
    /** Project-scoped skills catalog. Host requires absolute authorized cwd. */
    list: (cwd: string) => resource("skills", { cwd }),
  },
  plugins: {
    /** Project-scoped plugins catalog. Host requires absolute authorized cwd. */
    list: (cwd: string) => resource("plugins", { cwd }),
  },
  commands: {
    /** Project-scoped slash-command catalog. Host requires absolute authorized cwd. */
    list: (cwd: string) => resource("commands", { cwd }),
  },
  trust: {
    /** Project trust summary. Host requires absolute authorized cwd. */
    get: (cwd: string) => resource("trust", { cwd }),
  },
  auth: {
    /** Global auth provider list (no cwd). */
    providers: () => resource("auth/providers"),
    /** Per-provider status + configured flag (no cwd). */
    providerStatus: (providerId: string) => resource(`auth/providers/${encodedSegment(providerId)}/status`),
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
