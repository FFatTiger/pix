/**
 * Cross-package workspace-access contract — Phase 6A parity between the
 * runtime-core authority and the Protocol v2 additive projection.
 *
 * Absence of the wire field is unknown legacy and must never be coerced to
 * `authorized`. Protocol cannot import runtime-core; these tests pin both
 * copies by semantic equality.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKSPACE_ACCESS_REASONS as CANONICAL_REASONS,
  WORKSPACE_ACCESS_REASONS_BY_STATE as CANONICAL_REASONS_BY_STATE,
  WORKSPACE_ACCESS_STATES as CANONICAL_STATES,
  combineWorkspaceAccess,
  type WorkspaceAccess as CanonicalWorkspaceAccess,
} from "@fffattiger/pix-runtime-core";
import {
  SessionHeaderSchema,
  WORKSPACE_ACCESS_REASONS as WIRE_REASONS,
  WORKSPACE_ACCESS_REASONS_BY_STATE as WIRE_REASONS_BY_STATE,
  WORKSPACE_ACCESS_STATES as WIRE_STATES,
  WorkspaceAccessSchema,
  readWorkspaceAccess,
  type WorkspaceAccess as WireWorkspaceAccess,
} from "@fffattiger/pix-protocol";

const canonicalToWire = (value: CanonicalWorkspaceAccess): WireWorkspaceAccess => value;
const wireToCanonical = (value: WireWorkspaceAccess): CanonicalWorkspaceAccess => value;

const PROBES: readonly CanonicalWorkspaceAccess[] = [
  { state: "authorized", reason: "allowed_root" },
  { state: "history_only", reason: "outside_allowed_roots" },
  { state: "history_only", reason: "symlink_escape" },
  { state: "unavailable", reason: "missing" },
  { state: "unavailable", reason: "deleted" },
  { state: "unavailable", reason: "unreadable" },
  { state: "unavailable", reason: "unresolvable" },
  { state: "unavailable", reason: "malformed" },
];

test("protocol workspace-access vocabulary is semantically identical to runtime-core", () => {
  assert.deepEqual([...WIRE_STATES], [...CANONICAL_STATES]);
  assert.deepEqual([...WIRE_REASONS], [...CANONICAL_REASONS]);
  assert.deepEqual(
    { ...WIRE_REASONS_BY_STATE },
    { ...CANONICAL_REASONS_BY_STATE },
  );
});

test("workspaceAccess wire projection is semantically identical to runtime-core", () => {
  for (const canonical of PROBES) {
    const wire = canonicalToWire(canonical);
    assert.deepEqual(WorkspaceAccessSchema.parse(wire), canonical);
    assert.deepEqual(wireToCanonical(wire), canonical);
  }
});

test("legacy v2 headers without workspaceAccess stay unknown, never authorized", () => {
  const legacy = SessionHeaderSchema.parse({
    sessionId: "s1",
    cwd: "/repo",
    projectRoot: "/repo",
  });
  assert.equal(legacy.workspaceAccess, undefined);
  assert.equal(readWorkspaceAccess(legacy), undefined);
  assert.equal(
    SessionHeaderSchema.safeParse({
      sessionId: "s1",
      cwd: "/repo",
      projectRoot: "/repo",
      workspaceAccess: { state: "authorized", reason: "outside_allowed_roots" },
    }).success,
    false,
  );
});

test("combineWorkspaceAccess fail-closed lattice is the canonical authority", () => {
  const authorized: CanonicalWorkspaceAccess = { state: "authorized", reason: "allowed_root" };
  const history: CanonicalWorkspaceAccess = {
    state: "history_only",
    reason: "outside_allowed_roots",
  };
  const unavailable: CanonicalWorkspaceAccess = { state: "unavailable", reason: "missing" };
  assert.deepEqual(combineWorkspaceAccess(authorized, history), history);
  assert.deepEqual(combineWorkspaceAccess(history, unavailable), unavailable);
  assert.deepEqual(combineWorkspaceAccess(authorized, unavailable), unavailable);
});
