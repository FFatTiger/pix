import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  MAX_SUBAGENT_AGENT_TYPE_LENGTH,
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_NAME_LENGTH,
  MAX_SUBAGENT_PREVIEW_LENGTH,
  MAX_SUBAGENT_TASKS,
  MAX_SUBAGENT_TASK_ID_LENGTH,
  MAX_SUBAGENT_USAGE,
  normalizeSubagentProjection,
  type StreamingAgentMessage,
  type SubagentProjection,
  type SubagentTask,
  type SubagentTaskStatus,
} from "@fffattiger/pix-runtime-core";
import { mapMessage } from "../mappers/index.js";

const TASK_FILE_MAX_BYTES = 64 * 1024;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
export const MAX_SUBAGENT_TASK_DIRS = 128;
const SUBAGENT_STATUSES = new Set<SubagentTaskStatus>(["running", "completed", "partial", "failed", "stopped"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isTrackedChildSessionId(
  childSessionId: string,
  tasks: readonly SubagentTask[],
): boolean {
  if (!SESSION_ID_PATTERN.test(childSessionId) || childSessionId.length > MAX_SUBAGENT_TASK_ID_LENGTH) return false;
  return tasks.some((task) => task.childSessionId === childSessionId);
}

export function projectSubagentStreamEvent(input: {
  childSessionId: string;
  event: unknown;
  tasks: readonly SubagentTask[];
  sessionId: string;
}): { type: "subagent_delta"; sessionId: string; childSessionId: string; partial: StreamingAgentMessage; done: boolean } | undefined {
  if (!isTrackedChildSessionId(input.childSessionId, input.tasks)) return undefined;
  if (!input.event || typeof input.event !== "object") return undefined;
  const type = (input.event as { type?: unknown }).type;
  const message = (input.event as { message?: unknown }).message;
  if (type === "message_update") {
    return {
      type: "subagent_delta",
      sessionId: input.sessionId,
      childSessionId: input.childSessionId,
      partial: mapMessage(message, true) as StreamingAgentMessage,
      done: false,
    };
  }
  if (type === "message_end" && (message as { role?: unknown } | undefined)?.role === "assistant") {
    return {
      type: "subagent_delta",
      sessionId: input.sessionId,
      childSessionId: input.childSessionId,
      partial: mapMessage(message, true) as StreamingAgentMessage,
      done: true,
    };
  }
  return undefined;
}

export interface SubagentWatchTarget {
  readonly directory: string;
  /** null watches every direct child; otherwise only these exact basenames. */
  readonly basenames: readonly string[] | null;
}

export interface SubagentObservation {
  readonly tasks: readonly SubagentTask[];
  readonly watchTargets: readonly SubagentWatchTarget[];
  /** Validated child transcript identities; paths stay adapter-internal. */
  readonly childSignatures: readonly string[];
}

export const SUBAGENT_REFRESH_TOOLS = new Set(["Agent", "TaskOutput", "SendMessage", "TaskStop"]);
export const SUBAGENT_REFRESH_CUSTOM_TYPES = new Set(["pi-subagent-notification", "pi-subagent-progress-warning", "pi-subagent-notification-batch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /[^\s]/.test(value);
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

function isAbsentPath(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function regularFile(path: string, maxBytes: number) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maxBytes) return null;
    return info;
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return null;
  }
}

/** Regular, non-symlink file of any size (identity is validated by a bounded header read). */
function regularNonSymlinkFile(path: string) {
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink() && info.isFile() && info.size > 0 ? info : null;
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return null;
  }
}

function regularDir(path: string) {
  try {
    const info = lstatSync(path);
    return !info.isSymbolicLink() && info.isDirectory();
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return false;
  }
}

function containedPath(root: string, candidate: string): string | null {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  return resolved;
}

function sessionCandidate(record: Record<string, unknown>, agentDir: string): string | null {
  if (typeof record.sessionFile !== "string" || record.sessionFile.length === 0 || record.sessionFile.length > 4096 || record.sessionFile.includes("\0")) return null;
  const sessionsRoot = resolve(agentDir, "sessions");
  const candidate = containedPath(sessionsRoot, record.sessionFile);
  if (candidate === null || !candidate.endsWith(".jsonl")) return null;
  try {
    const realRoot = realpathSync(sessionsRoot);
    const realParent = realpathSync(dirname(candidate));
    if (containedPath(realRoot, realParent) === null) return null;
    return candidate;
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function millis(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function mapUsage(value: unknown): SubagentTask["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  const usage: NonNullable<SubagentTask["usage"]> = {};
  if (isSafeNonNegativeInt(value.turns) && value.turns <= MAX_SUBAGENT_USAGE) usage.turns = value.turns;
  const toolCalls = isSafeNonNegativeInt(value.toolCalls)
    ? value.toolCalls
    : isSafeNonNegativeInt(value.toolCallsExecuted) ? value.toolCallsExecuted : undefined;
  if (toolCalls !== undefined && toolCalls <= MAX_SUBAGENT_USAGE) usage.toolCalls = toolCalls;
  const tokens = [value.input, value.output, value.cacheRead, value.cacheWrite]
    .filter(isSafeNonNegativeInt)
    .reduce((sum, item) => sum + item, 0);
  if (tokens > 0 && tokens <= MAX_SUBAGENT_USAGE) usage.tokens = tokens;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function previewOf(record: Record<string, unknown>): string | undefined {
  return isBoundedText(record.preview, MAX_SUBAGENT_PREVIEW_LENGTH) ? record.preview : undefined;
}

/**
 * Bounded first-line read for the session header. Reads at most
 * SESSION_HEADER_MAX_BYTES + 1 bytes so an oversized (newline-less) header is
 * detectable without ever loading a large transcript; the session file itself
 * may be arbitrarily large.
 */
function readHeaderLine(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES + 1);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read === 0) return null;
    const text = buffer.toString("utf8", 0, read);
    const newline = text.indexOf("\n");
    if (newline === -1) return read > SESSION_HEADER_MAX_BYTES ? null : text;
    return text.slice(0, newline);
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function childSessionFromCandidate(sessionFile: string, input: {
  agentDir: string;
  parentSessionFile: string;
}): { childSessionId: string; signature: string } | undefined {
  const info = regularNonSymlinkFile(sessionFile);
  if (info === null) return undefined;
  try {
    const sessionsRoot = realpathSync(resolve(input.agentDir, "sessions"));
    if (containedPath(sessionsRoot, realpathSync(sessionFile)) === null) return undefined;
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return undefined;
  }
  const headerLine = readHeaderLine(sessionFile);
  if (headerLine === null) return undefined;
  const header = parseJson(headerLine);
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return undefined;
  if (!SESSION_ID_PATTERN.test(header.id) || header.id.length > MAX_SUBAGENT_TASK_ID_LENGTH) return undefined;
  if (typeof header.parentSession !== "string") return undefined;
  if (resolve(header.parentSession) !== resolve(input.parentSessionFile)) return undefined;
  return {
    childSessionId: header.id,
    signature: `${sessionFile}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
  };
}

function mapTask(record: unknown, input: {
  parentSessionId: string;
  agentDir: string;
  parentSessionFile: string;
}): { task: SubagentTask; sessionCandidate: string | null; childSignature?: string } | null {
  if (!isRecord(record)) return null;
  if (record.parentSessionId !== input.parentSessionId) return null;
  if (!isBoundedText(record.id, MAX_SUBAGENT_TASK_ID_LENGTH)) return null;
  if (!isBoundedText(record.description, MAX_SUBAGENT_DESCRIPTION_LENGTH)) return null;
  if (!isBoundedText(record.agent, MAX_SUBAGENT_AGENT_TYPE_LENGTH)) return null;
  if (typeof record.status !== "string" || !SUBAGENT_STATUSES.has(record.status as SubagentTaskStatus)) return null;
  const task: SubagentTask = {
    taskId: record.id,
    description: record.description,
    agentType: record.agent,
    status: record.status as SubagentTaskStatus,
  };
  if (record.name !== undefined) {
    if (!isBoundedText(record.name, MAX_SUBAGENT_NAME_LENGTH)) return null;
    task.name = record.name;
  }
  if (typeof record.background === "boolean") task.background = record.background;
  const startedAt = millis(record.startedAt);
  if (startedAt !== undefined) task.startedAt = startedAt;
  const completedAt = millis(record.completedAt);
  if (completedAt !== undefined) task.completedAt = completedAt;
  const preview = previewOf(record);
  if (preview !== undefined) task.preview = preview;
  const usage = mapUsage(record.usage);
  if (usage !== undefined) task.usage = usage;
  const candidate = sessionCandidate(record, input.agentDir);
  const child = candidate === null ? undefined : childSessionFromCandidate(candidate, input);
  if (child !== undefined) task.childSessionId = child.childSessionId;
  return {
    task,
    sessionCandidate: candidate,
    ...(child === undefined ? {} : { childSignature: child.signature }),
  };
}

export function readSubagentObservation(input: {
  agentDir: string;
  parentSessionId: string;
  parentSessionFile: string;
}): SubagentObservation {
  const empty: SubagentObservation = { tasks: [], watchTargets: [], childSignatures: [] };
  if (!SESSION_ID_PATTERN.test(input.parentSessionId) || input.parentSessionId.length > MAX_SUBAGENT_TASK_ID_LENGTH) return empty;
  const root = resolve(input.agentDir, "pi-claude-subagents", input.parentSessionId);
  if (!regularDir(root)) return empty;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  } catch (error) {
    if (!isAbsentPath(error)) throw error;
    return empty;
  }
  const tasks: SubagentTask[] = [];
  const watchTargets = new Map<string, Set<string> | null>([[root, null]]);
  const childSignatures: string[] = [];
  const taskIds = new Set<string>();
  let visitedDirs = 0;
  for (const entry of entries) {
    if (visitedDirs >= MAX_SUBAGENT_TASK_DIRS || tasks.length >= MAX_SUBAGENT_TASKS) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) continue;
    const dir = containedPath(root, join(root, entry.name));
    if (dir === null || !regularDir(dir)) continue;
    visitedDirs += 1;
    watchTargets.set(dir, new Set(["task.json"]));
    const taskFile = join(dir, "task.json");
    if (basename(taskFile) !== "task.json") continue;
    const info = regularFile(taskFile, TASK_FILE_MAX_BYTES);
    if (!info) continue;
    let text: string;
    try {
      text = readFileSync(taskFile, "utf8");
    } catch (error) {
      if (!isAbsentPath(error)) throw error;
      continue;
    }
    const mapped = mapTask(parseJson(text), input);
    if (mapped === null || taskIds.has(mapped.task.taskId)) continue;
    taskIds.add(mapped.task.taskId);
    tasks.push(mapped.task);
    if (mapped.sessionCandidate !== null) {
      const directory = dirname(mapped.sessionCandidate);
      const names = watchTargets.get(directory);
      if (names !== null) {
        const next = names ?? new Set<string>();
        next.add(basename(mapped.sessionCandidate));
        watchTargets.set(directory, next);
      }
    }
    if (mapped.childSignature !== undefined) childSignatures.push(mapped.childSignature);
  }
  tasks.sort((a, b) => {
    const started = (a.startedAt ?? 0) - (b.startedAt ?? 0);
    if (started !== 0) return started;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  childSignatures.sort();
  return {
    tasks,
    watchTargets: [...watchTargets]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([directory, basenames]) => ({
        directory,
        basenames: basenames === null ? null : [...basenames].sort(),
      })),
    childSignatures,
  };
}

export function readSubagentProjection(input: {
  agentDir: string;
  parentSessionId: string;
  parentSessionFile: string;
}): SubagentTask[] {
  return [...readSubagentObservation(input).tasks];
}

export function nextSubagentProjection(
  previous: SubagentProjection | undefined,
  tasks: readonly SubagentTask[],
  options: { contentChanged?: boolean } = {},
): { projection: SubagentProjection; changed: boolean } {
  const normalized = normalizeSubagentProjection({
    revision: previous?.revision ?? 0,
    tasks,
  });
  if (normalized === null) throw new Error("invalid subagent projection");
  const same = previous !== undefined && JSON.stringify(previous.tasks) === JSON.stringify(normalized.tasks);
  if (same && options.contentChanged !== true) return { projection: previous, changed: false };
  const revision = previous === undefined
    ? (normalized.tasks.length === 0 ? 0 : 1)
    : previous.revision + 1;
  return { projection: { revision, tasks: normalized.tasks }, changed: true };
}

export function cloneSubagents(value: SubagentProjection): SubagentProjection {
  return {
    revision: value.revision,
    tasks: value.tasks.map((task) => ({
      ...task,
      ...(task.usage === undefined ? {} : { usage: { ...task.usage } }),
    })),
  };
}

export function isSubagentRefreshEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "tool_execution_start" || value.type === "tool_execution_update" || value.type === "tool_execution_end") {
    return typeof value.toolName === "string" && SUBAGENT_REFRESH_TOOLS.has(value.toolName);
  }
  if (value.type === "message_end" || value.type === "message_start") {
    const message = isRecord(value.message) ? value.message : undefined;
    return message?.role === "custom"
      && typeof message.customType === "string"
      && SUBAGENT_REFRESH_CUSTOM_TYPES.has(message.customType);
  }
  return false;
}
