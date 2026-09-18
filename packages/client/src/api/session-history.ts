import { queryOptions } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createSessionsApi } from "./sessions";
import { queryKeys } from "./query-keys";
import type { DeferredThinkingLoader } from "@/lib/chat-view-model";

/**
 * THE single session-history query definition. Both the transcript hook
 * (`useSessionTranscript`) and every history consumer mount this exact
 * key + queryFn, so the complete-branch response is one shared cache entry —
 * one cache authority, no duplicate request logic, no drift.
 *
 * One complete lightweight response replaces the old 150-entry initial window
 * + 50-entry older-page pagination: the request sends `deferThinking=1` +
 * `deferMedia=1` (thinking blocks come back `deferred:true` for per-block
 * on-demand reads via `entries/:entryId/thinking?blockIndex=`; base64
 * tool-result images become truthful omission summaries) and NO `limit`,
 * which the Host contract answers with
 * the COMPLETE active branch and `pageInfo.hasMore:false`.
 *
 * `retry`/`retryOnMount` are pinned off: a failed fetch is a deterministic
 * result (not_found/unavailable) and the transcript must render the honest
 * error surface immediately instead of re-entering a loading spinner on mount.
 */
export function createSessionHistoryQueryOptions(input: {
  /** Typed transport (same HttpClient the app uses). */
  readonly http: HttpClient;
  /** Selected session id (empty string disables the fetch). */
  readonly sessionId: string;
  /** Live history generation (0 for a read-only history session). */
  readonly generation: number;
  /** Live anchor leaf (null for a read-only history session). */
  readonly anchor: string | null;
  /** Query gate (capability + session presence + live-anchor rule). */
  readonly enabled: boolean;
}) {
  const { http, sessionId, generation, anchor, enabled } = input;
  const sessionsApi = createSessionsApi(http);
  return queryOptions({
    queryKey: queryKeys.sessions.history(sessionId, generation, anchor),
    queryFn: ({ signal }) =>
      sessionsApi.context(sessionId, {
        ...(anchor === null ? {} : { leafId: anchor }),
        deferThinking: true,
        deferMedia: true,
        signal,
      }),
    enabled,
    // Same-session retention: a generation/anchor bump is a query REVISION of
    // the SAME conversation (read-only→live activation, turn-end leaf fence,
    // gap/epoch rebase), and the previous response keeps rendering — as ONE
    // consistent snapshot (entries + settings + contextTokens) — until the new
    // revision commits. That is the transcript's no-blank/no-yank guarantee:
    // an empty list would clamp scrollTop and the next commit would drag the
    // user to the bottom. Never carried across session ids.
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      return Array.isArray(previousKey) && previousKey[3] === sessionId
        ? previousData
        : undefined;
    },
    staleTime: 30_000,
    retry: false,
    retryOnMount: false,
  });
}

/**
 * Typed deferred-thinking loader for persisted history blocks: resolves one
 * `deferred:true` thinking block through the typed session-entry API
 * (`GET /v1/sessions/:id/entries/:entryId/thinking?blockIndex=` →
 * `{thinking, entryId}`). View components (MessageView / ProcessGroup) receive
 * this through their `loadDeferredThinking` prop — the transport stays in the
 * api layer, and MessageView's module-level cache owns single-flight/LRU.
 */
export function createDeferredThinkingLoader(http: HttpClient): DeferredThinkingLoader {
  const sessionsApi = createSessionsApi(http);
  return (sessionId, entryId, blockIndex) =>
    sessionsApi.thinking(sessionId, entryId, blockIndex).then((response) => response.thinking);
}
