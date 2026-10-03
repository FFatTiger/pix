import { useCallback, useEffect, useMemo, useState } from "react";
import type { StreamingAgentMessage, SubagentTask, TodoItem } from "@fffattiger/pix-protocol";
import { useRuntime } from "@/runtime";
import {
  selectChildStream,
  selectStatusTodos,
  selectSubagentActivity,
  type StatusTodoItem,
  type SubagentActivity,
  type SubagentStreams,
} from "@/lib/subagent-activity";

const NO_TASKS: readonly SubagentTask[] = [];
const NO_TODOS: readonly TodoItem[] = [];
const NO_STREAMS: SubagentStreams = {};

export interface SubagentActivityView {
  readonly activities: readonly SubagentActivity[];
  readonly todos: readonly StatusTodoItem[];
  /** Authoritative parent projection revision; null until a projection exists. */
  readonly revision: number | null;
  /** Parent runtime epoch fencing revision delivery; null while detached/unknown. */
  readonly epoch: string | null;
  readonly error: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  refresh(): void;
  /** Live child partial from the shared reducer; null when absent or not running. */
  childStream(childSessionId: string | null | undefined): StreamingAgentMessage | null;
}

export function useSubagentActivity(options: {
  sessionId: string | null;
  enabled: boolean;
  live: boolean;
}): SubagentActivityView {
  const { sessionId, enabled, live } = options;
  const runtime = useRuntime(sessionId);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const tasks = enabled
    ? runtime?.snapshot?.state.subagents?.tasks ?? NO_TASKS
    : NO_TASKS;
  const todoItems = enabled
    ? runtime?.snapshot?.state.todo?.items ?? NO_TODOS
    : NO_TODOS;
  const activities = useMemo(() => selectSubagentActivity(tasks), [tasks]);
  const todos = useMemo(() => selectStatusTodos(todoItems), [todoItems]);
  const revision = enabled
    ? runtime?.snapshot?.state.subagents?.revision ?? null
    : null;
  const streams = enabled
    ? readSubagentStreams(runtime?.snapshot?.state.subagents as { streams?: unknown } | undefined)
    : NO_STREAMS;

  useEffect(() => {
    setRefreshing(false);
    setRefreshError(false);
  }, [sessionId]);

  const refresh = useCallback(() => {
    if (!enabled || runtime?.available !== true || refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    void runtime.fetchSnapshot()
      .catch(() => setRefreshError(true))
      .finally(() => setRefreshing(false));
  }, [enabled, refreshing, runtime]);

  const childStream = useCallback(
    (childSessionId: string | null | undefined): StreamingAgentMessage | null => {
      return selectChildStream(streams, childSessionId);
    },
    [streams],
  );

  return {
    activities,
    todos,
    revision,
    epoch: enabled ? runtime?.epoch ?? null : null,
    error: refreshError,
    loading: enabled && live && runtime?.available === true && runtime.snapshot === null,
    refreshing,
    refresh,
    childStream,
  };
}

/**
 * Defensive read: `streams` is optional on the parent projection until the
 * protocol field lands, and snapshots may omit it entirely.
 */
function readSubagentStreams(subagents: { streams?: unknown } | null | undefined): SubagentStreams {
  const streams = subagents?.streams;
  if (streams === null || streams === undefined || typeof streams !== "object" || Array.isArray(streams)) {
    return NO_STREAMS;
  }
  return streams as SubagentStreams;
}
