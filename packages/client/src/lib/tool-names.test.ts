import { describe, expect, it } from "vitest";
import { assistantToolDetailValue, assistantToolLabel } from "./tool-names";

describe("assistantToolLabel", () => {
  it("maps the assistant session tools", () => {
    expect(assistantToolLabel("search_sessions")?.labelKey).toBe("desktop.codexAssistantSearchedSessions");
    expect(assistantToolLabel("read_session")?.labelKey).toBe("desktop.codexAssistantReadSession");
  });

  it("maps lore recall reads vs writes", () => {
    for (const name of ["lore_search", "lore_get_node", "lore_boot"]) {
      expect(assistantToolLabel(name)?.labelKey).toBe("desktop.codexAssistantMemoryRecall");
    }
    for (const name of ["lore_create_node", "lore_update_node", "lore_delete_node"]) {
      expect(assistantToolLabel(name)?.labelKey).toBe("desktop.codexAssistantMemorySaved");
    }
  });

  it("maps the round-3 session-capability tools", () => {
    expect(assistantToolLabel("session_status")?.labelKey).toBe("desktop.codexAssistantSessionStatus");
    expect(assistantToolLabel("list_open_todos")?.labelKey).toBe("desktop.codexAssistantOpenTodos");
    expect(assistantToolLabel("summarize_activity")?.labelKey).toBe("desktop.codexAssistantActivity");
    expect(assistantToolLabel("find_file_changes")?.labelKey).toBe("desktop.codexAssistantFileChanges");
    expect(assistantToolLabel("list_projects")?.labelKey).toBe("desktop.codexAssistantProjects");
    expect(assistantToolLabel("list_projects")?.iconName).toBe("stacks");
    expect(assistantToolLabel("open_session")?.labelKey).toBe("desktop.codexAssistantOpenSession");
    expect(assistantToolLabel("organize_sessions")?.labelKey).toBe("desktop.codexAssistantOrganize");
    expect(assistantToolLabel("draft_to_session")?.labelKey).toBe("desktop.codexAssistantDraft");
  });

  it("maps the round-7 session-operation tools", () => {
    expect(assistantToolLabel("send_to_session")?.labelKey).toBe("desktop.codexAssistantSendToSession");
    expect(assistantToolLabel("create_session")?.labelKey).toBe("desktop.codexAssistantCreateSession");
    expect(assistantToolLabel("stop_session")?.labelKey).toBe("desktop.codexAssistantStopSession");
    expect(assistantToolDetailValue("send_to_session", { session: "修 bug" })).toBe("修 bug");
    expect(assistantToolDetailValue("create_session", { project: "pix-next" })).toBe("pix-next");
    expect(assistantToolDetailValue("stop_session", { session: "s-9" })).toBe("s-9");
    expect(assistantToolDetailValue("send_to_session", { session: "x".repeat(80) }).length).toBeLessThanOrEqual(61);
  });

  it("detail values prefer session/action/path keys for the new tools", () => {
    expect(assistantToolDetailValue("open_session", { session: "修 bug" })).toBe("修 bug");
    expect(assistantToolDetailValue("organize_sessions", { action: "rename" })).toBe("rename");
    expect(assistantToolDetailValue("find_file_changes", { path: "nginx.conf" })).toBe("nginx.conf");
    expect(assistantToolDetailValue("summarize_activity", { range: "week" })).toBe("week");
  });

  it("returns null for ordinary tools", () => {
    expect(assistantToolLabel("read")).toBeNull();
    expect(assistantToolLabel("grep")).toBeNull();
    expect(assistantToolLabel("lore_move_node")).toBeNull();
  });
});

describe("assistantToolDetailValue", () => {
  it("uses the session arg for read_session and query/project otherwise", () => {
    expect(assistantToolDetailValue("read_session", { session: "布局C 实现" })).toBe("布局C 实现");
    expect(assistantToolDetailValue("search_sessions", { query: "openclash 域名" })).toBe("openclash 域名");
    expect(assistantToolDetailValue("search_sessions", { project: "pix" })).toBe("pix");
  });

  it("bounds long values and tolerates missing args", () => {
    expect(assistantToolDetailValue("search_sessions", { query: "x".repeat(200) }).length).toBeLessThanOrEqual(61);
    expect(assistantToolDetailValue("search_sessions", {})).toBe("");
    expect(assistantToolDetailValue("read_session", undefined)).toBe("");
  });
});
