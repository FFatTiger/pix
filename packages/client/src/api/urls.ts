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

/** Files resource operations. `watch`/`docx-preview` extend the source
 * file-workspace contract: `docx-preview` is live on the Host, `watch` is the
 * live /v1/files/watch SSE stream. */
export type FilesOperation =
  | "list"
  | "meta"
  | "read"
  | "preview"
  | "raw"
  | "download"
  | "watch"
  | "docx-preview";

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
    context: (id: string, params?: { leafId?: string; before?: string; limit?: number }) => {
      const query: { leafId?: string; before?: string; limit?: number } = {};
      if (params?.leafId !== undefined) query.leafId = params.leafId;
      if (params?.before !== undefined) query.before = params.before;
      if (params?.limit !== undefined) query.limit = params.limit;
      return resource(`sessions/${encodedSegment(id)}/context`, query);
    },
    /** Read-only normalized branch tree (no query surface). */
    tree: (id: string) => resource(`sessions/${encodedSegment(id)}/tree`),
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
    resource: (path: string, op?: FilesOperation) => resource("files", { path, op }),
    /**
     * Full files URL for element `src`/`href` and watch connections: op +
     * optional session scoping + extra query params (e.g. cache-bust `v`).
     * `sessionId` and undefined params are omitted; paths are URL-encoded.
     */
    file: (
      path: string,
      op: FilesOperation,
      options?: { sessionId?: string | null | undefined; params?: Record<string, string | number | undefined> | undefined },
    ) => resource("files", { path, op, sessionId: options?.sessionId ?? undefined, ...(options?.params ?? {}) }),
    upload: (path: string, conflict?: "error" | "overwrite" | "skip") => resource("files", { path, conflict }),
    /** POST /v1/files?op=upload-check — conflict preflight (live on Host). */
    uploadCheck: (path: string) => resource("files", { path, op: "upload-check" }),
    /** Live GET /v1/files/watch?path= SSE change stream. */
    watch: (path: string) => resource("files/watch", { path }),
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
    /** POST /v1/trust — set-project-trusted mutation (body {cwd, level:"trusted"}). */
    mutate: () => resource("trust"),
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
