import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { XIcon } from "@phosphor-icons/react/X";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { baseName, breadcrumbs, isWithinRoot, joinChild, parentWithinRoot } from "../paths";
import { describeFolderBrowserError } from "./folder-browser-errors";

const EMPTY_ROOTS: readonly string[] = [];
const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Choose the initial folder without inventing a path: the current cwd is used
 * only when the Host's roots authorize it, otherwise the Host default root (or
 * the first authorized root) wins. Never expands or validates a root here.
 */
export function resolveStartFolder(
  roots: readonly string[],
  defaultCwd: string | null | undefined,
  currentCwd: string | null | undefined,
): string | undefined {
  if (currentCwd && roots.some((root) => isWithinRoot(currentCwd, root))) return currentCwd;
  if (defaultCwd && roots.some((root) => isWithinRoot(defaultCwd, root))) return defaultCwd;
  return roots[0];
}

export interface ProjectFolderDialogProps {
  /** Current project cwd; used only when it is inside an authorized root. */
  initialPath?: string | null;
  /** Close without selecting. */
  onCancelAction: () => void;
  /** Receives the canonical `browse.data.path`, never the requested alias. */
  onSelectAction: (path: string) => void;
}

/**
 * Server-side project folder chooser.
 *
 * Reads exclusively through the typed cwd roots/browse queries. Single-click
 * navigation, Up + breadcrumbs, and root switching all issue a new browse
 * request keyed by path; a late response for a previous path cannot render in
 * the current listing. Confirm is disabled until the current path settled and
 * always submits the canonical path returned by the Host.
 */
export function ProjectFolderDialog({
  initialPath = null,
  onCancelAction,
  onSelectAction,
}: ProjectFolderDialogProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const http = useHttpClient();
  const options = useMemo(() => createQueryOptions(http), [http]);
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const rootsQuery = useQuery(options.cwd.roots());
  const roots = rootsQuery.data?.roots ?? EMPTY_ROOTS;
  const startPath = resolveStartFolder(roots, rootsQuery.data?.defaultCwd, initialPath);
  const browsePath = selectedPath ?? startPath;
  const browseQuery = useQuery({
    ...options.cwd.browse(browsePath),
    enabled: rootsQuery.isSuccess && Boolean(browsePath),
  });

  const canonicalPath = browseQuery.data?.path;
  const displayPath = canonicalPath ?? browsePath ?? "";
  const activeRoot = useMemo(() => {
    for (const candidate of [canonicalPath, browsePath]) {
      if (!candidate) continue;
      const match = roots.find((root) => isWithinRoot(candidate, root));
      if (match) return match;
    }
    return roots[0];
  }, [browsePath, canonicalPath, roots]);
  const crumbs = useMemo(() => {
    const fromRoot = activeRoot && displayPath
      ? breadcrumbs(displayPath, activeRoot)
      : [];
    if (fromRoot.length > 0) return fromRoot;
    return displayPath ? [{ label: baseName(displayPath), path: displayPath }] : [];
  }, [activeRoot, displayPath]);
  // Up is clamped to the selected authorized root, never the raw parent of an
  // alias/canonical mismatch.
  const upPath = activeRoot
    ? parentWithinRoot(displayPath, activeRoot)
    : browseQuery.data?.parentPath ?? null;
  // A directory name the path helper rejects (separator/traversal) is never
  // synthesized into a navigation target: fail closed and hide that row.
  const directoryEntries = canonicalPath
    ? (browseQuery.data?.directories ?? []).flatMap((name) => {
      try {
        return [{ name, path: joinChild(canonicalPath, name) }];
      } catch {
        return [];
      }
    })
    : [];

  // Focus trap + restore: the dialog owns the Tab loop while open and returns
  // focus to the trigger on close (when that trigger still exists).
  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    panelRef.current?.focus();
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      previousFocusRef.current = null;
    };
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancelAction();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (!panel.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onCancelAction]);

  const navigateTo = (path: string) => setSelectedPath(path);

  const rootsLoading = rootsQuery.isPending;
  const browseLoading = browseQuery.isPending;
  const confirmDisabled = canonicalPath === undefined
    || rootsQuery.isPending
    || rootsQuery.isError
    || rootsQuery.isFetching
    || browseQuery.isPending
    || browseQuery.isError
    || browseQuery.isFetching;
  const rowHeight = isMobile ? 44 : 34;
  const controlStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: rowHeight,
    padding: isMobile ? "0 12px" : "0 9px",
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "transparent",
    color: "var(--text-muted)",
    fontSize: 12,
    cursor: "pointer",
  };

  let body: ReactNode;
  if (rootsLoading) {
    body = <StatusLine>{t("desktop.folderBrowserLoading")}</StatusLine>;
  } else if (rootsQuery.isError) {
    body = (
      <ErrorPanel
        message={describeFolderBrowserError(rootsQuery.error, t)}
        retryLabel={t("desktop.folderBrowserRetry")}
        rowHeight={rowHeight}
        onRetry={() => { void rootsQuery.refetch(); }}
      />
    );
  } else if (roots.length === 0) {
    body = <StatusLine>{t("desktop.folderBrowserNoRoots")}</StatusLine>;
  } else if (browseLoading) {
    body = <StatusLine>{t("desktop.folderBrowserLoading")}</StatusLine>;
  } else if (browseQuery.isError) {
    body = (
      <ErrorPanel
        message={describeFolderBrowserError(browseQuery.error, t)}
        retryLabel={t("desktop.folderBrowserRetry")}
        rowHeight={rowHeight}
        onRetry={() => { void browseQuery.refetch(); }}
      />
    );
  } else if (directoryEntries.length === 0) {
    body = <StatusLine>{t("desktop.folderBrowserEmpty")}</StatusLine>;
  } else {
    body = (
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {directoryEntries.map((entry) => {
          return (
            <li key={entry.name}>
              <button
                type="button"
                data-testid="folder-browser-directory"
                title={entry.path}
                onClick={() => navigateTo(entry.path)}
                style={{
                  width: "100%",
                  minHeight: rowHeight,
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: isMobile ? "0 12px" : "0 10px",
                  border: "1px solid transparent",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--text)",
                  fontSize: 13,
                  textAlign: "left",
                  cursor: "pointer",
                }}
                onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
              >
                <FolderIcon size={15} weight="duotone" color="var(--accent)" aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.name}
                </span>
                <CaretRightIcon size={11} color="var(--text-dim)" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        padding: isMobile
          ? "max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left))"
          : 16,
        background: "rgba(0, 0, 0, 0.42)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancelAction();
      }}
      onKeyDown={handleKeyDown}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          width: isMobile ? "100%" : 560,
          maxWidth: "100%",
          ...(isMobile ? { height: "100%" } : {}),
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--surface-hairline)",
          borderRadius: 12,
          background: "var(--surface-content)",
          boxShadow: "0 16px 48px rgba(0, 0, 0, 0.28)",
          outline: "none",
        }}
      >
        <header style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: isMobile ? "14px 14px 10px" : "16px 18px 12px", borderBottom: "1px solid var(--surface-hairline)" }}>
          <FolderIcon size={20} weight="duotone" color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 15, fontWeight: 650, color: "var(--text)" }}>
              {t("desktop.browseFolders")}
            </h2>
            {displayPath ? (
              <p style={{ margin: "4px 0 0", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                {displayPath}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t("desktop.close")}
            title={t("desktop.close")}
            onClick={onCancelAction}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: isMobile ? 44 : 30,
              height: isMobile ? 44 : 30,
              padding: 0,
              border: "1px solid transparent",
              borderRadius: 7,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            <XIcon size={14} aria-hidden="true" />
          </button>
        </header>

        {rootsQuery.isSuccess && roots.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: isMobile ? "10px 14px" : "10px 18px", borderBottom: "1px solid var(--surface-hairline)" }} role="group" aria-label={t("desktop.folderBrowserRoots")}>
            {roots.map((root) => {
              const active = root === activeRoot;
              return (
                <button
                  key={root}
                  type="button"
                  data-testid="folder-browser-root"
                  aria-pressed={active}
                  title={root}
                  onClick={() => navigateTo(root)}
                  style={{
                    ...controlStyle,
                    maxWidth: "100%",
                    background: active ? "var(--bg-hover)" : "transparent",
                    borderColor: active ? "var(--accent)" : "var(--border)",
                    color: active ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  <FolderIcon size={13} weight={active ? "fill" : "regular"} aria-hidden="true" />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{baseName(root)}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {rootsQuery.isSuccess && roots.length > 0 ? (
          <nav aria-label={t("desktop.folderBrowserPath")} style={{ display: "flex", alignItems: "center", gap: 2, padding: isMobile ? "8px 14px" : "8px 18px", borderBottom: "1px solid var(--surface-hairline)", overflowX: "auto" }}>
            <button
              type="button"
              aria-label={t("desktop.folderBrowserUp")}
              title={t("desktop.folderBrowserUp")}
              disabled={upPath === null}
              onClick={() => { if (upPath !== null) navigateTo(upPath); }}
              style={{
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: isMobile ? 44 : 30,
                height: isMobile ? 44 : 30,
                padding: 0,
                border: "1px solid var(--border)",
                borderRadius: 7,
                background: "transparent",
                color: upPath === null ? "var(--text-dim)" : "var(--text-muted)",
                opacity: upPath === null ? 0.5 : 1,
                cursor: upPath === null ? "default" : "pointer",
              }}
            >
              <ArrowUpIcon size={13} aria-hidden="true" />
            </button>
            {crumbs.map((crumb, index) => (
              <Fragment key={`${crumb.path}:${index}`}>
                {index > 0 ? <CaretRightIcon size={9} color="var(--text-dim)" style={{ flexShrink: 0 }} aria-hidden="true" /> : null}
                <button
                  type="button"
                  data-testid="folder-browser-crumb"
                  aria-current={index === crumbs.length - 1 ? "location" : undefined}
                  title={crumb.path}
                  onClick={() => navigateTo(crumb.path)}
                  style={{
                    flexShrink: 0,
                    minHeight: isMobile ? 44 : 28,
                    padding: "0 5px",
                    border: "none",
                    borderRadius: 5,
                    background: "transparent",
                    color: index === crumbs.length - 1 ? "var(--text)" : "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
          </nav>
        ) : null}

        <div
          aria-busy={browseQuery.isFetching || rootsQuery.isFetching}
          aria-live="polite"
          style={{
            flex: 1,
            minHeight: 180,
            overflowY: "auto",
            padding: isMobile ? "8px 10px 12px" : "10px 12px 14px",
            background: "var(--bg)",
          }}
        >
          {body}
        </div>

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: isMobile ? "10px 14px" : "10px 18px", borderTop: "1px solid var(--surface-hairline)" }}>
          <button
            type="button"
            onClick={onCancelAction}
            style={{
              ...controlStyle,
              borderColor: "var(--border)",
              color: "var(--text-muted)",
            }}
          >
            {t("desktop.cancel")}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={() => { if (canonicalPath !== undefined) onSelectAction(canonicalPath); }}
            style={{
              ...controlStyle,
              borderColor: confirmDisabled ? "var(--border)" : "var(--accent)",
              background: confirmDisabled ? "var(--bg-subtle)" : "var(--accent)",
              color: confirmDisabled ? "var(--text-dim)" : "white",
              cursor: confirmDisabled ? "default" : "pointer",
              fontWeight: 600,
            }}
          >
            {t("desktop.selectFolder")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return (
    <div role="status" style={{ minHeight: 160, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>
      {children}
    </div>
  );
}

function ErrorPanel({
  message,
  retryLabel,
  rowHeight,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  rowHeight: number;
  onRetry: () => void;
}) {
  return (
    <div style={{ minHeight: 160, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 16, textAlign: "center" }}>
      <p role="alert" style={{ margin: 0, color: "var(--status-danger)", fontSize: 12, lineHeight: 1.6 }}>
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minHeight: Math.max(32, rowHeight),
          padding: "0 10px",
          border: "1px solid var(--border)",
          borderRadius: 7,
          background: "transparent",
          color: "var(--text-muted)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <ArrowClockwiseIcon size={13} aria-hidden="true" />
        {retryLabel}
      </button>
    </div>
  );
}
