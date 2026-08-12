/**
 * VisibleBranchExportButton — D1B-3 selection action.
 *
 * Exports the already-fetched selected SessionContext branch as normalized
 * JSON. Shares the TranscriptList cache key via createQueryOptions(...).sessions.context.
 * Never hits /export, /thinking, /bash-output, or live runtime projection.
 */

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import {
  VISIBLE_BRANCH_DISCLAIMER,
  VISIBLE_BRANCH_EXPORT_ERROR,
  downloadVisibleBranch,
  type DownloadDeps,
} from "@/lib/visible-branch-export";

export interface VisibleBranchExportButtonProps {
  /** Selected history session id (`search.session`). */
  sessionId: string;
  /**
   * When true the selected session matches the attached live runtime — the
   * button must not render (v1 does not export live snapshots).
   */
  selectionMatchesLive: boolean;
  /** Injectable download deps for jsdom tests. */
  downloadDeps?: Partial<DownloadDeps>;
}

const DESCRIPTION_ID = "visible-branch-export-desc";

export function VisibleBranchExportButton({
  sessionId,
  selectionMatchesLive,
  downloadDeps,
}: VisibleBranchExportButtonProps) {
  const http = useHttpClient();
  const { canBrowseSessions } = useCapabilities();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same-tick double-click guard (state alone is async).
  const busyRef = useRef(false);

  // Gate: only history selection with sessions capability, never live match.
  const visible = Boolean(sessionId) && canBrowseSessions && !selectionMatchesLive;

  // Share cache/key with TranscriptList. Do not invent a second query.
  const contextQuery = useQuery({
    ...createQueryOptions(http).sessions.context(sessionId),
    enabled: visible,
  });

  if (!visible) return null;

  const context = contextQuery.data?.context;
  const pending =
    contextQuery.isPending ||
    contextQuery.isFetching ||
    contextQuery.isError ||
    !context ||
    exporting;

  const handleClick = (): void => {
    // busyRef blocks double clicks across the current task + microtasks until the
    // next macrotask (real dblclick fires two click events that can cross tasks).
    // Content/object-URL cleanup stays in downloadVisibleBranch — this only guards the button.
    if (busyRef.current || pending || !context) return;
    busyRef.current = true;
    setExporting(true);
    setError(null);
    try {
      downloadVisibleBranch(context, {
        ...(downloadDeps === undefined ? {} : { deps: downloadDeps }),
      });
    } catch {
      // Never render raw errors — fixed UI copy only.
      setError(VISIBLE_BRANCH_EXPORT_ERROR);
    } finally {
      // UI state may settle immediately; keep busyRef until next macrotask.
      setExporting(false);
      globalThis.setTimeout(() => {
        busyRef.current = false;
      }, 0);
    }
  };

  return (
    <div className="visible-branch-export" data-testid="visible-branch-export">
      <button
        type="button"
        className="text-btn visible-branch-export-btn"
        onClick={handleClick}
        disabled={pending}
        aria-busy={exporting}
        aria-describedby={DESCRIPTION_ID}
        title={VISIBLE_BRANCH_DISCLAIMER}
      >
        Export visible branch
      </button>
      <p id={DESCRIPTION_ID} className="visible-branch-export-hint">
        Selected context branch only — not an archive or raw session.
      </p>
      {error ? (
        <p className="visible-branch-export-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
