import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import {
  baseName,
  breadcrumbs,
  isWithinRoot,
  joinChild,
  joinRelative,
  parentWithinRoot,
} from "./paths";

/** Debounce for the file search input. Keeps the network off keystroke noise. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface FilesPanelProps {
  /** Workspace project root (the current cwd). Undefined ⇒ panel is idle. */
  cwd: string | undefined;
  /** Honest capability gate — when false the panel never requests the API. */
  canFiles: boolean;
}

/** Human-readable byte size (binary, KiB/MiB…). */
function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Map a read failure into a single friendly sentence. Never echoes raw host messages. */
function describeReadError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "PREVIEW_TOO_LARGE":
        return "This file is too large to preview in read-only mode.";
      case "BINARY_FILE":
        return "Binary file — preview is not available in read-only mode.";
      case "NOT_FILE":
        return "Selected entry is not a file.";
      case "PATH_NOT_FOUND":
        return "File no longer exists.";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "File is outside the project root.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to read file.";
    if (error.kind === "timeout") return "Request timed out — unable to read file.";
  }
  return "Unable to read file.";
}

/** Fixed directory-listing error copy. Never renders body/stack/path/secret/raw host messages. */
function describeListError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "CWD_REQUIRED":
      case "INVALID_PATH":
      case "INVALID_INPUT":
        return "Invalid project path.";
      case "PATH_NOT_FOUND":
        return "Project path was not found.";
      case "NO_ALLOWED_ROOTS":
        return "No allowed roots are configured.";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "Project path is outside the allowed roots.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — unable to list directory.";
    if (error.kind === "timeout") return "Request timed out — unable to list directory.";
  }
  return "Unable to list directory.";
}

/**
 * Fixed file-search (file-index) error copy, code-first then kind, with a fixed
 * fallback. Aborts are treated as a cancelled search, never a user-facing
 * failure — a cancelled index is the normal result of typing a new query.
 * Never renders body/stack/path/secret/raw host messages.
 */
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

export function FilesPanel({ cwd, canFiles }: FilesPanelProps) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const [currentDir, setCurrentDir] = useState<string | null>(cwd ?? null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [invalidSearchResult, setInvalidSearchResult] = useState(false);

  // Reset navigation, search and selection when the project root (URL cwd)
  // changes. cwd switching immediately drops any in-flight/in-progress query:
  // raw is cleared and the pending debounce timer is torn down by the debounce
  // effect's cleanup, so a cwd B can never render results keyed to cwd A.
  useEffect(() => {
    setCurrentDir(cwd ?? null);
    setSelectedFile(null);
    setRaw("");
    setDebouncedQuery("");
    setInvalidSearchResult(false);
  }, [cwd]);

  // Debounce the trimmed query. Below 2 characters we never request an empty-q
  // full index; the query stays "" (disabled). Any raw change also clears the
  // stale "Invalid search result." message and hides previous results.
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

  // When the files capability is withdrawn the panel early-returns below; reset
  // search/selection so restoring the capability never flashes stale results.
  useEffect(() => {
    if (!canFiles) {
      setSelectedFile(null);
      setRaw("");
      setDebouncedQuery("");
      setInvalidSearchResult(false);
    }
  }, [canFiles]);

  // Canonical project root: a dedicated, navigation-independent listing of the
  // workspace cwd. The Host canonicalizes the returned `path`, so this is the
  // authoritative root even when cwd is a symlinked prefix (/tmp → /private/tmp
  // on macOS). TanStack Query de-dupes this against the navigation `list` query
  // while currentDir === cwd (identical key); once the user navigates they
  // split, and this query keeps observing cwd — so `root` stays stable and
  // canonical regardless of navigation timing or a stale cwd-list response.
  const rootList = useQuery({
    ...options.files.list(cwd ?? ""),
    enabled: canFiles && Boolean(cwd),
  });
  const root = rootList.data?.path ?? null;

  const list = useQuery({
    ...options.files.list(currentDir ?? ""),
    enabled: canFiles && Boolean(currentDir),
  });
  // Navigation authority derives from the canonical response path, never from
  // the (possibly non-canonical) requested `currentDir`. joinChild therefore
  // produces a canonical-prefixed path, so a symlinked cwd prefix can never
  // leak into a navigated directory or a selected file path.
  const canonicalCurrent = list.data?.path ?? currentDir ?? null;

  const crumbs = root && canonicalCurrent ? breadcrumbs(canonicalCurrent, root) : [];
  const upTarget =
    root && canonicalCurrent ? parentWithinRoot(canonicalCurrent, root) : null;

  const meta = useQuery({
    ...options.files.meta(selectedFile ?? ""),
    enabled: canFiles && Boolean(selectedFile),
  });
  const read = useQuery({
    ...options.files.read(selectedFile ?? ""),
    enabled: canFiles && Boolean(selectedFile),
  });
  // Canonical selected path: the Host returns the realpath in the `meta`
  // response. Used for display and the defense-in-depth root check so that,
  // even if a file was selected before the directory listing canonicalized,
  // the raw cwd prefix is never compared against the canonical root.
  const canonicalSelected = meta.data?.path ?? selectedFile;

  // File search: only the canonical root's index is queried, keyed by
  // (cwd, debouncedQuery) so a late q1 response can never render as q2 — the
  // query data we render below belongs only to the current debounced query.
  // Enabled only when the canonical root is ready, the files capability is
  // present, and the trimmed query is at least 2 characters.
  const search = useQuery({
    ...options.files.index(cwd ?? "", debouncedQuery),
    enabled: canFiles && Boolean(root) && debouncedQuery.length >= 2,
  });

  if (!canFiles) {
    return <p className="workspace-hint">File browsing is not available on this host.</p>;
  }
  if (!cwd) {
    return <p className="workspace-hint">Open a project to browse its files.</p>;
  }

  const entries = list.data?.entries ?? [];
  // The index schema is a union (empty-q `files` shape vs `matches` shape); we
  // only ever query with a non-empty q so the Host returns `matches`, but the
  // client still narrows explicitly — never treating a `files` payload as hits.
  const searchData = search.data;
  const matches = searchData && "matches" in searchData ? searchData.matches : [];
  const truncated = searchData?.truncated ?? false;

  const trimmed = raw.trim();
  const searchMode = trimmed.length >= 1;
  const validSearch = trimmed.length >= 2;
  // Only when the debounce has settled for the current raw value do we render
  // that query's results — typing a new query immediately hides the old ones.
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

  // All navigation/selection joins derive from the canonical current path, so
  // every produced path shares the canonical prefix the Host returned.
  const handleEnter = (name: string, isDir: boolean): void => {
    if (!canonicalCurrent) return;
    const next = joinChild(canonicalCurrent, name);
    if (isDir) {
      setSelectedFile(null);
      setCurrentDir(next);
    } else {
      setSelectedFile(next);
    }
  };

  // Search result selection: join the Host's relative match path onto the
  // canonical root. A null join (malformed/hostile path) shows a fixed message
  // and never issues meta/read requests — no leaked path reaches the DOM.
  const handleSearchSelect = (matchPath: string): void => {
    const path = root ? joinRelative(root, matchPath) : null;
    if (path === null) {
      setInvalidSearchResult(true);
      setSelectedFile(null);
      return;
    }
    setInvalidSearchResult(false);
    setSelectedFile(path);
  };

  return (
    <div className="files-panel" aria-label="Files">
      <form className="files-search-form" role="search" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          className="files-search-input"
          aria-label="Search files"
          placeholder="Search files…"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
        />
      </form>

      {searchMode ? (
        <section className="files-search" aria-label="Search results">
          {searchActive && search.isError ? (
            <p className="workspace-hint workspace-hint--error" role="alert">{describeIndexError(search.error)}</p>
          ) : null}
          {searchActive && !search.isError && matches.length > 0 ? (
            <ul className="files-search-results" aria-label="Search results">
              {matches.map((match) => {
                const path = root ? joinRelative(root, match.path) : null;
                const active = path !== null && canonicalSelected === path;
                return (
                  <li key={match.path}>
                    <button
                      type="button"
                      className={`files-entry${active ? " files-entry--active" : ""}`}
                      onClick={() => handleSearchSelect(match.path)}
                      title={match.path}
                    >
                      <span className="files-entry-icon" aria-hidden="true">📄</span>
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
        <>
          <nav className="files-breadcrumbs" aria-label="Directory path">
            {crumbs.length === 0 ? (
              <span className="files-crumb files-crumb--muted">{baseName(canonicalCurrent ?? "") || "root"}</span>
            ) : (
              crumbs.map((crumb, index) => {
                const isLast = index === crumbs.length - 1;
                return (
                  <span key={crumb.path} className="files-crumb-wrap">
                    <button
                      type="button"
                      className={`files-crumb${isLast ? " files-crumb--current" : ""}`}
                      onClick={() => {
                        setSelectedFile(null);
                        setCurrentDir(crumb.path);
                      }}
                      disabled={isLast}
                      title={crumb.path}
                    >
                      {crumb.label}
                    </button>
                    {!isLast ? <span className="files-crumb-sep" aria-hidden="true">/</span> : null}
                  </span>
                );
              })
            )}
          </nav>
          <div className="files-toolbar">
            <button
              type="button"
              className="text-btn files-up"
              disabled={!upTarget}
              onClick={() => {
                if (upTarget) {
                  setSelectedFile(null);
                  setCurrentDir(upTarget);
                }
              }}
              title={upTarget ? `Up to ${upTarget}` : "Already at project root"}
            >
              ↑ Up
            </button>
            <span className="files-count">{entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
          </div>

          <div className="files-list-scroll">
            {list.isLoading ? <p className="workspace-hint">Loading directory…</p> : null}
            {list.isError ? (
              <p className="workspace-hint workspace-hint--error" role="alert">{describeListError(list.error)}</p>
            ) : null}
            {!list.isLoading && !list.isError && entries.length === 0 ? (
              <p className="workspace-hint">This directory is empty.</p>
            ) : null}
            <ul className="files-list" role="listbox" aria-label="Directory entries">
              {entries.map((entry) => {
                const entryPath = canonicalCurrent ? joinChild(canonicalCurrent, entry.name) : entry.name;
                const active = canonicalSelected === entryPath;
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className={`files-entry${active ? " files-entry--active" : ""}`}
                      role="option"
                      aria-selected={active}
                      onClick={() => handleEnter(entry.name, entry.isDir)}
                      title={entry.isDir ? `Open ${entry.name}` : `Preview ${entry.name}`}
                    >
                      <span className="files-entry-icon" aria-hidden="true">{entry.isDir ? "📁" : entry.isSymlink ? "↪" : "📄"}</span>
                      <span className="files-entry-name">{entry.name}</span>
                      {entry.isDir ? <span className="files-entry-tag">dir</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      {selectedFile ? (
        <section className="files-detail" aria-label="File preview">
          <div className="files-detail-header">
            <span className="files-detail-name" title={canonicalSelected ?? selectedFile}>{baseName(canonicalSelected ?? selectedFile)}</span>
            <button type="button" className="icon-btn files-detail-close" aria-label="Close preview" onClick={() => setSelectedFile(null)}>×</button>
          </div>
          {meta.data ? (
            <dl className="files-meta">
              <div><dt>Size</dt><dd>{formatBytes(meta.data.size)}</dd></div>
              <div><dt>Modified</dt><dd>{new Date(meta.data.modified).toLocaleString()}</dd></div>
              {meta.data.mime ? <div><dt>Type</dt><dd>{meta.data.mime}</dd></div> : null}
            </dl>
          ) : null}
          {read.isLoading ? <p className="workspace-hint">Reading file…</p> : null}
          {read.isError ? (
            <p className="workspace-hint workspace-hint--error" role="alert">{describeReadError(read.error)}</p>
          ) : null}
          {read.data ? (
            <pre className="files-preview" aria-label="File contents">
              <code>{read.data.content}</code>
            </pre>
          ) : null}
          {read.data && isWithinRoot(canonicalSelected ?? "", root ?? canonicalSelected ?? "") === false ? (
            <p className="workspace-hint workspace-hint--error">Selected path is outside the project root.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
