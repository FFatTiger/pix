// Bounded SessionTree wire-contract projection tests.
//
// These are protocol-side projection tests for the bounded sessions.tree wire
// contract: the SessionTreeSchema must (a) accept bounded trees that carry the
// explicit `pageInfo` truncation metadata, (b) reject self-inconsistent
// pageInfo (never silent omission), and (c) keep enforcing the frozen preview
// contract (label cap + single-line). The numeric caps are mirrored here from
// the runtime-core authority (protocol cannot import runtime-core); the
// adapter-side parity test pins both sides to the same numbers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SESSION_TREE_DEPTH,
  MAX_SESSION_TREE_FRAME,
  MAX_SESSION_TREE_LABEL_LENGTH,
  MAX_SESSION_TREE_NODES,
  MAX_SESSION_TREE_SKIPPED_IDS,
  SessionTreeSchema,
} from "../dist/index.js";

const node = (entryId, over = {}) => ({
  entryId,
  kind: "assistant",
  label: "answer",
  truncated: false,
  children: [],
  ...over,
});

const baseTree = {
  sessionId: "s-1",
  currentLeafId: "e2",
  roots: [node("e1"), node("e2", { parentEntryId: "e1", skippedEntryIds: ["e1"] })],
  entryCount: 3,
};

describe("SessionTree bounded wire contract", () => {
  it("accepts a non-truncated tree without pageInfo (back-compatible)", () => {
    const parsed = SessionTreeSchema.parse(baseTree);
    assert.equal(parsed.entryCount, 3);
    assert.equal(parsed.pageInfo, undefined);
  });

  it("accepts a bounded tree with explicit pageInfo truncation", () => {
    const tree = {
      ...baseTree,
      pageInfo: { truncated: true, nodeCount: 2, skippedIdCount: 1, frameCount: 3 },
    };
    const parsed = SessionTreeSchema.parse(tree);
    assert.equal(parsed.pageInfo?.frameCount, 3);
  });

  it("round-trips a bounded tree through JSON", () => {
    const tree = {
      ...baseTree,
      pageInfo: { truncated: true, nodeCount: 5, skippedIdCount: 100, frameCount: 105 },
    };
    const json = JSON.parse(JSON.stringify(SessionTreeSchema.parse(tree)));
    assert.deepEqual(SessionTreeSchema.parse(json), tree);
  });

  it("rejects pageInfo whose frameCount is not nodeCount + skippedIdCount", () => {
    const tree = {
      ...baseTree,
      pageInfo: { truncated: true, nodeCount: 2, skippedIdCount: 1, frameCount: 4 },
    };
    const result = SessionTreeSchema.safeParse(tree);
    assert.equal(result.success, false, "self-inconsistent pageInfo must be rejected (never silent omission)");
  });

  it("rejects pageInfo that is not flagged truncated", () => {
    const tree = {
      ...baseTree,
      pageInfo: { truncated: false, nodeCount: 2, skippedIdCount: 1, frameCount: 3 },
    };
    assert.equal(SessionTreeSchema.safeParse(tree).success, false);
  });

  it("rejects pageInfo with negative or fractional counts", () => {
    for (const bad of [
      { truncated: true, nodeCount: -1, skippedIdCount: 1, frameCount: 0 },
      { truncated: true, nodeCount: 1, skippedIdCount: 1.5, frameCount: 2.5 },
      { truncated: true, nodeCount: 1, skippedIdCount: 1, frameCount: "2" },
    ]) {
      assert.equal(SessionTreeSchema.safeParse({ ...baseTree, pageInfo: bad }).success, false);
    }
  });

  it("mirrors the runtime-core tree limits (parity pins)", () => {
    // SINGLE DOMAIN AUTHORITY = packages/runtime-core/src/session.ts. These
    // MUST stay equal; the adapter parity test cross-checks both sides.
    assert.equal(MAX_SESSION_TREE_LABEL_LENGTH, 40);
    assert.equal(MAX_SESSION_TREE_DEPTH, 200);
    assert.equal(MAX_SESSION_TREE_NODES, 1000);
    assert.equal(MAX_SESSION_TREE_SKIPPED_IDS, 5000);
    assert.equal(MAX_SESSION_TREE_FRAME, 6000);
  });

  it("keeps enforcing the frozen preview contract (label cap + single-line)", () => {
    const over = { label: "x".repeat(MAX_SESSION_TREE_LABEL_LENGTH + 1) };
    assert.equal(SessionTreeSchema.safeParse({ ...baseTree, roots: [node("e1", over)] }).success, false, "label over the preview cap is rejected");
    const newline = { label: "two\nlines" };
    assert.equal(SessionTreeSchema.safeParse({ ...baseTree, roots: [node("e1", newline)] }).success, false, "multi-line labels are rejected");
    const ok = { label: "x".repeat(MAX_SESSION_TREE_LABEL_LENGTH) };
    assert.equal(SessionTreeSchema.safeParse({ ...baseTree, roots: [node("e1", ok)] }).success, true, "exactly at the cap is accepted");
  });
});
