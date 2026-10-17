import { describe, expect, it } from "vitest";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import { assistantToolDetailText, assistantToolDetailValue, assistantToolLabel } from "./tool-names";

/** zh translator built from the real message table (same {name} interpolation). */
const zhMessages: Record<string, string> = zhCNLocale.messages;
const zhT = (key: string, params?: Record<string, string>) =>
  (zhMessages[key] ?? key).replace(/\{(\w+)\}/g, (_token: string, name: string) => params?.[name] ?? `{${name}}`);

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

  it("maps local pi-memory tools to the same recall/write wording", () => {
    for (const name of ["memory_read", "memory_status"]) {
      expect(assistantToolLabel(name)?.labelKey).toBe("desktop.codexAssistantMemoryRecall");
      expect(assistantToolLabel(name)?.iconName).toBe("brain");
    }
    expect(assistantToolLabel("memory_write")?.labelKey).toBe("desktop.codexAssistantMemorySaved");
    expect(assistantToolLabel("memory_write")?.iconName).toBe("brain");
    expect(assistantToolLabel("memory_forget")?.labelKey).toBe("desktop.codexAssistantMemoryForgot");
    expect(assistantToolLabel("memory_forget")?.detailKey).toBe("desktop.codexAssistantMemoryForgotDetail");
    expect(assistantToolLabel("memory_restore")?.labelKey).toBe("desktop.codexAssistantMemoryRestored");
    expect(assistantToolLabel("scratchpad")?.labelKey).toBe("desktop.codexAssistantScratchpad");
    expect(assistantToolLabel("scratchpad")?.detailKey).toBe("desktop.codexAssistantScratchpadDetail");
    expect(assistantToolLabel("scratchpad")?.iconName).toBe("penNib");
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

  it("detail values prefer session/path keys for the new tools", () => {
    expect(assistantToolDetailValue("open_session", { session: "修 bug" })).toBe("修 bug");
    // organize_sessions no longer surfaces the raw action token — its object
    // is the target session, resolved by the composer below.
    expect(assistantToolDetailValue("organize_sessions", { action: "rename" })).toBe("");
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

  it("reads content/match/text for the pi-memory tools", () => {
    expect(assistantToolDetailValue("memory_write", { content: "大哥时区是 Asia/Shanghai" })).toBe("大哥时区是 Asia/Shanghai");
    expect(assistantToolDetailValue("memory_forget", { match: "旧域名" })).toBe("旧域名");
    expect(assistantToolDetailValue("scratchpad", { action: "add", text: "检查 e2e" })).toBe("检查 e2e");
    // memory_restore surfaces no argument value; memory_read/memory_status keep
    // the generic probe order.
    expect(assistantToolDetailValue("memory_restore", { recoveryId: "r-1" })).toBe("");
    expect(assistantToolDetailValue("memory_read", { target: "long_term" })).toBe("");
    expect(assistantToolDetailValue("memory_write", { content: "x".repeat(200) }).length).toBeLessThanOrEqual(61);
  });

  it("bounds long values and tolerates missing args", () => {
    expect(assistantToolDetailValue("search_sessions", { query: "x".repeat(200) }).length).toBeLessThanOrEqual(61);
    expect(assistantToolDetailValue("search_sessions", {})).toBe("");
    expect(assistantToolDetailValue("read_session", undefined)).toBe("");
  });
});

describe("assistantToolDetailText", () => {
  it("reads as verb + 「object」", () => {
    expect(assistantToolDetailText("search_sessions", { query: "openclash 域名" }, zhT)).toBe("查找「openclash 域名」相关的会话");
    expect(assistantToolDetailText("organize_sessions", { action: "rename", sessions: [{ session: "修 bug" }] }, zhT)).toBe("整理「修 bug」");
    expect(assistantToolDetailText("find_file_changes", { path: "nginx.conf" }, zhT)).toBe("查找「nginx.conf」的改动记录");
    expect(assistantToolDetailText("list_projects", { query: "pix" }, zhT)).toBe("查找项目「pix」");
    expect(assistantToolDetailText("open_session", { session: "布局C 实现" }, zhT)).toBe("打开「布局C 实现」");
    expect(assistantToolDetailText("draft_to_session", { session: "修 bug" }, zhT)).toBe("给「修 bug」填写草稿");
    expect(assistantToolDetailText("send_to_session", { session: "修 bug" }, zhT)).toBe("发消息给「修 bug」");
    expect(assistantToolDetailText("create_session", { project: "pix-next" }, zhT)).toBe("在「pix-next」新建会话");
    // A bare id in the call reads as the session title once the result names it.
    const id = "01a14473-841c-716c-925c-000ca123fd35";
    expect(assistantToolDetailText("send_to_session", { session: id }, zhT, { sessionId: id, cwd: "/x", title: "修 bug" })).toBe("发消息给「修 bug」");
    expect(assistantToolDetailText("send_to_session", { session: id }, zhT)).toBe(`发消息给「${id}」`);
    expect(assistantToolDetailText("stop_session", { session: "s-9" }, zhT)).toBe("停止「s-9」");
    expect(assistantToolDetailText("scratchpad", { action: "add", text: "检查 e2e" }, zhT)).toBe("记到便签：检查 e2e");
  });

  it("localizes the activity range and prefixes the project scope", () => {
    expect(assistantToolDetailText("summarize_activity", { range: "week" }, zhT)).toBe("汇总本周的进展");
    expect(assistantToolDetailText("summarize_activity", { range: "3" }, zhT)).toBe("汇总最近 3 天的进展");
    expect(assistantToolDetailText("summarize_activity", {}, zhT)).toBe("汇总今天的进展");
    expect(assistantToolDetailText("summarize_activity", { project: "pix", range: "today" }, zhT)).toBe("汇总「pix」今天的进展");
  });

  it("uses whole-scope wording instead of an empty object", () => {
    expect(assistantToolDetailText("search_sessions", {}, zhT)).toBe("查找会话");
    expect(assistantToolDetailText("session_status", {}, zhT)).toBe("查看全部会话的状态");
    expect(assistantToolDetailText("list_open_todos", {}, zhT)).toBe("汇总全部待办");
    expect(assistantToolDetailText("list_projects", {}, zhT)).toBe("列出全部项目");
  });

  it("returns an empty string for ordinary tools", () => {
    expect(assistantToolDetailText("read", { path: "a.ts" }, zhT)).toBe("");
  });
});
