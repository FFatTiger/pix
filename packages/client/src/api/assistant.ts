import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { AssistantInfoSchema } from "./schemas";

/**
 * Assistant conversation binding (GET /v1/assistant).
 *
 * The assistant is a project-less evergreen conversation: `cwd` is the fixed
 * Host-managed assistant workspace and `sessionId` is its most recent session
 * (null until the first message creates one). The call stays read-only — it
 * never creates or activates anything; creation rides the normal first-send
 * transaction with this cwd.
 */
export function createAssistantApi(http: HttpClient) {
  return {
    get: (signal?: AbortSignal) => http.get(urls.assistant.get(), { schema: AssistantInfoSchema, ...(signal === undefined ? {} : { signal }) }),
  };
}
