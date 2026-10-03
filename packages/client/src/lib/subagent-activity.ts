import type {
  StreamingAgentMessage,
  SubagentTask,
  SubagentTaskStatus,
  TodoItem,
  TodoItemStatus,
} from "@fffattiger/pix-protocol";

export type SubagentActivityStatus = SubagentTaskStatus;
export type StatusTodoStatus = TodoItemStatus;

export interface SubagentActivity {
  readonly key: string;
  readonly taskId: string;
  readonly title: string;
  readonly agentType: string;
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
