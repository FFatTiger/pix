import { useQueries } from "@tanstack/react-query";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { SettingsSection } from "@/features/settings/settings-ui";
import { useI18n } from "@/hooks/useI18n";
import { useSidebarItemState } from "@/lib/sidebar-item-state";

function sessionTitle(session: SessionHeader | undefined, fallbackId: string): string {
  if (!session) return fallbackId;
  if (session.title) return session.title;
  const first = session.firstMessage;
  if (typeof first === "string" && first.trim().length > 0) {
    const oneLine = first.replace(/[\r\n\t]+/g, " ").trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }
  return session.sessionId.slice(0, 12);
}

function pathBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function ArchiveRow({
  title,
  detail,
  onRestore,
  restoreLabel,
}: {
  title: string;
  detail?: string;
  onRestore: () => void;
  restoreLabel: string;
}) {
  return (
    <div
      data-testid="archive-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        minHeight: 36,
        padding: "6px 0",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 13 }}>
          {title}
        </div>
        {detail ? (
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 11 }}>
            {detail}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="sidebar-icon-btn"
        style={{ width: "auto", padding: "0 10px", fontSize: 12, color: "var(--text)" }}
        onClick={onRestore}
      >
        {restoreLabel}
      </button>
    </div>
  );
}

export function ArchiveConfig() {
  const { t } = useI18n();
  const http = useHttpClient();
  const { canBrowseSessions } = useCapabilities();
  const { state, archiveSession, archiveProject } = useSidebarItemState();
  const options = createQueryOptions(http);
  const details = useQueries({
    queries: state.archivedSessions.map((sessionId) => ({
      ...options.sessions.detail(sessionId),
      enabled: canBrowseSessions,
    })),
  });
  // Parent-linked child/subagent sessions are temporarily excluded from every
  // browse surface, including stale ids already persisted in the local archive
  // preference. Wait for exact detail before rendering so a child never flashes
  // as an "unknown session" while the request is in flight.
  const visibleArchivedSessions = details.flatMap((query, index) => {
    const session = query.data?.session;
    const sessionId = state.archivedSessions[index];
    return session !== undefined && sessionId !== undefined && session.parentSessionId === undefined
      ? [{ sessionId, session }]
      : [];
  });
  const archivedSessionsLoading = details.some((query) => query.isLoading);
  const archivedSessionsError = details.some((query) => query.isError);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.archivedSessions")} description={t("desktop.archivedSessionsDescription")}>
        {archivedSessionsLoading ? (
          <div data-testid="archive-loading-sessions" style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {t("desktop.loading")}
          </div>
        ) : archivedSessionsError ? (
          <div role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
            {t("desktop.archivedSessionsUnavailable")}
          </div>
        ) : visibleArchivedSessions.length === 0 ? (
          <div data-testid="archive-empty-sessions" style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {t("desktop.noArchivedSessions")}
          </div>
        ) : (
          visibleArchivedSessions.map(({ sessionId, session }) => (
            <ArchiveRow
              key={sessionId}
              title={sessionTitle(session, t("desktop.archivedUnknownSession", { id: sessionId.slice(0, 12) }))}
              detail={session.cwd}
              restoreLabel={t("desktop.restore")}
              onRestore={() => archiveSession(sessionId, false)}
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title={t("desktop.archivedProjects")} description={t("desktop.archivedProjectsDescription")}>
        {state.archivedProjects.length === 0 ? (
          <div data-testid="archive-empty-projects" style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {t("desktop.noArchivedProjects")}
          </div>
        ) : (
          state.archivedProjects.map((projectRoot) => (
            <ArchiveRow
              key={projectRoot}
              title={pathBaseName(projectRoot)}
              detail={projectRoot}
              restoreLabel={t("desktop.restore")}
              onRestore={() => archiveProject(projectRoot, false)}
            />
          ))
        )}
      </SettingsSection>
    </div>
  );
}
