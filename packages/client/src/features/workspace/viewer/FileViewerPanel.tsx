import { useCallback, forwardRef, useImperativeHandle, useRef, useState } from "react";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import { getFileName } from "@/lib/file-paths";
import type { FileViewerState } from "./file-viewer-state";

/**
 * File viewer panel — the source AppShell's right-panel file workspace
 * (TabBar + FileViewer + tab state machine) as a self-contained component.
 *
 * Tab semantics are the source's, ported verbatim: `openFileTab` /
 * `saveFileViewerState` keep per-tab viewer state (mode, wrap, scroll) with
 * revision guards, and the active viewer is keyed by
 * `${tab.id}:${viewerRevision}` so a re-opened tab remounts cleanly.
 * AppShell integration opens files through the imperative handle.
 */

export interface FileViewerPanelProps {
  /** Workspace cwd — relative-path display and git diff scoping. */
  cwd?: string;
  /** Insert a file's relative path into the chat input (@ mention). */
  onAtMention?: ((relativePath: string, isDir: boolean) => void) | undefined;
  /**
   * Override for opening files linked inside the viewer (markdown links).
   * Default: open another tab in this panel, carrying the active tab's
   * source session id.
   */
  onOpenLinkedFile?: ((filePath: string) => void) | undefined;
  /** Placeholder text override for the empty state (default "No file open"). */
  emptyLabel?: string | undefined;
}

export interface FileViewerPanelHandle {
  /** Open (or re-focus) a file tab. Mirrors the source AppShell handler. */
  openFile: (
    filePath: string,
    fileName?: string,
    sourceOrOptions?: string | null | { initialDisplayMode?: "diff" },
    options?: { initialDisplayMode?: "diff" },
  ) => void;
  /** Close every tab (e.g. when the workspace cwd changes owner). */
  closeAllTabs: () => void;
}

export const FileViewerPanel = forwardRef<FileViewerPanelHandle, FileViewerPanelProps>(
  function FileViewerPanel({ cwd, onAtMention, onOpenLinkedFile, emptyLabel = "No file open" }, ref) {
    const [fileTabs, setFileTabs] = useState<Tab[]>([]);
    const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
    const activeFileTabIdRef = useRef<string | null>(null);
    activeFileTabIdRef.current = activeFileTabId;

    const handleFileViewerStateChange = useCallback((
      tabId: string,
      viewerRevision: number,
      viewerState: FileViewerState,
    ) => {
      setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
    }, []);

    const handleOpenFile = useCallback((
      filePath: string,
      fileName?: string,
      sourceOrOptions?: string | null | { initialDisplayMode?: "diff" },
      options?: { initialDisplayMode?: "diff" },
    ) => {
      const sourceSessionId = typeof sourceOrOptions === "string" || sourceOrOptions === null ? sourceOrOptions : undefined;
      const openOptions = typeof sourceOrOptions === "object" && sourceOrOptions !== null ? sourceOrOptions : options;
      const tabId = `file:${filePath}`;
      setFileTabs((prev) => openFileTab(prev, {
        fileName: fileName ?? getFileName(filePath),
        filePath,
        modeHint: openOptions?.initialDisplayMode,
        sourceSessionId,
        tabId,
      }));
      setActiveFileTabId(tabId);
    }, []);

    const handleCloseFileTab = useCallback((tabId: string) => {
      setFileTabs((prev) => prev.filter((t) => t.id !== tabId));
      setActiveFileTabId((cur) => {
        if (cur !== tabId) return cur;
        const remaining = fileTabs.filter((t) => t.id !== tabId);
        return remaining.length > 0 ? remaining[remaining.length - 1]!.id : null;
      });
    }, [fileTabs]);

    useImperativeHandle(ref, () => ({
      openFile: (filePath, fileName, sourceOrOptions, options) => {
        handleOpenFile(filePath, fileName, sourceOrOptions, options);
      },
      closeAllTabs() {
        setFileTabs([]);
        setActiveFileTabId(null);
      },
    }), [handleOpenFile]);

    const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;

    const openLinkedFile = useCallback((filePath: string) => {
      if (onOpenLinkedFile) {
        onOpenLinkedFile(filePath);
        return;
      }
      const sourceSessionId = fileTabs.find((t) => t.id === activeFileTabIdRef.current)?.sourceSessionId ?? null;
      handleOpenFile(filePath, getFileName(filePath), sourceSessionId);
    }, [fileTabs, handleOpenFile, onOpenLinkedFile]);

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: "var(--bg)" }}>
        {/* Right panel tab bar */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={fileTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>
        </div>

        {/* File content */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          {activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={cwd}
              sourceSessionId={activeFileTab.sourceSessionId}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialState={activeFileTab.viewerState}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              {...(onAtMention === undefined ? {} : { onAtMention })}
              onOpenFile={openLinkedFile}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              {emptyLabel}
            </div>
          )}
        </div>
      </div>
    );
  },
);
