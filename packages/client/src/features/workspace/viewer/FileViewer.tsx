import { useEffect, useState, useRef, useCallback, useContext, useMemo, useLayoutEffect, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { At, DownloadSimple } from "@phosphor-icons/react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import ReactMarkdown from "react-markdown";
import { useI18n } from "@/hooks/useI18n";
import {
  DOCX_PREVIEW_MAX_BYTES,
  getFileExt,
  isAudioPath,
  isDocumentPreviewPath,
  isImagePath,
} from "@/lib/file-types";
import { getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { resolveLocalFileHref } from "@/lib/file-links";
import { resolveMarkdownImageSrc } from "@/lib/markdown-images";
import { headingId, markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { prismTheme } from "@/lib/prism-theme";
import { CodeBlock, MarkdownCodeContext, MermaidBlock } from "@/components/chat/MarkdownBody";
import { parseUnifiedPatch } from "@/lib/patch";
import { useHttpClient } from "@/app/http-context";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import type { WatchChangeEvent, WatchConnectionState } from "@/api/files-watch";
import { getFileApiUrl, watchFile } from "./viewer-api";
import {
  resolveInitialFileDisplayMode,
  type FileViewerState,
} from "./file-viewer-state";

interface Props {
  filePath: string;
  cwd?: string | undefined;
  sourceSessionId?: string | null | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
  /** Insert this file's relative path into the chat input (@ mention). */
  onAtMention?: ((relativePath: string, isDir: boolean) => void) | undefined;
  initialDisplayMode?: "diff" | undefined;
  /** Viewer state to restore when the file is re-opened (tab switch). */
  initialState?: FileViewerState | undefined;
  /** Called when the viewer unmounts so the tab can snapshot scroll/mode. */
  onStateChange?: ((state: FileViewerState) => void) | undefined;
}

/**
 * Shared query-options builder. Reads/meta/diff are owned by React Query
 * (queryKeys/createQueryOptions) so the viewer shares the one remote-state
 * authority with the explorer and quick-changes surfaces.
 */
function useWorkspaceViewerOptions() {
  const http = useHttpClient();
  return useMemo(() => createQueryOptions(http), [http]);
}

/** Non-blocking watch status surface (Gap 2): typed, no scattered toasts. */
export interface WatchStatusInfo {
  /** Explicit WatchSession connection state surfaced to the viewer UI. */
  state: WatchConnectionState;
  /** Last stream failure while reconnecting/closed (undefined while healthy). */
  detail: string | undefined;
}

/**
 * Owns the per-file WatchSession lifecycle (create on mount/file change, close
 * on unmount) and surfaces its explicit connection state + last error. All
 * four viewer variants use this single hook so a closed/reconnecting stream is
 * never silent. `onEvent` is invoked for `change`/`resync`; a per-file
 * generation guard drops events from a stale session (e.g. the viewer switched
 * away from a file) so they cannot affect the newly shown file.
 */
function useFileWatch(
  filePath: string,
  sourceSessionId: string | null | undefined,
  onEvent: (kind: "change" | "resync", event?: WatchChangeEvent) => void,
): WatchStatusInfo {
  const [info, setInfo] = useState<WatchStatusInfo>({ state: "idle", detail: undefined });
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const generationRef = useRef(0);
  useEffect(() => {
    const generation = ++generationRef.current;
    const es = watchFile(filePath, sourceSessionId);
    setInfo({ state: es.state, detail: es.lastError });
    const offChange = es.addEventListener("change", (event) => {
      if (generationRef.current !== generation) return;
      onEventRef.current("change", event);
    });
    const offResync = es.addEventListener("resync", () => {
      if (generationRef.current !== generation) return;
      onEventRef.current("resync");
    });
    const offState = es.addEventListener("state", (state) => {
      setInfo({ state, detail: es.lastError });
    });
    return () => {
      offChange();
      offResync();
      offState();
      es.close();
    };
  }, [filePath, sourceSessionId]);
  return info;
}

/**
 * Small typed non-blocking status chip for the viewer status bar. Renders only
 * while the watch is degraded (reconnecting / closed); connected/idle states
 * render nothing so the surface never adds noise during normal operation.
 */
function WatchStatusBadge({ state, detail }: WatchStatusInfo) {
  const { t } = useI18n();
  if (state !== "reconnecting" && state !== "closed") return null;
  const closed = state === "closed";
  const statusColor = closed ? "var(--status-danger)" : "var(--status-warning)";
  return (
    <span
      role="status"
      aria-live="polite"
      title={detail ?? (closed ? t("desktop.watchClosed") : t("desktop.watchReconnecting"))}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 18,
        padding: "0 7px",
        borderRadius: 9,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: statusColor,
        background: `color-mix(in srgb, ${statusColor} 12%, var(--bg-panel))`,
        border: `1px solid color-mix(in srgb, ${statusColor} 45%, var(--border))`,
        flexShrink: 0,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} aria-hidden="true" />
      {closed ? t("desktop.watchClosed") : t("desktop.watchReconnecting")}
    </span>
  );
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null | undefined }) {
  const { t } = useI18n();

  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("desktop.downloadFile")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 20,
        padding: "0 5px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-muted)",
        cursor: "pointer",
        flexShrink: 0,
        textDecoration: "none",
      }}
    >
      <DownloadSimple size={11} aria-hidden="true" />
    </a>
  );
}

/** @ button — insert this file's relative path into the chat input. */
function MentionButton({ filePath, cwd, onAtMention }: { filePath: string; cwd?: string | undefined; onAtMention?: ((relativePath: string, isDir: boolean) => void) | undefined }) {
  const { t } = useI18n();
  const { pathFlavor } = useCapabilities();

  return (
    <button
      type="button"
      onClick={() => onAtMention?.(getRelativeFilePath(filePath, cwd, pathFlavor), false)}
      title={t("desktop.insertFileMention")}
      aria-label={t("desktop.insertFileMention")}
      disabled={!onAtMention}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 20,
        padding: "0 5px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: onAtMention ? "var(--text-muted)" : "var(--text-dim)",
        cursor: onAtMention ? "pointer" : "not-allowed",
        flexShrink: 0,
        opacity: onAtMention ? 1 : 0.55,
      }}
    >
      <At size={11} aria-hidden="true" />
    </button>
  );
}

type DiffLine =
  | { type: "unchanged"; text: string }
  | { type: "removed"; text: string }
  | { type: "added"; text: string };

type DiffBlockKind = "delete" | "add" | "edit";

// Diff colors come from the active pi CLI theme palette via the git-status
// CSS variables — the same set used by the quick-changes indicator — so they
// stay in sync with the theme JSON's diff/semantic colors.
// The left indicator bar expresses the change-block type: pure deletions are
// red, pure additions green, edits (removed + added) yellow.
const DIFF_BLOCK_BORDER: Record<DiffBlockKind, string> = {
  delete: "3px solid var(--git-status-deleted)",
  add: "3px solid var(--git-status-added)",
  edit: "3px solid var(--git-status-modified)",
};
// Row backgrounds stay red for removed lines and green for added lines; the
// yellow is reserved for the indicator bar above.
const DIFF_REMOVED_BG = "var(--git-status-deleted-bg)";
const DIFF_ADDED_BG = "var(--git-status-added-bg)";
// Added lines show their new-file line number in green, replacing the +/-
// prefix; deleted lines show no line number at all.
const DIFF_ADD_NUMBER_COLOR = "var(--git-status-added)";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Myers diff — returns line-level unified diff
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const max = m + n;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max]! < v[k + 1 + max]!)) {
        x = v[k + 1 + max]!;
      } else {
        x = v[k - 1 + max]! + 1;
      }
      let y = x - k;
      while (x < m && y < n && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= m && y >= n) {
        // backtrack
        const result: DiffLine[] = [];
        let cx = m, cy = n;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd - 1]!;
          const pk = cx - cy;
          let prevK: number;
          if (pk === -dd || (pk !== dd && pv[pk - 1 + max]! < pv[pk + 1 + max]!)) {
            prevK = pk + 1;
          } else {
            prevK = pk - 1;
          }
          const prevX = pv[prevK + max]!;
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            result.unshift({ type: "unchanged", text: oldLines[cx]! });
          }
          if (dd > 0) {
            if (cx > prevX) {
              cx--;
              result.unshift({ type: "removed", text: oldLines[cx]! });
            } else {
              cy--;
              result.unshift({ type: "added", text: newLines[cy]! });
            }
          }
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          result.unshift({ type: "unchanged", text: oldLines[cx]! });
        }
        return result;
      }
    }
  }
  // Fallback: treat all as replaced
  return [
    ...oldLines.map((t) => ({ type: "removed" as const, text: t })),
    ...newLines.map((t) => ({ type: "added" as const, text: t })),
  ];
}

function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const { t } = useI18n();
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = diffLines(oldLines, newLines);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("desktop.noChanges")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]!);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  // Track running line number for added/unchanged lines
  const newLineNos: number[] = [];
  let nlo = 1;
  for (const line of diff) {
    if (line.type === "removed") {
      newLineNos.push(0);
    } else {
      newLineNos.push(nlo++);
    }
  }

  let diffIdx = 0;

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6, minWidth: "max-content" }}>
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              {t("desktop.unchangedLines", { count: seg.count })}
            </div>
          );
          diffIdx += seg.count;
          return result;
        }
        // Group consecutive changed lines into delete / add / edit blocks;
        // context lines break the block. Edited blocks render all removed
        // lines first, then all added lines.
        const out: Array<{
          key: string;
          kind: "context" | "removed" | "added";
          text: string;
          lineNo: number | null;
          block: DiffBlockKind | null;
        }> = [];
        let removed: Array<{ key: string; text: string }> = [];
        let added: Array<{ key: string; text: string; lineNo: number | null }> = [];
        const flushBlock = () => {
          if (removed.length || added.length) {
            const block: DiffBlockKind = removed.length && added.length ? "edit" : removed.length ? "delete" : "add";
            for (const r of removed) out.push({ key: r.key, kind: "removed", text: r.text, lineNo: null, block });
            for (const a of added) out.push({ key: a.key, kind: "added", text: a.text, lineNo: a.lineNo, block });
            removed = [];
            added = [];
          }
        };
        seg.lines.forEach((line, li) => {
          if (line.type === "unchanged") {
            flushBlock();
            out.push({ key: `${si}:${li}`, kind: "context", text: line.text, lineNo: newLineNos[diffIdx + li] ?? null, block: null });
          } else if (line.type === "removed") {
            removed.push({ key: `${si}:${li}`, text: line.text });
          } else {
            added.push({ key: `${si}:${li}`, text: line.text, lineNo: newLineNos[diffIdx + li] ?? null });
          }
        });
        flushBlock();

        const rendered = out.map((row) => {
          const bg = row.kind === "removed" ? DIFF_REMOVED_BG : row.kind === "added" ? DIFF_ADDED_BG : "transparent";
          const borderLeft = row.block ? DIFF_BLOCK_BORDER[row.block] : "3px solid transparent";
          const numberColor = row.kind === "added" ? DIFF_ADD_NUMBER_COLOR : "var(--text-dim)";
          return (
            <div
              key={row.key}
              style={{
                display: "flex",
                background: bg,
                borderLeft,
              }}
            >
              <span
                style={{
                  minWidth: 44,
                  padding: "0 8px 0 16px",
                  textAlign: "right",
                  color: numberColor,
                  userSelect: "none",
                  fontSize: 11,
                  lineHeight: 1.6,
                  flexShrink: 0,
                }}
              >
                {row.lineNo ?? ""}
              </span>
              <span style={{ flex: 1, minWidth: 0, padding: "0 8px 0 0", whiteSpace: "pre", color: "var(--text)" }}>
                {row.text || "\u00a0"}
              </span>
            </div>
          );
        });
        diffIdx += seg.lines.length;
        return <div key={si}>{rendered}</div>;
      })}
    </div>
  );
}

function GitDiffView({ patch }: { patch: string }) {
  const files = parseUnifiedPatch(patch);
  if (!files) return null;

  // Flatten the split (side-by-side) representation into unified rows like
  // `git diff`. Consecutive changed lines form one block, classified as
  // delete / add / edit:
  //   delete: only removed lines  -> red
  //   add:    only added lines    -> green
  //   edit:   removed + added     -> yellow, with all removed lines rendered
  //                                  first, then all added lines
  // Deleted lines show no line number; added lines show their new-file line
  // number in green, replacing the +/- prefix.
  type Row = {
    key: string;
    kind: "hunk" | "context" | "removed" | "added";
    text: string;
    lineNo: number | null;
    block: DiffBlockKind | null;
  };
  const rows: Row[] = [];
  let removed: Array<{ key: string; text: string }> = [];
  let added: Array<{ key: string; text: string; lineNo: number | null }> = [];
  const flushBlock = () => {
    if (removed.length || added.length) {
      const block: DiffBlockKind = removed.length && added.length ? "edit" : removed.length ? "delete" : "add";
      for (const r of removed) rows.push({ key: r.key, kind: "removed", text: r.text, lineNo: null, block });
      for (const a of added) rows.push({ key: a.key, kind: "added", text: a.text, lineNo: a.lineNo, block });
      removed = [];
      added = [];
    }
  };
  files.forEach((file, fileIndex) => {
    file.rows.forEach((row, rowIndex) => {
      if (row.type === "hunk") {
        flushBlock();
        rows.push({ key: `${fileIndex}:${rowIndex}:h`, kind: "hunk", text: row.text, lineNo: null, block: null });
        return;
      }
      const { left, right } = row;
      if (left.type === "context" && right.type === "context") {
        flushBlock();
        rows.push({ key: `${fileIndex}:${rowIndex}:c`, kind: "context", text: left.text, lineNo: right.lineNo, block: null });
        return;
      }
      if (left.type === "removed") {
        removed.push({ key: `${fileIndex}:${rowIndex}:l`, text: left.text });
      }
      if (right.type === "added") {
        added.push({ key: `${fileIndex}:${rowIndex}:r`, text: right.text, lineNo: right.lineNo });
      }
    });
  });
  flushBlock();

  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, minWidth: "max-content" }}>
      {rows.map((row) => {
        if (row.kind === "hunk") {
          return (
            <div key={row.key}>
              {/* Leave one blank line above and below each hunk header so the
                  abbreviated summary reads as a gap between the surrounding
                  diff rows. */}
              <div style={{ height: "1.55em" }} />
              <div style={{ padding: "3px 12px", color: "var(--accent-blue)", background: "var(--bg-secondary)" }}>
                {row.text}
              </div>
              <div style={{ height: "1.55em" }} />
            </div>
          );
        }
        const bg = row.kind === "removed" ? DIFF_REMOVED_BG : row.kind === "added" ? DIFF_ADDED_BG : "transparent";
        const borderLeft = row.block ? DIFF_BLOCK_BORDER[row.block] : "3px solid transparent";
        const numberColor = row.kind === "added" ? DIFF_ADD_NUMBER_COLOR : "var(--text-dim)";
        return (
          <div
            key={row.key}
            style={{
              display: "flex",
              background: bg,
              borderLeft,
            }}
          >
            <span
              style={{
                width: 44,
                flexShrink: 0,
                padding: "0 8px 0 16px",
                textAlign: "right",
                color: numberColor,
                userSelect: "none",
                fontSize: 11,
              }}
            >
              {row.lineNo ?? ""}
            </span>
            <span style={{ flex: 1, minWidth: 0, padding: "0 8px 0 0", whiteSpace: "pre", color: "var(--text)" }}>
              {row.text || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ImageViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const { pathFlavor } = useCapabilities();
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
  }, [filePath, sourceSessionId]);

  const watchStatus = useFileWatch(filePath, sourceSessionId, (kind, event) => {
    if (kind === "resync") {
      // Authoritative refetch after a (re)connect: events dropped while the
      // stream was down cannot be replayed, so re-read via cache-bust.
      setBust((b) => b + 1);
      return;
    }
    try {
      const d = JSON.parse(event?.data ?? "") as { size?: number };
      if (typeof d.size === "number") setSize(d.size);
    } catch { /* ignore */ }
    setBust((b) => b + 1);
  });

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd, pathFlavor)}
        </span>
        <WatchStatusBadge {...watchStatus} />
        <span style={{ marginLeft: "auto" }}>{ext || t("desktop.image")}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError(t("desktop.failedToLoadImage"))}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const { pathFlavor } = useCapabilities();
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
  }, [filePath, sourceSessionId]);

  const watchStatus = useFileWatch(filePath, sourceSessionId, (kind, event) => {
    if (kind === "resync") {
      // Authoritative refetch after a (re)connect (see ImageViewer).
      setBust((b) => b + 1);
      return;
    }
    try {
      const d = JSON.parse(event?.data ?? "") as { size?: number };
      if (typeof d.size === "number") setSize(d.size);
    } catch { /* ignore */ }
    setDuration(null);
    setError(null);
    setBust((b) => b + 1);
  });

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd, pathFlavor)}
        </span>
        <WatchStatusBadge {...watchStatus} />
        <span style={{ marginLeft: "auto" }}>{ext || t("desktop.audio")}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg-panel)",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError(t("desktop.failedToLoadAudio"))}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const { pathFlavor } = useCapabilities();
  const options = useWorkspaceViewerOptions();
  const queryClient = useQueryClient();
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  // DOCX renders through the Host's dedicated sandboxed op=docx-preview.
  const previewUrl = isPdf
    ? getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined)
    : getFileApiUrl(filePath, "docx-preview", sourceSessionId, bust ? { v: bust } : undefined);

  // File metadata is owned by React Query (session-scoped request identity);
  // the docx preview size gate reads it.
  const metaQuery = useQuery({ ...options.files.meta(filePath, sourceSessionId) });

  useEffect(() => {
    if (metaQuery.data !== undefined) {
      setSize(metaQuery.data.size);
      if (!isPdf && metaQuery.data.size > DOCX_PREVIEW_MAX_BYTES) {
        setError(t("desktop.docxTooLargeForPreview"));
      }
    }
  }, [isPdf, metaQuery.data, t]);

  useEffect(() => {
    setBust(0);
    setError(null);
  }, [filePath, sourceSessionId]);

  const watchStatus = useFileWatch(filePath, sourceSessionId, (kind, event) => {
    if (kind === "resync") {
      // Authoritative refetch after a (re)connect: re-read meta and reload the
      // preview so changes that landed during the outage are not missed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.files.meta(filePath, sourceSessionId) });
      setBust((b) => b + 1);
      return;
    }
    try {
      const d = JSON.parse(event?.data ?? "") as { size?: number };
      if (typeof d.size === "number") {
        setSize(d.size);
        if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
          setError(t("desktop.docxTooLargeForPreview"));
          return;
        }
      }
    } catch { /* ignore */ }
    setError(null);
    setBust((b) => b + 1);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd, pathFlavor)}
        </span>
        <WatchStatusBadge {...watchStatus} />
        <span style={{ marginLeft: "auto" }}>{ext === "docx" ? t("desktop.docxPreview") : "pdf"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div style={{ flex: 1, minHeight: 0, background: "var(--bg-panel)" }}>
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f87171", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : "allow-same-origin"}
            title={t("desktop.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--bg)" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd, sourceSessionId, onOpenFile, onAtMention, initialDisplayMode, initialState, onStateChange }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} onOpenFile={onOpenFile} onAtMention={onAtMention} initialDisplayMode={initialDisplayMode} initialState={initialState} onStateChange={onStateChange} />;
}

function TextFileViewer({ filePath, cwd, sourceSessionId, onOpenFile, onAtMention, initialDisplayMode, initialState, onStateChange }: Props) {
  const { t } = useI18n();
  const { pathFlavor } = useCapabilities();
  // Restore per-tab viewer state: display mode first, then wrap + scroll.
  // The markdown/html default-preview auto-switch only applies on a fresh open
  // (no initialState) — re-opening a tab must restore what the user left.
  const requestedInitialDisplayMode = resolveInitialFileDisplayMode(initialState, initialDisplayMode);
  const initialWrapLines = initialState?.wrapLines ?? false;
  const initialScrollTop = initialState?.scrollTop ?? 0;
  const initialScrollLeft = initialState?.scrollLeft ?? 0;
  const options = useWorkspaceViewerOptions();
  const queryClient = useQueryClient();
  const [prevContent, setPrevContent] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [previewMode, setPreviewMode] = useState(requestedInitialDisplayMode === "preview");
  const [viewMode, setViewMode] = useState<"source" | "diff">(requestedInitialDisplayMode === "diff" ? "diff" : "source");
  const [wrapLines, setWrapLines] = useState(initialWrapLines);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRestorePendingRef = useRef(true);
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
  });
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // Reads/meta/diff are owned by React Query (single remote-state authority).
  // Each file has its own queryKey (session-scoped request identity), and a
  // refetch aborts the prior in-flight read/diff for that key, so a stale
  // settle can never win.
  const readQuery = useQuery({ ...options.files.read(filePath, sourceSessionId) });
  const diffQuery = useQuery({ ...options.git.diff(cwd ?? "", filePath), enabled: Boolean(cwd && filePath) });
  const data = readQuery.data ?? null;
  const gitDiff = diffQuery.data ?? null;

  // Per-file boundary: a new filePath is a fresh viewer scope. Reset the
  // ephemeral mode/wrap/scroll bookkeeping and the live-diff snapshot so a
  // remount-free prop change can never carry old UI into the new file.
  const prevFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevFilePathRef.current === filePath) return;
    prevFilePathRef.current = filePath;
    setPrevContent(null);
    setChangeCount(0);
    setPreviewMode(requestedInitialDisplayMode === "preview");
    setViewMode(requestedInitialDisplayMode === "diff" ? "diff" : "source");
    setWrapLines(initialWrapLines);
    // Scroll is applied once the content container renders below.
    scrollRestorePendingRef.current = true;
    viewerStateRef.current = {
      displayMode: requestedInitialDisplayMode,
      wrapLines: initialWrapLines,
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft,
    };
  }, [filePath, initialWrapLines, initialScrollTop, initialScrollLeft, requestedInitialDisplayMode]);

  // Live-diff bookkeeping (ephemeral UI): whenever the settled read content
  // changes while this file is open, snapshot the previously shown content so
  // the source/diff toggle can render a working-tree diff. React Query aborts
  // the prior in-flight read for this key when a refetch starts, so only the
  // newest settle ever reaches this effect (out-of-order cannot win).
  const lastContentRef = useRef<string | null>(null);
  useEffect(() => {
    const content = readQuery.data?.content ?? null;
    if (content !== null && lastContentRef.current !== null && content !== lastContentRef.current) {
      setPrevContent(lastContentRef.current);
      setChangeCount((c) => c + 1);
    }
    lastContentRef.current = content;
  }, [readQuery.data?.content]);

  // The markdown/html default-preview auto-switch only applies on a fresh
  // open; a restored tab keeps its saved display mode.
  useEffect(() => {
    if (initialState === undefined && readQuery.data?.language === "markdown" && initialDisplayMode !== "diff") {
      setPreviewMode(true);
    }
  }, [initialDisplayMode, initialState, readQuery.data]);

  // File watch: a WatchSession with explicit connection state, bounded
  // reconnect/backoff and an authoritative resync after every (re)connect.
  // Every change/resync invalidates the read + diff queries for THIS file;
  // the hook owns the session lifecycle and per-file generation guard. The
  // typed status is surfaced via the non-blocking WatchStatusBadge below.
  const watchStatus = useFileWatch(filePath, sourceSessionId, () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.files.read(filePath, sourceSessionId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.git.diff(cwd ?? "", filePath) });
  });

  // Snapshot the current viewer state into the tab before unmounting so a
  // later tab switch restores scroll/mode/wrap instead of losing them.
  useEffect(() => () => onStateChangeRef.current?.({ ...viewerStateRef.current }), []);


  const normalizedMarkdown = useMemo(
    () => normalizeDisplayMath(data?.content ?? ""),
    [data?.content],
  );
  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";

  useEffect(() => {
    // Auto-switch to the diff view only on a fresh open. A tab restored from
    // its saved viewer state must keep the mode the user left (they may have
    // switched back to source while the diff still exists).
    if (initialState === undefined && initialDisplayMode === "diff" && hasGitDiff) setViewMode("diff");
  }, [hasGitDiff, initialDisplayMode, initialState]);

  // Mirror the rendered viewer state into the ref so the unmount snapshot
  // carries the current display mode / wrap setting even if the user changed
  // them after the last explicit save.
  useEffect(() => {
    viewerStateRef.current.displayMode = viewMode === "diff"
      ? "diff"
      : previewMode ? "preview" : "source";
    viewerStateRef.current.wrapLines = wrapLines;
  }, [viewMode, previewMode, wrapLines]);

  // Restore the saved scroll position once the content container is mounted.
  const handleContentScroll = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    viewerStateRef.current.scrollTop = el.scrollTop;
    viewerStateRef.current.scrollLeft = el.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    if (!scrollRestorePendingRef.current || !data) return;
    const el = contentRef.current;
    if (!el) return;
    el.scrollTop = viewerStateRef.current.scrollTop;
    el.scrollLeft = viewerStateRef.current.scrollLeft;
    scrollRestorePendingRef.current = false;
  }, [data]);

  const isDeletedGitDiff = hasGitDiff && gitDiff?.status === "deleted";

  if (readQuery.isLoading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("desktop.loadingFile")}
      </div>
    );
  }

  if (isDeletedGitDiff && !data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ padding: "5px 16px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }} title={filePath}>
          {getRelativeFilePath(filePath, cwd, pathFlavor)}
        </div>
        <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}><GitDiffView patch={gitDiff.patch} /></div>
      </div>
    );
  }

  if (readQuery.isError) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#f87171", fontSize: 13 }}>
        <span style={{ padding: "0 16px", textAlign: "center", overflowWrap: "anywhere" }}>
          {readQuery.error instanceof Error ? readQuery.error.message : String(readQuery.error)}
        </span>
        <button
          type="button"
          onClick={() => void readQuery.refetch()}
          title="Retry"
          style={{ height: 22, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const isHtml = data.language === "html";
  const isMarkdown = data.language === "markdown";
  const markdownDirectory = getFileDirectory(filePath);
  const lines = data.content.split("\n");
  const hasLiveDiff = prevContent !== null && prevContent !== data.content;
  const hasDiff = hasLiveDiff || hasGitDiff;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd, pathFlavor)}
        </span>
        <WatchStatusBadge {...watchStatus} />
        <span style={{ marginLeft: "auto" }}>{data.language}</span>
        {viewMode === "source" && <span>{t("desktop.lines", { count: lines.length })}</span>}
        <span>{formatSize(data.size)}</span>

        {/* Diff / Source toggle — shown only when there are changes */}
        {hasDiff && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => setViewMode("source")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: viewMode === "source" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "source" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "source" ? 600 : 400,
              }}
            >
              {t("desktop.source")}
            </button>
            <button
              onClick={() => setViewMode("diff")}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: viewMode === "diff" ? "var(--bg-selected)" : "var(--bg-hover)",
                color: viewMode === "diff" ? "var(--text)" : "var(--text-muted)",
                fontWeight: viewMode === "diff" ? 600 : 400,
              }}
            >
              {t("desktop.diff")} {changeCount > 0 && <span style={{ color: "var(--git-status-added)", marginLeft: 2 }}>+{changeCount}</span>}
            </button>
          </div>
        )}

        {/* Word wrap toggle */}
        {viewMode === "source" && !previewMode && (
          <button
            onClick={() => setWrapLines((v) => !v)}
            title={wrapLines ? t("desktop.disableWordWrap") : t("desktop.enableWordWrap")}
            style={{
              padding: "2px 8px", fontSize: 11, cursor: "pointer",
              background: wrapLines ? "var(--bg-selected)" : "var(--bg-hover)",
              color: wrapLines ? "var(--text)" : "var(--text-muted)",
              border: "1px solid var(--border)", borderRadius: 5,
              fontWeight: wrapLines ? 600 : 400,
            }}
          >
            {t("desktop.wrap")}
          </button>
        )}

        {/* HTML source/preview toggle */}
        {isHtml && viewMode === "source" && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => setPreviewMode(false)}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              {t("desktop.code")}
            </button>
            <button
              onClick={() => setPreviewMode(true)}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              {t("desktop.preview")}
            </button>
          </div>
        )}

        {/* Markdown preview/raw toggle */}
        {isMarkdown && viewMode === "source" && (
          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button
              onClick={() => setPreviewMode(true)}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", cursor: "pointer",
                background: previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: previewMode ? 600 : 400,
              }}
            >
              {t("desktop.preview")}
            </button>
            <button
              onClick={() => setPreviewMode(false)}
              style={{
                padding: "2px 8px", fontSize: 11, border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
                background: !previewMode ? "var(--bg-selected)" : "var(--bg-hover)",
                color: !previewMode ? "var(--text)" : "var(--text-muted)",
                fontWeight: !previewMode ? 600 : 400,
              }}
            >
              {t("desktop.raw")}
            </button>
          </div>
        )}
        <MentionButton filePath={filePath} cwd={cwd} onAtMention={onAtMention} />
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>

      {/* Content area */}
      <div
        ref={contentRef}
        onScroll={handleContentScroll}
        style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}
      >
        {viewMode === "diff" && hasDiff ? (
          hasGitDiff
            ? <GitDiffView patch={gitDiff.patch!} />
            : <DiffView oldContent={prevContent!} newContent={data.content} />
        ) : isHtml && previewMode ? (
          <iframe
            srcDoc={data.content}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
            title={t("desktop.htmlPreview")}
          />
        ) : isMarkdown && previewMode ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px" }}
          >
            <ReactMarkdown
              remarkPlugins={markdownRemarkPlugins}
              rehypePlugins={markdownRehypePlugins}
              components={{
                h1({ children }: React.ComponentProps<'h1'>) {
                  return <h1 id={headingId(children)}>{children}</h1>
                },
                h2({ children }: React.ComponentProps<'h2'>) {
                  return <h2 id={headingId(children)}>{children}</h2>
                },
                h3({ children }: React.ComponentProps<'h3'>) {
                  return <h3 id={headingId(children)}>{children}</h3>
                },
                code: function CodeElement({ className, children, ...props }) {
                  // `node` is react-markdown metadata, never a DOM attribute.
                  delete props.node;
                  const lang = className?.replace("language-", "").toLowerCase() ?? "";
                  const raw = String(children);
                  const isBlock = useContext(MarkdownCodeContext);
                  if (isBlock) {
                    if (lang === "mermaid") {
                      return <MermaidBlock code={raw.replace(/\n$/, "")} />;
                    }
                    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
                  }
                  return (
                    <code
                      className="inline max-w-full whitespace-normal break-words [overflow-wrap:anywhere] align-baseline bg-(--bg-secondary) border border-(--border) px-1.5 py-0.5 text-xs font-mono text-(--accent-blue)"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                pre: function PreElement({ children }) {
                  // Mark real code blocks: `code` reads this context to decide
                  // block vs inline (newlines in inline code spans are legal).
                  return <MarkdownCodeContext.Provider value>{children}</MarkdownCodeContext.Provider>;
                },
                a({ href, children, ...props }) {
                  delete props.node;
                  const linkClass = "text-(--accent-blue) underline underline-offset-2 hover:text-(--accent-blue)/80";
                  const linkedFile = onOpenFile
                    ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory, pathFlavor)
                    : null;
                  if (!linkedFile || !onOpenFile) {
                    return (
                      <a href={href} {...props} className={linkClass} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    );
                  }

                  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                    if (event.defaultPrevented || event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    const target = event.currentTarget.getAttribute("target");
                    if (target && target !== "_self") return;
                    event.preventDefault();
                    onOpenFile(linkedFile);
                  };

                  return (
                    <a href={href} {...props} className={linkClass} onClick={handleClick}>
                      {children}
                    </a>
                  );
                },
                img({ src, alt, ...props }) {
                  // `node` is react-markdown metadata, never a DOM attribute.
                  delete props.node;
                  // Local paths (relative to the markdown file, absolute, or
                  // file:) are rewritten to /api/files; unsafe URL shapes return
                  // null and the image is dropped entirely.
                  const resolved = resolveMarkdownImageSrc(
                    src,
                    markdownDirectory,
                    cwd ?? markdownDirectory,
                    sourceSessionId,
                    pathFlavor,
                  );
                  if (!resolved) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element -- dynamic file/remote src, cannot use next/image
                    <img
                      src={resolved}
                      alt={alt}
                      {...props}
                      className="max-w-full h-auto"
                    />
                  );
                },
                table({ children }) {
                  return (
                    <div className="my-3 rounded-lg overflow-hidden border border-(--border)">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse [&_tr:last-child>td]:border-b-0">
                          {children}
                        </table>
                      </div>
                    </div>
                  );
                },
              }}
            >
              {normalizedMarkdown}
            </ReactMarkdown>
          </div>
        ) : (
          <SyntaxHighlighter
            language={data.language === "text" ? "plaintext" : data.language}
            style={prismTheme}
            showLineNumbers
            lineNumberStyle={{
              color: "var(--text-dim)",
              fontStyle: "normal",
              minWidth: "3em",
              paddingRight: "1em",
            }}
            customStyle={{
              margin: 0,
              padding: "12px 0",
              background: "var(--bg)",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: "var(--font-mono)",
              minHeight: "100%",
            }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            wrapLongLines={wrapLines}
          >
            {data.content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
