import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { At, CaretRight, Check, Copy, DownloadSimple, Info, LinkSimple, MinusCircle, Spinner, UploadSimple, Warning, X } from "@phosphor-icons/react";
import { getFileIcon, FolderIcon } from "@/components/files/FileIcons";
import { filePathCompareKey, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { useContextMenu } from "@/components/ContextMenu";
import type { GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { useHttpClient } from "@/app/http-context";
import { urls } from "@/api/urls";
import { createResourcesApi, UploadConflictError, type UploadResponse } from "@/api/resources";
import { createQueryOptions } from "@/api/query-keys";
import { invalidateFileWorkspace } from "@/api/mutations";
import { mapExplorerGitStatus } from "./explorer-api";



interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: { initialDisplayMode?: "diff" }) => void;
  onAtMention?: ((relativePath: string, isDir: boolean) => void) | undefined;
  onAtMentions?: ((relativePaths: string[]) => void) | undefined;
  onUploadBusyChange?: ((busy: boolean) => void) | undefined;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  /** Run the upload state machine on dropped files (same preflight → conflict
   *  card → typed progress transport as the picker). */
  prepareUpload: (files: File[]) => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}



type ExplorerGitStatus = "added" | "modified" | "deleted";

function gitPathKey(filePath: string): string {
  return filePathCompareKey(filePath);
}

function toExplorerGitStatus(status: GitFileStatusKind): ExplorerGitStatus {
  if (status === "added" || status === "untracked") return "added";
  if (status === "deleted" || status === "conflict") return "deleted";
  return "modified";
}

function gitStatusColor(status: ExplorerGitStatus | undefined): string {
  if (status === "added") return "var(--git-status-added)";
  if (status === "deleted") return "var(--git-status-deleted)";
  if (status === "modified") return "var(--git-status-modified)";
  return "var(--text)";
}

function gitStatusPriority(status: ExplorerGitStatus): number {
  return status === "deleted" ? 3 : status === "added" ? 2 : 1;
}

function getNodeGitStatus(
  pathKey: string,
  isDirectory: boolean,
  changedFiles: Map<string, ExplorerGitStatus>,
): ExplorerGitStatus | undefined {
  const directStatus = changedFiles.get(pathKey);
  if (directStatus || !isDirectory) return directStatus;

  let descendantStatus: ExplorerGitStatus | undefined;
  for (const [changedPath, status] of changedFiles) {
    if (!changedPath.startsWith(`${pathKey}/`)) continue;
    if (!descendantStatus || gitStatusPriority(status) > gitStatusPriority(descendantStatus)) {
      descendantStatus = status;
    }
  }
  return descendantStatus;
}

function isIgnoredPath(pathKey: string, ignoredPaths: Set<string>): boolean {
  if (ignoredPaths.has(pathKey)) return true;
  for (const ignoredPath of ignoredPaths) {
    if (pathKey.startsWith(`${ignoredPath}/`)) return true;
  }
  return false;
}

/**
 * Shared query-options builder for the workspace tree. Every TreeNode and the
 * panel build listings from the same queryKeys/createQueryOptions authority,
 * so expanded directories are cached/refreshed like any other remote read.
 */
function useWorkspaceQueryOptions() {
  const http = useHttpClient();
  return useMemo(() => createQueryOptions(http), [http]);
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return <At size={size} weight="regular" aria-hidden="true" />;
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <X size={13} weight="regular" aria-hidden="true" />
    </button>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  highlightedPaths,
  ignoredPaths,
  changedFiles,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: ((relativePath: string, isDir: boolean) => void) | undefined;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  highlightedPaths: Set<string>;
  ignoredPaths: Set<string>;
  changedFiles: Map<string, ExplorerGitStatus>;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const pathKey = gitPathKey(node.fullPath);
  const ignored = isIgnoredPath(pathKey, ignoredPaths);
  const gitStatus = getNodeGitStatus(pathKey, node.isDir, changedFiles);
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const { openMenu } = useContextMenu();
  const options = useWorkspaceQueryOptions();

  // Directory listings are owned by React Query: the query is enabled only
  // while the directory is expanded, and every refresh/invalidation of the
  // files domain refetches open directories from the one authority.
  const childrenQuery = useQuery({
    ...options.files.list(node.fullPath),
    enabled: open && node.isDir,
  });
  const children = useMemo<FileNode[]>(
    () => (childrenQuery.data ? childrenQuery.data.entries.map((entry) => ({
      name: entry.name,
      fullPath: joinFilePath(node.fullPath, entry.name),
      isDir: entry.isDir,
    })) : []),
    [childrenQuery.data, node.fullPath],
  );
  const loaded = open && node.isDir && (childrenQuery.data !== undefined || childrenQuery.isError);
  const loading = open && node.isDir && childrenQuery.isFetching;

  const handleClick = useCallback(() => {
    if (node.isDir) {
      onToggleExpanded(node.fullPath, !open);
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, open, onOpenFile, onToggleExpanded]);

  const handleRetry = useCallback(() => {
    void childrenQuery.refetch();
  }, [childrenQuery]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { type: "separator" },
      {
        label: t("desktop.copyRelativePath"),
        icon: <Copy size={13} weight="regular" aria-hidden="true" />,
        feedbackLabel: t("desktop.copied"),
        onSelect: () => copyText(getRelativeFilePath(node.fullPath, cwd)),
      },
      {
        label: t("desktop.copyAbsolutePath"),
        icon: <LinkSimple size={13} weight="regular" aria-hidden="true" />,
        feedbackLabel: t("desktop.copied"),
        onSelect: () => copyText(node.fullPath),
      },
    ]);
  }, [cwd, node.fullPath, openMenu, t]);


  return (
    <div>
      <div
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
          opacity: ignored ? (hovered ? 0.72 : 0.5) : 1,
        }}
      >
        {node.isDir && (
          <CaretRight size={10} color="var(--text-dim)" weight="regular" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }} aria-hidden="true" />
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ position: "relative", width: 14, height: 14, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} name={node.name} /> : getFileIcon(node.name, 14)}
          {gitStatus && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: -1,
                bottom: -1,
                zIndex: 1,
                width: 7,
                height: 7,
                border: "1px solid var(--bg-panel)",
                borderRadius: "50%",
                background: gitStatusColor(gitStatus),
              }}
            />
          )}
        </span>
        <span
          style={{
            fontSize: 12,
            color: gitStatusColor(gitStatus),
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title="Newly uploaded"
            aria-label="Newly uploaded"
            style={{ width: 6, height: 6, flexShrink: 0, borderRadius: "50%", background: "#3b82f6" }}
          />
        )}
        {loading && (
          <Spinner size={10} color="var(--text-dim)" weight="regular" aria-hidden="true" />
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title="Insert path into chat"
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            mention
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={urls.files.file(node.fullPath, "download")}
            download
            onClick={(e) => e.stopPropagation()}
            title="Download file"
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <DownloadSimple size={11} weight="regular" aria-hidden="true" />
          </a>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              highlightedPaths={highlightedPaths}
              ignoredPaths={ignoredPaths}
              changedFiles={changedFiles}
            />
          ))}
          {childrenQuery.isError && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingLeft: 8 + (depth + 1) * 14,
                paddingRight: 8,
                height: 22,
                fontSize: 11,
                color: "#f87171",
              }}
            >
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Could not list directory.
              </span>
              <button
                type="button"
                onClick={handleRetry}
                title={t("desktop.refresh")}
                style={{ height: 18, padding: "0 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}
              >
                Retry
              </button>
            </div>
          )}
          {children.length === 0 && !childrenQuery.isError && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
}, ref) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const http = useHttpClient();
  const options = useWorkspaceQueryOptions();
  const queryClient = useQueryClient();
  const resources = useMemo(() => createResourcesApi(http), [http]);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadBusy = uploadPhase !== "idle";

  // Root listing + git status are owned by React Query. Git status is shared
  // with QuickChangesPanel via the same queryKeys.git.status(cwd) key, so the
  // two surfaces never issue competing requests.
  const rootQuery = useQuery({ ...options.files.list(cwd), enabled: Boolean(cwd) });
  const gitQuery = useQuery({ ...options.git.status(cwd), enabled: Boolean(cwd) });
  const gitStatus: GitStatusResponse | null = useMemo(
    () => (gitQuery.data ? mapExplorerGitStatus(gitQuery.data) : null),
    [gitQuery.data],
  );

  const roots = useMemo<FileNode[]>(
    () => (rootQuery.data ? rootQuery.data.entries.map((entry) => ({
      name: entry.name,
      fullPath: joinFilePath(cwd, entry.name),
      isDir: entry.isDir,
    })) : []),
    [rootQuery.data, cwd],
  );
  const ignoredPaths = useMemo(
    () => new Set((gitStatus?.ignoredPaths ?? []).map(gitPathKey)),
    [gitStatus],
  );
  const changedFiles = useMemo(
    () => new Map((gitStatus?.files ?? []).map((file) => [
      gitPathKey(file.filePath),
      toExplorerGitStatus(file.status),
    ])),
    [gitStatus],
  );

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    const abort = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = abort;

    try {
      const data = await resources.files.uploadWithProgress(
        { directory: cwd, files, conflict: strategy },
        (progress) => setUploadProgress(progress.percent),
        abort.signal,
      );
      setUploadProgress(100);
      applyUploadResult(data);
      // Single remote-state authority: upload success refreshes every affected
      // files/git/index/viewer query (same invalidation as the upload mutation).
      await invalidateFileWorkspace(queryClient);
    } catch (uploadFailure) {
      if (uploadFailure instanceof UploadConflictError) {
        setPendingConflict({
          files,
          conflicts: uploadFailure.conflicts,
          nonReplaceable: uploadFailure.nonReplaceable,
        });
        return;
      }
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd, resources]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const data = await resources.files.uploadCheck(
        cwd,
        files.map((file) => file.name),
      );

      if (data.conflicts.length > 0) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable,
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, resources, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
    prepareUpload(files: File[]) {
      void prepareUpload(files);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [uploadBusy, prepareUpload]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  // Workspace boundary: a cwd switch is a new remote-state scope. Reset the
  // ephemeral tree/upload UI and abort any in-flight upload so a late settle
  // from the previous workspace can never surface in the new one.
  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    if (cwdChanged) {
      uploadAbortRef.current?.abort();
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
    }
  }, [cwd]);

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  const rootError = rootQuery.isError ? "Could not list files." : null;

  return (
    <div style={{ minHeight: "100%" }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? "Checking files" : `Uploading, ${uploadProgress}%`}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <Spinner size={13} weight="regular" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
              ) : (
                <UploadSimple size={13} weight="regular" aria-hidden="true" />
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {pendingConflict.conflicts.length} file{pendingConflict.conflicts.length === 1 ? "" : "s"} already exist: {pendingConflict.conflicts.join(", ")}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                Cannot replace: {pendingConflict.nonReplaceable.join(", ")}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                Replace
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                Skip existing
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title="Dismiss error" />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <Check size={13} weight="regular" aria-hidden="true" />
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <MinusCircle size={13} weight="regular" aria-hidden="true" />
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <Warning size={13} weight="regular" aria-hidden="true" />
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? "Add uploaded file to chat" : "Add all uploaded files to chat"}
                  aria-label={uploadSummary.uploaded.length === 1 ? "Add uploaded file to chat" : "Add all uploaded files to chat"}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  mention
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title="Dismiss upload results" />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <Info size={11} weight="regular" style={{ flexShrink: 0 }} aria-hidden="true" />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}



      <div style={{ padding: "2px 4px" }}>
        {rootQuery.isLoading ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>Loading files...</div>
        ) : rootError ? (
          <div
            role="alert"
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", fontSize: 11, color: "#f87171" }}
          >
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{rootError}</span>
            <button
              type="button"
              onClick={() => void rootQuery.refetch()}
              title="Retry"
              style={{ height: 20, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}
            >
              Retry
            </button>
          </div>
        ) : (
          roots.map((node) => (
            <TreeNode
              key={node.fullPath}
              node={node}
              depth={0}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={handleToggleExpanded}
              highlightedPaths={highlightedPaths}
              ignoredPaths={ignoredPaths}
              changedFiles={changedFiles}
            />
          ))
        )}
        {!rootQuery.isLoading && !rootError && roots.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            No files found
          </div>
        )}
      </div>
    </div>
  );
});
