import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SessionDetailSchema,
  SessionHeaderSchema,
  SessionsListResultSchema,
  WORKSPACE_ACCESS_REASONS,
  WORKSPACE_ACCESS_REASONS_BY_STATE,
  WORKSPACE_ACCESS_STATES,
  WorkspaceAccessSchema,
  readWorkspaceAccess,
} from "../dist/index.js";

const BASE = { sessionId: "s-1", cwd: "/p", projectRoot: "/p" };

describe("Protocol v2 additive workspaceAccess", () => {
  it("accepts the exact tri-state with matching reasons", () => {
    assert.deepEqual([...WORKSPACE_ACCESS_STATES], ["authorized", "history_only", "unavailable"]);
    assert.deepEqual([...WORKSPACE_ACCESS_REASONS], [
      "allowed_root",
      "outside_allowed_roots",
      "symlink_escape",
      "missing",
      "deleted",
      "unreadable",
      "unresolvable",
      "malformed",
    ]);
    assert.deepEqual(
      WorkspaceAccessSchema.parse({ state: "authorized", reason: "allowed_root" }),
      { state: "authorized", reason: "allowed_root" },
    );
    assert.deepEqual(
      WorkspaceAccessSchema.parse({ state: "history_only", reason: "outside_allowed_roots" }),
      { state: "history_only", reason: "outside_allowed_roots" },
    );
    assert.deepEqual(
      WorkspaceAccessSchema.parse({ state: "history_only", reason: "symlink_escape" }),
      { state: "history_only", reason: "symlink_escape" },
    );
    for (const reason of WORKSPACE_ACCESS_REASONS_BY_STATE.unavailable) {
      assert.equal(
        WorkspaceAccessSchema.parse({ state: "unavailable", reason }).reason,
        reason,
      );
    }
  });

  it("rejects extra fields, unknown states, and cross-state reasons", () => {
    assert.equal(WorkspaceAccessSchema.safeParse({ state: "authorized" }).success, false);
    assert.equal(WorkspaceAccessSchema.safeParse({ state: "live", reason: "allowed_root" }).success, false);
    assert.equal(WorkspaceAccessSchema.safeParse({
      state: "authorized",
      reason: "allowed_root",
      extra: true,
    }).success, false);
    assert.equal(WorkspaceAccessSchema.safeParse({
      state: "authorized",
      reason: "outside_allowed_roots",
    }).success, false, "authorized must never pair with a history_only reason");
    assert.equal(WorkspaceAccessSchema.safeParse({
      state: "history_only",
      reason: "allowed_root",
    }).success, false);
    assert.equal(WorkspaceAccessSchema.safeParse({
      state: "unavailable",
      reason: "allowed_root",
    }).success, false);
  });

  it("treats a missing v2 field as unknown legacy and never guesses authorized", () => {
    const parsed = SessionHeaderSchema.parse(BASE);
    assert.equal(parsed.workspaceAccess, undefined);
    assert.equal(readWorkspaceAccess(parsed), undefined);
    assert.equal(SessionHeaderSchema.safeParse({ ...BASE, workspaceAccess: { state: "authorized" } }).success, false);
    const current = SessionHeaderSchema.parse({
      ...BASE,
      workspaceAccess: { state: "history_only", reason: "outside_allowed_roots" },
    });
    assert.deepEqual(current.workspaceAccess, {
      state: "history_only",
      reason: "outside_allowed_roots",
    });
    const detail = SessionDetailSchema.parse({
      ...BASE,
      entries: [],
    });
    assert.equal(detail.workspaceAccess, undefined);
    const legacyList = SessionsListResultSchema.parse({ sessions: [BASE], page: 1, pageSize: 50, total: 1, totalPages: 1, catalogRevision: 1 });
    assert.equal(legacyList.sessions[0].workspaceAccess, undefined);
    const currentList = SessionsListResultSchema.parse({
      sessions: [{ ...BASE, workspaceAccess: { state: "authorized", reason: "allowed_root" } }],
      page: 1,
      pageSize: 50,
      total: 1,
      totalPages: 1,
      catalogRevision: 1,
    });
    assert.deepEqual(currentList.sessions[0].workspaceAccess, {
      state: "authorized",
      reason: "allowed_root",
    });
  });
});
