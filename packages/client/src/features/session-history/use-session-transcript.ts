/**
 * useSessionTranscript — shared Protocol v2 transcript history hook.
 *
 * Replaces the old `RuntimeView.messages` dependency. Live committed entries
 * come from the SessionStore history layer (`historyGeneration` /
 * `historyAnchorLeafId` / `liveEntries`), persisted history comes from the
 * cursor-paginated `GET /v1/sessions/:id/context` endpoint via a single
 * `useInfiniteQuery`:
 *
 *  - the query key includes (sessionId, historyGeneration, anchor leaf) so a
 *    fresh attach / epoch / branch / count rebase invalidates and refetches the
 *    newest 50;
 *  - the FIRST page resolves the branch leafId, which the hook pins for all
 *    older-page requests so later appends cannot shift pagination;
 *  - pages are flattened chronologically and deduped by persisted entryId, then
 *    live committed entries are appended EXCLUDING ids already persisted;
 *  - capability withdrawal disables the query immediately (cached history is
 *    hidden, never served stale);
 *  - an empty live snapshot (no leaf) skips history entirely and shows live
 *    commits only, so a leaf-less request can never race a later append.
 *
 * TranscriptList, Composer, SessionInfoBar labels/stats and the minimap all
 * consume this single merged entry list so no surface can drift.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { SessionEntry } from "@fffattiger/pix-protocol";
import { createSessionsApi } from "@/api/sessions";
import { queryKeys } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useRuntime } from "@/runtime";
import { useCapabilities } from "@/features/capability/CapabilityProvider";

/** Default first-page size (Protocol v2 default; bounded 1..200 server-side). */
export const TRANSCRIPT_PAGE_SIZE = 50;

export interface SessionTranscript {
  /** Merged chronological entries (persisted pages + committed live entries). */
  readonly entries: readonly SessionEntry[];
  /** Persisted entryId per entry index (live entries use their own ids). */
  readonly entryIds: readonly string[];
  /** True when older persisted entries exist (upward load available). */
  readonly hasOlder: boolean;
  /** True while an older page is being fetched. */
  readonly isFetchingOlder: boolean;
  /** True while the first page is loading. */
  readonly isFetchingInitial: boolean;
  /** Fetch the next older page (no-op when nothing older / already fetching). */
  loadOlder(): void;
  /** Refetch the newest page (e.g. branch navigate / compaction rebase). */
  refetch(): void;
  /** True when history is unavailable (error). */
  readonly error: boolean;
}

export interface UseSessionTranscriptOptions {
  /** Selected session id; null/empty disables the query. */
  readonly sessionId: string | null;
  /** Overall gating (e.g. history-mode flag). */
  readonly enabled: boolean;
  /** True when the selected session IS the attached runtime (live layer). */
  readonly live: boolean;
}

/**
 * Flatten persisted pages chronologically (pages arrive newest-first) and dedupe
 * by persisted entryId. Each page is already chronological within itself.
 */
function flattenPersistedPages(pages: readonly { context: { entries: readonly SessionEntry[] } }[]): SessionEntry[] {
  const seen = new Set<string>();
  const out: SessionEntry[] = [];
  // useInfiniteQuery appends newest-first; reverse for oldest→newest order.
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const page = pages[index];
    if (!page) continue;
    for (const entry of page.context.entries) {
      if (seen.has(entry.entryId)) continue;
      seen.add(entry.entryId);
      out.push(entry);
    }
  }
  return out;
}

/** Append committed live entries, excluding ids already persisted. */
function mergeLiveEntries(persisted: readonly SessionEntry[], live: readonly SessionEntry[]): SessionEntry[] {
  if (live.length === 0) return [...persisted];
  const persistedIds = new Set(persisted.map((entry) => entry.entryId));
  const out = [...persisted];
  for (const entry of live) {
    if (persistedIds.has(entry.entryId)) continue;
    persistedIds.add(entry.entryId);
    out.push(entry);
  }
  return out;
}

export function useSessionTranscript(options: UseSessionTranscriptOptions): SessionTranscript {
  const { sessionId, enabled, live } = options;
  const http = useHttpClient();
  const runtime = useRuntime();
  const { canBrowseSessions } = useCapabilities();
  const sessionsApi = createSessionsApi(http);
  // Live history layer: anchor/generation/live entries come from the store.
  const liveGeneration = live ? runtime.historyGeneration : 0;
  const liveAnchor = live ? runtime.historyAnchorLeafId : null;
  const liveEntries = live ? runtime.liveEntries : [];

  // Empty live snapshot (no leaf): skip history (a leaf-less request could race
  // a later append). Show live commits until a rebase provides an anchor.
  const historyEnabled =
    enabled &&
    canBrowseSessions &&
    Boolean(sessionId) &&
    !(live && liveAnchor === null);

  type HistoryPageParam = { readonly leafId?: string; readonly before?: string };
  const initialPageParam: HistoryPageParam = liveAnchor === null ? {} : { leafId: liveAnchor };

  const query = useInfiniteQuery({
    queryKey: queryKeys.sessions.history(sessionId ?? "", liveGeneration, liveAnchor),
    queryFn: ({ pageParam, signal }) => sessionsApi.context(sessionId ?? "", {
      ...(pageParam.leafId === undefined ? {} : { leafId: pageParam.leafId }),
      ...(pageParam.before === undefined ? {} : { before: pageParam.before }),
      limit: TRANSCRIPT_PAGE_SIZE,
      signal,
    }),
    initialPageParam,
    getNextPageParam: (lastPage): HistoryPageParam | undefined => {
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
    enabled: historyEnabled,
    staleTime: 30_000,
  });

  const persistedPages = query.data?.pages ?? [];
  const persistedEntries = useMemo(
    () => flattenPersistedPages(persistedPages as { context: { entries: readonly SessionEntry[] } }[]),
    [persistedPages],
  );
  const entries = useMemo(
    () => mergeLiveEntries(persistedEntries, liveEntries),
    [persistedEntries, liveEntries],
  );
  const entryIds = useMemo(() => entries.map((entry) => entry.entryId), [entries]);

  const hasOlder = query.hasNextPage === true && query.isFetchingNextPage === false;
  const loadOlder = useCallback(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [query]);
  const refetch = useCallback(() => { void query.refetch(); }, [query]);

  return {
    entries,
    entryIds,
    hasOlder,
    isFetchingOlder: query.isFetchingNextPage,
    isFetchingInitial: query.isPending && historyEnabled,
    loadOlder,
    refetch,
    error: query.isError === true,
  };
}
