import { infiniteQueryOptions } from "@tanstack/react-query";
import type { HttpClient } from "./http-client";
import { createSessionsApi } from "./sessions";
import { queryKeys } from "./query-keys";

/** Default first-page size (Protocol v2 default; bounded 1..200 server-side). */
export const TRANSCRIPT_PAGE_SIZE = 50;

/**
 * Infinite-query page parameter for the cursor-paginated session context:
 * `leafId` pins the branch (carried from the FIRST page so later appends can
 * never shift pagination), `before` is the exclusive projected entryId cursor
 * (omitted = newest page).
 */
export interface SessionHistoryPageParam {
  readonly leafId?: string;
  readonly before?: string;
}

export interface SessionHistoryQueryInput {
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
}

/**
 * THE single session-history infinite-query definition. Both the transcript
 * hook (`useSessionTranscript`) and the AppShell sidebar prepare/ensure flow
 * consume this exact key + queryFn + cursor/leaf semantics, so a prepared
 * first page is the identical cache the detail frame mounts against — one
 * cache authority, no duplicate cursor/leaf logic, no drift.
 *
 * `retry`/`retryOnMount` are pinned off: a failed first-page fetch is a
 * deterministic result (not_found/unavailable), the sidebar prepare commits on
 * settle either way, and the detail frame must render the honest error surface
 * immediately instead of re-entering a loading spinner on mount.
 */
export function createSessionHistoryQueryOptions(input: SessionHistoryQueryInput) {
  const { http, sessionId, generation, anchor, enabled } = input;
  const sessionsApi = createSessionsApi(http);
  const initialPageParam: SessionHistoryPageParam = anchor === null ? {} : { leafId: anchor };
  return infiniteQueryOptions({
    queryKey: queryKeys.sessions.history(sessionId, generation, anchor),
    queryFn: ({ pageParam, signal }) =>
      sessionsApi.context(sessionId, {
        ...(pageParam.leafId === undefined ? {} : { leafId: pageParam.leafId }),
        ...(pageParam.before === undefined ? {} : { before: pageParam.before }),
        limit: TRANSCRIPT_PAGE_SIZE,
        signal,
      }),
    initialPageParam,
    getNextPageParam: (lastPage): SessionHistoryPageParam | undefined => {
      const cursor = lastPage.context.pageInfo.nextCursor;
      if (!lastPage.context.pageInfo.hasMore || cursor === undefined) return undefined;
      // Carry the FIRST page's resolved branch leaf in the page parameter. This
      // makes the cursor self-contained per query/session and prevents a mutable
      // ref from leaking A's branch into B during a fast session switch.
      return {
        ...(lastPage.context.leafId === undefined ? {} : { leafId: lastPage.context.leafId }),
        before: cursor,
      };
    },
    enabled,
    staleTime: 30_000,
    retry: false,
    retryOnMount: false,
  });
}
