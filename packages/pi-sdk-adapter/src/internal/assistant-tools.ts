/**
 * Assistant-only session-history tools (search_sessions / read_session).
 *
 * The pix Assistant is a project-less conversation whose superpower is
 * remembering and finding: it may search every project's session history and
 * read a session's recent messages. These tools are registered ONLY for
 * sessions whose cwd is the assistant workspace (`<home>/.pi/pix/assistant`,
 * see runtime-core `assistant-workspace`) — `sdk-runtime.createServices`
 * injects this extension conditionally, so ordinary project sessions never
 * see them.
 *
 * Data source is the SAME read-only Pi SDK JSONL surface the session catalog
 * uses (`SessionManager.listAll` / `SessionManager.open`): zero Workers, no
 * activation of other sessions, no filesystem access outside the Pi agent
 * sessions directory, no mutation. Hidden workspaces (subagent homes, the
 * sessiond home, the assistant's own directory) are excluded from search
 * results — the tools see exactly the sessions the sidebar shows.
 *
 * Every output is bounded (limits, snippets, total characters) so a tool
 * result can never blow up the assistant's own context.
 */
import { homedir } from "node:os";
import type { WorkerSessionStatusItem } from "@fffattiger/pix-protocol";
import { basename, sep as pathSep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isAssistantWorkspacePath, matchesAssistantWorkspacePattern, normalizeAssistantWorkspacePath } from "@fffattiger/pix-runtime-core";
import { browseKindForWorkspace } from "./session-projection.js";

/** Fixed tool names (also used by the client's process-line labels). */
export const ASSISTANT_TOOL_NAMES = [
  "search_sessions",
  "read_session",
  "session_status",
  "list_open_todos",
  "summarize_activity",
  "find_file_changes",
  "open_session",
  "organize_sessions",
  "draft_to_session",
] as const;

/** True when a session cwd IS the assistant workspace on this machine. */
export function isAssistantWorkspaceCwd(cwd: string): boolean {
  return isAssistantWorkspacePath(cwd, homedir());
}

/**
 * The assistant extensions to inject for a session cwd: the tools extension
 * when the cwd IS the assistant workspace, else nothing. `sdk-runtime`
 * composes this into `createServices` so ordinary project sessions never
 * register the assistant tools.
 */
export function assistantExtensionFactoriesForCwd(
  cwd: string,
  sessionStatus?: () => Promise<readonly WorkerSessionStatusItem[]>,
): InlineExtension[] {
  return isAssistantWorkspaceCwd(cwd) ? [createAssistantToolsExtension(sessionStatus)] : [];
}

/**
 * Keep the assistant tools ACTIVE after a global tool selection is applied.
 * The tools are the assistant's defining capability: a narrow global
 * `pixDefaultTools` list must not silently remove them (an explicit runtime
 * `set_tools` remains a live override until the next selection application,
 * exactly like every other tool). No-op for non-assistant sessions and when
 * both tools are already active.
 */
export function ensureAssistantToolsActive(
  session: { getActiveToolNames(): readonly string[]; setActiveToolsByName(names: readonly string[]): void },
  cwd: string,
): void {
  if (!isAssistantWorkspaceCwd(cwd)) return;
  const active = new Set(session.getActiveToolNames());
  let changed = false;
  for (const name of ASSISTANT_TOOL_NAMES) {
    if (!active.has(name)) {
      active.add(name);
      changed = true;
    }
  }
  if (changed) session.setActiveToolsByName([...active]);
}

// ---------------------------------------------------------------------------
// Bounded read-only session list (shared cache for both tools)
// ---------------------------------------------------------------------------

type AssistantSessionInfo = Awaited<ReturnType<typeof SessionManager.listAll>>[number];

const LIST_CACHE_TTL_MS = 30_000;
let listCache: { at: number; sessions: AssistantSessionInfo[] } | null = null;

/** Hidden rows the assistant must never surface (mirrors the catalog policy). */
function isVisibleAssistantSession(info: Pick<AssistantSessionInfo, "cwd" | "parentSessionPath">): boolean {
  if (info.parentSessionPath !== undefined && info.parentSessionPath !== "") return false;
  // The assistant's own conversations are hidden from every catalog surface.
  if (matchesAssistantWorkspacePattern(normalizeAssistantWorkspacePath(info.cwd))) return false;
  return browseKindForWorkspace(info.cwd) !== "hidden";
}

async function listSessionsForAssistant(signal?: AbortSignal): Promise<AssistantSessionInfo[]> {
  const now = Date.now();
  if (listCache !== null && now - listCache.at < LIST_CACHE_TTL_MS) {
    signal?.throwIfAborted();
    return listCache.sessions;
  }
  const sessions = (await SessionManager.listAll(undefined, signal))
    .filter((info) => isVisibleAssistantSession(info));
  listCache = { at: now, sessions };
  return sessions;
}

/** Test-only: drop the bounded list cache (deterministic re-scan). */
export function resetAssistantToolsListCacheForTests(): void {
  listCache = null;
}

// ---------------------------------------------------------------------------
// Bounded text helpers
// ---------------------------------------------------------------------------

function concise(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** ±context chars around the first case-insensitive match; null when absent. */
function snippetAround(text: string, needle: string, context = 60, max = 160): string | null {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return null;
  const start = Math.max(0, index - context);
  const end = Math.min(text.length, index + needle.length + context);
  return `${start > 0 ? "…" : ""}${concise(text.slice(start, end), max)}${end < text.length ? "…" : ""}`;
}

function parseSince(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return Number.NaN; // distinguish "invalid" from "absent"
  return parsed;
}

function projectLabel(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function relativeDate(ms: number): string {
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// search_sessions
// ---------------------------------------------------------------------------

const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;
const SEARCH_OUTPUT_MAX_CHARS = 6_000;

function searchResultText(
  matches: AssistantSessionInfo[],
  totalMatched: number,
  query: string | undefined,
): string {
  if (matches.length === 0) {
    return query === undefined || query === ""
      ? "没有找到任何会话。"
      : `没有匹配「${concise(query, 60)}」的会话。`;
  }
  const lines: string[] = [`共匹配 ${totalMatched} 个会话，列出最近 ${matches.length} 个：`];
  let used = lines[0]!.length;
  for (const info of matches) {
    const title = concise(info.name ?? info.firstMessage ?? "(无消息)", 60);
    const snippet = query
      ? snippetAround(info.allMessagesText, query) ?? snippetAround(info.firstMessage, query)
      : undefined;
    const line = `- ${title}｜项目:${projectLabel(info.cwd)}｜${relativeDate(info.modified.getTime())}｜id:${info.id}`
      + (snippet === undefined ? "" : `\n  摘录: ${snippet}`);
    if (used + line.length > SEARCH_OUTPUT_MAX_CHARS) {
      lines.push("(输出已达上限，未列出的会话可用更窄的条件再查)");
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

function projectMatches(info: AssistantSessionInfo, project: string): boolean {
  const raw = project.trim();
  if (raw === "") return true;
  const normalized = normalizeAssistantWorkspacePath(raw);
  const cwd = normalizeAssistantWorkspacePath(info.cwd);
  if (cwd === normalized || cwd.endsWith(`/${normalized}`)) return true;
  return projectLabel(info.cwd).toLowerCase() === raw.toLowerCase();
}

// ---------------------------------------------------------------------------
// read_session
// ---------------------------------------------------------------------------

const READ_DEFAULT_TAIL = 20;
const READ_MAX_TAIL = 50;
const READ_OUTPUT_MAX_CHARS = 6_000;
const READ_MESSAGE_MAX_CHARS = 320;

type SdkMessageEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string; toolName?: string; name?: string }>;
    toolName?: string;
    isError?: boolean;
  };
};

/** One-line bounded summary of a message entry (never throws). */
function summarizeMessageEntry(entry: SdkMessageEntry): string | null {
  if (entry.type !== "message" || entry.message === undefined) return null;
  const message = entry.message;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = typeof message.content === "string"
    ? message.content
    : blocks.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join(" ");
  if (message.role === "user") {
    return text.trim() === "" ? null : `用户: ${concise(text, READ_MESSAGE_MAX_CHARS)}`;
  }
  if (message.role === "assistant") {
    // pi-ai ToolCall blocks carry `name` (SDK wire shape); `toolName` is a
    // tolerated alias so a shape drift degrades gracefully, never crashes.
    const toolNames = blocks
      .filter((block) => block.type === "toolCall")
      .map((block) => {
        const tool = block.toolName ?? block.name;
        return typeof tool === "string" && tool !== "" ? tool : "tool";
      });
    if (text.trim() !== "") return `助手: ${concise(text, READ_MESSAGE_MAX_CHARS)}`;
    if (toolNames.length > 0) return `助手调用工具: ${toolNames.join(", ")}`;
    return null; // thinking-only assistant entries carry no conversational content
  }
  if (message.role === "toolResult") {
    const tool = typeof message.toolName === "string" && message.toolName !== ""
      ? message.toolName
      : "工具";
    return `结果(${tool}${message.isError === true ? ", 失败" : ""}): ${concise(text, 120)}`;
  }
  return null;
}

function readSessionResultText(
  info: AssistantSessionInfo,
  summaries: string[],
  totalMessages: number,
): string {
  const header = `会话「${concise(info.name ?? info.firstMessage ?? "(无标题)", 60)}」`
    + `｜项目: ${info.cwd}｜最后活动 ${relativeDate(info.modified.getTime())}`
    + `｜共 ${totalMessages} 条消息，显示最近 ${summaries.length} 条：`;
  const lines = [header];
  let used = header.length;
  for (const line of summaries) {
    if (used + line.length > READ_OUTPUT_MAX_CHARS) {
      lines.push("(已达输出上限)");
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Session-analysis helpers (read-only JSONL, bounded tails)
// ---------------------------------------------------------------------------

/** Bounded number of tail message entries analyzed per session. */
const TAIL_ENTRY_BUDGET = 40;
/** Bounded sessions per status/activity listing. */
const LIST_SESSION_BUDGET = 15;

type SdkMessageContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  input?: Record<string, unknown>;
};

type SdkMessage = {
  role?: string;
  content?: string | SdkMessageContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
};

/** Latest `todo` toolResult snapshot replayed from a session's entries. */
function replayTodoSnapshot(entries: readonly SdkMessageEntry[]): { tasks: Array<{ id: number; subject: string; status: string }>; nextId: number } | null {
  let state: { tasks: Array<{ id: number; subject: string; status: string }>; nextId: number } | null = null;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as SdkMessage;
    if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
    const details = message.details as { tasks?: unknown; nextId?: unknown } | undefined;
    const tasks = details?.tasks ?? (details as { details?: { tasks?: unknown } } | undefined)?.details?.tasks;
    if (!Array.isArray(tasks)) continue;
    const parsed: Array<{ id: number; subject: string; status: string }> = [];
    for (const raw of tasks) {
      if (raw === null || typeof raw !== "object") continue;
      const task = raw as { id?: unknown; subject?: unknown; status?: unknown };
      if (typeof task.id !== "number" || typeof task.subject !== "string" || typeof task.status !== "string") continue;
      parsed.push({ id: task.id, subject: task.subject, status: task.status });
    }
    state = { tasks: parsed, nextId: typeof details?.nextId === "number" ? details.nextId : 0 };
  }
  return state;
}

/** write/edit-family toolCall path argument (the persisted written-file source). */
function writtenPathFromCall(block: SdkMessageContentBlock): string | null {
  const name = typeof block.name === "string" ? block.name.toLowerCase() : "";
  const isWrite = name === "write" || name.startsWith("write_") || name.endsWith(".write") || name.endsWith("_write");
  const isEdit = name === "edit" || name.startsWith("edit_") || name.endsWith(".edit") || name.endsWith("_edit")
    || name.includes("str_replace") || name.includes("replace_editor");
  if (!isWrite && !isEdit) return null;
  const args = (block.arguments ?? block.input) as { path?: unknown; file_path?: unknown } | undefined;
  const raw = args?.path ?? args?.file_path;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** One session's tail analysis for session_status. */
function analyzeTail(entries: readonly SdkMessageEntry[]): { state: "waiting_user" | "running_suspected" | "recent_error" | "idle"; detail: string } {
  const tail = entries.filter((entry) => entry.type === "message").slice(-TAIL_ENTRY_BUDGET);
  if (tail.length === 0) return { state: "idle", detail: "" };
  const answered = new Set<string>();
  let lastResultError: string | null = null;
  for (const entry of tail) {
    const message = entry.message as SdkMessage;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
      if (message.isError === true) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join(" ");
        lastResultError = concise(text, 100);
      } else {
        lastResultError = null;
      }
    }
  }
  // Unclosed toolCalls in the LAST assistant message = in-flight on disk.
  const lastAssistant = [...tail].reverse().find((entry) => (entry.message as SdkMessage)?.role === "assistant");
  if (lastAssistant !== undefined) {
    const message = lastAssistant.message as SdkMessage;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const openCalls = blocks.filter((b) => b.type === "toolCall" && typeof b.id === "string" && !answered.has(b.id as string));
    if (openCalls.length > 0) {
      const ask = openCalls.find((b) => (b.name ?? "") === "ask_user_question");
      if (ask !== undefined) return { state: "waiting_user", detail: "有一个待回答的向用户提问" };
      return { state: "running_suspected", detail: `有 ${openCalls.length} 个未闭合的工具调用（疑似进行中或中断）` };
    }
  }
  if (lastResultError !== null) return { state: "recent_error", detail: lastResultError === "" ? "最近一次工具调用失败" : `最近一次工具调用失败：${lastResultError}` };
  return { state: "idle", detail: "" };
}

/** Resolve a session selector (id or title) against the visible catalog. */
function resolveSessionTarget(selector: string, sessions: readonly AssistantSessionInfo[]): AssistantSessionInfo | undefined {
  const trimmed = selector.trim();
  if (trimmed === "") return undefined;
  const byId = sessions.find((info) => info.id === trimmed);
  if (byId !== undefined) return byId;
  const lower = trimmed.toLowerCase();
  const byTitle = sessions.find((info) => (info.name ?? "").toLowerCase() === lower);
  if (byTitle !== undefined) return byTitle;
  return sessions.find((info) =>
    (info.name ?? "").toLowerCase().includes(lower) || info.firstMessage.toLowerCase().includes(lower));
}

function targetLine(info: AssistantSessionInfo): string {
  const title = concise(info.name ?? info.firstMessage ?? "(无标题)", 60);
  return `${title}｜项目:${projectLabel(info.cwd)}｜id:${info.id}`;
}


function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}
function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true as const };
}
function toolFailure(prefix: string, error: unknown) {
  return toolError(`${prefix}：${error instanceof Error ? concise(error.message, 120) : "未知错误"}`);
}
async function resolveTarget(selector: string, signal?: AbortSignal): Promise<{ target: AssistantSessionInfo } | { error: ReturnType<typeof toolError> }> {
  let sessions: AssistantSessionInfo[];
  try {
    sessions = await listSessionsForAssistant(signal);
  } catch (error) {
    signal?.throwIfAborted();
    return { error: toolFailure("读取会话目录失败", error) };
  }
  const target = resolveSessionTarget(selector, sessions);
  if (target === undefined) {
    return { error: toolError(`没有找到会话「${concise(selector, 60)}」。可先用 search_sessions 查找。`) };
  }
  return { target };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * The assistant tools extension. Registered for assistant-workspace sessions
 * only; every execute is read-only JSONL access with bounded output and
 * honest `isError` results (never a thrown rejection, never fake success).
 */
export function createAssistantToolsExtension(
  sessionStatus?: () => Promise<readonly WorkerSessionStatusItem[]>,
): InlineExtension {
  return (pi: ExtensionAPI): void => {
    pi.registerTool({
      name: "search_sessions",
      label: "查找会话",
      description: [
        "搜索用户所有项目里的历史会话（只读，不会打开或激活任何会话）。",
        "按关键词匹配会话标题和消息内容，可按项目名和日期过滤。",
        "返回会话标题、项目、最后活动时间、会话 id 和命中摘录。",
        "需要详细内容时再用 read_session 读取。",
      ].join(""),
      promptSnippet: "Search past sessions across all projects (read-only).",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "关键词，匹配标题和消息内容" })),
        project: Type.Optional(Type.String({ description: "项目目录名或路径前缀" })),
        since: Type.Optional(Type.String({ description: "只看此日期之后的会话（如 2026-10-01）" })),
        limit: Type.Optional(Type.Integer({ description: "返回条数上限，默认 8，最大 20", minimum: 1, maximum: SEARCH_MAX_LIMIT })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const limit = Math.min(Math.max(params.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
        if (params.since !== undefined) {
          const since = parseSince(params.since);
          if (Number.isNaN(since)) {
            return {
              content: [{ type: "text", text: `since 日期无法解析：${concise(params.since, 40)}。请用 YYYY-MM-DD 或 ISO 格式。` }],
              details: undefined,
              isError: true,
            };
          }
        }
        const sinceMs = params.since === undefined ? undefined : parseSince(params.since) ?? undefined;
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return {
            content: [{ type: "text", text: `读取会话目录失败：${error instanceof Error ? concise(error.message, 120) : "未知错误"}` }],
            details: undefined,
            isError: true,
          };
        }
        const rawQuery = typeof params.query === "string" ? params.query.trim() : "";
        const query = rawQuery === "" ? undefined : rawQuery;
        const matched = sessions.filter((info) => {
          if (sinceMs !== undefined && info.modified.getTime() < sinceMs) return false;
          if (params.project !== undefined && !projectMatches(info, params.project)) return false;
          if (query === undefined) return true;
          const haystack = `${info.name ?? ""}\n${info.firstMessage}\n${info.allMessagesText}`.toLowerCase();
          return haystack.includes(query.toLowerCase());
        });
        const page = matched.slice(0, limit);
        return {
          content: [{ type: "text", text: searchResultText(page, matched.length, query) }],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: "session_status",
      label: "查看会话动态",
      description: [
        "查看所有项目的会话当前状态（只读，与界面侧边栏同一权威数据源）。",
        "列出：正在运行的会话、等待用户回答的会话（未回答的提问卡片/扩展请求）、最近一轮报错的会话。",
        "状态实时来自会话管理器；「最近报错」来自各会话记录的最后错误。",
      ].join(""),
      promptSnippet: "Read-only live session status (running/waiting-user/recent-error).",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "可选：仅当用户明确要求按某个项目过滤时才传（目录名或路径前缀）。默认不传=返回全部项目" })),
      }),
      execute: async (_toolCallId, params, signal) => {
        if (sessionStatus === undefined) {
          return toolError("实时会话状态通道不可用（此 Worker 未接入会话管理器状态源）。");
        }
        let live: readonly WorkerSessionStatusItem[];
        try {
          live = await sessionStatus();
        } catch (error) {
          signal?.throwIfAborted();
          return toolFailure("查询实时会话状态失败", error);
        }
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return toolFailure("读取会话目录失败", error);
        }
        const projectFilter = params.project !== undefined && !isAssistantWorkspaceCwd(params.project)
          ? params.project.replace(/^\/*|\/*$/g, "")
          : "";
        const scoped = projectFilter === ""
          ? live
          : live.filter((item) => item.cwd.includes(projectFilter) || projectFilter.includes(item.cwd.split("/").filter(Boolean).at(-1) ?? "\u0000"));
        const lines: string[] = [];
        for (const item of scoped.slice(0, LIST_SESSION_BUDGET)) {
          if (isAssistantWorkspaceCwd(item.cwd)) continue;
          const stateLabel = item.state === "busy" ? "运行中" : item.state === "waitingUser" ? "等待用户" : "在线空闲";
          const info = sessions.find((candidate) => candidate.id === item.sessionId);
          const line = info !== undefined ? targetLine(info) : `${item.sessionId}｜项目:${projectLabel(item.cwd)}｜id:${item.sessionId}`;
          lines.push(`- [${stateLabel}] ${line}`);
          // Recent errors ride along from the persisted record (authoritative
          // for "the last turn failed"), only for non-running sessions.
          if (item.state !== "busy" && info !== undefined) {
            const entries = SessionManager.open(info.path).getEntries() as unknown as SdkMessageEntry[];
            const analysis = analyzeTail(entries);
            if (analysis.state === "recent_error" && analysis.detail !== "") lines.push(`  ${analysis.detail}`);
          }
        }
        if (lines.length === 0) {
          return toolText(scoped.length === 0 && params.project !== undefined
            ? "该项目下没有活跃会话。"
            : "没有正在运行或等待用户的会话；也没有需要留意的最近报错。");
        }
        return toolText(`当前活跃会话状态（与界面一致）：\n${lines.join("\n")}`);
      },
    });

    pi.registerTool({
      name: "list_open_todos",
      label: "汇总待办",
      description: [
        "汇总各会话待办清单里未完成的项（只读，按会话分组；pending 和 in_progress 算未完成）。",
        "数据来自每个会话记录里最后一次待办快照，不会激活任何会话。",
      ].join(""),
      promptSnippet: "Read-only open-todo digest grouped by session.",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "只看某个项目（目录名或路径前缀）" })),
      }),
      execute: async (_toolCallId, params, signal) => {
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return toolFailure("读取会话目录失败", error);
        }
        const scoped = params.project !== undefined
          ? sessions.filter((info) => projectMatches(info, params.project!))
          : sessions;
        const groups: string[] = [];
        let total = 0;
        for (const info of scoped) {
          if (groups.length >= LIST_SESSION_BUDGET) break;
          const entries = SessionManager.open(info.path).getEntries() as unknown as SdkMessageEntry[];
          const snapshot = replayTodoSnapshot(entries);
          const open = snapshot?.tasks.filter((task) => task.status === "pending" || task.status === "in_progress") ?? [];
          if (open.length === 0) continue;
          total += open.length;
          const items = open.slice(0, 6).map((task) => `  - [${task.status === "in_progress" ? "进行中" : "待办"}] ${concise(task.subject, 80)}`);
          if (open.length > 6) items.push(`  - …等 ${open.length - 6} 项`);
          groups.push(`${targetLine(info)}：\n${items.join("\n")}`);
        }
        if (groups.length === 0) {
          return toolText(params.project === undefined ? "所有会话都没有未完成的待办。" : "该项目下没有未完成的待办。");
        }
        return toolText(`共 ${total} 项未完成待办：\n${groups.join("\n")}`);
      },
    });

    pi.registerTool({
      name: "summarize_activity",
      label: "整理动态",
      description: [
        "整理一段时间内各会话的活动（只读）：每个会话的轮数、写入过的文件、最后一条助手消息摘要。",
        "用于写日报/周报；本身不调用模型。默认今天；range 可为 today/week 或 N（最近 N 天）。",
      ].join(""),
      promptSnippet: "Read-only per-session activity digest for a time range.",
      parameters: Type.Object({
        range: Type.Optional(Type.String({ description: "today（默认）、week，或最近 N 天（如 3）" })),
        project: Type.Optional(Type.String({ description: "只看某个项目（目录名或路径前缀）" })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const now = Date.now();
        const range = (params.range ?? "today").trim().toLowerCase();
        let sinceMs: number;
        if (range === "today") {
          const dayStart = new Date(now);
          dayStart.setHours(0, 0, 0, 0);
          sinceMs = dayStart.getTime();
        } else if (range === "week") {
          sinceMs = now - 7 * 24 * 60 * 60 * 1000;
        } else if (/^\d+$/.test(range)) {
          sinceMs = now - Math.min(90, Math.max(1, Number(range))) * 24 * 60 * 60 * 1000;
        } else {
          return toolError(`range 无法解析：${concise(range, 40)}。请用 today / week / 数字天数。`);
        }
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return toolFailure("读取会话目录失败", error);
        }
        const scoped = (params.project !== undefined
          ? sessions.filter((info) => projectMatches(info, params.project!))
          : sessions)
          .filter((info) => info.modified.getTime() >= sinceMs)
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .slice(0, LIST_SESSION_BUDGET);
        if (scoped.length === 0) {
          return toolText("这个时间段内没有会话活动。");
        }
        const lines: string[] = [];
        for (const info of scoped) {
          const entries = SessionManager.open(info.path).getEntries() as unknown as SdkMessageEntry[];
          const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message as SdkMessage);
          const userTurns = messages.filter((message) => message?.role === "user").length;
          const written = new Set<string>();
          let lastAssistantText = "";
          for (const message of messages) {
            if (message?.role !== "assistant") continue;
            const blocks = Array.isArray(message.content) ? message.content : [];
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") lastAssistantText = block.text;
              if (block.type === "toolCall") {
                const path = writtenPathFromCall(block);
                if (path !== null && written.size < 8) written.add(path);
              }
            }
          }
          const files = written.size === 0 ? "" : `｜写入: ${[...written].map((path) => basename(path) || path).slice(0, 5).join(", ")}${written.size > 5 ? ` 等 ${written.size} 个` : ""}`;
          const summary = lastAssistantText === "" ? "" : `｜${concise(lastAssistantText, 120)}`;
          lines.push(`- ${targetLine(info)}｜${userTurns} 轮${files}${summary}`);
        }
        return toolText(`时间范围内 ${scoped.length} 个会话有活动：\n${lines.join("\n")}`);
      },
    });

    pi.registerTool({
      name: "find_file_changes",
      label: "查文件改动",
      description: [
        "查一个文件最近被哪些会话写过/改过（只读）：返回会话、时间、路径和那一轮的说明。",
        "数据来自各会话记录里的写入/编辑工具调用（含 write/edit 及常见别名）。",
      ].join(""),
      promptSnippet: "Read-only which sessions recently wrote/edited a file.",
      parameters: Type.Object({
        path: Type.String({ description: "文件路径或文件名（如 nginx.conf 或 /etc/nginx/nginx.conf）" }),
        limit: Type.Optional(Type.Integer({ description: "返回条数上限，默认 5，最大 10", minimum: 1, maximum: 10 })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
        const raw = params.path.trim().replace(/\\/g, "/");
        if (raw === "") return toolError("path 不能为空。");
        const needle = raw.toLowerCase();
        const matches = (candidate: string): boolean => {
          const normalized = candidate.replace(/\\/g, "/").toLowerCase();
          return normalized === needle || normalized.endsWith(`/${needle}`) || normalized.endsWith(needle);
        };
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return toolFailure("读取会话目录失败", error);
        }
        type Hit = { info: AssistantSessionInfo; at: number; path: string; note: string };
        const hits: Hit[] = [];
        for (const info of sessions) {
          if (hits.length >= limit * 3) break;
          const entries = SessionManager.open(info.path).getEntries() as unknown as SdkMessageEntry[];
          const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message as SdkMessage);
          const answered = new Map<string, { ok: boolean; at: number }>();
          for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
              answered.set(message.toolCallId, { ok: message.isError !== true, at: index });
            }
          }
          for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            if (message?.role !== "assistant") continue;
            const blocks = Array.isArray(message.content) ? message.content : [];
            const note = concise(blocks
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text as string).join(" "), 100);
            for (const block of blocks) {
              if (block.type !== "toolCall" || typeof block.id !== "string") continue;
              const path = writtenPathFromCall(block);
              if (path === null || !matches(path)) continue;
              const result = answered.get(block.id as string);
              if (result === undefined || !result.ok) continue;
              hits.push({ info, at: index, path, note: note === "" ? "(无文字说明)" : note });
              if (hits.length >= limit * 3) break;
            }
          }
        }
        if (hits.length === 0) {
          return toolText(`没有会话记录写过「${concise(raw, 60)}」。`);
        }
        const lines = hits
          .sort((a, b) => b.at - a.at || b.info.modified.getTime() - a.info.modified.getTime())
          .slice(0, limit)
          .map((hit) => `- ${targetLine(hit.info)}｜${relativeDate(hit.info.modified.getTime())}｜${hit.path}\n  说明: ${hit.note}`);
        return toolText(`找到 ${Math.min(hits.length, limit)} 条改动记录：\n${lines.join("\n")}`);
      },
    });

    pi.registerTool({
      name: "open_session",
      label: "建议打开会话",
      description: [
        "建议用户打开某个会话（不直接执行）。工具解析目标并返回信息；界面会渲染「打开」按钮，用户点击后才会切换。",
        "session 用 search_sessions 拿到的 id，或标题。",
      ].join(""),
      promptSnippet: "Suggest opening a session (user confirms via button).",
      parameters: Type.Object({
        session: Type.String({ description: "会话 id 或标题" }),
      }),
      execute: async (_toolCallId, params, signal) => {
        const resolved = await resolveTarget(params.session, signal);
        if ("error" in resolved) return resolved.error;
        const target = resolved.target;
        return toolText(`已建议打开会话（等用户点击「打开」按钮）：\n${targetLine(target)}\n\n如果用户没有点击，请继续在当前对话里帮助他。`);
      },
    });

    pi.registerTool({
      name: "organize_sessions",
      label: "建议整理会话",
      description: [
        "建议用户批量整理会话（不直接执行）：重命名或删除。",
        "界面会渲染「执行」按钮，用户点击后才会真正整理；删除还需要二次确认。",
        "重命名/删除是服务端会话操作。",
      ].join(""),
      promptSnippet: "Suggest a batch organize action (user confirms via button).",
      parameters: Type.Object({
        action: Type.String({ enum: ["rename", "delete"] }),
        sessions: Type.Array(Type.Object({ session: Type.String({ description: "会话 id 或标题" }) }), { minItems: 1, maxItems: 20, description: "目标会话列表" }),
        title: Type.Optional(Type.String({ description: "rename 时的会话新标题（必填）", maxLength: 200 })),
      }),
      execute: async (_toolCallId, params, signal) => {
        if (params.action === "rename") {
          const title = params.title?.trim();
          if (title === undefined || title === "") return toolError("rename 需要提供 title。");
          if (params.sessions.length !== 1) return toolError("rename 一次只支持一个会话。");
        }
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return toolFailure("读取会话目录失败", error);
        }
        const targets: AssistantSessionInfo[] = [];
        const missing: string[] = [];
        for (const row of params.sessions) {
          const target = resolveSessionTarget(row.session, sessions);
          if (target === undefined) missing.push(concise(row.session, 40));
          else if (!targets.some((existing) => existing.id === target.id)) targets.push(target);
        }
        if (missing.length > 0) {
          return toolError(`以下目标没有找到：${missing.join("、")}。可先用 search_sessions 查找。`);
        }
        const actionLabel: Record<string, string> = {
          rename: "重命名",
          delete: "删除",
        };
        const suffix = params.action === "rename" ? ` 为「${concise(params.title!.trim(), 60)}」` : "";
        return toolText(`已建议${actionLabel[params.action]} ${targets.length} 个会话${suffix}（等用户点击「执行」按钮${params.action === "delete" ? "并确认删除" : ""}）：\n${targets.map((target) => `- ${targetLine(target)}`).join("\n")}`);
      },
    });

    pi.registerTool({
      name: "draft_to_session",
      label: "起草续话",
      description: [
        "为另一个会话起草一段接续输入（不发送）。界面会渲染「填入输入框」按钮，用户点击后会切到该会话并把文字填进输入框，仍需用户自己发送。",
        "session 用 search_sessions 拿到的 id，或标题；text 是要填入的完整输入。",
      ].join(""),
      promptSnippet: "Draft a follow-up message into another session (fill only, never send).",
      parameters: Type.Object({
        session: Type.String({ description: "目标会话 id 或标题" }),
        text: Type.String({ description: "要填入目标会话输入框的文字（完整可发送的中文输入）", minLength: 1, maxLength: 8000 }),
      }),
      execute: async (_toolCallId, params, signal) => {
        const resolved = await resolveTarget(params.session, signal);
        if ("error" in resolved) return resolved.error;
        const target = resolved.target;
        return toolText(`已起草续话（等用户点击「填入输入框」按钮，不会自动发送）：\n目标: ${targetLine(target)}\n草稿: ${concise(params.text, 200)}`);
      },
    });

    pi.registerTool({
      name: "read_session",
      label: "读取会话",
      description: [
        "读取一个历史会话的最近消息（只读，不会打开或激活该会话）。",
        "用 search_sessions 拿到的会话 id，或会话标题。",
        "返回该会话的标题、项目和最近消息的文本摘要：用户消息与助手正文保留原文（截断），工具调用只给名字和简短结果。",
      ].join(""),
      promptSnippet: "Read the tail of a past session (read-only summary).",
      parameters: Type.Object({
        session: Type.String({ description: "会话 id 或标题" }),
        tail: Type.Optional(Type.Integer({ description: "读取最近 N 条消息，默认 20，最大 50", minimum: 1, maximum: READ_MAX_TAIL })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const tail = Math.min(Math.max(params.tail ?? READ_DEFAULT_TAIL, 1), READ_MAX_TAIL);
        const selector = params.session.trim();
        let sessions: AssistantSessionInfo[];
        try {
          sessions = await listSessionsForAssistant(signal);
        } catch (error) {
          signal?.throwIfAborted();
          return {
            content: [{ type: "text", text: `读取会话目录失败：${error instanceof Error ? concise(error.message, 120) : "未知错误"}` }],
            details: undefined,
            isError: true,
          };
        }
        const byId = sessions.filter((info) => info.id === selector);
        const byTitle = sessions.filter((info) => (info.name ?? "").toLowerCase() === selector.toLowerCase());
        const byTitleContains = sessions.filter((info) =>
          (info.name ?? "").toLowerCase().includes(selector.toLowerCase())
          || info.firstMessage.toLowerCase().includes(selector.toLowerCase()));
        const target = byId[0] ?? byTitle[0] ?? byTitleContains[0];
        if (target === undefined) {
          return {
            content: [{ type: "text", text: `没有找到会话「${concise(selector, 60)}」。可先用 search_sessions 查找。` }],
            details: undefined,
            isError: true,
          };
        }
        signal?.throwIfAborted();
        const manager = SessionManager.open(target.path);
        // Fail closed on identity mismatch (AGENTS §6): a stale/cached path must
        // never summarize a different JSONL as the requested session.
        if (manager.getSessionId() !== target.id) {
          return {
            content: [{ type: "text", text: `会话文件身份校验失败，无法读取「${concise(selector, 60)}」。可重新用 search_sessions 查找。` }],
            details: undefined,
            isError: true,
          };
        }
        const entries = manager.getEntries() as unknown as SdkMessageEntry[];
        const messageEntries = entries.filter((entry) => entry.type === "message");
        const recent = messageEntries.slice(-tail);
        const summaries = recent
          .map((entry) => summarizeMessageEntry(entry))
          .filter((line): line is string => line !== null);
        return {
          content: [{ type: "text", text: readSessionResultText(target, summaries, messageEntries.length) }],
          details: undefined,
        };
      },
    });
  };
}
