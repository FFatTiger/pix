import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowClockwise, Check, CaretRight, MagnifyingGlass, UploadSimple, X } from "@phosphor-icons/react";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { useI18n } from "@/hooks/useI18n";
import { useDragDrop } from "@/hooks/useDragDrop";
import { getFileIcon } from "@/components/files/FileIcons";
import { getFileName } from "@/lib/file-paths";
import { baseName, joinRelative } from "../paths";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { QuickChangesPanel } from "./QuickChangesPanel";
import { loadExplorerOpen, saveExplorerOpen } from "./file-explorer-state";

/**
 * Files explorer panel — the source sidebar's file-workspace composition
 * (explorer section header + lazy tree + quick-changes footer) fused with the
 * pix file search (250 ms debounce, canonical-root `joinRelative` joins), all
 * behind honest capability props: no request fires unless the outer layer
 * negotiated the capability.
 */

/** Debounce for the file search input (same value as the pix FilesPanel). */
export const SEARCH_DEBOUNCE_MS = 250;

export interface ExplorerPanelProps {
  /** Workspace project root (the current cwd). Undefined ⇒ panel is idle. */
  cwd: string | undefined;
  /** Honest capability gate — when false the panel never requests the API. */
  canFiles: boolean;
  /** Honest git capability gate for the quick-changes footer (default off). */
  canGit?: boolean | undefined;
  /** Open a file (viewer tab ownership stays with the outer shell). */
  onOpenFile: (filePath: string, fileName: string, options?: { initialDisplayMode?: "diff" }) => void;
  /** Insert a path into the chat input (@ mention). */
  onAtMention?: ((relativePath: string, isDir: boolean) => void) | undefined;
  /** Insert several paths into the chat input (uploaded files). */
  onAtMentions?: ((relativePaths: string[]) => void) | undefined;
  /** Optional header action (the right-edge file-browser toggle when fused). */
  headerAction?: ReactNode;
  /** Whether the panel is on screen. Gates queries so a hidden panel never
   *  fires file/git requests (the container stays mounted for animations). */
  visible?: boolean;
}

/** Fixed file-search error copy (code-first, then kind, fixed fallback). */
function describeIndexError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "CWD_REQUIRED":
      case "INVALID_PATH":
      case "INVALID_INPUT":
      case "NOT_DIRECTORY":
        return "Invalid project path for search.";
      case "PATH_NOT_FOUND":
        return "Project path was not found.";
      case "NO_ALLOWED_ROOTS":
        return "No allowed roots are configured.";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "Project path is outside the allowed roots.";
      case "INDEX_TIMEOUT":
      case "TIMEOUT":
        return "Search timed out — try a more specific query.";
      case "INDEX_ABORTED":
      case "ABORTED":
        return "Search cancelled.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to search files.";
    if (error.kind === "timeout") return "Search timed out — try a more specific query.";
  }
  return "Unable to search files.";
}

export function ExplorerPanel({ cwd, canFiles, canGit = false, onOpenFile, onAtMention, onAtMentions, headerAction, visible = true }: ExplorerPanelProps) {
  const { t } = useI18n();
  const http = useHttpClient();
  const options = useMemo(() => createQueryOptions(http), [http]);
  const queryClient = useQueryClient();
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Explorer section state (source sidebar semantics, verbatim).
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File search state (pix fusion: debounced query against the file index).
  const [searchOpen, setSearchOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [invalidSearchResult, setInvalidSearchResult] = useState(false);

  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
    return () => {
      if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    };
  }, []);

  // Reset search when the project root changes: raw is cleared and the pending
  // debounce timer is torn down by the effect cleanup, so a cwd B can never
  // render results keyed to cwd A. FileExplorer/QuickChanges re-key their own
  // queries on cwd (queryKeys are cwd-scoped) and reset their ephemeral UI.
  useEffect(() => {
    setRaw("");
    setDebouncedQuery("");
    setInvalidSearchResult(false);
  }, [cwd]);

  // Debounce the trimmed query. Below 2 characters we never request an empty-q
  // full index; the query stays "" (disabled).
  useEffect(() => {
    setInvalidSearchResult(false);
    const trimmed = raw.trim();
    if (trimmed.length < 2) {
      setDebouncedQuery("");
      return;
    }
    const handle = window.setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [raw]);

  useEffect(() => {
    if (!canFiles) {
      setRaw("");
      setDebouncedQuery("");
      setInvalidSearchResult(false);
    }
  }, [canFiles]);

  // Canonical project root: navigation-independent listing of the workspace
  // cwd; the Host canonicalizes `path`, so search matches join onto the same
  // canonical prefix the tree shows.
  const rootList = useQuery({
    ...options.files.list(cwd ?? ""),
    enabled: canFiles && Boolean(cwd) && visible,
  });
  const root = rootList.data?.path ?? null;

  // File search: only the canonical root's index is queried, keyed by
  // (cwd, debouncedQuery) so a late q1 response can never render as q2.
  const search = useQuery({
    ...options.files.index(cwd ?? "", debouncedQuery),
    enabled: canFiles && Boolean(root) && debouncedQuery.length >= 2 && visible,
  });

  const handleRefreshExplorer = () => {
    // Refresh the whole files + git domains from the one remote-state
    // authority: tree listings, expanded subdirectories, the search index and
    // every git status/diff consumer refetch in one pass.
    void queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.git.all });
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  };

  // Drag-and-drop upload: dropped files run the explorer's upload state
  // machine (preflight → conflict card → XHR progress).
  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop((files) => {
    fileExplorerRef.current?.prepareUpload(files);
  });

  if (!canFiles || !cwd) {
    // The header (with the fused always-visible browser toggle) must render
    // even in the inactive states, or an open panel could never be closed.
    return (
      <div className="explorer-panel" aria-label="Files">
        <div className="sidebar-section-head">
          <span className="sidebar-section-label-text">{t("desktop.files")}</span>
          {headerAction ? <div className="explorer-header-action">{headerAction}</div> : null}
        </div>
        <p className="workspace-hint">
          {!canFiles
            ? "File browsing is not available on this host."
            : "Open a project to browse its files."}
        </p>
      </div>
    );
  }

  const searchData = search.data;
  const matches = searchData && "matches" in searchData ? searchData.matches : [];
  const truncated = searchData?.truncated ?? false;

  const trimmed = raw.trim();
  const searchMode = trimmed.length >= 1;
  const validSearch = trimmed.length >= 2;
  const querySettled = trimmed === debouncedQuery;
  const searchActive = validSearch && querySettled && Boolean(root);

  let searchStatus = "";
  if (searchMode) {
    if (!validSearch) {
      searchStatus = "Type at least 2 characters to search.";
    } else if (!querySettled || !root) {
      searchStatus = "Searching…";
    } else if (search.isError) {
      searchStatus = ""; // reported via role="alert" below
    } else if (search.isLoading || search.data === undefined) {
      searchStatus = "Searching…";
    } else if (matches.length === 0) {
      searchStatus = "No matches found.";
    } else {
      searchStatus = `${matches.length} ${matches.length === 1 ? "match" : "matches"} found.`;
      if (truncated) searchStatus += " Results truncated.";
    }
  }

  // Search result selection: join the Host's relative match path onto the
  // canonical root. A null join (malformed/hostile path) shows a fixed message
  // and never opens the file.
  const handleSearchSelect = (matchPath: string): void => {
    const path = root ? joinRelative(root, matchPath) : null;
    if (path === null) {
      setInvalidSearchResult(true);
      return;
    }
    setInvalidSearchResult(false);
    onOpenFile(path, getFileName(path));
  };

  return (
    <div
      className="explorer-panel"
      aria-label="Files"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: 1,
        overflow: "hidden",
        outline: isDragOver ? "2px dashed var(--accent)" : "none",
        outlineOffset: -2,
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {searchOpen ? (
        <div className="sidebar-search-field">
          <div className="sidebar-search-wrap">
            <MagnifyingGlass size={13} className="sidebar-search-icon" aria-hidden="true" />
            <input
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (raw) setRaw("");
                  else setSearchOpen(false);
                }
              }}
              placeholder={t("desktop.searchFilesPlaceholder")}
              aria-label={t("desktop.searchFiles")}
              autoFocus
            />
          </div>
          <button
            type="button"
            className="sidebar-icon-btn"
            onClick={() => { setSearchOpen(false); setRaw(""); }}
            title={t("desktop.exitSearch")}
            aria-label={t("desktop.exitSearch")}
          >
            <X size={13} weight="regular" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {searchMode ? (
        <section className="files-search" aria-label="Search results" style={{ minHeight: 0, overflowY: "auto" }}>
          {searchActive && search.isError ? (
            <p className="workspace-hint workspace-hint--error" role="alert">{describeIndexError(search.error)}</p>
          ) : null}
          {searchActive && !search.isError && matches.length > 0 ? (
            <ul className="files-search-results" aria-label="Search results">
              {matches.map((match) => {
                const path = root ? joinRelative(root, match.path) : null;
                return (
                  <li key={match.path}>
                    <button
                      type="button"
                      className="files-entry"
                      onClick={() => handleSearchSelect(match.path)}
                      title={path ?? match.path}
                    >
                      <span className="files-entry-icon" aria-hidden="true">{getFileIcon(baseName(match.path), 13)}</span>
                      <span className="files-entry-name">{match.path}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {invalidSearchResult ? (
            <p className="workspace-hint workspace-hint--error" role="alert">Invalid search result.</p>
          ) : null}
          <p className="files-search-status" aria-live="polite">{searchStatus}</p>
        </section>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: "0 0 auto",
          }}
        >
          <div className="sidebar-section-head" data-expanded={explorerOpen ? "true" : "false"}>
            <button
              type="button"
              className="sidebar-section-toggle"
              data-testid="files-section-toggle"
              aria-expanded={explorerOpen}
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
            >
              <span className="sidebar-section-label-text">{t("desktop.files")}</span>
              <CaretRight
                className="sidebar-section-chevron"
                size={14}
                weight="bold"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none" }}
                aria-hidden="true"
              />
            </button>
            <div className="sidebar-section-actions">
              <button
                type="button"
                className="sidebar-icon-btn"
                onClick={() => {
                  setSearchOpen((open) => {
                    if (open) setRaw("");
                    return !open;
                  });
                }}
                title={t("desktop.searchFiles")}
                aria-label={t("desktop.searchFiles")}
              >
                <MagnifyingGlass size={14} weight="regular" aria-hidden="true" />
              </button>
              {explorerOpen && (
                <button
                  type="button"
                  className="sidebar-icon-btn"
                  onClick={() => fileExplorerRef.current?.openUploadPicker()}
                  disabled={explorerUploadBusy}
                  title={t("desktop.uploadFilesToProjectRoot")}
                  aria-label={t("desktop.uploadFiles")}
                >
                  <UploadSimple size={14} weight="regular" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="sidebar-icon-btn"
                onClick={handleRefreshExplorer}
                title={t("desktop.refreshExplorer")}
                aria-label={t("desktop.refreshExplorer")}
              >
                {explorerRefreshDone ? (
                  <Check size={14} color="#4ade80" weight="regular" aria-hidden="true" />
                ) : (
                  <ArrowClockwise size={14} weight="regular" aria-hidden="true" />
                )}
              </button>
            </div>
            {headerAction ? <div className="explorer-header-action">{headerAction}</div> : null}
          </div>
          {explorerOpen && visible && (
            <div>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={cwd}
                onOpenFile={onOpenFile}
                {...(onAtMention === undefined ? {} : { onAtMention })}
                {...(onAtMentions === undefined ? {} : { onAtMentions })}
                onUploadBusyChange={setExplorerUploadBusy}
              />
            </div>
          )}
        </div>
      )}

      {canGit && visible ? (
        <QuickChangesPanel
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  );
}
