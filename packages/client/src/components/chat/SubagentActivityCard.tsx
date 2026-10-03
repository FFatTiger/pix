import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowsInSimpleIcon } from "@phosphor-icons/react/ArrowsInSimple";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useI18n } from "@/hooks/useI18n";
import type { StatusTodoItem, SubagentActivity } from "@/lib/subagent-activity";

export type StatusCardDisplayMode = "auto" | "panel" | "mini";

export interface SubagentActivityCardProps {
  activities: readonly SubagentActivity[];
  todos?: readonly StatusTodoItem[];
  displayMode?: StatusCardDisplayMode;
  onDisplayModeChange?: (mode: StatusCardDisplayMode) => void;
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

export function SubagentActivityCard({
  activities,
  todos = EMPTY_TODOS,
  displayMode = "auto",
  onDisplayModeChange,
  onOpenActivity,
  onOpenDirectory,
}: SubagentActivityCardProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [progressOpen, setProgressOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(() => activities.some((activity) => activity.status === "running"));
  const [allTodosOpen, setAllTodosOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
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
    if (hasRunning) setAgentsOpen(true);
  }, [hasRunning]);

  useEffect(() => {
    if (running.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running.length]);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (todos.length === 0 && activities.length === 0) return null;

  const setMode = (mode: StatusCardDisplayMode): void => {
    setMenuOpen(false);
    onDisplayModeChange?.(mode);
  };

  return (
    <div
      className="subagent-activity-card"
      data-testid="subagent-activity-card"
      data-display-mode={displayMode}
    >
      <aside
        className="status-card-shell"
        aria-label={t("desktop.status")}
        data-testid="status-card-shell"
      >
        <div className="status-card-panel">
          <div className="subagent-activity-head">
            <span className="subagent-activity-title">{t("desktop.status")}</span>
            <span className="status-card-head-actions">
              <span className="status-card-menu" ref={menuRef}>
                <button
                  type="button"
                  className="subagent-icon-button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={t("desktop.statusDisplayMode")}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <DotsThreeIcon size={15} aria-hidden="true" />
                </button>
                {menuOpen ? (
                  <div className="status-card-menu-list" role="menu">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={displayMode === "auto"}
                      className="status-card-menu-item"
                      onClick={() => setMode("auto")}
                    >
                      {t("desktop.statusDisplayModeAuto")}
                    </button>
                  </div>
                ) : null}
              </span>
              <button
                type="button"
                className="subagent-icon-button"
                onClick={() => setMode("mini")}
                title={t("desktop.minimizeStatus")}
                aria-label={t("desktop.minimizeStatus")}
              >
                <ArrowsInSimpleIcon size={15} aria-hidden="true" />
              </button>
            </span>
          </div>
          <div className="status-card-body">
            {todos.length > 0 ? (
              <section className="status-card-section" data-testid="status-progress-section">
                <button
                  type="button"
                  className="status-card-section-toggle"
                  aria-expanded={progressOpen}
                  aria-controls="status-progress-body"
                  id="status-progress-heading"
                  aria-label={t("desktop.statusProgress")}
                  onClick={() => setProgressOpen((open) => !open)}
                >
                  <span className="status-card-section-title">
                    {progressOpen
                      ? <CaretDownIcon size={12} aria-hidden="true" />
                      : <CaretRightIcon size={12} aria-hidden="true" />}
                    {t("desktop.statusProgress")}
                  </span>
                  <span className="status-card-section-count">
                    {completedTodoCount}/{todos.length}
                  </span>
                </button>
                {progressOpen ? (
                  <ul
                    className="status-todo-list"
                    id="status-progress-body"
                    aria-labelledby="status-progress-heading"
                  >
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
                ) : null}
              </section>
            ) : null}
            {activities.length > 0 ? (
              <section
                className={`status-card-section${todos.length > 0 ? " is-separated" : ""}`}
                data-testid="status-agents-section"
              >
                <button
                  type="button"
                  className="status-card-section-toggle"
                  aria-expanded={agentsOpen}
                  aria-controls="status-agents-body"
                  id="status-agents-heading"
                  aria-label={t("desktop.subagents")}
                  onClick={() => setAgentsOpen((open) => !open)}
                >
                  <span className="status-card-section-title">
                    {agentsOpen
                      ? <CaretDownIcon size={12} aria-hidden="true" />
                      : <CaretRightIcon size={12} aria-hidden="true" />}
                    {t("desktop.subagents")}
                  </span>
                  {running.length > 0 ? (
                    <span className="status-card-section-count">
                      {t("desktop.runningAgentsCount", { count: running.length })}
                    </span>
                  ) : null}
                </button>
                {agentsOpen ? (
                  <div className="subagent-activity-body" id="status-agents-body" aria-labelledby="status-agents-heading">
                    {running.map((activity) => {
                      const content = (
                        <>
                          <CircleNotchIcon className="subagent-running-icon" size={15} aria-hidden="true" />
                          <span className="subagent-activity-copy">
                            <span className="subagent-activity-row-title">{activity.title}</span>
                            <span className="subagent-activity-meta">
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
                    {endedCount > 0 ? (
                      <button
                        type="button"
                        className="subagent-ended-row"
                        onClick={onOpenDirectory}
                      >
                        <span>{t("desktop.endedAgents")}</span>
                        <span className="subagent-ended-count">{endedCount}</span>
                        <CaretRightIcon size={14} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
        {summary ? (
          <button
            type="button"
            className="subagent-activity-capsule"
            onClick={() => setMode("panel")}
            aria-label={t("desktop.expandStatus")}
            aria-expanded="false"
          >
            {summary.icon}
            <span className="status-capsule-label">{summary.label}</span>
          </button>
        ) : null}
      </aside>
    </div>
  );
}
