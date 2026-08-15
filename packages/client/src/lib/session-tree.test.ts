// BranchNavigator slice — client-side tree contract tests.
//
// 1. The tree response schema is STRICT: extra fields, malformed shapes and
//    non-canonical kinds are rejected, never coerced.
// 2. Query keys isolate the tree per session (never shared with context/list).
// 3. The pure helpers (active path, branch detection, leaf resolution) honor
//    the frozen live/history leaf semantics.
import { describe, expect, it } from "vitest";
import { SessionTreeSchema, type SessionTree } from "@fffattiger/pix-protocol";
import { SessionTreeResponseSchema } from "../api/schemas";
import { queryKeys } from "../api/query-keys";
import { urls } from "../api/urls";
import { activePathEntryIds, findTreeNodePath, hasBranchPoint, resolveActiveLeafId } from "./session-tree";

const node = (over: Record<string, unknown> = {}) => ({
  entryId: "e1",
  kind: "user",
  label: "hello",
  truncated: false,
  children: [],
  ...over,
});

const tree = (over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  currentLeafId: "e2",
  roots: [node({ children: [node({ entryId: "e2", kind: "assistant", label: "answer", skippedEntryIds: ["e1-5"] })] })],
  entryCount: 5,
  ...over,
});

describe("session tree response schema (strict DTO)", () => {
  it("accepts the canonical tree under `tree` and bare", () => {
    expect(SessionTreeResponseSchema.parse({ tree: tree() })).toEqual({ tree: tree() });
    expect(SessionTreeSchema.parse(tree())).toEqual(tree());
  });

  it("rejects extra fields at every level (never coerced)", () => {
    expect(() => SessionTreeSchema.parse(tree({ message: { role: "user" } }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ message: "raw" })] }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ sessionFile: "/raw/path.jsonl" }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ entries: [] }))).toThrow();
    expect(() => SessionTreeResponseSchema.parse({ tree: tree(), extra: 1 })).toThrow();
  });

  it("rejects malformed shapes and non-canonical kinds", () => {
    expect(() => SessionTreeSchema.parse(tree({ entryCount: -1 }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ currentLeafId: "" }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ kind: "sdk_treenode" })] }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ truncated: "yes" })] }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ skippedEntryIds: ["", "x"] })] }))).toThrow();
  });

  it("enforces the frozen single-line 40-char label cap", () => {
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ label: "x".repeat(41) })] }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ label: "two\nlines" })] }))).toThrow();
    expect(() => SessionTreeSchema.parse(tree({ roots: [node({ label: "x".repeat(40), truncated: true })] }))).not.toThrow();
  });
});

describe("session tree client wiring", () => {
  it("query keys isolate the tree per session id", () => {
    const a = queryKeys.sessions.tree("a");
    const b = queryKeys.sessions.tree("b");
    expect(a).not.toEqual(b);
    expect(a).toEqual(["pix", "sessions", "session", "a", "tree"]);
    expect(a).not.toEqual(queryKeys.sessions.context("a"));
    expect(a).not.toEqual(queryKeys.sessions.detail("a"));
  });

  it("the tree URL is a plain per-session path with no query surface", () => {
    expect(urls.sessions.tree("s 1")).toBe("/v1/sessions/s%201/tree");
  });
});

describe("pure tree helpers", () => {
  const linear = tree({ roots: [node({ children: [node({ entryId: "e9", kind: "assistant", label: "end", skippedEntryIds: ["e2", "e5"] })] })] }) as SessionTree;
  const branched = tree({
    currentLeafId: "b2",
    roots: [
      node({
        entryId: "root",
        children: [
          node({ entryId: "a1", kind: "assistant", label: "a" }),
          node({ entryId: "b1", kind: "assistant", label: "b", children: [node({ entryId: "b2", kind: "user", label: "b2" })] }),
        ],
      }),
    ],
  }) as SessionTree;

  it("findTreeNodePath resolves ids inside contracted chains (iteratively)", () => {
    const path = findTreeNodePath(linear.roots, "e2");
    expect(path?.map((n) => n.entryId)).toEqual(["e1", "e9"]);
    expect(findTreeNodePath(linear.roots, "missing")).toBeNull();
    expect(findTreeNodePath(linear.roots, null)).toBeNull();
  });

  it("activePathEntryIds includes the contracted chain ids of the path", () => {
    expect([...activePathEntryIds(linear.roots, "e2")].sort()).toEqual(["e1", "e2", "e5", "e9"]);
    expect(activePathEntryIds(linear.roots, "nope").size).toBe(0);
  });

  it("hasBranchPoint detects forks and rejects purely linear trees", () => {
    expect(hasBranchPoint(branched.roots)).toBe(true);
    expect(hasBranchPoint(linear.roots)).toBe(false);
  });

  it("resolveActiveLeafId: selected leaf wins, persisted head is the default, absent resolves null", () => {
    expect(resolveActiveLeafId(branched, "a1")).toBe("a1");
    expect(resolveActiveLeafId(branched)).toBe("b2");
    // A live snapshot leaf that was never persisted honestly resolves null —
    // the tree never fabricates persistence.
    expect(resolveActiveLeafId(branched, "live-only-leaf")).toBeNull();
    expect(resolveActiveLeafId({ ...branched, currentLeafId: undefined })).toBeNull();
  });
});
