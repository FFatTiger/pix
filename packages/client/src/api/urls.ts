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
  preferences: {
    get: () => resource("preferences"),
    update: () => resource("preferences"),
  },
  gate: {
    status: () => resource("gate/status"),
    login: () => resource("gate/login"),
    logout: () => resource("gate/logout"),
    changePassword: () => resource("gate/password"),
  },
  projects: {
    list: (input: { page: number; pageSize: number }) => resource("projects", input),
  },
  sessions: {
    list: (input: { page: number; pageSize: number; cwd?: string; projectRoot?: string }) => resource("sessions", input),
    byId: (id: string) => resource(`sessions/${encodedSegment(id)}`),
    /**
     * Session context. `leafId` pins the branch; omitting `limit` asks for the
     * COMPLETE active branch (one lightweight response, `pageInfo.hasMore`
     * false). `deferThinking`/`deferMedia` serialize as `1` per the Host
     * contract: thinking blocks come back `deferred:true` (fetched per block
     * via `entries/:entryId/thinking?blockIndex=`), while base64 tool-result
     * images are replaced by truthful omission summaries.
     */
    context: (
      id: string,
      params?: {
        leafId?: string;
        before?: string;
        limit?: number;
        deferThinking?: boolean;
        deferMedia?: boolean;
      },
    ) => {
      const query: {
        leafId?: string;
        before?: string;
        limit?: number;
        deferThinking?: number;
        deferMedia?: number;
      } = {};
      if (params?.leafId !== undefined) query.leafId = params.leafId;
      if (params?.before !== undefined) query.before = params.before;
      if (params?.limit !== undefined) query.limit = params.limit;
      if (params?.deferThinking === true) query.deferThinking = 1;
      if (params?.deferMedia === true) query.deferMedia = 1;
      return resource(`sessions/${encodedSegment(id)}/context`, query);
    },
    /** Read-only normalized branch tree (no query surface). */
    tree: (id: string) => resource(`sessions/${encodedSegment(id)}/tree`),
    /** Deferred thinking block content; `blockIndex` is REQUIRED (Host contract). */
    thinking: (id: string, entryId: string, blockIndex: number) =>
      resource(`sessions/${encodedSegment(id)}/entries/${encodedSegment(entryId)}/thinking`, { blockIndex }),
    bashOutput: (id: string, entryId: string) => resource(`sessions/${encodedSegment(id)}/entries/${encodedSegment(entryId)}/bash-output`),
    export: (id: string, format?: string) => resource(`sessions/${encodedSegment(id)}/export`, { format }),
  },
  models: {
    /** Global model catalog (agent-dir models.json providers; no cwd). */
    list: () => resource("models"),
    /** Global models.json editor; no cwd/query surface. */
    config: () => resource("models/config"),
    discover: () => resource("models/discover"),
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
  settings: {
    /** Session idle-reclamation timeout (GET) / set+persist (PUT). */
    sessionIdleTimeout: () => resource("settings/session-idle-timeout"),
    /** Global agent-dir settings.json raw-text editor; no query surface. */
    configFile: () => resource("settings/config"),
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
