import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOtherWorkspaceTabs,
  closeWorkspaceTab,
  closeWorkspaceTabsToRight,
  fileTabId,
  minimalFileTab,
  minimalSessionTab,
  loadLastWorkspaceSession,
  loadWorkspaceSessionTabs,
  normalizeFileTabPath,
  openFileWorkspaceTab,
  openSessionWorkspaceTab,
  reconcileWorkspaceCwd,
  saveFileWorkspaceViewerState,
  saveLastWorkspaceSession,
  saveWorkspaceSessionTabs,
  sessionTabId,
  WORKSPACE_SESSION_TABS_STORAGE_KEY,
  WORKSPACE_LAST_SESSION_STORAGE_KEY,
  type FileWorkspaceTab,
  type SessionWorkspaceTab,
  type WorkspaceTab,
} from "./workspace-tab-state";

const sessionA: SessionWorkspaceTab = { kind: "session", id: "session:A", sessionId: "A", cwd: "/x" };
const fileA = (overrides: Partial<FileWorkspaceTab> = {}): FileWorkspaceTab => ({
  kind: "file",
  id: fileTabId("/x", "/x/src/a.ts"),
  cwd: "/x",
  filePath: "/x/src/a.ts",
  label: "a.ts",
  viewerRevision: 0,
  ...overrides,
});

beforeEach(() => {
  window.localStorage.removeItem(WORKSPACE_SESSION_TABS_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
});

afterEach(() => {
  window.localStorage.removeItem(WORKSPACE_SESSION_TABS_STORAGE_KEY);
  window.localStorage.removeItem(WORKSPACE_LAST_SESSION_STORAGE_KEY);
});

describe("session tab persistence", () => {
  it("round-trips session tabs and excludes file/runtime view state", () => {
    const sessionB: SessionWorkspaceTab = { kind: "session", id: "session:B", sessionId: "B", cwd: "/y" };
    saveWorkspaceSessionTabs([sessionA, fileA({ sourceSessionId: "A" }), sessionB]);

    expect(loadWorkspaceSessionTabs()).toEqual([sessionA, sessionB]);
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_TABS_STORAGE_KEY) ?? "null")).toEqual({
      version: 1,
      sessions: [
        { sessionId: "A", cwd: "/x" },
        { sessionId: "B", cwd: "/y" },
      ],
    });
  });

  it("fails closed for unknown versions and skips malformed or duplicate identities", () => {
    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, JSON.stringify({ version: 2, sessions: [{ sessionId: "A" }] }));
    expect(loadWorkspaceSessionTabs()).toEqual([]);

    window.localStorage.setItem(WORKSPACE_SESSION_TABS_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "A", cwd: "/x" }, { sessionId: "" }, { sessionId: "A", cwd: "/y" }],
    }));
    expect(loadWorkspaceSessionTabs()).toEqual([sessionA]);
  });

  it("restores the last active session only while its durable tab remains open", () => {
    const sessionB: SessionWorkspaceTab = { kind: "session", id: "session:B", sessionId: "B", cwd: "/y" };
    saveWorkspaceSessionTabs([sessionA, sessionB]);
    saveLastWorkspaceSession("B");

    expect(loadLastWorkspaceSession()).toEqual(sessionB);
    saveWorkspaceSessionTabs([sessionA]);
    expect(loadLastWorkspaceSession()).toBeNull();
  });

  it("clears an intentional home and fails closed for malformed selection state", () => {
    saveWorkspaceSessionTabs([sessionA]);
    saveLastWorkspaceSession("A");
    saveLastWorkspaceSession(null);
    expect(loadLastWorkspaceSession()).toBeNull();

    window.localStorage.setItem(WORKSPACE_LAST_SESSION_STORAGE_KEY, JSON.stringify({ version: 2, sessionId: "A" }));
    expect(loadLastWorkspaceSession()).toBeNull();
    window.localStorage.setItem(WORKSPACE_LAST_SESSION_STORAGE_KEY, JSON.stringify({ version: 1, sessionId: "" }));
    expect(loadLastWorkspaceSession()).toBeNull();
  });
});

describe("identity helpers", () => {
  it("session tab id is session:<sessionId>", () => {
    expect(sessionTabId("s1")).toBe("session:s1");
  });

  it("file tab id combines cwd and normalized path", () => {
    expect(fileTabId("/x", "/x/src/a.ts")).toBe("file:/x:/x/src/a.ts");
  });

  it("normalizes backslash paths for identity/dedupe", () => {
    expect(normalizeFileTabPath("C:\\repo\\a.ts")).toBe("C:/repo/a.ts");
    expect(fileTabId("C:\\repo", "C:\\repo\\a.ts")).toBe("file:C:/repo:C:/repo/a.ts");
  });

  it("minimal tabs carry URL-derived identity without viewer state", () => {
    expect(minimalFileTab("/x", "/x/src/a.ts")).toEqual(fileA());
    expect(minimalSessionTab("A", "/x")).toEqual(sessionA);
    expect(minimalSessionTab("A")).toEqual({ kind: "session", id: "session:A", sessionId: "A" });
  });
});

describe("openFileWorkspaceTab", () => {
  it("appends a new file tab and dedupes by cwd + path", () => {
    const once = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/src/a.ts", fileName: "a.ts" });
    expect(once).toHaveLength(1);
    const twice = openFileWorkspaceTab(once, { cwd: "/x", filePath: "/x/src/a.ts", fileName: "a.ts" });
    expect(twice).toHaveLength(1);
    expect(twice[0]).toEqual(once[0]);
  });

  it("a different path under the same cwd is a separate tab", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts" });
    const next = openFileWorkspaceTab(tabs, { cwd: "/x", filePath: "/x/b.ts", fileName: "b.ts" });
    expect(next).toHaveLength(2);
  });

  it("the same path under a different cwd is a separate tab (cwd-owned)", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts" });
    const next = openFileWorkspaceTab(tabs, { cwd: "/y", filePath: "/y/a.ts", fileName: "a.ts" });
    expect(next).toHaveLength(2);
  });

  it("re-open with a diff mode bumps the viewer revision and resets scroll", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts" });
    const withDiff = openFileWorkspaceTab(tabs, { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts", initialDisplayMode: "diff" });
    const tab = withDiff.find((t) => t.kind === "file") as FileWorkspaceTab;
    expect(tab.viewerRevision).toBe(1);
    expect(tab.initialDisplayMode).toBe("diff");
    expect(tab.viewerState?.displayMode).toBe("diff");
    expect(tab.viewerState?.scrollTop).toBe(0);
    expect(tab.viewerState?.scrollLeft).toBe(0);
  });

  it("explorer reopen without a source session never erases the existing source session", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts", sourceSessionId: "S" });
    const reopened = openFileWorkspaceTab(tabs, { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts" });
    expect(reopened).toHaveLength(1);
    expect((reopened[0] as FileWorkspaceTab).sourceSessionId).toBe("S");
    expect((reopened[0] as FileWorkspaceTab).viewerRevision).toBe(0);
  });

  it("re-open with a changed source session bumps the revision", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts", sourceSessionId: "S1" });
    const changed = openFileWorkspaceTab(tabs, { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts", sourceSessionId: "S2" });
    const tab = changed.find((t) => t.kind === "file") as FileWorkspaceTab;
    expect(tab.sourceSessionId).toBe("S2");
    expect(tab.viewerRevision).toBe(1);
  });
});

describe("openSessionWorkspaceTab", () => {
  it("appends a new session tab and dedupes by sessionId", () => {
    const once = openSessionWorkspaceTab([], "A", "/x");
    expect(once).toHaveLength(1);
    const twice = openSessionWorkspaceTab(once, "A", "/x");
    expect(twice).toHaveLength(1);
  });

  it("creates without a cwd when the URL has none", () => {
    const tabs = openSessionWorkspaceTab([], "A");
    expect(tabs[0]).toEqual({ kind: "session", id: "session:A", sessionId: "A" });
  });

  it("keeps an existing tab's remembered cwd", () => {
    const tabs = openSessionWorkspaceTab([], "A", "/x");
    const reopened = openSessionWorkspaceTab(tabs, "A", "/y");
    expect(reopened).toHaveLength(1);
    expect((reopened[0] as SessionWorkspaceTab).cwd).toBe("/x");
  });
});

describe("closeWorkspaceTab", () => {
  const tabs: WorkspaceTab[] = [sessionA, fileA()];

  it("closing a non-active tab keeps the active tab", () => {
    const { tabs: next, nextActiveTabId } = closeWorkspaceTab(tabs, sessionA.id, fileA().id);
    expect(next).toHaveLength(1);
    expect(nextActiveTabId).toBe(sessionA.id);
  });

  it("closing the active tab selects the right neighbor", () => {
    const { tabs: next, nextActiveTabId } = closeWorkspaceTab(tabs, sessionA.id, sessionA.id);
    expect(nextActiveTabId).toBe(fileA().id);
    expect(next.find((t) => t.id === nextActiveTabId)).toBeTruthy();
  });

  it("closing the last active tab selects the left neighbor", () => {
    const { nextActiveTabId } = closeWorkspaceTab(tabs, fileA().id, fileA().id);
    expect(nextActiveTabId).toBe(sessionA.id);
  });

  it("closing the only active tab falls back to home (null)", () => {
    const { tabs: next, nextActiveTabId } = closeWorkspaceTab([sessionA], sessionA.id, sessionA.id);
    expect(next).toHaveLength(0);
    expect(nextActiveTabId).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    const { tabs: next, nextActiveTabId } = closeWorkspaceTab(tabs, sessionA.id, "nope");
    expect(next).toEqual(tabs);
    expect(nextActiveTabId).toBe(sessionA.id);
  });
});

describe("reconcileWorkspaceCwd", () => {
  it("keeps session tabs and the file tabs owned by the current cwd", () => {
    const mixed: WorkspaceTab[] = [
      sessionA,
      fileA(),
      { kind: "file", id: fileTabId("/y", "/y/b.ts"), cwd: "/y", filePath: "/y/b.ts", label: "b.ts", viewerRevision: 0 },
    ];
    const next = reconcileWorkspaceCwd(mixed, "/x");
    expect(next).toHaveLength(2);
    expect(next.map((t) => t.id)).toEqual([sessionA.id, fileA().id]);
  });

  it("clears all file tabs when there is no cwd", () => {
    const next = reconcileWorkspaceCwd([sessionA, fileA()], undefined);
    expect(next).toHaveLength(1);
    expect(next[0]!.kind).toBe("session");
  });
});

describe("saveFileWorkspaceViewerState", () => {
  it("saves state at the matching revision and bails on a stale revision", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts" });
    const tabId = tabs[0]!.id;
    const saved = saveFileWorkspaceViewerState(tabs, tabId, 0, {
      displayMode: "source",
      wrapLines: true,
      scrollTop: 12,
      scrollLeft: 0,
    });
    expect((saved[0] as FileWorkspaceTab).viewerState?.scrollTop).toBe(12);
    const stale = saveFileWorkspaceViewerState(saved, tabId, 7, {
      displayMode: "source",
      wrapLines: true,
      scrollTop: 99,
      scrollLeft: 0,
    });
    expect((stale[0] as FileWorkspaceTab).viewerState?.scrollTop).toBe(12);
  });

  it("keeps the file tab's kind/cwd when saving (delegates without mangling)", () => {
    const tabs = openFileWorkspaceTab([], { cwd: "/x", filePath: "/x/a.ts", fileName: "a.ts", sourceSessionId: "S" });
    const tabId = tabs[0]!.id;
    const saved = saveFileWorkspaceViewerState(tabs, tabId, 0, {
      displayMode: "source",
      wrapLines: false,
      scrollTop: 3,
      scrollLeft: 0,
    });
    const tab = saved[0] as FileWorkspaceTab;
    expect(tab.kind).toBe("file");
    expect(tab.cwd).toBe("/x");
    expect(tab.sourceSessionId).toBe("S");
  });
});

describe("bulk close helpers", () => {
  const s1 = sessionA;
  const f1 = fileA();
  const f2 = fileA({ id: "file:/x:/b", filePath: "/x/b", label: "b" });
  const s2: SessionWorkspaceTab = { kind: "session", id: "session:B", sessionId: "B", cwd: "/x" };
  const tabs: WorkspaceTab[] = [s1, f1, f2, s2];

  it("closeOtherWorkspaceTabs keeps only the anchor", () => {
    expect(closeOtherWorkspaceTabs(tabs, f2.id)).toEqual([f2]);
    expect(closeOtherWorkspaceTabs(tabs, "missing")).toEqual([]);
  });

  it("closeWorkspaceTabsToRight keeps the anchor and everything left of it", () => {
    expect(closeWorkspaceTabsToRight(tabs, f1.id)).toEqual([s1, f1]);
    expect(closeWorkspaceTabsToRight(tabs, s2.id)).toEqual(tabs);
    expect(closeWorkspaceTabsToRight(tabs, "missing")).toEqual(tabs);
  });
});
