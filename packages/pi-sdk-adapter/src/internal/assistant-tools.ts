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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isAssistantWorkspacePath, matchesAssistantWorkspacePattern, normalizeAssistantWorkspacePath } from "@fffattiger/pix-runtime-core";
import { browseKindForWorkspace } from "./session-projection.js";

/** Fixed tool names (also used by the client's process-line labels). */
export const ASSISTANT_TOOL_NAMES = ["search_sessions", "read_session"] as const;

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
export function assistantExtensionFactoriesForCwd(cwd: string): InlineExtension[] {
  return isAssistantWorkspaceCwd(cwd) ? [createAssistantToolsExtension()] : [];
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
// Extension
// ---------------------------------------------------------------------------

/**
 * The assistant tools extension. Registered for assistant-workspace sessions
 * only; every execute is read-only JSONL access with bounded output and
 * honest `isError` results (never a thrown rejection, never fake success).
 */
export function createAssistantToolsExtension(): InlineExtension {
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
        const entries = SessionManager.open(target.path).getEntries() as unknown as SdkMessageEntry[];
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
