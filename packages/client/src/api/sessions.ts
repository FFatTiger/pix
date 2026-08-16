import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  BashOutputResponseSchema,
  OkSchema,
  SessionContextResponseSchema,
  SessionDetailResponseSchema,
  SessionTreeResponseSchema,
  SessionListSchema,
  SuccessSchema,
  ThinkingResponseSchema,
} from "./schemas";

export function createSessionsApi(http: HttpClient) {
  return {
    list: (input: { cwd?: string; signal?: AbortSignal } = {}) => http.get(urls.sessions.list(input.cwd), { schema: SessionListSchema, ...(input.signal === undefined ? {} : { signal: input.signal }) }),
    detail: (id: string, signal?: AbortSignal) => http.get(urls.sessions.byId(id), { schema: SessionDetailResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    // Cursor-paginated context (Protocol v2): `leafId` pins the branch,
    // `before` is an exclusive projected entryId cursor (omitted = newest
    // page), `limit` is the page size (default 50, bounded 1..200). The
    // AbortSignal is passed through so session/branch/generation changes can
    // abort in-flight pages.
    context: (id: string, options: { leafId?: string; before?: string; limit?: number; signal?: AbortSignal } = {}) => {
      const params: { leafId?: string; before?: string; limit?: number } = {};
      if (options.leafId !== undefined) params.leafId = options.leafId;
      if (options.before !== undefined) params.before = options.before;
      if (options.limit !== undefined) params.limit = options.limit;
      return http.get(urls.sessions.context(id, params), {
        schema: SessionContextResponseSchema,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    // Read-only branch tree for the BranchNavigator slice (history mode).
    tree: (id: string, signal?: AbortSignal) => http.get(urls.sessions.tree(id), { schema: SessionTreeResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    thinking: (id: string, entryId: string, signal?: AbortSignal) => http.get(urls.sessions.thinking(id, entryId), { schema: ThinkingResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    bashOutput: (id: string, entryId: string, signal?: AbortSignal) => http.get(urls.sessions.bashOutput(id, entryId), { schema: BashOutputResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    export: (id: string, format?: string, signal?: AbortSignal) => http.get<Blob>(urls.sessions.export(id, format), { responseMode: "blob", ...(signal === undefined ? {} : { signal }) }),
    // D4: Host PATCH /v1/sessions/:id (rename) and DELETE /v1/sessions/:id both
    // settle with `{ success: true }` (Host route contract). autoName keeps its
    // own contract untouched.
    rename: (id: string, name: string, signal?: AbortSignal) => http.patch(urls.sessions.byId(id), { name }, { schema: SuccessSchema, ...(signal === undefined ? {} : { signal }) }),
    remove: (id: string, signal?: AbortSignal) => http.delete(urls.sessions.byId(id), undefined, { schema: SuccessSchema, ...(signal === undefined ? {} : { signal }) }),
    autoName: (id: string, signal?: AbortSignal) => http.post(urls.sessions.autoName(id), {}, { schema: OkSchema, ...(signal === undefined ? {} : { signal }) }),
  };
}
export type SessionsApi = ReturnType<typeof createSessionsApi>;
