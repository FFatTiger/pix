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
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { SessionEntry } from "@fffattiger/pix-protocol";
import { createSessionHistoryQueryOptions, TRANSCRIPT_PAGE_SIZE } from "@/api/session-history";
import { useHttpClient } from "@/app/http-context";
import { useRuntime } from "@/runtime";
import type { OptimisticSessionEntry } from "@/runtime/session-store";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { isCompactionBoundary } from "@/components/transcript/chat-projection";

// Back-compat re-export: page size now lives with the centralized history
// query options (packages/client/src/api/session-history.ts).
export { TRANSCRIPT_PAGE_SIZE };

/**
 * Module-level single-flight lock for older-page fetches, keyed by the
 * serialized query key. The hook is shared (TranscriptList + Composer both
 * instantiate it), and React Query does not dedup back-to-back fetchNextPage
 * calls across observers — the lock collapses concurrent triggers into one
 * network request per key.
 */
const olderFlightKeys = new Set<string>();

/**
 * Upper bound on automatic turn-completion pages per history generation.
 * Opening a session must stay fast and calm: at most ONE automatic follow-up
 * page (so a turn sliced near its tail still renders collapsed), and longer
 * mid-turn fragments fall back to per-row rendering exactly like the legacy
 * web until the user scrolls up. This used to be 20 pages, which made opening
 * a tool-heavy session chain-load ~1000 entries with visible flicker.
 */
const MAX_TURN_COMPLETION_PAGES = 2;

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

function userEntryText(entry: SessionEntry): string | null {
  if (entry.message.role !== "user") return null;
  const content = entry.message.content;
  return (typeof content === "string"
    ? content
    : content.filter((block) => block.type === "text").map((block) => block.text).join("\n"))
    .trim();
}

/** Pure transcript transaction merge used by the hook and deterministic tests. */
export function mergeTranscriptEntries(
  persistedEntries: readonly SessionEntry[],
  liveEntries: readonly SessionEntry[],
  optimisticCandidates: readonly OptimisticSessionEntry[],
): SessionEntry[] {
  const committed = mergeLiveEntries(persistedEntries, liveEntries);
  const optimistic = optimisticCandidates
    .filter((candidate) => {
      if (candidate.baseEntryId === undefined) return true;
      const text = userEntryText(candidate.entry);
      return !committed.some((entry) =>
        !entry.entryId.startsWith("optimistic:")
        && userEntryText(entry) === text
        && (candidate.baseEntryId === null
          ? entry.parentEntryId === undefined
          : entry.parentEntryId === candidate.baseEntryId),
      );
    })
    .map((candidate) => candidate.entry);
  return mergeLiveEntries(committed, optimistic);
}

export function useSessionTranscript(options: UseSessionTranscriptOptions): SessionTranscript {
  const { sessionId, enabled, live } = options;
  const http = useHttpClient();
  const runtime = useRuntime();
  const { canBrowseSessions } = useCapabilities();
  // Live history layer: anchor/generation/live entries come from the store.
  const liveGeneration = live ? runtime.historyGeneration : 0;
  const liveAnchor = live ? runtime.historyAnchorLeafId : null;
  const liveEntries = live ? runtime.liveEntries : [];
  // UI-first transaction layer: selected-session optimistic entries render at
  // the chronological tail even while activation is still in flight and the
  // selected tab is not attached yet. Authority/live entries remain separate;
  // duplicate optimistic ids are removed by the same identity merge below.
  const optimisticCandidates = useMemo(
    () => runtime.optimisticEntries.filter((candidate) => candidate.sessionId === sessionId),
    [runtime.optimisticEntries, sessionId],
  );

  // Empty live snapshot (no leaf): skip history (a leaf-less request could race
  // a later append). Show live commits until a rebase provides an anchor.
  const historyEnabled =
    enabled &&
    canBrowseSessions &&
    Boolean(sessionId) &&
    !(live && liveAnchor === null);

  // Centralized history query: the SAME key/queryFn/cursor semantics the
  // sidebar prepare/ensure flow uses, so a prepared first page is the exact
  // cache this hook mounts against (no second request, no drift).
  const historyQueryOptions = createSessionHistoryQueryOptions({
    http,
    sessionId: sessionId ?? "",
    generation: liveGeneration,
    anchor: liveAnchor,
    enabled: historyEnabled,
  });
  const query = useInfiniteQuery(historyQueryOptions);
  const queryKey = historyQueryOptions.queryKey;

  const persistedPages = query.data?.pages ?? [];
  const persistedEntries = useMemo(
    () => flattenPersistedPages(persistedPages as { context: { entries: readonly SessionEntry[] } }[]),
    [persistedPages],
  );
  const entries = useMemo(
    () => mergeTranscriptEntries(persistedEntries, liveEntries, optimisticCandidates),
    [persistedEntries, liveEntries, optimisticCandidates],
  );
  const entryIds = useMemo(() => entries.map((entry) => entry.entryId), [entries]);

  // --- Turn-boundary completion ---------------------------------------------
  // The chat projection only renders the collapsed ProcessGroup for a turn
  // when it sees the turn's opening message (user prompt or compaction
  // boundary). A page boundary can slice a turn so the oldest loaded entry is
  // a mid-turn fragment (assistant / toolResult / bash) — those rows would
  // degrade to one-by-one rendering until the user scrolls enough to load the
  // turn's head. When the oldest loaded entry is a fragment, keep pulling
  // older pages automatically (bounded) so a whole turn is always rendered
  // collapsed.
  const boundaryKey = `${sessionId ?? ""}:${liveGeneration}:${liveAnchor ?? ""}`;
  const autoPagesRef = useRef({ key: "", count: 0 });
  if (autoPagesRef.current.key !== boundaryKey) autoPagesRef.current = { key: boundaryKey, count: 0 };

  const { hasNextPage, isFetchingNextPage } = query;
  const flightKey = JSON.stringify(queryKey);
  const fetchOlderOnce = useCallback((): void => {
    if (olderFlightKeys.has(flightKey)) return;
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    olderFlightKeys.add(flightKey);
    void query.fetchNextPage().finally(() => olderFlightKeys.delete(flightKey));
  }, [query, flightKey]);
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    if (autoPagesRef.current.key !== boundaryKey) return;
    if (autoPagesRef.current.count >= MAX_TURN_COMPLETION_PAGES) return;
    const oldestMessage = persistedEntries[0]?.message;
    if (oldestMessage === undefined) return;
    const startsCompleteTurn = oldestMessage.role === "user" || isCompactionBoundary(oldestMessage);
    if (startsCompleteTurn) return;
    autoPagesRef.current.count += 1;
    fetchOlderOnce();
  }, [persistedEntries, hasNextPage, isFetchingNextPage, fetchOlderOnce, boundaryKey]);

  const hasOlder = query.hasNextPage === true && query.isFetchingNextPage === false;
  const loadOlder = useCallback(() => {
    fetchOlderOnce();
  }, [fetchOlderOnce]);
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
