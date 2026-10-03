/**
 * Canonical runtime projections for actually-loaded built-ins, subagents, and
 * todos. These are snapshot-frame product models, never transcript derivation
 * and never Host desired-enablement config.
 *
 * Bounds exist so a reconnect snapshot stays inside Worker/Host frame budgets.
 * No path, raw prompt, or backend package name is part of these DTOs.
 */
import {
  BUILT_IN_CAPABILITY_IDS,
  isBuiltInCapabilityId,
  type BuiltInCapabilityId,
} from "./built-in-capabilities.js";

export const BUILT_IN_LOAD_FAILURE_CODES = ["load_failed", "incompatible"] as const;
export type BuiltInLoadFailureCode = (typeof BUILT_IN_LOAD_FAILURE_CODES)[number];

export const SUBAGENT_TASK_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
  "stopped",
] as const;
export type SubagentTaskStatus = (typeof SUBAGENT_TASK_STATUSES)[number];

export const TODO_ITEM_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoItemStatus = (typeof TODO_ITEM_STATUSES)[number];

/** SHA-256 of the desired-enablement bytes that produced this loaded set. */
export const BUILT_IN_CONFIG_REVISION_PATTERN = /^[0-9a-f]{64}$/;

export const MAX_SUBAGENT_TASKS = 64;
export const MAX_TODO_ITEMS = 64;
export const MAX_SUBAGENT_TASK_ID_LENGTH = 128;
export const MAX_SUBAGENT_NAME_LENGTH = 80;
export const MAX_SUBAGENT_DESCRIPTION_LENGTH = 240;
export const MAX_SUBAGENT_AGENT_TYPE_LENGTH = 64;
export const MAX_SUBAGENT_PREVIEW_LENGTH = 240;
export const MAX_TODO_SUBJECT_LENGTH = 160;
export const MAX_TODO_DESCRIPTION_LENGTH = 240;
export const MAX_TODO_ACTIVE_FORM_LENGTH = 80;
export const MAX_TODO_OWNER_LENGTH = 64;
export const MAX_TODO_BLOCKED_BY = 16;
export const MAX_SUBAGENT_USAGE = 1_000_000_000;
export const MAX_SUBAGENT_STREAM_CHARS = 16_384;

const SUBAGENT_STATUS_SET: ReadonlySet<string> = new Set(SUBAGENT_TASK_STATUSES);
const TODO_STATUS_SET: ReadonlySet<string> = new Set(TODO_ITEM_STATUSES);
const FAILURE_CODE_SET: ReadonlySet<string> = new Set(BUILT_IN_LOAD_FAILURE_CODES);

export interface BuiltInLoadFailure {
  id: BuiltInCapabilityId;
  code: BuiltInLoadFailureCode;
}

/**
 * Actually-loaded built-ins for this runtime. Distinct from Host desired
 * enablement (`BuiltInCapabilityConfigSnapshot`): `configRevision` is the
 * digest of the desired file that was applied; `loaded` is what the adapter
 * successfully installed.
 */
export interface BuiltInRuntimeState {
  configRevision: string;
  loaded: readonly BuiltInCapabilityId[];
  failures: readonly BuiltInLoadFailure[];
}

export interface SubagentTaskUsage {
  turns?: number;
  toolCalls?: number;
  tokens?: number;
}

/** Safe subagent task fields only — no path, no raw prompt. */
export interface SubagentTask {
  taskId: string;
  name?: string;
  description: string;
  agentType: string;
  status: SubagentTaskStatus;
  background?: boolean;
  startedAt?: number;
  completedAt?: number;
  childSessionId?: string;
  preview?: string;
  usage?: SubagentTaskUsage;
}

export interface SubagentProjection {
  revision: number;
  tasks: readonly SubagentTask[];
}

export interface TodoItem {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  blockedBy: readonly number[];
  status: TodoItemStatus;
}

export interface TodoProjection {
  revision: number;
  items: readonly TodoItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInt(value: unknown): value is number {
  return isSafeNonNegativeInt(value) && value > 0;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /[^\s]/.test(value);
}

function uniqueCanonicalIds(ids: readonly BuiltInCapabilityId[]): BuiltInCapabilityId[] {
  const seen = new Set(ids);
  return BUILT_IN_CAPABILITY_IDS.filter((id) => seen.has(id));
}

/**
 * Canonical loaded-built-in snapshot: unique IDs in vocabulary order, unique
 * failure rows, 64-hex revision. Returns null on any malformed input.
 */
export function normalizeBuiltInRuntimeState(value: unknown): BuiltInRuntimeState | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("configRevision") || !keys.includes("loaded") || !keys.includes("failures")) {
    return null;
  }
  const { configRevision, loaded, failures } = value;
  if (typeof configRevision !== "string" || !BUILT_IN_CONFIG_REVISION_PATTERN.test(configRevision)) return null;
  if (!Array.isArray(loaded) || loaded.length > BUILT_IN_CAPABILITY_IDS.length) return null;
  const loadedIds: BuiltInCapabilityId[] = [];
  const loadedSeen = new Set<BuiltInCapabilityId>();
  for (const id of loaded) {
    if (typeof id !== "string" || !isBuiltInCapabilityId(id) || loadedSeen.has(id)) return null;
    loadedSeen.add(id);
    loadedIds.push(id);
  }
  if (!Array.isArray(failures) || failures.length > BUILT_IN_CAPABILITY_IDS.length) return null;
  const failureRows: BuiltInLoadFailure[] = [];
  const failureSeen = new Set<BuiltInCapabilityId>();
  for (const row of failures) {
    if (!isRecord(row)) return null;
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== 2 || !rowKeys.includes("id") || !rowKeys.includes("code")) return null;
    const id = row.id;
    const code = row.code;
    if (typeof id !== "string" || !isBuiltInCapabilityId(id) || failureSeen.has(id) || loadedSeen.has(id)) return null;
    if (typeof code !== "string" || !FAILURE_CODE_SET.has(code)) return null;
    failureSeen.add(id);
    failureRows.push({ id, code: code as BuiltInLoadFailureCode });
  }
  const canonicalLoaded = uniqueCanonicalIds(loadedIds);
  const canonicalFailures = BUILT_IN_CAPABILITY_IDS
    .filter((id) => failureSeen.has(id))
    .map((id) => failureRows.find((row) => row.id === id)!);
  return { configRevision, loaded: canonicalLoaded, failures: canonicalFailures };
}

function normalizeUsage(value: unknown): SubagentTaskUsage | null {
  if (!isRecord(value)) return null;
  const usage: SubagentTaskUsage = {};
  for (const key of Object.keys(value)) {
    if (key !== "turns" && key !== "toolCalls" && key !== "tokens") return null;
    const amount = value[key];
    if (!isSafeNonNegativeInt(amount) || amount > MAX_SUBAGENT_USAGE) return null;
    usage[key as keyof SubagentTaskUsage] = amount;
  }
  return usage;
}

function normalizeSubagentTask(value: unknown): SubagentTask | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "taskId", "name", "description", "agentType", "status", "background",
    "startedAt", "completedAt", "childSessionId", "preview", "usage",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return null;
  }
  if (!isBoundedText(value.taskId, MAX_SUBAGENT_TASK_ID_LENGTH)) return null;
  if (!isBoundedText(value.description, MAX_SUBAGENT_DESCRIPTION_LENGTH)) return null;
  if (!isBoundedText(value.agentType, MAX_SUBAGENT_AGENT_TYPE_LENGTH)) return null;
  if (typeof value.status !== "string" || !SUBAGENT_STATUS_SET.has(value.status)) return null;
  const task: SubagentTask = {
    taskId: value.taskId,
    description: value.description,
    agentType: value.agentType,
    status: value.status as SubagentTaskStatus,
  };
  if (value.name !== undefined) {
    if (!isBoundedText(value.name, MAX_SUBAGENT_NAME_LENGTH)) return null;
    task.name = value.name;
  }
  if (value.background !== undefined) {
    if (typeof value.background !== "boolean") return null;
    task.background = value.background;
  }
  if (value.startedAt !== undefined) {
    if (!isSafeNonNegativeInt(value.startedAt)) return null;
    task.startedAt = value.startedAt;
  }
  if (value.completedAt !== undefined) {
    if (!isSafeNonNegativeInt(value.completedAt)) return null;
    task.completedAt = value.completedAt;
  }
  if (value.childSessionId !== undefined) {
    if (!isBoundedText(value.childSessionId, MAX_SUBAGENT_TASK_ID_LENGTH)) return null;
    task.childSessionId = value.childSessionId;
  }
  if (value.preview !== undefined) {
    if (!isBoundedText(value.preview, MAX_SUBAGENT_PREVIEW_LENGTH)) return null;
    task.preview = value.preview;
  }
  if (value.usage !== undefined) {
    const usage = normalizeUsage(value.usage);
    if (usage === null) return null;
    task.usage = usage;
  }
  return task;
}

/**
 * Full-replacement subagent projection: unique taskIds, bounded array/text,
 * nonnegative revision. Returns null on any malformed input.
 */
export function normalizeSubagentProjection(value: unknown): SubagentProjection | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("revision") || !keys.includes("tasks")) return null;
  if (!isSafeNonNegativeInt(value.revision)) return null;
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_SUBAGENT_TASKS) return null;
  const tasks: SubagentTask[] = [];
  const seen = new Set<string>();
  for (const item of value.tasks) {
    const task = normalizeSubagentTask(item);
    if (task === null || seen.has(task.taskId)) return null;
    seen.add(task.taskId);
    tasks.push(task);
  }
  return { revision: value.revision, tasks };
}

function normalizeTodoItem(value: unknown): TodoItem | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["id", "subject", "description", "activeForm", "owner", "blockedBy", "status"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return null;
  }
  if (!isSafePositiveInt(value.id)) return null;
  if (!isBoundedText(value.subject, MAX_TODO_SUBJECT_LENGTH)) return null;
  if (typeof value.status !== "string" || !TODO_STATUS_SET.has(value.status)) return null;
  if (!Array.isArray(value.blockedBy) || value.blockedBy.length > MAX_TODO_BLOCKED_BY) return null;
  const blockedBy: number[] = [];
  const blockedSeen = new Set<number>();
  for (const id of value.blockedBy) {
    if (!isSafePositiveInt(id) || blockedSeen.has(id) || id === value.id) return null;
    blockedSeen.add(id);
    blockedBy.push(id);
  }
  const item: TodoItem = {
    id: value.id,
    subject: value.subject,
    blockedBy,
    status: value.status as TodoItemStatus,
  };
  if (value.description !== undefined) {
    if (!isBoundedText(value.description, MAX_TODO_DESCRIPTION_LENGTH)) return null;
    item.description = value.description;
  }
  if (value.activeForm !== undefined) {
    if (!isBoundedText(value.activeForm, MAX_TODO_ACTIVE_FORM_LENGTH)) return null;
    item.activeForm = value.activeForm;
  }
  if (value.owner !== undefined) {
    if (!isBoundedText(value.owner, MAX_TODO_OWNER_LENGTH)) return null;
    item.owner = value.owner;
  }
  return item;
}

/**
 * Full-replacement todo projection: unique positive ids, bounded arrays/text,
 * nonnegative revision. Returns null on any malformed input.
 */
export function normalizeTodoProjection(value: unknown): TodoProjection | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("revision") || !keys.includes("items")) return null;
  if (!isSafeNonNegativeInt(value.revision)) return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_TODO_ITEMS) return null;
  const items: TodoItem[] = [];
  const seen = new Set<number>();
  for (const raw of value.items) {
    const item = normalizeTodoItem(raw);
    if (item === null || seen.has(item.id)) return null;
    seen.add(item.id);
    items.push(item);
  }
  return { revision: value.revision, items };
}
