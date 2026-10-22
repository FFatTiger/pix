import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  /** Toggle one queued row's delivery type (steer ↔ follow-up). The index
   *  counts the visible rows in the same order they render. */
  onToggleQueuedDelivery?: (index: number) => void;
  /** Light failure notice for the last type toggle (fixed copy from the
   *  owner; cleared by the next attempt). Rendered only inside the queue
   *  section. */
  queueSwitchError?: string | null;
  /** Clear the queue and put every message back into the composer. */
  onRecallQueue?: () => void;
  onOpenActivity: (activity: SubagentActivity) => void;
}

const EMPTY_TODOS: readonly StatusTodoItem[] = [];
/** Ended agents listed under the running ones, newest first. */
const RECENT_ENDED_SHOWN = 5;
/** Pending todos shown after the step in progress before folding into "N more". */
const NEXT_TODOS_SHOWN = 3;

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
  agentCount: number,
  queuedCount: number,
  t: ReturnType<typeof useI18n>["t"],
): { icon: ReactNode; label: string } | null {
  if (todos.length === 0 && agentCount === 0 && queuedCount > 0) {
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
  // The state counts sit right beside this label, so it only names the section.
  if (agentCount > 0) {
    return { icon: <RobotIcon size={15} aria-hidden="true" />, label: t("desktop.subagents") };
  }
  return null;
}

/** "anthropic/claude-sonnet-4" → "claude-sonnet-4": the provider is noise in a one-line row. */
function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/** Ended agents read by recency: "just now", "3 minutes ago"... */
function endedAgo(completedAt: number | undefined, now: number, t: ReturnType<typeof useI18n>["t"]): string {
  if (completedAt === undefined) return "";
  const minutes = Math.floor((now - completedAt) / 60_000);
  if (minutes < 1) return t("desktop.justNow");
  if (minutes < 60) return t("desktop.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("desktop.hoursAgo", { count: hours });
  return t("desktop.daysAgo", { count: Math.floor(hours / 24) });
}

/** Failed and stopped read as errors on the capsule; partial counts as done. */
const AGENT_ERROR_STATUSES: ReadonlySet<SubagentActivity["status"]> = new Set(["failed", "stopped"]);

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
  onToggleQueuedDelivery,
  queueSwitchError = null,
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
  // Delivery order: every steering entry first, then the follow-ups — the
  // same order the runtime drains the queues in.
  const queued = useMemo(
    () => [...(queuedMessages?.steering ?? []), ...(queuedMessages?.followUp ?? [])],
    [queuedMessages],
  );
  const queuedKinds = useMemo(
    () => [
      ...(queuedMessages?.steering ?? []).map(() => "steer" as const),
      ...(queuedMessages?.followUp ?? []).map(() => "followUp" as const),
    ],
    [queuedMessages],
  );
  const running = useMemo(() => activities.filter((activity) => activity.status === "running"), [activities]);
  const completedTodoCount = useMemo(
    () => todos.filter((item) => item.status === "completed").length,
    [todos],
  );
  const summary = capsuleSummary(todos, activities.length, queued.length, t);
  const hasAgents = activities.length > 0;
  // Running first, then the most recently ended few (older ones live in the agents pane).
  const ended = useMemo(
    () => activities
      .filter((activity) => activity.status !== "running")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, RECENT_ENDED_SHOWN),
    [activities],
  );
  const failedCount = activities.filter((activity) => AGENT_ERROR_STATUSES.has(activity.status)).length;
  const doneCount = activities.length - running.length - failedCount;
  const [completedOpen, setCompletedOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);

  useEffect(() => {
    if (activities.length === 0) return;
    // Seconds tick for running durations; a slow tick keeps "N minutes ago" honest.
    const timer = window.setInterval(() => setNow(Date.now()), running.length > 0 ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  }, [activities.length, running.length]);

  useLayoutEffect(() => {
    if (open) return;
    const capsule = capsuleRef.current;
    if (capsule === null) return;
    // Sub-pixel accurate: the shell that carries the fillets takes exactly the
    // tab's width, so a rounded measurement would leave the joint a fraction
    // of a pixel inside the tab's edge.
    const measure = (): void => {
      const width = capsule.getBoundingClientRect().width;
      setTabWidth((previous) => (previous === width ? previous : width));
    };
    measure();
    // The tab's width follows its capped content and the viewport, so keep the
    // shape box in step with it instead of sampling once after mount.
    const observer = new ResizeObserver(measure);
    observer.observe(capsule);
    return () => observer.disconnect();
  }, [open]);

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
      {hasAgents ? (
        <span className="status-capsule-agents">
          {running.length > 0 ? (
            <span className="status-capsule-agent is-running" title={t("desktop.runningAgentsCount", { count: running.length })}>
              <CircleNotchIcon className="subagent-running-icon" size={12} aria-hidden="true" />
              {running.length}
            </span>
          ) : null}
          {doneCount > 0 ? (
            <span className="status-capsule-agent is-done" title={t("desktop.doneAgentsCount", { count: doneCount })}>
              <CheckCircleIcon size={12} aria-hidden="true" />
              {doneCount}
            </span>
          ) : null}
          {failedCount > 0 ? (
            <span className="status-capsule-agent is-failed" title={t("desktop.failedAgentsCount", { count: failedCount })}>
              <XCircleIcon size={12} aria-hidden="true" />
              {failedCount}
            </span>
          ) : null}
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

  const agentRow = (activity: SubagentActivity, isEnded: boolean) => {
    const content = (
      <>
        <AgentStatusIcon status={activity.status} />
        <span className="subagent-activity-lines">
          <span className="subagent-activity-line">
            {activity.agentType ? (
              <span className="subagent-activity-note" title={activity.agentType}>{activity.agentType}</span>
            ) : null}
            <span className="subagent-activity-name" title={activity.title}>{activity.title}</span>
          </span>
          <span className="subagent-activity-meta">
            {[activity.model ? shortModel(activity.model) : null, isEnded ? endedAgo(activity.completedAt, now, t) : elapsedLabel(activity, now, t)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </>
    );
    return activity.childSessionId === undefined ? (
      <div className={`subagent-activity-row is-pending${isEnded ? " is-ended" : ""}`} key={activity.key} aria-disabled="true">
        {content}
      </div>
    ) : (
      <button
        type="button"
        className={`subagent-activity-row${isEnded ? " is-ended" : ""}`}
        key={activity.key}
        onClick={() => onOpenActivity(activity)}
        aria-label={t("desktop.openSubagent", { title: activity.title })}
      >
        {content}
      </button>
    );
  };

  // Todos fold to what matters now: one row for everything done, the step in
  // progress, and the next few; the rest behind "N more".
  const completedTodos = todos.filter((item) => item.status === "completed");
  const activeTodos = todos.filter((item) => item.status === "in_progress");
  const pendingTodos = todos.filter((item) => item.status === "pending");
  const shownPending = pendingOpen ? pendingTodos : pendingTodos.slice(0, NEXT_TODOS_SHOWN);
  const todoRow = (item: StatusTodoItem) => (
    <li key={item.id} className={`status-todo-row is-${item.status}`} data-todo-status={item.status}>
      <TodoStatusIcon status={item.status} />
      <span className="status-todo-subject" title={item.subject}>{item.subject}</span>
    </li>
  );

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
                  {completedTodos.length > 0 ? (
                    <li>
                      <button
                        type="button"
                        className="status-todo-row status-todo-fold is-completed"
                        aria-expanded={completedOpen}
                        onClick={() => setCompletedOpen((value) => !value)}
                      >
                        <TodoStatusIcon status="completed" />
                        <span className="status-todo-subject">{t("desktop.statusTodosDone", { count: completedTodos.length })}</span>
                      </button>
                    </li>
                  ) : null}
                  {completedOpen ? completedTodos.map(todoRow) : null}
                  {activeTodos.map(todoRow)}
                  {shownPending.map(todoRow)}
                  {pendingTodos.length > shownPending.length ? (
                    <li>
                      <button type="button" className="status-todo-row status-todo-fold" onClick={() => setPendingOpen(true)}>
                        <span className="status-todo-more-spacer" aria-hidden="true" />
                        <span className="status-todo-subject">{t("desktop.statusTodosMore", { count: pendingTodos.length - shownPending.length })}</span>
                      </button>
                    </li>
                  ) : null}
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
                    const kind = queuedKinds[index] === "steer" ? "steer" : "followUp";
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
                        {onToggleQueuedDelivery ? (
                          <button
                            type="button"
                            className={`status-queue-kind${kind === "steer" ? " is-steer" : " is-follow-up"}`}
                            aria-label={kind === "steer" ? t("desktop.queueKindSteerTitle") : t("desktop.queueKindFollowUpTitle")}
                            title={kind === "steer" ? t("desktop.queueKindSteerTitle") : t("desktop.queueKindFollowUpTitle")}
                            onClick={() => onToggleQueuedDelivery(index)}
                          >
                            {kind === "steer" ? t("desktop.queueKindSteer") : t("desktop.queueKindFollowUp")}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {queueSwitchError ? <div className="status-queue-error" role="alert">{queueSwitchError}</div> : null}
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
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
