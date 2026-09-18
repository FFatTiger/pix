/**
 * Phase 5A SessionRevision contract tests (deterministic; NOT executed in this
 * worktree — validation pending).
 *
 * Pins:
 *  - strict schema shape {epoch, eventId} (extras/missing/blank/non-int fail);
 *  - cursor 0 / negative / fractional eventIds are NOT revisions (a revision is
 *    never guessed and never defaulted from the "no events yet" cursor);
 *  - same-epoch ordering only: before/equal/after inside one epoch;
 *  - cross-epoch pairs are ALWAYS incomparable (no order, no fallback);
 *  - exact-leaf equality (epoch string equality + eventId numeric equality);
 *  - continuity predicate: only same-epoch eventId+1 is the successor (gap /
 *    duplicate / cross-epoch are not continuous);
 *  - TurnStatus.revision is a per-turn status sequence — the schema keeps it a
 *    bare nonnegative int and it never validates as a SessionRevision.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EventIdSchema,
  LastEventIdSchema,
  SessionRevisionSchema,
  TurnStatusSchema,
  compareSessionRevisions,
  isNextSessionRevision,
  isSameSessionRevision,
} from "../dist/index.js";

describe("SessionRevision schema (strict {epoch, eventId})", () => {
  it("accepts exactly {epoch: non-empty string, eventId: positive safe int}", () => {
    const parsed = SessionRevisionSchema.parse({ epoch: "e1", eventId: 1 });
    assert.deepEqual(parsed, { epoch: "e1", eventId: 1 });
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "worker-restart-2", eventId: 9007199254740991 }).success, true);
  });

  it("rejects missing fields, blank epoch, and unknown extra fields (strict)", () => {
    assert.equal(SessionRevisionSchema.safeParse({ eventId: 1 }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1" }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "", eventId: 1 }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: 1, extra: true }).success, false);
    assert.equal(SessionRevisionSchema.safeParse("e1:1").success, false);
  });

  it("rejects guessed / cursor-0 / non-integer eventIds (a revision is a journal event id, never the zero cursor)", () => {
    // Cursor 0 is the resume "no events yet" sentinel (LastEventIdSchema), not a
    // comparable journal position — it must never validate as a revision.
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: 0 }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: -1 }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: 1.5 }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: "1" }).success, false);
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: Number.MAX_SAFE_INTEGER + 1 }).success, false);
    // The wire domains stay distinct: eventId is positive, lastEventId is the
    // nonnegative resume cursor (0 = no events yet).
    assert.equal(EventIdSchema.safeParse(0).success, false);
    assert.equal(LastEventIdSchema.safeParse(0).success, true);
  });
});

describe("SessionRevision comparability (same-epoch order only)", () => {
  it("orders strictly by eventId inside one epoch", () => {
    assert.equal(compareSessionRevisions({ epoch: "e1", eventId: 1 }, { epoch: "e1", eventId: 2 }), "before");
    assert.equal(compareSessionRevisions({ epoch: "e1", eventId: 2 }, { epoch: "e1", eventId: 1 }), "after");
    assert.equal(compareSessionRevisions({ epoch: "e1", eventId: 7 }, { epoch: "e1", eventId: 7 }), "equal");
  });

  it("returns incomparable for ANY cross-epoch pair — never ordered, never a fallback", () => {
    assert.equal(compareSessionRevisions({ epoch: "e1", eventId: 1 }, { epoch: "e2", eventId: 1 }), "incomparable");
    assert.equal(compareSessionRevisions({ epoch: "e1", eventId: 1 }, { epoch: "e2", eventId: 1000 }), "incomparable");
    assert.equal(compareSessionRevisions({ epoch: "e1", eventId: 1000 }, { epoch: "e2", eventId: 1 }), "incomparable");
  });

  it("equality is exact leaf equality of both fields", () => {
    assert.equal(isSameSessionRevision({ epoch: "e1", eventId: 3 }, { epoch: "e1", eventId: 3 }), true);
    assert.equal(isSameSessionRevision({ epoch: "e1", eventId: 3 }, { epoch: "e1", eventId: 4 }), false);
    assert.equal(isSameSessionRevision({ epoch: "e1", eventId: 3 }, { epoch: "e2", eventId: 3 }), false);
  });

  it("continuity: only same-epoch eventId+1 is the immediate successor", () => {
    assert.equal(isNextSessionRevision({ epoch: "e1", eventId: 4 }, { epoch: "e1", eventId: 5 }), true);
    // gap → not continuous (explicit rebase)
    assert.equal(isNextSessionRevision({ epoch: "e1", eventId: 4 }, { epoch: "e1", eventId: 6 }), false);
    // duplicate / regress → not continuous
    assert.equal(isNextSessionRevision({ epoch: "e1", eventId: 4 }, { epoch: "e1", eventId: 4 }), false);
    assert.equal(isNextSessionRevision({ epoch: "e1", eventId: 4 }, { epoch: "e1", eventId: 3 }), false);
    // cross-epoch → never continuous
    assert.equal(isNextSessionRevision({ epoch: "e1", eventId: 4 }, { epoch: "e2", eventId: 5 }), false);
  });
});

describe("TurnStatus.revision is explicitly NOT a session revision", () => {
  it("keeps its per-turn status domain (nonnegative int from 0) and never parses as a SessionRevision", () => {
    const status = TurnStatusSchema.parse({
      sessionId: "s1",
      epoch: "e1",
      operationId: "op-1",
      turnId: "turn-1",
      revision: 0,
      state: "admitted",
    });
    assert.equal(status.revision, 0);
    // A turn status revision (bare number from 0) is NOT a {epoch, eventId}
    // session revision — the shapes/domains never interchange.
    assert.equal(SessionRevisionSchema.safeParse({ epoch: "e1", eventId: status.revision }).success, false);
    assert.equal(SessionRevisionSchema.safeParse(status).success, false);
  });
});
