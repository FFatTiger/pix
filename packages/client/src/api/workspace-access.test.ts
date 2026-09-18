import { describe, expect, it } from "vitest";
import type { SessionHeader, WorkspaceAccess } from "@fffattiger/pix-protocol";
import {
  describeWorkspaceAccess,
  isLiveWorkspaceAuthorized,
  liveWorkspaceEnabledForSelection,
  readSessionWorkspaceAccess,
  resolveWorkspaceAccessDecision,
  selectAuthoritativeSessionHeader,
  workspaceAccessMessageKey,
  workspaceAccessUnsupportedError,
  WORKSPACE_ACCESS_MESSAGE_KEYS,
} from "./workspace-access";

const AUTHORIZED: WorkspaceAccess = { state: "authorized", reason: "allowed_root" };
const HISTORY: WorkspaceAccess = { state: "history_only", reason: "outside_allowed_roots" };
const ESCAPE: WorkspaceAccess = { state: "history_only", reason: "symlink_escape" };
const MISSING: WorkspaceAccess = { state: "unavailable", reason: "missing" };
const DELETED: WorkspaceAccess = { state: "unavailable", reason: "deleted" };

function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return {
    sessionId: "s1",
    cwd: "/repo",
    projectRoot: "/repo",
    ...over,
  };
}

describe("workspace-access Client owner", () => {
  it("treats a missing additive field as unknown legacy and never guesses authorized", () => {
    const legacy = header();
    expect(legacy.workspaceAccess).toBeUndefined();
    expect(readSessionWorkspaceAccess(legacy)).toBeUndefined();
    expect(resolveWorkspaceAccessDecision(legacy)).toEqual({ kind: "unknown" });
    expect(isLiveWorkspaceAuthorized(legacy)).toBe(false);
    expect(liveWorkspaceEnabledForSelection("s1", legacy)).toBe(false);
    expect(describeWorkspaceAccess({ kind: "unknown" })).toBe(
      "This session is history-only until workspace access is confirmed.",
    );
    expect(describeWorkspaceAccess({ kind: "unknown" })).not.toMatch(/\/repo|ENOENT|secret/i);
  });

  it("authorized stays live; history_only and unavailable fail closed", () => {
    expect(resolveWorkspaceAccessDecision(header({ workspaceAccess: AUTHORIZED }))).toEqual({
      kind: "authorized",
      access: AUTHORIZED,
    });
    expect(isLiveWorkspaceAuthorized(header({ workspaceAccess: AUTHORIZED }))).toBe(true);
    expect(liveWorkspaceEnabledForSelection("s1", header({ workspaceAccess: AUTHORIZED }))).toBe(true);

    expect(resolveWorkspaceAccessDecision(header({ workspaceAccess: HISTORY }))).toEqual({
      kind: "history_only",
      access: HISTORY,
    });
    expect(isLiveWorkspaceAuthorized(header({ workspaceAccess: HISTORY }))).toBe(false);
    expect(describeWorkspaceAccess({ kind: "history_only", access: HISTORY })).toBe(
      "This session is history-only. Live workspace actions are unavailable.",
    );

    expect(resolveWorkspaceAccessDecision(header({ workspaceAccess: ESCAPE }))).toEqual({
      kind: "history_only",
      access: ESCAPE,
    });
    expect(describeWorkspaceAccess({ kind: "history_only", access: ESCAPE })).toBe(
      "This session path is not a live workspace.",
    );

    expect(resolveWorkspaceAccessDecision(header({ workspaceAccess: MISSING }))).toEqual({
      kind: "unavailable",
      access: MISSING,
    });
    expect(describeWorkspaceAccess({ kind: "unavailable", access: MISSING })).toBe(
      "This session's workspace is no longer available.",
    );
    expect(describeWorkspaceAccess({ kind: "unavailable", access: DELETED })).toBe(
      "This session's workspace is no longer available.",
    );
    expect(describeWorkspaceAccess({ kind: "unavailable", access: { state: "unavailable", reason: "unreadable" } })).toBe(
      "This session's workspace cannot be opened.",
    );
  });

  it("new-session home is not inferred from a history row", () => {
    expect(liveWorkspaceEnabledForSelection(null, header({ workspaceAccess: HISTORY }))).toBe(true);
    expect(liveWorkspaceEnabledForSelection(undefined, header({ workspaceAccess: DELETED }))).toBe(true);
    expect(liveWorkspaceEnabledForSelection("", header({ workspaceAccess: AUTHORIZED }))).toBe(true);
  });

  it("selects the exact HTTP detail over a list row and never a runtime snapshot", () => {
    const listed = header({ sessionId: "A", workspaceAccess: AUTHORIZED, title: "list" });
    const detail = header({ sessionId: "A", workspaceAccess: HISTORY, title: "detail" });
    const other = header({ sessionId: "B", workspaceAccess: AUTHORIZED, title: "B" });
    expect(selectAuthoritativeSessionHeader("A", detail, [listed, other])?.title).toBe("detail");
    expect(selectAuthoritativeSessionHeader("A", undefined, [listed, other])?.title).toBe("list");
    expect(selectAuthoritativeSessionHeader("B", detail, [listed, other])?.sessionId).toBe("B");
    expect(selectAuthoritativeSessionHeader("C", detail, [listed, other])).toBeUndefined();
    expect(selectAuthoritativeSessionHeader(null, detail, [listed])).toBeUndefined();
  });

  it("A authorized / B history_only decisions never leak across ids", () => {
    const a = header({ sessionId: "A", workspaceAccess: AUTHORIZED });
    const b = header({ sessionId: "B", workspaceAccess: HISTORY });
    expect(isLiveWorkspaceAuthorized(selectAuthoritativeSessionHeader("A", undefined, [a, b]))).toBe(true);
    expect(isLiveWorkspaceAuthorized(selectAuthoritativeSessionHeader("B", undefined, [a, b]))).toBe(false);
    expect(liveWorkspaceEnabledForSelection("B", b)).toBe(false);
    expect(liveWorkspaceEnabledForSelection("A", a)).toBe(true);
  });

  it("sanitized copy never interpolates paths, errno, or backend messages", () => {
    const copy = describeWorkspaceAccess({ kind: "unavailable", access: DELETED });
    expect(copy).not.toMatch(/\/Users|ENOENT|EACCES|secret|stack/i);
    const translated = describeWorkspaceAccess({ kind: "unknown" }, (key) => `i18n:${key}`);
    expect(translated).toBe(`i18n:${WORKSPACE_ACCESS_MESSAGE_KEYS.unknown}`);
    expect(workspaceAccessMessageKey({ kind: "authorized", access: AUTHORIZED })).toBeNull();
    const error = workspaceAccessUnsupportedError({ kind: "history_only", access: HISTORY });
    expect(error).toEqual({
      code: "unsupported_capability",
      message: "This session is history-only. Live workspace actions are unavailable.",
      retryable: false,
      phase: "activation",
    });
  });
});
