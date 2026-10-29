import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { AssistantInfoSchema, SessionListSchema } from "./schemas";

/**
 * Assistant (Pixie) conversation surface.
 *
 * - `get()` — the conversation binding: `cwd` is the fixed Host-managed
 *   assistant workspace and `sessionId` is its most recent session (null until
 *   the first message creates one).
 * - `byId(sessionId)` — EXACT binding for one selected conversation. The Host
 *   verifies existence + root + exact workspace identity and answers a fixed
 *   404 otherwise (never a latest fallback).
 * - `sessions({page, pageSize})` — one true numbered page of that workspace's
 *   own conversations (same SessionPage DTO as /v1/sessions), server-resolved:
 *   the client never sends a cwd.
 *
 * Every call stays read-only — none of them creates or activates anything;
 * creation rides the normal first-send transaction with the resolved cwd.
 */
export function createAssistantApi(http: HttpClient) {
  return {
    get: (signal?: AbortSignal) => http.get(urls.assistant.get(), { schema: AssistantInfoSchema, ...(signal === undefined ? {} : { signal }) }),
    byId: (sessionId: string, signal?: AbortSignal) => http.get(
      urls.assistant.byId(sessionId),
      { schema: AssistantInfoSchema, ...(signal === undefined ? {} : { signal }) },
    ),
    sessions: (input: { page: number; pageSize: number; signal?: AbortSignal }) => http.get(
      urls.assistant.sessions({ page: input.page, pageSize: input.pageSize }),
      { schema: SessionListSchema, ...(input.signal === undefined ? {} : { signal: input.signal }) },
    ),
  };
}

export type AssistantApi = ReturnType<typeof createAssistantApi>;
