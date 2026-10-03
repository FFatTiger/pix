import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { XIcon } from "@phosphor-icons/react/X";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { refreshReadonlySessionHistory } from "@/api/session-history";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentActivity, SubagentActivityStatus } from "@/lib/subagent-activity";
import type { StreamingAgentMessage } from "@fffattiger/pix-protocol";

export interface SubagentPanelProps {
  activities: readonly SubagentActivity[];
  error: boolean;
  loading: boolean;
  refreshing: boolean;
  parentSessionId: string;
  parentEpoch: string | null;
  subagentsRevision: number | null;
  selectedChildSessionId: string | null;
  onSelectActivity: (activity: SubagentActivity) => void;
  onBack: () => void;
  onClose: () => void;
  onRefresh: () => void;
  /** Live child partial from the parent snapshot; ignored unless the child is running. */
  childStream?: StreamingAgentMessage | null;
}

function statusIcon(status: SubagentActivityStatus) {
  switch (status) {
    case "running": return <CircleNotchIcon className="subagent-running-icon" size={16} aria-hidden="true" />;
    case "completed": return <CheckCircleIcon size={16} aria-hidden="true" />;
    case "failed": return <XCircleIcon size={16} aria-hidden="true" />;
    case "partial":
    case "stopped": return <WarningCircleIcon size={16} aria-hidden="true" />;
  }
}

function statusLabel(status: SubagentActivityStatus, t: ReturnType<typeof useI18n>["t"]): string {
  return t(`desktop.subagentStatus.${status}`);
}

export function SubagentPanel({
  activities,
  error,
  loading,
  refreshing,
  parentSessionId,
  parentEpoch,
  subagentsRevision,
  selectedChildSessionId,
  onSelectActivity,
  onBack,
  onClose,
  onRefresh,
  childStream = null,
}: SubagentPanelProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const refreshGeneration = useRef(0);
  const observedRevision = useRef<{
    parentSessionId: string;
    parentEpoch: string | null;
    childSessionId: string;
    revision: number;
  } | null>(null);
  useEffect(() => {
    const generation = ++refreshGeneration.current;
    const next = selectedChildSessionId === null || subagentsRevision === null
      ? null
      : { parentSessionId, parentEpoch, childSessionId: selectedChildSessionId, revision: subagentsRevision };
    const previous = observedRevision.current;
    observedRevision.current = next;
    if (next === null || previous === null) return;
    if (previous.parentSessionId !== next.parentSessionId || previous.childSessionId !== next.childSessionId) return;
    if (previous.parentEpoch === next.parentEpoch && previous.revision === next.revision) return;
    const ownsRefresh = (): boolean => {
      const current = observedRevision.current;
      return refreshGeneration.current === generation
        && current !== null
        && current.parentSessionId === next.parentSessionId
        && current.parentEpoch === next.parentEpoch
        && current.childSessionId === next.childSessionId
        && current.revision === next.revision;
    };
    void refreshReadonlySessionHistory(queryClient, next.childSessionId, ownsRefresh);
  }, [parentEpoch, parentSessionId, queryClient, selectedChildSessionId, subagentsRevision]);
  const selectedActivity = selectedChildSessionId === null
    ? undefined
    : activities.find((activity) => activity.childSessionId === selectedChildSessionId);
  const childRunning = selectedActivity?.status === "running";
  const externalStreaming = childRunning ? (childStream ?? null) : null;
  const ordered = useMemo(
    () => [...activities].sort((left, right) => {
      if ((left.status === "running") !== (right.status === "running")) return left.status === "running" ? -1 : 1;
      return (right.startedAt ?? 0) - (left.startedAt ?? 0);
    }),
    [activities],
  );

  return (
    <section className="subagent-panel" aria-label={t("desktop.subagents")} data-testid="subagent-panel">
      <header className="subagent-panel-head">
        {selectedChildSessionId === null ? (
          <span className="subagent-panel-heading">
            <RobotIcon size={16} aria-hidden="true" />
            {t("desktop.subagentDirectory")}
          </span>
        ) : (
          <>
            <button
              type="button"
              className="subagent-icon-button"
              onClick={onBack}
              title={t("desktop.backToSubagents")}
              aria-label={t("desktop.backToSubagents")}
            >
              <ArrowLeftIcon size={16} aria-hidden="true" />
            </button>
            <span className="subagent-panel-child-title" title={selectedActivity?.title}>
              {selectedActivity?.title ?? t("desktop.subagentTranscript")}
            </span>
          </>
        )}
        <span className="subagent-panel-head-spacer" />
        {selectedChildSessionId === null ? (
          <button
            type="button"
            className="subagent-icon-button"
            onClick={onRefresh}
            disabled={refreshing}
            title={t("desktop.refresh")}
            aria-label={t("desktop.refresh")}
          >
            <ArrowClockwiseIcon className={refreshing ? "subagent-refreshing-icon" : undefined} size={15} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="subagent-icon-button"
          onClick={onClose}
          title={t("desktop.close")}
          aria-label={t("desktop.close")}
        >
          <XIcon size={15} aria-hidden="true" />
        </button>
      </header>

      {selectedChildSessionId !== null ? (
        <div className="subagent-transcript">
          <TranscriptList
            key={selectedChildSessionId}
            sessionId={selectedChildSessionId}
            live={false}
            overscan={8}
            publishScrollRef={false}
            tailActive={childRunning}
            externalStreaming={externalStreaming}
          />
        </div>
      ) : (
        <div className="subagent-directory">
          {error ? <div className="subagent-panel-state" role="alert">{t("desktop.subagentsUnavailable")}</div> : null}
          {!error && loading ? <div className="subagent-panel-state" aria-busy="true">{t("desktop.loading")}</div> : null}
          {!error && !loading && ordered.length === 0 ? (
            <div className="subagent-panel-state">{t("desktop.noSubagents")}</div>
          ) : null}
          {ordered.map((activity) => {
            const canOpen = activity.childSessionId !== undefined;
            const content = (
              <>
                <span className={`subagent-directory-status is-${activity.status}`}>{statusIcon(activity.status)}</span>
                <span className="subagent-directory-copy">
                  <span className="subagent-directory-title">{activity.title}</span>
                  <span className="subagent-directory-meta">
                    {activity.agentType ? <span>{activity.agentType}</span> : null}
                    <span>{statusLabel(activity.status, t)}</span>
                  </span>
                </span>
                {canOpen ? <CaretRightIcon size={14} aria-hidden="true" /> : null}
              </>
            );
            return canOpen ? (
              <button
                type="button"
                className="subagent-directory-row"
                key={activity.key}
                onClick={() => onSelectActivity(activity)}
                aria-label={t("desktop.openSubagent", { title: activity.title })}
              >
                {content}
              </button>
            ) : (
              <div className="subagent-directory-row is-pending" key={activity.key} aria-disabled="true">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
