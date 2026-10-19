import type {
  StreamingAgentMessage,
  SubagentTask,
  SubagentTaskStatus,
  TodoItem,
  TodoItemStatus,
  UserContent,
} from "@fffattiger/pix-protocol";
import { assistantUserMessageKind } from "@/lib/assistant-message";

export type SubagentActivityStatus = SubagentTaskStatus;
export type StatusTodoStatus = TodoItemStatus;

export interface SubagentActivity {
  readonly key: string;
  readonly taskId: string;
  readonly title: string;
  readonly agentType: string;
  readonly model?: string | undefined;
  readonly status: SubagentActivityStatus;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly childSessionId?: string | undefined;
}

/** Transient child stream slot owned by the shared Protocol reducer. */
export interface SubagentChildStream {
  readonly partial: StreamingAgentMessage;
  readonly updatedAt?: number | undefined;
}

export type SubagentStreams = Readonly<Record<string, SubagentChildStream>>;

export interface StatusTodoItem {
  readonly id: number;
  readonly subject: string;
  readonly status: StatusTodoStatus;
}

/**
 * Start of the current turn: the timestamp of the most recent user-authored
 * message. Pixie's work notice and the messages Pixie sends on the user's
 * behalf are `user`-role entries too, but they do not open a turn — only a
 * message the user typed does.
 *
 * Returns `null` when no such message carries a usable timestamp (empty
 * session, history not committed yet, older producer): callers keep the old
 * unfiltered behavior instead of hiding work they cannot date.
 */
export function selectTurnStartedAt(
  messages: readonly { readonly role: string; readonly content?: unknown; readonly timestamp?: number | undefined }[],
): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    if (assistantUserMessageKind(userMessageText(message.content)) !== null) continue;
    const timestamp = message.timestamp;
    return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as UserContent as readonly { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * What the status capsule may show of THIS turn: agents still running, plus the
 * ones that ended at or after `turnStartedAt`. A session that has delegated a
 * task once used to keep its whole delegation history in the capsule forever;
 * the pane keeps that history, the capsule only carries the current turn.
 *
 * `turnStartedAt` is the timestamp of the session's most recent real user
 * message. `null` = unknown (history not loaded yet / snapshot missing): every
 * activity stays visible, never a silent hide.
 */
export function selectTurnActivities(
  activities: readonly SubagentActivity[],
  turnStartedAt: number | null,
): SubagentActivity[] {
  if (turnStartedAt === null) return [...activities];
  return activities.filter((activity) =>
    activity.status === "running"
    || (activity.completedAt !== undefined && activity.completedAt >= turnStartedAt));
}

/**
 * Todos stay off the capsule once the turn is over and everything is done — a
 * finished checklist is the last turn's work, not current state. While the
 * turn runs, a just-completed list stays visible so the user sees it land.
 */
export function shouldShowTodos(todos: readonly StatusTodoItem[], turnRunning: boolean): boolean {
  if (todos.length === 0) return false;
  if (turnRunning) return true;
  return todos.some((item) => item.status !== "completed");
}

/**
 * Project the authority-owned runtime task list into the card/panel view model.
 * The client never reconstructs task state or child identity from transcript
 * tool calls, opaque extension details, paths, or ordering guesses.
 */
export function selectSubagentActivity(tasks: readonly SubagentTask[]): SubagentActivity[] {
  return tasks.map((task) => ({
    key: `task:${task.taskId}`,
    taskId: task.taskId,
    title: task.name ?? task.description,
    agentType: task.agentType,
    ...(task.model === undefined ? {} : { model: task.model }),
    status: task.status,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.childSessionId === undefined ? {} : { childSessionId: task.childSessionId }),
  }));
}

/**
 * Project the authority-owned todo snapshot into the status card. Hidden
 * backend fields stay on the wire object; the view never mutates it.
 */
export function selectStatusTodos(items: readonly TodoItem[]): StatusTodoItem[] {
  return items.map((item) => ({
    id: item.id,
    subject: item.subject,
    status: item.status,
  }));
}

/**
 * Read one child's live partial from the parent snapshot's optional streams map.
 * Backend reducer owns replace-on-delta / delete-on-done; this never reconstructs.
 * Snapshot may omit `streams` until the protocol field lands — treat as empty.
 */
export function selectChildStream(
  streams: SubagentStreams | null | undefined,
  childSessionId: string | null | undefined,
): StreamingAgentMessage | null {
  if (childSessionId === null || childSessionId === undefined || childSessionId === "") return null;
  const slot = streams?.[childSessionId];
  return slot?.partial ?? null;
}
