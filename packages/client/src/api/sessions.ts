import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  BashOutputResponseSchema,
  ProjectListSchema,
  SessionContextResponseSchema,
  SessionDetailResponseSchema,
  SessionTreeResponseSchema,
  SessionListSchema,
  SuccessSchema,
  ThinkingResponseSchema,
} from "./schemas";

export function createSessionsApi(http: HttpClient) {
  return {
    list: (input: { page: number; pageSize: number; cwd?: string; projectRoot?: string; signal?: AbortSignal }) => {
      const params: { page: number; pageSize: number; cwd?: string; projectRoot?: string } = { page: input.page, pageSize: input.pageSize };
      if (input.cwd !== undefined) params.cwd = input.cwd;
      if (input.projectRoot !== undefined) params.projectRoot = input.projectRoot;
      return http.get(urls.sessions.list(params), { schema: SessionListSchema, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    },
    projects: (input: { page: number; pageSize: number; signal?: AbortSignal }) => http.get(
      urls.projects.list({ page: input.page, pageSize: input.pageSize }),
      { schema: ProjectListSchema, ...(input.signal === undefined ? {} : { signal: input.signal }) },
    ),
    detail: (id: string, signal?: AbortSignal) => http.get(urls.sessions.byId(id), { schema: SessionDetailResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    // Session context (Protocol v2): `leafId` pins the branch, `deferThinking`/
    // `deferMedia` request the lightweight deferred projection (thinking blocks
    // come back `deferred:true` for on-demand block reads; base64 tool-result
    // images become truthful omission summaries). Omitting `limit` returns the
    // COMPLETE active branch in one
    // response (`pageInfo.hasMore:false`). The AbortSignal is passed through so
    // session/branch/generation changes can abort in-flight responses.
    context: (
      id: string,
      options: {
        leafId?: string;
        before?: string;
        limit?: number;
        deferThinking?: boolean;
        deferMedia?: boolean;
        signal?: AbortSignal;
      } = {},
    ) => {
      const params: {
        leafId?: string;
        before?: string;
        limit?: number;
        deferThinking?: boolean;
        deferMedia?: boolean;
      } = {};
      if (options.leafId !== undefined) params.leafId = options.leafId;
      if (options.before !== undefined) params.before = options.before;
      if (options.limit !== undefined) params.limit = options.limit;
      if (options.deferThinking !== undefined) params.deferThinking = options.deferThinking;
      if (options.deferMedia !== undefined) params.deferMedia = options.deferMedia;
      return http.get(urls.sessions.context(id, params), {
        schema: SessionContextResponseSchema,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    // Read-only branch tree for the BranchNavigator slice (history mode).
    tree: (id: string, signal?: AbortSignal) => http.get(urls.sessions.tree(id), { schema: SessionTreeResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    thinking: (id: string, entryId: string, blockIndex: number, signal?: AbortSignal) => http.get(urls.sessions.thinking(id, entryId, blockIndex), { schema: ThinkingResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    bashOutput: (id: string, entryId: string, signal?: AbortSignal) => http.get(urls.sessions.bashOutput(id, entryId), { schema: BashOutputResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    export: (id: string, format?: string, signal?: AbortSignal) => http.get<Blob>(urls.sessions.export(id, format), { responseMode: "blob", ...(signal === undefined ? {} : { signal }) }),
    // D4: Host PATCH /v1/sessions/:id (rename) and DELETE /v1/sessions/:id both
    // settle with `{ success: true }` (Host route contract).
    rename: (id: string, name: string, signal?: AbortSignal) => http.patch(urls.sessions.byId(id), { name }, { schema: SuccessSchema, ...(signal === undefined ? {} : { signal }) }),
    remove: (id: string, signal?: AbortSignal) => http.delete(urls.sessions.byId(id), undefined, { schema: SuccessSchema, ...(signal === undefined ? {} : { signal }) }),
    // Session-title generation has NO HTTP surface: it is the typed runtime
    // command `generate_session_title` (features/session-title/session-title.ts).
    // The former autoName POST targeted a route the Host never exposed.
  };
}
export type SessionsApi = ReturnType<typeof createSessionsApi>;
