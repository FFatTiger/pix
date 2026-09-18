/**
 * Phase 5A — `mergeTranscriptEntries` identity ghost-removal tables
 * (deterministic pure-function tests; NOT executed in this worktree —
 * validation pending).
 *
 * Pins:
 *  - POSITIVE: an optimistic entry bound to authority identity is dropped once
 *    the committed table (persisted page OR live tail) contains the bound
 *    userEntryId — even when the committed TEXT differs;
 *  - POSITIVE: a finalLeafId binding removes the ghost the same way when the
 *    user entry is the final leaf;
 *  - NEGATIVE: a wrong identity never removes — same text with a different
 *    entryId cannot consume an identity-bound bubble once the identity is
 *    KNOWN (userEntryId/finalLeafId reported);
 *  - REFINED BOUNDARY: an identity that is bound but still UNKNOWN (only the
 *    operationId; the authority has not reported the user entry id) falls
 *    through to the quarantined legacy branch (matching the live controller);
 *  - LEGACY isolation: identity-less entries keep the quarantined text/base
 *    fallback exactly as before (removal condition: Protocol v3 minimum +
 *    Phase 7 build contract);
 *  - a fresh identity-bound optimistic prompt stays before a later committed
 *    live assistant when its own early user completion was missed during the
 *    post-admission observation-attach window;
 *  - legacy entries with no base retain persisted → committed live → tail.
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@fffattiger/pix-protocol";
import type { OptimisticTurnIdentity } from "@/runtime/session-controller";
import { mergeTranscriptEntries } from "./use-session-transcript";

const user = (entryId: string, content: string, parentEntryId?: string): SessionEntry => ({
  entryId,
  ...(parentEntryId === undefined ? {} : { parentEntryId }),
  message: { role: "user", content },
});

const assistant = (entryId: string, text: string, parentEntryId?: string): SessionEntry => ({
  entryId,
  ...(parentEntryId === undefined ? {} : { parentEntryId }),
  message: { role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p" },
});

const identity = (overrides: Partial<OptimisticTurnIdentity> = {}): OptimisticTurnIdentity => ({
  operationId: "op-1",
  turnId: "turn-1",
  userEntryId: null,
  finalLeafId: null,
  ...overrides,
});

describe("mergeTranscriptEntries — Phase 5A identity ghost removal", () => {
  it("POSITIVE: bound userEntryId in the PERSISTED table removes the ghost even with different text", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "old"), assistant("a1", "answer", "u1"), user("u9", "committed text differs", "a1")],
      [],
      [{
        sessionId: "s1",
        baseEntryId: "a1",
        identity: identity({ userEntryId: "u9" }),
        entry: user("optimistic:1", "optimistic text"),
      }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "u9"]);
  });

  it("POSITIVE: bound userEntryId in the LIVE tail removes the ghost (refetched page not needed)", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "old")],
      [user("u42", "committed live", "u1")],
      [{
        sessionId: "s1",
        baseEntryId: "u1",
        identity: identity({ userEntryId: "u42" }),
        entry: user("optimistic:1", "optimistic text"),
      }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "u42"]);
  });

  it("POSITIVE: a finalLeafId binding removes the ghost when the user entry is the final leaf", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "old"), assistant("a1", "answer", "u1"), user("u7", "hello", "a1")],
      [],
      [{
        sessionId: "s1",
        baseEntryId: "a1",
        identity: identity({ finalLeafId: "u7" }),
        entry: user("optimistic:1", "hello"),
      }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "u7"]);
  });

  it("NEGATIVE: same TEXT but a different entryId never consumes an identity-bound bubble", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "repeat"), assistant("a1", "answer", "u1"), user("u2", "repeat", "a1")],
      [],
      [{
        sessionId: "s1",
        baseEntryId: "a1",
        identity: identity({ userEntryId: "u99" }),
        entry: user("optimistic:1", "repeat"),
      }],
    );
    // u2 carries the exact optimistic text on the exact base leaf, but the
    // bubble is bound to u99 — text matching is forbidden for identity-bound
    // entries; the bubble stays until u99 (or its own failure/rebase) settles.
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "u2", "optimistic:1"]);
  });

  it("REFINED BOUNDARY: identity bound but user/final id not yet reported falls through to the quarantined legacy branch", () => {
    // Unknown identity + matching text/base (legacy rule) → removed.
    const removed = mergeTranscriptEntries(
      [user("u1", "old"), assistant("a1", "answer", "u1"), user("u2", "repeat", "a1")],
      [],
      [{
        sessionId: "s1",
        baseEntryId: "a1",
        identity: identity(),
        entry: user("optimistic:1", "repeat"),
      }],
    );
    expect(removed.map((entry) => entry.entryId)).toEqual(["u1", "a1", "u2"]);
    // Unknown identity + NON-matching text/base → kept.
    const kept = mergeTranscriptEntries(
      [user("u1", "other"), user("u2", "unrelated", "u1")],
      [],
      [{
        sessionId: "s1",
        baseEntryId: "u1",
        identity: identity(),
        entry: user("optimistic:1", "repeat"),
      }],
    );
    expect(kept.map((entry) => entry.entryId)).toEqual(["u1", "u2", "optimistic:1"]);
  });

  it("LEGACY isolation: identity-less entries keep the quarantined text/base fallback exactly", () => {
    // Ghost removed by text+base equality (legacy).
    const ghost = mergeTranscriptEntries(
      [user("u1", "old"), assistant("a1", "answer", "u1"), user("u2", "repeat", "a1")],
      [],
      [{ sessionId: "s1", baseEntryId: "a1", entry: user("optimistic:1", "repeat") }],
    );
    expect(ghost.map((entry) => entry.entryId)).toEqual(["u1", "a1", "u2"]);
    // Different parent → retained (legacy base-leaf rule).
    const kept = mergeTranscriptEntries(
      [user("u1", "repeat"), assistant("a1", "answer", "u1")],
      [],
      [{ sessionId: "s1", baseEntryId: "a1", entry: user("optimistic:2", "repeat") }],
    );
    expect(kept.map((entry) => entry.entryId)).toEqual(["u1", "a1", "optimistic:2"]);
  });

  it("keeps a fresh optimistic user before a later live assistant when the early user event was missed", () => {
    const entries = mergeTranscriptEntries(
      [],
      [assistant("a1", "live answer", "hidden-user-entry")],
      [{
        sessionId: "s1",
        // Fresh Pi sessions can have a non-display model/thinking leaf before
        // the first user prompt, so this exact authority base is not present in
        // the rendered committed table.
        baseEntryId: "thinking-config-leaf",
        identity: identity(),
        entry: user("optimistic:1", "first prompt"),
      }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["optimistic:1", "a1"]);
  });

  it("places an existing-session optimism after its visible base and before the later live assistant", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "old"), assistant("a1", "old answer", "u1")],
      [assistant("a2", "new answer", "hidden-user-entry")],
      [{
        sessionId: "s1",
        baseEntryId: "a1",
        identity: identity(),
        entry: user("optimistic:2", "new prompt"),
      }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "optimistic:2", "a2"]);
  });

  it("keeps the finite legacy no-base ordering at the committed tail", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "old")],
      [assistant("a1", "live answer", "u1")],
      [{ sessionId: "s1", entry: user("optimistic:legacy", "new") }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "optimistic:legacy"]);
  });
});
