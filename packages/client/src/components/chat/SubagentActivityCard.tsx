import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useI18n } from "@/hooks/useI18n";
import { shortModelName } from "@/lib/model-display";
import type { StatusTodoItem, SubagentActivity } from "@/lib/subagent-activity";

export interface SubagentActivityCardProps {
  activities: readonly SubagentActivity[];
  todos?: readonly StatusTodoItem[];
  onOpenActivity: (activity: SubagentActivity) => void;
  onOpenDirectory: () => void;
}

const EMPTY_TODOS: readonly StatusTodoItem[] = [];
const COMPACT_TODO_THRESHOLD = 6;
const TODO_FOCUS_WINDOW_SIZE = 3;

function elapsedLabel(startedAt: number | undefined, now: number, t: ReturnType<typeof useI18n>["t"]): string {
  if (startedAt === undefined) return "";
  const totalSeconds = Math.max(1, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(t("desktop.processDurationHours", { hours }));
  if (hours > 0 || minutes > 0) parts.push(t("desktop.processDurationMinutes", { minutes }));
  parts.push(t("desktop.processDurationSeconds", { seconds }));
  return parts.join(" ");
}

function todoFocusWindow(items: readonly StatusTodoItem[]): {
  compact: boolean;
  preceding: number;
  focus: readonly StatusTodoItem[];
  following: number;
} {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return { compact: false, preceding: 0, focus: items, following: 0 };
  }
  const runningIndex = items.findIndex((item) => item.status === "in_progress");
  const pendingIndex = items.findIndex((item) => item.status === "pending");
  const focusIndex = runningIndex >= 0
    ? runningIndex
    : pendingIndex >= 0
      ? pendingIndex
      : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
  const start = Math.max(
    0,
    Math.min(focusIndex - Math.floor(TODO_FOCUS_WINDOW_SIZE / 2), items.length - TODO_FOCUS_WINDOW_SIZE),
  );
  const end = Math.min(items.length, start + TODO_FOCUS_WINDOW_SIZE);
  return {
    compact: true,
    preceding: start,
    focus: items.slice(start, end),
    following: items.length - end,
  };
}

function capsuleSummary(
  todos: readonly StatusTodoItem[],
  running: readonly SubagentActivity[],
  endedCount: number,
  t: ReturnType<typeof useI18n>["t"],
): { icon: ReactNode; label: string } | null {
  const inProgress = todos.find((item) => item.status === "in_progress");
  if (inProgress) {
    return {
      icon: <ArrowRightIcon size={15} aria-hidden="true" />,
      label: inProgress.subject,
    };
  }
  const pending = todos.find((item) => item.status === "pending");
  if (pending) {
    return {
      icon: <CircleIcon size={15} aria-hidden="true" />,
      label: pending.subject,
    };
  }
  const completed = [...todos].reverse().find((item) => item.status === "completed");
  if (completed) {
    return {
      icon: <CheckCircleIcon className="status-todo-icon is-completed" size={15} aria-hidden="true" />,
      label: completed.subject,
    };
  }
  if (running.length > 0) {
    return {
      icon: <RobotIcon size={15} aria-hidden="true" />,
      label: t("desktop.runningAgentsCount", { count: running.length }),
    };
  }
  if (endedCount > 0) {
    return {
      icon: <RobotIcon size={15} aria-hidden="true" />,
      label: t("desktop.endedAgentsCount", { count: endedCount }),
    };
  }
  return null;
}

function TodoStatusIcon({ status }: { status: StatusTodoItem["status"] }) {
  if (status === "completed") {
    return <CheckCircleIcon className="status-todo-icon is-completed" size={14} aria-hidden="true" />;
  }
  if (status === "in_progress") {
    return <ArrowRightIcon className="status-todo-icon" size={14} aria-hidden="true" />;
  }
  return <CircleIcon className="status-todo-icon is-pending" size={14} aria-hidden="true" />;
}

/**
 * Status strip above the composer. The capsule carries the current step, the
 * todo completion count, and the running-agent count; clicking it expands a
 * flat card upward (todos, then running agents, then the ended-agents entry).
 * Expansion is component-local transient state — never persisted.
 */
export function SubagentActivityCard({
  activities,
  todos = EMPTY_TODOS,
  onOpenActivity,
  onOpenDirectory,
}: SubagentActivityCardProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const capsuleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [allTodosOpen, setAllTodosOpen] = useState(false);
  const running = useMemo(() => activities.filter((activity) => activity.status === "running"), [activities]);
  const endedCount = activities.length - running.length;
  const completedTodoCount = useMemo(
    () => todos.filter((item) => item.status === "completed").length,
    [todos],
  );
  const summary = capsuleSummary(todos, running, endedCount, t);
  const todoWindow = todoFocusWindow(todos);
  const hasRunning = running.length > 0;

  useEffect(() => {
    if (running.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      if (rootRef.current?.contains(document.activeElement)) capsuleRef.current?.focus();
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (todos.length === 0 && activities.length === 0) return null;

  const endedRow = endedCount > 0 ? (
    <button type="button" className="subagent-ended-row" onClick={onOpenDirectory}>
      <span>{t("desktop.endedAgents")}</span>
      <span className="subagent-ended-count">{endedCount}</span>
      <CaretRightIcon size={14} aria-hidden="true" />
    </button>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="subagent-activity-card"
      data-testid="subagent-activity-card"
      data-open={open || undefined}
    >
      <aside
        className="status-card-shell"
        aria-label={t("desktop.status")}
        data-testid="status-card-shell"
      >
        {summary ? (
          <button
            ref={capsuleRef}
            type="button"
            className="subagent-activity-capsule"
            onClick={() => setOpen((value) => !value)}
            title={summary.label}
            aria-label={t("desktop.expandStatus")}
            aria-expanded={open}
          >
            {summary.icon}
            <span className="status-capsule-label">{summary.label}</span>
            {todos.length > 0 ? (
              <span className="status-capsule-count">{completedTodoCount}/{todos.length}</span>
            ) : null}
            {hasRunning ? (
              <span
                className="status-capsule-agents"
                title={t("desktop.runningAgentsCount", { count: running.length })}
              >
                <CircleNotchIcon className="subagent-running-icon" size={12} aria-hidden="true" />
                {running.length}
              </span>
            ) : null}
            <span className="status-capsule-joint" aria-hidden="true" />
          </button>
        ) : null}
        <div className="status-card-panel" inert={!open}>
          <div className="status-card-body">
            {todos.length > 0 ? (
              <section className="status-card-section" data-testid="status-progress-section">
                <ul className="status-todo-list">
                  {!allTodosOpen && todoWindow.preceding > 0 ? (
                    <li>
                      <button type="button" className="status-todo-fold" aria-expanded={false} aria-controls="status-progress-body" onClick={() => setAllTodosOpen(true)}>
                        {t("desktop.statusTodosEarlier", { count: todoWindow.preceding })}
                      </button>
                    </li>
                  ) : null}
                  {(allTodosOpen ? todos : todoWindow.focus).map((item) => (
                    <li
                      key={item.id}
                      className={`status-todo-row is-${item.status}`}
                      data-todo-status={item.status}
                    >
                      <TodoStatusIcon status={item.status} />
                      <span className="status-todo-subject" title={item.subject}>{item.subject}</span>
                    </li>
                  ))}
                  {!allTodosOpen && todoWindow.following > 0 ? (
                    <li>
                      <button type="button" className="status-todo-fold" aria-expanded={false} aria-controls="status-progress-body" onClick={() => setAllTodosOpen(true)}>
                        {t("desktop.statusTodosLater", { count: todoWindow.following })}
                      </button>
                    </li>
                  ) : null}
                  {allTodosOpen && todoWindow.compact ? (
                    <li>
                      <button type="button" className="status-todo-fold" aria-expanded={true} aria-controls="status-progress-body" onClick={() => setAllTodosOpen(false)}>
                        {t("desktop.showLess")}
                      </button>
                    </li>
                  ) : null}
                </ul>
              </section>
            ) : null}
            {hasRunning ? (
              <section
                className={`status-card-section${todos.length > 0 ? " is-separated" : ""}`}
                data-testid="status-agents-section"
              >
                <div className="subagent-activity-body">
                  {running.map((activity) => {
                    const content = (
                      <>
                        <CircleNotchIcon className="subagent-running-icon" size={15} aria-hidden="true" />
                        <span className="subagent-activity-copy">
                          <span className="subagent-activity-row-title">{activity.title}</span>
                          <span
                            className="subagent-activity-meta"
                            title={[activity.model, activity.agentType].filter(Boolean).join(" · ")}
                          >
                            {activity.model === undefined ? null : (
                              <span className="subagent-activity-model">{shortModelName(activity.model)}</span>
                            )}
                            {activity.agentType ? <span>{activity.agentType}</span> : null}
                            {activity.startedAt === undefined ? null : <span>{elapsedLabel(activity.startedAt, now, t)}</span>}
                          </span>
                        </span>
                        {activity.childSessionId === undefined ? null : <CaretRightIcon size={14} aria-hidden="true" />}
                      </>
                    );
                    return activity.childSessionId === undefined ? (
                      <div
                        className="subagent-activity-row is-pending"
                        key={activity.key}
                        aria-disabled="true"
                      >
                        {content}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="subagent-activity-row"
                        key={activity.key}
                        onClick={() => onOpenActivity(activity)}
                        aria-label={t("desktop.openSubagent", { title: activity.title })}
                      >
                        {content}
                      </button>
                    );
                  })}
                  {endedRow}
                </div>
              </section>
            ) : endedRow}
          </div>
        </div>
      </aside>
    </div>
  );
}
