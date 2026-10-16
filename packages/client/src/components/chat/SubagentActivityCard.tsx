import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { ArrowBendUpLeftIcon } from "@phosphor-icons/react/ArrowBendUpLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useI18n } from "@/hooks/useI18n";
import type { QueuedMessages } from "@/lib/chat-view-model";
import type { StatusTodoItem, SubagentActivity } from "@/lib/subagent-activity";

export interface SubagentActivityCardProps {
  activities: readonly SubagentActivity[];
  todos?: readonly StatusTodoItem[];
  /** Steering messages first, then follow-ups, in queue order. */
  queuedMessages?: QueuedMessages | null;
  /** Steer one queued message now (clear the queue, steer it, re-queue the rest). */
  onSteerQueued?: (index: number) => void;
  /** Clear the queue and put every message back into the composer. */
  onRecallQueue?: () => void;
  onOpenActivity: (activity: SubagentActivity) => void;
}

const EMPTY_TODOS: readonly StatusTodoItem[] = [];

/** Run time of an agent: start to finish once ended, start to now while running. Two units at most. */
function elapsedLabel(activity: SubagentActivity, now: number, t: ReturnType<typeof useI18n>["t"]): string {
  if (activity.startedAt === undefined) return "";
  const end = activity.status === "running" ? now : activity.completedAt;
  if (end === undefined) return "";
  const totalSeconds = Math.max(1, Math.floor((end - activity.startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return [t("desktop.processDurationHours", { hours }), ...(minutes > 0 ? [t("desktop.processDurationMinutes", { minutes })] : [])].join(" ");
  if (minutes > 0) return [t("desktop.processDurationMinutes", { minutes }), ...(seconds > 0 ? [t("desktop.processDurationSeconds", { seconds })] : [])].join(" ");
  return t("desktop.processDurationSeconds", { seconds });
}

function capsuleSummary(
  todos: readonly StatusTodoItem[],
  running: readonly SubagentActivity[],
  endedCount: number,
  queuedCount: number,
  t: ReturnType<typeof useI18n>["t"],
): { icon: ReactNode; label: string } | null {
  if (todos.length === 0 && running.length === 0 && endedCount === 0 && queuedCount > 0) {
    return {
      icon: <ArrowBendUpLeftIcon size={15} aria-hidden="true" />,
      label: t("desktop.pendingMessagesCount", { count: queuedCount }),
    };
  }
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
    return <CheckCircleIcon className="status-todo-icon is-completed" size={16} aria-hidden="true" />;
  }
  if (status === "in_progress") {
    return <ArrowRightIcon className="status-todo-icon" size={16} aria-hidden="true" />;
  }
  return <CircleIcon className="status-todo-icon is-pending" size={16} aria-hidden="true" />;
}

function AgentStatusIcon({ status }: { status: SubagentActivity["status"] }) {
  if (status === "running") {
    return <CircleNotchIcon className="subagent-running-icon" size={16} aria-hidden="true" />;
  }
  if (status === "completed") {
    return <CheckCircleIcon className="status-todo-icon is-completed" size={16} aria-hidden="true" />;
  }
  return <XCircleIcon className="subagent-status-icon is-failed" size={16} aria-hidden="true" />;
}

/**
 * Status strip above the composer. The capsule carries the current step, the
 * todo completion count, and the running-agent count; clicking it expands a
 * flat card upward (todos, then agents, then queued messages).
 * Expansion is component-local transient state — never persisted.
 */
export function SubagentActivityCard({
  activities,
  todos = EMPTY_TODOS,
  queuedMessages = null,
  onSteerQueued,
  onRecallQueue,
  onOpenActivity,
}: SubagentActivityCardProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const capsuleRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // The card morphs out of the tab, so it needs the tab's resting width.
  const [tabWidth, setTabWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [expandedQueuedIndex, setExpandedQueuedIndex] = useState<number | null>(null);
  const queued = useMemo(
    () => [...(queuedMessages?.steering ?? []), ...(queuedMessages?.followUp ?? [])],
    [queuedMessages],
  );
  const running = useMemo(() => activities.filter((activity) => activity.status === "running"), [activities]);
  const ended = useMemo(
    // Every ended agent stays on the card (faded, newest first); the card scrolls.
    () => activities.filter((activity) => activity.status !== "running").reverse(),
    [activities],
  );
  const endedCount = activities.length - running.length;
  const completedTodoCount = useMemo(
    () => todos.filter((item) => item.status === "completed").length,
    [todos],
  );
  const summary = capsuleSummary(todos, running, endedCount, queued.length, t);
  const hasAgents = activities.length > 0;

  useEffect(() => {
    if (running.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running.length]);

  useLayoutEffect(() => {
    if (open) return;
    const width = capsuleRef.current?.offsetWidth ?? 0;
    setTabWidth((previous) => (previous === width ? previous : width));
  });

  const toggle = (next: boolean): void => {
    setOpen(next);
    // Move focus with the visible control: tab <-> card header.
    window.requestAnimationFrame(() => (next ? headerRef.current : capsuleRef.current)?.focus());
  };

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

  if (todos.length === 0 && activities.length === 0 && queued.length === 0) return null;

  const capsuleContent = summary ? (
    <>
      {summary.icon}
      <span className="status-capsule-label">{summary.label}</span>
      {todos.length > 0 ? (
        <span className="status-capsule-count">{completedTodoCount}/{todos.length}</span>
      ) : null}
      {running.length > 0 ? (
        <span
          className="status-capsule-agents"
          title={t("desktop.runningAgentsCount", { count: running.length })}
        >
          <CircleNotchIcon className="subagent-running-icon" size={12} aria-hidden="true" />
          {running.length}
        </span>
      ) : null}
      {queued.length > 0 && (todos.length > 0 || activities.length > 0) ? (
        <span
          className="status-capsule-queue"
          title={t("desktop.pendingMessagesCount", { count: queued.length })}
        >
          {t("desktop.pendingMessagesCount", { count: queued.length })}
        </span>
      ) : null}
    </>
  ) : null;

  // A lone section needs no heading: the capsule already names it.
  const showSectionTitles = [todos.length > 0, hasAgents, queued.length > 0].filter(Boolean).length > 1;

  const agentRow = (activity: SubagentActivity, faded: boolean) => {
    const content = (
      <>
        <AgentStatusIcon status={activity.status} />
        <span className="subagent-activity-name" title={activity.title}>{activity.title}</span>
        {activity.agentType ? (
          <span className="subagent-activity-note" title={activity.agentType}>{activity.agentType}</span>
        ) : null}
        <span className="subagent-activity-elapsed">{elapsedLabel(activity, now, t)}</span>
      </>
    );
    return activity.childSessionId === undefined ? (
      <div
        className={`subagent-activity-row is-pending${faded ? " is-ended" : ""}`}
        key={activity.key}
        aria-disabled="true"
      >
        {content}
      </div>
    ) : (
      <button
        type="button"
        className={`subagent-activity-row${faded ? " is-ended" : ""}`}
        key={activity.key}
        onClick={() => onOpenActivity(activity)}
        aria-label={t("desktop.openSubagent", { title: activity.title })}
      >
        {content}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className="subagent-activity-card"
      data-testid="subagent-activity-card"
      data-open={open || undefined}
      style={{ "--status-tab-width": `${tabWidth}px` } as CSSProperties}
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
            onClick={() => toggle(true)}
            title={summary.label}
            aria-label={t("desktop.expandStatus")}
            aria-expanded={open}
            tabIndex={open ? -1 : 0}
          >
            {capsuleContent}
          </button>
        ) : null}
        <div className="status-card-panel" inert={!open}>
          <div className="status-card-body">
            {todos.length > 0 ? (
              <section className="status-card-section" data-testid="status-progress-section">
                {showSectionTitles ? <div className="status-section-title">{t("desktop.statusTodos")}</div> : null}
                <ul className="status-todo-list">
                  {todos.map((item) => (
                    <li
                      key={item.id}
                      className={`status-todo-row is-${item.status}`}
                      data-todo-status={item.status}
                    >
                      <TodoStatusIcon status={item.status} />
                      <span className="status-todo-subject" title={item.subject}>{item.subject}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {hasAgents ? (
              <section
                className={`status-card-section${todos.length > 0 ? " is-separated" : ""}`}
                data-testid="status-agents-section"
              >
                {showSectionTitles ? <div className="status-section-title">{t("desktop.subagents")}</div> : null}
                <div className="subagent-activity-body">
                  {running.map((activity) => agentRow(activity, false))}
                  {ended.map((activity) => agentRow(activity, true))}
                </div>
              </section>
            ) : null}
            {queued.length > 0 ? (
              <section
                className={`status-card-section${todos.length > 0 || hasAgents ? " is-separated" : ""}`}
                data-testid="status-queue-section"
              >
                <div className="status-queue-head">
                  <span>{t("desktop.pendingMessages")}</span>
                  {onRecallQueue ? (
                    <button
                      type="button"
                      className="status-queue-recall"
                      onClick={onRecallQueue}
                      title={t("desktop.recallQueuedMessages")}
                    >
                      <ArrowBendUpLeftIcon size={13} aria-hidden="true" />
                      {t("desktop.recallToInput")}
                    </button>
                  ) : null}
                </div>
                <ul className="status-queue-list">
                  {queued.map((text, index) => {
                    const expanded = expandedQueuedIndex === index;
                    return (
                      <li key={`${index}:${text}`} className="status-queue-row">
                        <button
                          type="button"
                          className="status-queue-text"
                          aria-expanded={expanded}
                          title={text}
                          onClick={() => setExpandedQueuedIndex(expanded ? null : index)}
                        >
                          <span className={expanded ? "is-expanded" : undefined}>{text}</span>
                        </button>
                        {onSteerQueued ? (
                          <button
                            type="button"
                            className="status-queue-steer"
                            aria-label={t("desktop.steerQueuedMessage")}
                            title={t("desktop.steerQueuedMessage")}
                            onClick={() => onSteerQueued(index)}
                          >
                            {t("desktop.steer")}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </div>
          {summary ? (
            <button
              ref={headerRef}
              type="button"
              className="status-card-header"
              onClick={() => toggle(false)}
              aria-label={t("desktop.showLess")}
              aria-expanded={open}
            >
              {capsuleContent}
              <CaretDownIcon className="status-card-header-caret" size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
