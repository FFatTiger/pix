import { afterEach, describe, expect, it } from "vitest";
import { applySidebarItemPatch, loadSidebarItemState, saveSidebarItemState } from "./sidebar-item-state";

const STORAGE_KEY = "pi-sidebar-item-state";

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("sidebar item pin/archive", () => {
  it("starts empty and persists a pin", () => {
    expect(loadSidebarItemState().pinnedSessions).toEqual([]);
    saveSidebarItemState(applySidebarItemPatch(loadSidebarItemState(), { sessionId: "s1", pinned: true }));
    expect(loadSidebarItemState().pinnedSessions).toEqual(["s1"]);
  });

  it("moves a pinned session to archive and drops the pin", () => {
    const pinned = applySidebarItemPatch(loadSidebarItemState(), { sessionId: "s1", pinned: true });
    const archived = applySidebarItemPatch(pinned, { sessionId: "s1", archived: true });
    expect(archived.pinnedSessions).toEqual([]);
    expect(archived.archivedSessions).toEqual(["s1"]);
  });

  it("unpins a project without touching session pins", () => {
    const next = applySidebarItemPatch(
      applySidebarItemPatch(loadSidebarItemState(), { projectRoot: "/p", pinned: true }),
      { sessionId: "s1", pinned: true },
    );
    const unpinned = applySidebarItemPatch(next, { projectRoot: "/p", pinned: false });
    expect(unpinned.pinnedProjects).toEqual([]);
    expect(unpinned.pinnedSessions).toEqual(["s1"]);
  });

  it("persists project expansion and keeps old stored shapes backward-compatible", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      pinnedSessions: [],
      pinnedProjects: ["/old"],
      archivedSessions: [],
      archivedProjects: [],
    }));
    expect(loadSidebarItemState().expandedProjects).toEqual([]);
    expect(loadSidebarItemState().collapsedProjects).toEqual([]);

    const expanded = applySidebarItemPatch(loadSidebarItemState(), { projectRoot: "/old", expanded: true });
    saveSidebarItemState(expanded);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}").expandedProjects).toEqual(["/old"]);
    expect(loadSidebarItemState().expandedProjects).toEqual(["/old"]);
  });

  it("parses persisted collapsedProjects and drops invalid entries", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      expandedProjects: ["/open"],
      collapsedProjects: ["/closed", "", 5, "/closed"],
    }));
    const state = loadSidebarItemState();
    expect(state.expandedProjects).toEqual(["/open"]);
    expect(state.collapsedProjects).toEqual(["/closed"]);
  });

  it("collapsing marks the project explicit-collapsed so the recency default cannot reopen it", () => {
    const expanded = applySidebarItemPatch(loadSidebarItemState(), { projectRoot: "/p", expanded: true });
    expect(expanded.expandedProjects).toEqual(["/p"]);
    expect(expanded.collapsedProjects).toEqual([]);

    const collapsed = applySidebarItemPatch(expanded, { projectRoot: "/p", expanded: false });
    expect(collapsed.expandedProjects).toEqual([]);
    expect(collapsed.collapsedProjects).toEqual(["/p"]);

    // Re-expanding clears the explicit-collapse mark again.
    const reopened = applySidebarItemPatch(collapsed, { projectRoot: "/p", expanded: true });
    expect(reopened.expandedProjects).toEqual(["/p"]);
    expect(reopened.collapsedProjects).toEqual([]);
  });

  it("archiving a project clears both its pin and expanded state", () => {
    const pinned = applySidebarItemPatch(loadSidebarItemState(), { projectRoot: "/p", pinned: true });
    const expanded = applySidebarItemPatch(pinned, { projectRoot: "/p", expanded: true });
    const archived = applySidebarItemPatch(expanded, { projectRoot: "/p", archived: true });
    expect(archived.pinnedProjects).toEqual([]);
    expect(archived.expandedProjects).toEqual([]);
    expect(archived.archivedProjects).toEqual(["/p"]);
  });

  it("archiving a project also drops its explicit-collapse mark", () => {
    const collapsed = applySidebarItemPatch(loadSidebarItemState(), { projectRoot: "/p", expanded: false });
    const archived = applySidebarItemPatch(collapsed, { projectRoot: "/p", archived: true });
    expect(archived.collapsedProjects).toEqual([]);
    expect(archived.archivedProjects).toEqual(["/p"]);
  });
});
