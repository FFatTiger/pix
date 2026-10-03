import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";
import { BuiltInCapabilityIdSchema } from "./built-in-capabilities.js";
import { StreamingAgentMessageSchema } from "./messages.js";

/**
 * Wire projection of actually-loaded built-ins, subagents, and todos.
 *
 * Canonical owner is `packages/runtime-core/src/runtime-projections.ts`.
 * Protocol cannot import runtime-core; this module mirrors the snapshot
 * shapes and bounds. Cross-package parity tests pin the two copies.
 */

export const BUILT_IN_LOAD_FAILURE_CODES = ["load_failed", "incompatible"] as const;
export const BuiltInLoadFailureCodeSchema = z.enum(BUILT_IN_LOAD_FAILURE_CODES);
export type BuiltInLoadFailureCode = z.infer<typeof BuiltInLoadFailureCodeSchema>;

export const SUBAGENT_TASK_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
  "stopped",
] as const;
export const SubagentTaskStatusSchema = z.enum(SUBAGENT_TASK_STATUSES);
export type SubagentTaskStatus = z.infer<typeof SubagentTaskStatusSchema>;

export const TODO_ITEM_STATUSES = ["pending", "in_progress", "completed"] as const;
export const TodoItemStatusSchema = z.enum(TODO_ITEM_STATUSES);
export type TodoItemStatus = z.infer<typeof TodoItemStatusSchema>;

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

const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const BoundedIdSchema = NonEmptyStringSchema.max(MAX_SUBAGENT_TASK_ID_LENGTH);
const SafeNonNegativeInt = z.number().int().nonnegative().safe();
const SafePositiveInt = z.number().int().positive().safe();
const UsageCountSchema = SafeNonNegativeInt.max(MAX_SUBAGENT_USAGE);

function uniqueCanonicalCapabilityIds(ids: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  let previous = -1;
  for (const id of ids) {
    const index = BuiltInCapabilityIdSchema.options.indexOf(id as typeof BuiltInCapabilityIdSchema.options[number]);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}

export const BuiltInLoadFailureSchema = z.strictObject({
  id: BuiltInCapabilityIdSchema,
  code: BuiltInLoadFailureCodeSchema,
});
export type BuiltInLoadFailure = z.infer<typeof BuiltInLoadFailureSchema>;

export const BuiltInRuntimeStateSchema = z.strictObject({
  configRevision: Hex64Schema,
  loaded: z.array(BuiltInCapabilityIdSchema).max(BuiltInCapabilityIdSchema.options.length),
  failures: z.array(BuiltInLoadFailureSchema).max(BuiltInCapabilityIdSchema.options.length),
}).superRefine((value, ctx) => {
  if (!uniqueCanonicalCapabilityIds(value.loaded)) {
    ctx.addIssue({ code: "custom", path: ["loaded"], message: "loaded built-ins must be unique in canonical order" });
  }
  const failureIds = value.failures.map((row) => row.id);
  if (!uniqueCanonicalCapabilityIds(failureIds)) {
    ctx.addIssue({ code: "custom", path: ["failures"], message: "built-in failures must be unique in canonical order" });
  }
  const loadedIds = new Set(value.loaded);
  if (failureIds.some((id) => loadedIds.has(id))) {
    ctx.addIssue({ code: "custom", path: ["failures"], message: "a built-in cannot be both loaded and failed" });
  }
});
export type BuiltInRuntimeState = z.infer<typeof BuiltInRuntimeStateSchema>;

export const SubagentTaskUsageSchema = z.strictObject({
  turns: UsageCountSchema.optional(),
  toolCalls: UsageCountSchema.optional(),
  tokens: UsageCountSchema.optional(),
});
export type SubagentTaskUsage = z.infer<typeof SubagentTaskUsageSchema>;

export const SubagentTaskSchema = z.strictObject({
  taskId: BoundedIdSchema,
  name: NonEmptyStringSchema.max(MAX_SUBAGENT_NAME_LENGTH).optional(),
  description: NonEmptyStringSchema.max(MAX_SUBAGENT_DESCRIPTION_LENGTH),
  agentType: NonEmptyStringSchema.max(MAX_SUBAGENT_AGENT_TYPE_LENGTH),
  status: SubagentTaskStatusSchema,
  background: z.boolean().optional(),
  startedAt: SafeNonNegativeInt.optional(),
  completedAt: SafeNonNegativeInt.optional(),
  childSessionId: BoundedIdSchema.optional(),
  preview: NonEmptyStringSchema.max(MAX_SUBAGENT_PREVIEW_LENGTH).optional(),
  usage: SubagentTaskUsageSchema.optional(),
});
export type SubagentTask = z.infer<typeof SubagentTaskSchema>;

export const SubagentProjectionSchema = z.strictObject({
  revision: SafeNonNegativeInt,
  tasks: z.array(SubagentTaskSchema).max(MAX_SUBAGENT_TASKS),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (seen.has(task.taskId)) {
      ctx.addIssue({ code: "custom", path: ["tasks", index, "taskId"], message: "subagent taskId must be unique" });
      return;
    }
    seen.add(task.taskId);
  }
});
export type SubagentProjection = z.infer<typeof SubagentProjectionSchema>;

export const SubagentStreamEntrySchema = z.strictObject({
  partial: StreamingAgentMessageSchema,
  updatedAt: SafeNonNegativeInt,
});
export type SubagentStreamEntry = z.infer<typeof SubagentStreamEntrySchema>;

export const SubagentStreamsSchema = z.record(BoundedIdSchema, SubagentStreamEntrySchema).superRefine((value, ctx) => {
  if (Object.keys(value).length > MAX_SUBAGENT_TASKS) {
    ctx.addIssue({ code: "custom", message: "subagent streams exceed MAX_SUBAGENT_TASKS" });
  }
});
export type SubagentStreams = z.infer<typeof SubagentStreamsSchema>;

export const TodoItemSchema = z.strictObject({
  id: SafePositiveInt,
  subject: NonEmptyStringSchema.max(MAX_TODO_SUBJECT_LENGTH),
  description: NonEmptyStringSchema.max(MAX_TODO_DESCRIPTION_LENGTH).optional(),
  activeForm: NonEmptyStringSchema.max(MAX_TODO_ACTIVE_FORM_LENGTH).optional(),
  owner: NonEmptyStringSchema.max(MAX_TODO_OWNER_LENGTH).optional(),
  blockedBy: z.array(SafePositiveInt).max(MAX_TODO_BLOCKED_BY),
  status: TodoItemStatusSchema,
}).superRefine((item, ctx) => {
  const seen = new Set<number>();
  for (const [index, id] of item.blockedBy.entries()) {
    if (id === item.id || seen.has(id)) {
      ctx.addIssue({ code: "custom", path: ["blockedBy", index], message: "blockedBy ids must be unique and not self-referential" });
      return;
    }
    seen.add(id);
  }
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoProjectionSchema = z.strictObject({
  revision: SafeNonNegativeInt,
  items: z.array(TodoItemSchema).max(MAX_TODO_ITEMS),
}).superRefine((value, ctx) => {
  const seen = new Set<number>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", path: ["items", index, "id"], message: "todo id must be unique" });
      return;
    }
    seen.add(item.id);
  }
});
export type TodoProjection = z.infer<typeof TodoProjectionSchema>;
