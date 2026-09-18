/**
 * Selected-session workspace-access hook (Phase 6B).
 *
 * Derives the exact selected session gate from the authoritative HTTP session
 * detail, falling back to the catalog list row for the same id. Never reads a
 * runtime snapshot or current holder. New-session home (no id) is not a
 * history-row inference: live workspace stays cwd/catalog-route governed.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createQueryOptions } from "@/api/query-keys";
import {
  liveWorkspaceEnabledForSelection,
  resolveWorkspaceAccessDecision,
  selectAuthoritativeSessionHeader,
  type WorkspaceAccessDecision,
} from "@/api/workspace-access";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import type { SessionHeader } from "@fffattiger/pix-protocol";

export interface SelectedWorkspaceAccess {
  readonly mode: "new-session" | "existing";
  readonly header: SessionHeader | undefined;
  readonly decision: WorkspaceAccessDecision;
  /** True only for authorized existing sessions, or new-session home. */
  readonly liveWorkspaceEnabled: boolean;
  /**
   * True only while an enabled HTTP detail request is in flight AND no
   * authoritative header (detail or listed row) is available yet. Disabled,
   * error, and completed-unknown lookups are NOT pending.
   */
  readonly accessLookupPending: boolean;
}

export function useSelectedWorkspaceAccess(
  sessionId: string | null | undefined,
  listed?: readonly SessionHeader[] | null | undefined,
): SelectedWorkspaceAccess {
  const http = useHttpClient();
  const { canBrowseSessions } = useCapabilities();
  const options = createQueryOptions(http);
  const detailEnabled = Boolean(sessionId) && canBrowseSessions;
  const detailQuery = useQuery({
    ...options.sessions.detail(sessionId ?? ""),
    enabled: detailEnabled,
  });

  return useMemo<SelectedWorkspaceAccess>(() => {
    if (!sessionId) {
      return {
        mode: "new-session",
        header: undefined,
        decision: { kind: "unknown" },
        liveWorkspaceEnabled: true,
        accessLookupPending: false,
      };
    }
    const header = selectAuthoritativeSessionHeader(
      sessionId,
      detailQuery.data?.session,
      listed ?? undefined,
    );
    const decision = resolveWorkspaceAccessDecision(header);
    const accessLookupPending = detailEnabled
      && header === undefined
      && detailQuery.isFetching
      && !detailQuery.isError
      && detailQuery.data === undefined;
    return {
      mode: "existing",
      header,
      decision,
      liveWorkspaceEnabled: liveWorkspaceEnabledForSelection(sessionId, header),
      accessLookupPending,
    };
  }, [sessionId, detailQuery.data, detailQuery.isFetching, detailQuery.isError, listed, detailEnabled]);
}
