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

/** Files resource operations. `watch`/`upload-check`/`docx-preview` extend the
 * source file-workspace contract; `docx-preview` is live on the Host,
 * `watch`+`upload-check` are frozen URL contracts awaiting their endpoints. */
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
  themes: {
    /** Theme-set catalog (global + project sets + builtins). cwd optional. */
    list: (cwd?: string) => resource("themes", { cwd }),
    /** Resolved variant (dark/light) of a theme set. */
    resolve: (name: string, mode: "dark" | "light") => resource(`themes/${encodedSegment(name)}`, { mode }),
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
    /** POST /v1/files?op=upload-check — conflict preflight (Host endpoint pending). */
    uploadCheck: (path: string) => resource("files", { path, op: "upload-check" }),
    /** GET /v1/files?op=watch — SSE change stream (Host endpoint pending). */
    watch: (path: string, sessionId?: string | null) => resource("files", { path, op: "watch", sessionId: sessionId ?? undefined }),
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
