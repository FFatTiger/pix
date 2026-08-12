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
  parentWithinRoot,
} from "./paths";

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

/** Map a read/meta failure into a single friendly sentence. */
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
        return "File is outside the project root.";
      default:
        return `Unable to read file: ${error.message || "host error"}`;
    }
  }
  return "Unable to read file: the host is unreachable.";
}

export function FilesPanel({ cwd, canFiles }: FilesPanelProps) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const [currentDir, setCurrentDir] = useState<string | null>(cwd ?? null);
  const [root, setRoot] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Reset navigation when the project root (URL cwd) changes.
  useEffect(() => {
    setCurrentDir(cwd ?? null);
    setRoot(null);
    setSelectedFile(null);
  }, [cwd]);

  const list = useQuery({
    ...options.files.list(currentDir ?? ""),
    enabled: canFiles && Boolean(currentDir),
  });

  // The Host canonicalizes the listing path; capture it as the navigation root
  // once so a symlinked macOS prefix (/var → /private/var) cannot split a
  // canonical child away from its own canonical root.
  useEffect(() => {
    if (root === null && list.data?.path) setRoot(list.data.path);
  }, [root, list.data?.path]);

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

  if (!canFiles) {
    return <p className="workspace-hint">File browsing is not available on this host.</p>;
  }
  if (!cwd) {
    return <p className="workspace-hint">Open a project to browse its files.</p>;
  }

  const entries = list.data?.entries ?? [];

  const handleEnter = (name: string, isDir: boolean): void => {
    if (!currentDir) return;
    if (isDir) {
      setSelectedFile(null);
      // joinChild guards against traversal/separator escapes client-side.
      setCurrentDir(joinChild(currentDir, name));
    } else {
      setSelectedFile(joinChild(currentDir, name));
    }
  };

  return (
    <div className="files-panel" aria-label="Files">
      <nav className="files-breadcrumbs" aria-label="Directory path">
        {crumbs.length === 0 ? (
          <span className="files-crumb files-crumb--muted">{baseName(currentDir ?? "") || "root"}</span>
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
          <p className="workspace-hint workspace-hint--error" role="alert">
            Unable to list directory. {list.error instanceof HttpError ? list.error.message : "Host unreachable."}
          </p>
        ) : null}
        {!list.isLoading && !list.isError && entries.length === 0 ? (
          <p className="workspace-hint">This directory is empty.</p>
        ) : null}
        <ul className="files-list" role="listbox" aria-label="Directory entries">
          {entries.map((entry) => {
            const entryPath = currentDir ? joinChild(currentDir, entry.name) : entry.name;
            const active = selectedFile === entryPath || (entry.isDir && canonicalCurrent === entryPath);
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

      {selectedFile ? (
        <section className="files-detail" aria-label="File preview">
          <div className="files-detail-header">
            <span className="files-detail-name" title={selectedFile}>{baseName(selectedFile)}</span>
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
          {read.data && isWithinRoot(selectedFile, root ?? selectedFile) === false ? (
            <p className="workspace-hint workspace-hint--error">Selected path is outside the project root.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
