/**
 * SessionRevision — the comparable per-session revision fence (Phase 5A).
 *
 * A `SessionRevision` pairs the two wire cursor fields every runtime event and
 * authoritative snapshot already carry (`epoch` + `eventId`) into ONE strict,
 * comparable value. It identifies "the session journal position" of a JSONL
 * read model, a runtime snapshot, or a live event so the history/live merge can
 * prove continuity instead of guessing.
 *
 * Comparability rules (FROZEN):
 *  - `eventId` order is meaningful ONLY inside one `epoch` (same-epoch order
 *    only). Revisions from different epochs are INCOMPARABLE — never ordered,
 *    never subtracted, never "best-effort" merged. An epoch change is always an
 *    explicit rebase, never an incremental merge.
 *  - `eventId` is the canonical journal event id (`EventIdSchema`, a positive
 *    safe integer). Cursor 0 is NOT a revision: `0` is the "no events yet"
 *    resume cursor (`LastEventIdSchema`), never a comparable journal position —
 *    a revision is never guessed and never defaulted (fail closed).
 *  - Two revisions are the SAME position only by exact leaf equality of both
 *    fields (`epoch` string equality + `eventId` numeric equality). No
 *    prefix/approximate matching.
 *
 * NOT a session revision (explicit):
 *  - `TurnStatus.revision` (packages/protocol/src/turns.ts) is a per-TURN
 *    status revision — the monotonic sequence number of status pushes for ONE
 *    admitted turn. It is scoped to `(sessionId, epoch, operationId, turnId)`,
 *    starts at 0, and is NEVER comparable with a `SessionRevision` (nor across
 *    turns). Mixing the two is a defect: turn status ordering never proves
 *    journal continuity.
 *  - `RuntimeRunningState.revision` (sessiond watch baseline) is a global
 *    running-projection revision — also not a session journal position.
 */

import { z } from "zod";
import { EpochSchema, EventIdSchema } from "./common.js";

/**
 * Strict comparable session revision fence: `{ epoch, eventId }`.
 * Extra/missing fields fail closed (strictObject), `eventId` must be a
 * positive safe integer, `epoch` a non-empty opaque string token.
 */
export const SessionRevisionSchema = z.strictObject({
  epoch: EpochSchema,
  eventId: EventIdSchema,
});
export type SessionRevision = z.infer<typeof SessionRevisionSchema>;

/**
 * Ordering result for two session revisions. `"incomparable"` is returned for
 * any cross-epoch pair (and is the ONLY cross-epoch answer — callers must
 * rebase, never guess).
 */
export type SessionRevisionOrder = "before" | "equal" | "after" | "incomparable";

/**
 * Compare two session revisions. Same epoch → strict `eventId` ordering
 * (`before` = `a` is strictly older). Different epoch → `"incomparable"`
 * (same-epoch order only; there is no cross-epoch order and no fallback).
 */
export function compareSessionRevisions(
  a: SessionRevision,
  b: SessionRevision,
): SessionRevisionOrder {
  if (a.epoch !== b.epoch) return "incomparable";
  if (a.eventId === b.eventId) return "equal";
  return a.eventId < b.eventId ? "before" : "after";
}

/**
 * Exact session-revision equality: both fields must match (`epoch` string
 * equality + `eventId` numeric equality). Leaf equality only — no
 * approximation, no epoch-insensitive comparison.
 */
export function isSameSessionRevision(a: SessionRevision, b: SessionRevision): boolean {
  return a.epoch === b.epoch && a.eventId === b.eventId;
}

/**
 * True only when `candidate` is the PROVABLE immediate successor of `base`
 * (same epoch, `eventId === base.eventId + 1`). This is the single continuity
 * predicate for incremental merges of live events onto an authoritative
 * position: anything else (gap, duplicate, cross-epoch) is NOT continuous and
 * the caller must rebase. Never true for a cross-epoch pair, never true for a
 * guessed/cursor-0 revision.
 */
export function isNextSessionRevision(base: SessionRevision, candidate: SessionRevision): boolean {
  if (base.epoch !== candidate.epoch) return false;
  return candidate.eventId === base.eventId + 1;
}
