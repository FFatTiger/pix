/**
 * useSessionTranscript — shared Protocol v2 transcript history hook.
 *
 * Replaces the old merged-view `messages` dependency. Live committed entries
 * come from the exact controller history layer (`historyGeneration` /
 * `historyAnchorLeafId` / `liveEntries`), persisted history comes from ONE
 * complete lightweight `GET /v1/sessions/:id/context` response (deferThinking
 * + deferMedia, no limit ⇒ the complete active branch, `hasMore:false`) via a
 * single `useQuery`:
 *
 *  - the query key includes (sessionId, historyGeneration, anchor leaf) so a
 *    fresh attach / epoch / branch / count rebase invalidates and refetches
 *    one complete response;
 *  - persisted entries are chronological and complete, then live committed
 *    entries are appended EXCLUDING ids already persisted;
 *  - capability withdrawal disables the query immediately (cached history is
 *    hidden, never served stale);
 *  - an empty live snapshot (no leaf) skips history entirely and shows live
 *    commits only, so a leaf-less request can never race a later append.
 *
 * TranscriptList, Composer, SessionInfoBar labels/stats and the minimap all
 * consume this single merged entry list so no surface can drift. Older-entry
 * reveal is a LOCAL TranscriptList window over this complete list — the server
 * never paginates.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type {
  ModelSelector,
  SessionEntry,
  ThinkingLevel,
} from "@fffattiger/pix-protocol";
import { createSessionHistoryQueryOptions } from "@/api/session-history";
import { useHttpClient } from "@/app/http-context";
import { useRuntime } from "@/runtime";
import type { OptimisticSessionEntry } from "@/runtime/session-controller";
import { useCapabilities } from "@/features/capability/CapabilityProvider";

export interface SessionTranscript {
  /** Merged chronological entries (persisted complete branch + committed live entries). */
  readonly entries: readonly SessionEntry[];
  /** Persisted entryId per entry index (live entries use their own ids). */
  readonly entryIds: readonly string[];
  /**
   * Exact JSONL model resolved on the selected branch. `null` means the file
   * records no model; `undefined` means the additive v2 metadata is not yet
   * available (loading/error/older daemon). Never replace it with a catalog
   * default when rendering an existing detached session.
   */
  readonly persistedModel: ModelSelector | null | undefined;
  /** Exact JSONL thinking level on the selected branch; undefined = unknown. */
  readonly persistedThinkingLevel: ThinkingLevel | undefined;
  /**
   * Estimated context tokens of the FULL raw selected branch, from the SAME
   * `/sessions/:id/context` response that resolved {@link persistedModel}
   * (adapter's shared estimator — identical arithmetic to the live usage).
   * `null` = honestly unknown (post-compaction); `undefined` = the additive
   * v2 field is not available (loading/error/older daemon). Never combined
   * with anything but the exact displayed model's catalog window.
   */
  readonly contextTokens: number | null | undefined;
  /** True while the complete history response is loading. */
  readonly isFetchingInitial: boolean;
  /** Refetch the complete history (e.g. branch navigate / compaction rebase). */
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
  const committedEntryIds = new Set(committed.map((entry) => entry.entryId));
  const survivingOptimistic = optimisticCandidates
    .filter((candidate) => {
      // Phase 5A: an optimistic entry bound to authority identity is removed
      // by EXACT IDENTITY ONLY — the committed userEntryId (or finalLeafId when
      // the user entry is the final leaf) appearing anywhere in the merged
      // committed table (persisted page OR live tail). Never by text: a
      // same-text historical entry can never consume an identity-bound bubble,
      // and a wrong identity never removes it.
      const identity = candidate.identity;
      if (identity !== undefined) {
        // KNOWN identity (userEntryId, or finalLeafId when the user entry is
        // the final leaf): remove by EXACT IDENTITY ONLY — the bound id
        // appearing anywhere in the merged committed table (persisted page OR
        // live tail). Never by text: a same-text historical entry can never
        // consume it, and a wrong identity never removes it.
        if (identity.userEntryId !== null) return !committedEntryIds.has(identity.userEntryId);
        if (identity.finalLeafId !== null) return !committedEntryIds.has(identity.finalLeafId);
        // Identity bound (operationId) but the authority has not reported the
        // user entry id yet → fall through to the quarantined legacy branch
        // below (bounded by the same removal condition), matching the live
        // controller semantics.
      }
      // LEGACY Protocol-v2 prompt text fallback — QUARANTINED to entries with
      // NO KNOWN authority identity (legacy command-envelope prompt / queued
      // turns, or a negotiated turn before its userEntryId/finalLeafId is
      // reported). Removal condition: Protocol v3 minimum version + Phase 7
      // build contract (runtime.submit-turn.v1 universal ⇒ every prompt
      // carries and reports an operation identity); delete this branch
      // together with the legacy submit shim (migration ledger §72).
      if (candidate.baseEntryId === undefined) return true;
      const text = userEntryText(candidate.entry);
      return !committed.some((entry) =>
        !entry.entryId.startsWith("optimistic:")
        && userEntryText(entry) === text
        && (candidate.baseEntryId === null
          ? entry.parentEntryId === undefined
          : entry.parentEntryId === candidate.baseEntryId),
      );
    });

  // Place surviving optimistic USER entries at their transaction boundary,
  // never blindly after the committed live tail. A fresh submit can commit its
  // user entry before the Browser's post-admission observation attach; that
  // early event is then absent from `liveEntries` while a later assistant
  // completion is present. Tail-appending would render AI before the user's
  // still-valid optimistic bubble until refresh.
  //
  // The persisted table remains the chronological prefix. For an optimism with
  // a known base, insert no earlier than the persisted/live boundary and after
  // the base when it is visible. If the base is a non-display JSONL entry
  // (model/thinking/custom metadata), identity-bound submit optimism still
  // belongs immediately before the live tail. Legacy entries with no base keep
  // the finite Protocol-v2 tail behavior.
  const persistedIds = new Set(persistedEntries.map((entry) => entry.entryId));
  const committedLiveIds = new Set(
    liveEntries
      .filter((entry) => !persistedIds.has(entry.entryId))
      .map((entry) => entry.entryId),
  );
  const merged = [...committed];
  for (const candidate of survivingOptimistic) {
    const firstLiveIndex = merged.findIndex((entry) => committedLiveIds.has(entry.entryId));
    const liveBoundary = firstLiveIndex === -1 ? merged.length : firstLiveIndex;
    const baseIndex = candidate.baseEntryId === null || candidate.baseEntryId === undefined
      ? -1
      : merged.findIndex((entry) => entry.entryId === candidate.baseEntryId);
    const insertionIndex = candidate.baseEntryId === undefined
      ? merged.length
      : baseIndex >= 0
        ? Math.max(baseIndex + 1, liveBoundary)
        : candidate.identity !== undefined || candidate.baseEntryId === null
          ? liveBoundary
          : merged.length;
    merged.splice(insertionIndex, 0, candidate.entry);
  }
  return merged;
}

export function useSessionTranscript(options: UseSessionTranscriptOptions): SessionTranscript {
  const { sessionId, enabled, live } = options;
  const http = useHttpClient();
  // Exact per-session runtime (4A.3.2b1a): the exact hook is ID-bound, so there
  // is no facade current/foreground/session filter and no cross-session
  // optimism. committed live entries (`liveEntries`) and exact optimistic
  // entries (`optimisticEntries`) are already scoped to the bound sessionId.
  // An unadmitted selected session returns a stable `available:false` wrapper
  // with empty live/optimistic arrays — the transcript stays HTTP-only with
  // ZERO controller/admission/attach. Retained detached exact controller data
  // may still be projected here (no forced eviction), but the `live` gate below
  // keeps history-mode rendering identical to before.
  const runtime = useRuntime(sessionId);
  const { canBrowseSessions } = useCapabilities();
  // Live history layer: anchor/generation/live entries come from the exact
  // per-session controller (committed only; optimism lives in optimisticEntries).
  const liveGeneration = live && runtime !== null ? runtime.historyGeneration : 0;
  const liveAnchor = live && runtime !== null ? runtime.historyAnchorLeafId : null;
  const liveEntries = live && runtime !== null ? runtime.liveEntries : [];
  // UI-first transaction layer: exact optimistic entries render at the
  // chronological tail even while activation is still in flight and the
  // selected tab is not attached yet. The exact controller's optimistic set is
  // already session-scoped (no sessionId filter needed); the same identity
  // merge below removes duplicate optimistic ids.
  const optimisticCandidates = useMemo(
    () => (runtime === null ? [] : runtime.optimisticEntries),
    [runtime],
  );

  // Empty live snapshot (no leaf): skip history (a leaf-less request could race
  // a later append). Show live commits until a rebase provides an anchor.
  const historyEnabled =
    enabled &&
    canBrowseSessions &&
    Boolean(sessionId) &&
    !(live && liveAnchor === null);

  // Centralized history query: the SAME key/queryFn semantics every history
  // consumer uses — one complete deferred (thinking/media) branch response.
  const historyQueryOptions = createSessionHistoryQueryOptions({
    http,
    sessionId: sessionId ?? "",
    generation: liveGeneration,
    anchor: liveAnchor,
    enabled: historyEnabled,
  });
  const query = useQuery(historyQueryOptions);

  // The query itself is the committed-history owner: `placeholderData` (same
  // session) keeps the previous COMPLETE response — entries, settings and
  // contextTokens as one consistent snapshot — while a revision bump
  // (activation, turn-end leaf fence, rebase) is still in flight, so the
  // transcript never blanks and never mixes old rows with new metadata.
  const persistedEntries = useMemo(
    () => query.data?.context.entries ?? [],
    [query.data],
  );
  const entries = useMemo(
    () => mergeTranscriptEntries(persistedEntries, liveEntries, optimisticCandidates),
    [persistedEntries, liveEntries, optimisticCandidates],
  );
  const entryIds = useMemo(() => entries.map((entry) => entry.entryId), [entries]);
  // Branch-wide metadata repeated on the complete response by the Host.
  const persistedSettings = query.data?.context.settings;

  const refetch = useCallback(() => { void query.refetch(); }, [query]);

  return {
    entries,
    entryIds,
    persistedModel: persistedSettings?.model,
    persistedThinkingLevel: persistedSettings?.thinkingLevel,
    contextTokens: query.data?.context.contextTokens,
    isFetchingInitial: query.isPending && historyEnabled,
    refetch,
    error: query.isError === true,
  };
}
