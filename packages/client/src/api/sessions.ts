import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  BashOutputResponseSchema,
  OkSchema,
  SessionContextResponseSchema,
  SessionDetailResponseSchema,
  SessionListSchema,
  ThinkingResponseSchema,
} from "./schemas";

export function createSessionsApi(http: HttpClient) {
  return {
    list: (input: { cwd?: string; signal?: AbortSignal } = {}) => http.get(urls.sessions.list(input.cwd), { schema: SessionListSchema, ...(input.signal === undefined ? {} : { signal: input.signal }) }),
    detail: (id: string, signal?: AbortSignal) => http.get(urls.sessions.byId(id), { schema: SessionDetailResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    context: (id: string, signal?: AbortSignal) => http.get(urls.sessions.context(id), { schema: SessionContextResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    thinking: (id: string, entryId: string, signal?: AbortSignal) => http.get(urls.sessions.thinking(id, entryId), { schema: ThinkingResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    bashOutput: (id: string, entryId: string, signal?: AbortSignal) => http.get(urls.sessions.bashOutput(id, entryId), { schema: BashOutputResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    export: (id: string, format?: string, signal?: AbortSignal) => http.get<Blob>(urls.sessions.export(id, format), { responseMode: "blob", ...(signal === undefined ? {} : { signal }) }),
    rename: (id: string, name: string, signal?: AbortSignal) => http.patch(urls.sessions.byId(id), { name }, { schema: OkSchema, ...(signal === undefined ? {} : { signal }) }),
    remove: (id: string, signal?: AbortSignal) => http.delete(urls.sessions.byId(id), undefined, { schema: OkSchema, ...(signal === undefined ? {} : { signal }) }),
    autoName: (id: string, signal?: AbortSignal) => http.post(urls.sessions.autoName(id), {}, { schema: OkSchema, ...(signal === undefined ? {} : { signal }) }),
  };
}
export type SessionsApi = ReturnType<typeof createSessionsApi>;
