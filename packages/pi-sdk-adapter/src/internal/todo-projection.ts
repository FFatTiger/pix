import {
  MAX_TODO_ACTIVE_FORM_LENGTH,
  MAX_TODO_BLOCKED_BY,
  MAX_TODO_DESCRIPTION_LENGTH,
  MAX_TODO_ITEMS,
  MAX_TODO_OWNER_LENGTH,
  MAX_TODO_SUBJECT_LENGTH,
  normalizeTodoProjection,
  type TodoItem,
  type TodoItemStatus,
  type TodoProjection,
} from "@fffattiger/pix-runtime-core";
import { TODO_TOOL_NAME } from "./built-in-detection.js";

const TODO_STATUSES = new Set<TodoItemStatus>(["pending", "in_progress", "completed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value > 0;
}

// Plugin task text may exceed the wire's display budgets. Preserve the task
// and its authoritative status while projecting a bounded display summary.
function displayText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim().slice(0, max);
}

function mapItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null;
  if (!isSafePositiveInt(value.id)) return null;
  const subject = displayText(value.subject, MAX_TODO_SUBJECT_LENGTH);
  if (subject === null) return null;
  if (typeof value.status !== "string") return null;
  if (value.status === "deleted") return null;
  if (!TODO_STATUSES.has(value.status as TodoItemStatus)) return null;
  const blockedRaw = Array.isArray(value.blockedBy) ? value.blockedBy : [];
  if (blockedRaw.length > MAX_TODO_BLOCKED_BY) return null;
  const blockedBy: number[] = [];
  const seen = new Set<number>();
  for (const id of blockedRaw) {
    if (!isSafePositiveInt(id) || seen.has(id) || id === value.id) return null;
    seen.add(id);
    blockedBy.push(id);
  }
  const item: TodoItem = {
    id: value.id,
    subject,
    blockedBy,
    status: value.status as TodoItemStatus,
  };
  if (value.description !== undefined) {
    const description = displayText(value.description, MAX_TODO_DESCRIPTION_LENGTH);
    if (description === null) return null;
    item.description = description;
  }
  if (value.activeForm !== undefined) {
    const activeForm = displayText(value.activeForm, MAX_TODO_ACTIVE_FORM_LENGTH);
    if (activeForm === null) return null;
    item.activeForm = activeForm;
  }
  if (value.owner !== undefined) {
    const owner = displayText(value.owner, MAX_TODO_OWNER_LENGTH);
    if (owner === null) return null;
    item.owner = owner;
  }
  return item;
}

export function parseTodoDetails(value: unknown): TodoItem[] | null {
  const details = isRecord(value) && Array.isArray(value.tasks)
    ? value
    : isRecord(value) && isRecord(value.details) && Array.isArray(value.details.tasks)
      ? value.details
      : null;
  if (details === null || !Array.isArray(details.tasks) || details.tasks.length > MAX_TODO_ITEMS * 2) return null;
  const items: TodoItem[] = [];
  const seen = new Set<number>();
  for (const raw of details.tasks) {
    if (isRecord(raw) && raw.status === "deleted") continue;
    const item = mapItem(raw);
    if (item === null || seen.has(item.id)) return null;
    seen.add(item.id);
    items.push(item);
    if (items.length > MAX_TODO_ITEMS) return null;
  }
  return items;
}

function isExactTodoResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const toolName = value.toolName ?? value.tool_name;
  return value.role === "toolResult" && toolName === TODO_TOOL_NAME && value.isError === false;
}

export function todoItemsFromMessages(messages: readonly unknown[]): TodoItem[] {
  let latest: TodoItem[] | null = null;
  for (const message of messages) {
    if (!isExactTodoResult(message)) continue;
    const items = parseTodoDetails(isRecord(message) ? (message.details ?? message) : null);
    if (items !== null) latest = items;
  }
  return latest ?? [];
}

/**
 * Replay the selected durable branch, including entries hidden by compaction.
 * `session.messages` is the compacted LLM view and may omit the last Todo
 * result; SessionManager.getBranch() remains the authoritative branch history.
 */
export function todoItemsFromBranch(entries: readonly unknown[]): TodoItem[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    messages.push(entry.message);
  }
  return todoItemsFromMessages(messages);
}

export function todoItemsFromToolEnd(event: unknown): TodoItem[] | null {
  if (!isRecord(event) || event.type !== "tool_execution_end") return null;
  if (event.toolName !== TODO_TOOL_NAME || event.isError !== false) return null;
  const result = event.result;
  const details = isRecord(result) ? (result.details ?? result) : event.result;
  return parseTodoDetails(details);
}

/**
 * Exact successful `compaction_end` only: the branch was rewritten, so the
 * cold-seed replay from the authoritative session messages must run again.
 * Aborted, failed (no result), or lookalike events never trigger a replay.
 */
export function isTodoReplayEvent(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "compaction_end") return false;
  return event.aborted === false && isRecord(event.result);
}

export function nextTodoProjection(
  previous: TodoProjection | undefined,
  items: readonly TodoItem[],
): { projection: TodoProjection; changed: boolean } {
  const normalized = normalizeTodoProjection({
    revision: previous?.revision ?? 0,
    items,
  });
  if (normalized === null) throw new Error("invalid todo projection");
  const same = previous !== undefined && JSON.stringify(previous.items) === JSON.stringify(normalized.items);
  if (same) return { projection: previous, changed: false };
  const revision = previous === undefined
    ? (normalized.items.length === 0 ? 0 : 1)
    : previous.revision + 1;
  return { projection: { revision, items: normalized.items }, changed: true };
}

export function cloneTodo(value: TodoProjection): TodoProjection {
  return {
    revision: value.revision,
    items: value.items.map((item) => ({ ...item, blockedBy: [...item.blockedBy] })),
  };
}
