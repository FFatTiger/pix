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
