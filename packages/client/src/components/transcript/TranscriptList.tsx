import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { AgentMessage, ToolResultMessage } from "@fffattiger/pix-protocol";
import type { HostPathFlavor } from "@fffattiger/pix-protocol/host-bootstrap";
import { useVirtualList } from "@/lib/virtual-list";
import {
  buildChatTranscriptRows,
  estimateChatRowHeight,
  type ChatTranscriptRow,
} from "./chat-projection";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { foldsPathCase } from "@/lib/file-paths";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useRuntime } from "@/runtime";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSessionTranscript } from "@/features/session-history/use-session-transcript";
import { MessageView } from "@/components/chat/MessageView";
import { ProcessGroup } from "@/components/chat/ProcessGroup";
import { ChatMinimap, useMessageRefs } from "@/components/chat/ChatMinimap";
import {
  chatInputHandle,
  transcriptScrollRef,
  useChatOpenFile,
} from "@/components/chat/chat-experience-bridge";
import type { ChatFileIndexSnapshot, ChatSkillIndex, UserMessage } from "@/lib/chat-view-model";
import type { MentionValidators } from "@/lib/mention-tokens";

export interface TranscriptListProps {
  sessionId?: string;
  overscan?: number;
  /**
   * Explicit selection gate (history-switching fix). When `true` the SELECTED
   * session is the attached runtime, so rows come from the live SessionStore
   * projection. When `false` rows come from session history even if some OTHER
   * session happens to be attached (never show a non-selected live stream). When
   * omitted the legacy behavior applies: live whenever the runtime is attached.
   */
  live?: boolean;
}

/** Combine the virtualizer measurement ref with the minimap message ref. */
function combineRefs(
  measure: (el: Element | null) => void | (() => void),
  assignMessageRef: ((el: HTMLDivElement | null) => void) | undefined,
): (el: HTMLDivElement | null) => void {
  return (el) => {
    void measure(el);
    assignMessageRef?.(el);
  };
}

export function TranscriptList({ sessionId, overscan = 8, live: liveProp }: TranscriptListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Row that currently owns DOM focus (kept mounted so focus follows content).
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const http = useHttpClient();
  const { isReadonly, canBrowseSessions, can, pathFlavor } = useCapabilities();
  const foldPathCase = foldsPathCase(pathFlavor);
  const runtime = useRuntime();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const onOpenFile = useChatOpenFile();

  // Publish the scroll element so the composer's floating menus can cap their
  // height at the transcript's top edge (source messagesScrollRef wiring).
  useEffect(() => {
    transcriptScrollRef.current = parentRef.current;
    return () => {
      if (transcriptScrollRef.current === parentRef.current) transcriptScrollRef.current = null;
    };
  }, []);

  // The live projection is shown ONLY when the caller explicitly gates it (the
  // selected session IS the attached runtime). Without the prop, fall back to
  // the legacy behavior (live whenever attached) so standalone mounts keep
  // working. A non-selected attached session never contributes rows here.
  const isLive = (liveProp ?? runtime.attached) === true;
  // Protocol v2: persisted history comes from the cursor-paginated context
  // endpoint; committed live entries come from the SessionStore history layer.
  // The single shared hook merges both by persisted entryId.
  const transcript = useSessionTranscript({
    sessionId: sessionId ?? null,
    enabled: Boolean(sessionId) && canBrowseSessions,
    live: isLive,
  });

  const snapshot = isLive ? runtime.snapshot : null;
  const liveState = snapshot?.state;
  const running = isLive && (liveState?.isStreaming === true || liveState?.isPromptRunning === true);

  // Fail-closed: while the sessions capability is retracted the transcript
  // never derives rows from cached history (stale) and never trusts a
  // late-arriving response after revocation. The empty-state JSX renders the
  // honest "history unavailable" message.
  const messages = useMemo<readonly AgentMessage[]>(
    () => transcript.entries.map((entry) => entry.message),
    [transcript.entries],
  );
  const entryIds = useMemo<readonly string[]>(() => transcript.entryIds, [transcript.entryIds]);

  const streamingPartial = isLive ? runtime.streamingPartial : null;
  const streamingMessage = (streamingPartial ?? null) as AgentMessage | null;
  const cwd = isLive ? snapshot?.cwd : undefined;
  const effectiveSessionId = isLive ? runtime.sessionId : sessionId;

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") map.set(msg.toolCallId, msg);
    }
    return map;
  }, [messages]);

  // Mention validity (live sessions with a real cwd): the @file highlight in
  // rendered user messages uses the same project index the composer uses.
  const canFilesIndex = can("files");
  const canSkills = can("skills");
  const filesIndexQuery = useQuery({
    ...createQueryOptions(http).files.index(cwd ?? ""),
    enabled: isLive && Boolean(cwd) && canFilesIndex,
  });
  const skillsQuery = useQuery({
    ...createQueryOptions(http).skills.list(cwd ?? ""),
    enabled: isLive && Boolean(cwd) && canSkills,
  });

  const fileIndexSnapshot = useMemo<ChatFileIndexSnapshot | null>(() => {
    const data = filesIndexQuery.data;
    if (!data || !cwd || !("files" in data)) return null;
    const paths = new Set<string>();
    const dirs = new Set<string>();
    for (const file of data.files) {
      const key = foldPathCase ? file.toLowerCase() : file;
      paths.add(key);
      const slash = key.lastIndexOf("/");
      if (slash > 0) dirs.add(key.slice(0, slash));
    }
    return { cwd, paths, dirs, truncated: data.truncated };
  }, [filesIndexQuery.data, cwd, foldPathCase]);

  const skillNames = useMemo<Set<string> | null>(() => {
    const data = skillsQuery.data;
    return data ? new Set(data.skills.map((skill) => skill.name)) : null;
  }, [skillsQuery.data]);

  const mentionValidators = useMemo<MentionValidators | undefined>(() => {
    if (!fileIndexSnapshot && !skillNames) return undefined;
    return {
      ...(fileIndexSnapshot
        ? {
            fileExists: (path: string) => {
              const key = foldPathCase ? path.toLowerCase() : path;
              return fileIndexSnapshot.paths.has(key) || fileIndexSnapshot.dirs.has(key);
            },
          }
        : {}),
      ...(skillNames ? { isSkill: (name: string) => skillNames.has(name) } : {}),
    };
  }, [fileIndexSnapshot, skillNames, foldPathCase]);

  const skillInfo = useMemo<ChatSkillIndex | null>(() => {
    const data = skillsQuery.data;
    if (!data) return null;
    const map: ChatSkillIndex = new Map();
    for (const skill of data.skills) {
      map.set(skill.name, skill.description === undefined ? {} : { description: skill.description });
    }
    return map;
  }, [skillsQuery.data]);

  const handleEditContent = useMemo(() => {
    return (message: UserMessage) => {
      chatInputHandle.current?.replaceMessage(message);
    };
  }, []);

  // Source render-loop projection → virtualizer rows.
  const chatRows = useMemo(
    () =>
      buildChatTranscriptRows({
        messages,
        entryIds,
        streamingMessage,
        running,
        ...(cwd === undefined ? {} : { cwd }),
        pathFlavor,
      }),
    [messages, entryIds, streamingMessage, running, cwd, pathFlavor],
  );

  // Live in-flight bash projection (source pendingBash row) — only while the
  // runtime reports bash running, so the completed bashExecution message that
  // lands in `messages` never duplicates it.
  const liveBash = isLive ? liveState?.bash : undefined;
  const bashRunning = isLive && liveState?.isBashRunning === true;

  // Terminal status line for compaction / in-flight bash without a live row.
  const statusLabel = liveState?.isCompacting === true
    ? t("desktop.compacting")
    : bashRunning && !liveBash
      ? t("desktop.runningShellCommand")
      : null;

  const rows = useMemo<ChatTranscriptRow[]>(() => {
    const next: ChatTranscriptRow[] = [];
    if (!isLive && isReadonly) {
      next.push({
        kind: "message",
        key: "row:system:readonly",
        message: {
          role: "custom",
          customType: "readonlyNotice",
          content: "Read-only mode — host has no agent capability. Browsing history only.",
          display: true,
        },
      });
    }
    next.push(...chatRows);
    if (liveBash && bashRunning) {
      next.push({
        kind: "message",
        key: "row:live:bash",
        message: {
          role: "bashExecution",
          command: liveBash.command,
          output: liveBash.output,
          excludeFromContext: liveBash.excludeFromContext,
        },
      });
    }
    if (statusLabel !== null) {
      next.push({
        kind: "message",
        key: "row:live:status",
        message: { role: "custom", customType: "statusNotice", content: statusLabel, display: true },
      });
    }
    return next;
  }, [isLive, isReadonly, chatRows, liveBash, bashRunning, statusLabel]);

  // Minimap refs: one slot per user/assistant message (null when virtualized
  // out of the window — the source minimap skips missing elements).
  const visibleMessageCount = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant").length,
    [messages],
  );
  const messageRefs = useMessageRefs(visibleMessageCount);

  const virtualizer = useVirtualList({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateChatRowHeight(rows[index]!),
    overscan,
    getItemKey: (index) => rows[index]!.key,
    // A row that currently owns DOM focus must stay mounted so focus never
    // drops to <body> when scrolling moves it off-viewport (focus follows
    // content, not the viewport).
    pinnedKeys: focusedRowId === null ? [] : [focusedRowId],
    // Streaming chat: auto-scroll to bottom while the user is pinned at the
    // bottom; scrolling up releases the pin (scroll-position preservation).
    // Re-pin whenever the session or live/history mode changes. Prepending
    // older pages never jumps to bottom (the user is above the bottom then).
    stickToBottom: true,
    stickToBottomKey: `${effectiveSessionId ?? ""}:${isLive ? "live" : "history"}`,
  });

  // Protocol v2 upward loading: a top sentinel observes the scroll container.
  // Reaching the top shows a hint (up arrow) instead of auto-refreshing;
  // clicking it — or scrolling up again past the top — loads the older page.
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadOlderHint, setLoadOlderHint] = useState(false);
  // ScrollHeight of the scroll container captured BEFORE an older page prepends;
  // used to preserve the visual anchor (scroll-height delta fallback).
  const prependHeightRef = useRef<number | null>(null);
  const loadOlderRef = useRef(transcript.loadOlder);
  loadOlderRef.current = transcript.loadOlder;
  const hasOlderRef = useRef(transcript.hasOlder);
  hasOlderRef.current = transcript.hasOlder;
  const fetchingOlderRef = useRef(transcript.isFetchingOlder);
  fetchingOlderRef.current = transcript.isFetchingOlder;
  const loadOlderNow = useCallback(() => {
    if (!hasOlderRef.current || fetchingOlderRef.current) return;
    prependHeightRef.current = parentRef.current?.scrollHeight ?? null;
    setLoadOlderHint(false);
    loadOlderRef.current();
  }, []);

  useEffect(() => {
    const root = parentRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        // At the top: surface the load-older hint (no auto-fetch). The user
        // clicks it or scrolls up again to fetch the previous page.
        if (entries[0]?.isIntersecting === true) {
          if (hasOlderRef.current && !fetchingOlderRef.current) setLoadOlderHint(true);
        } else {
          setLoadOlderHint(false);
        }
      },
      { root, rootMargin: "0px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Scroll-up again while at the top also loads the older page. A continuous
  // wheel gesture fires many scroll events while scrollTop is pinned at 0, so
  // the load is DEBOUNCED: the first contact only surfaces the hint, and a
  // load fires only after the scroll has been idle for a beat and then moved
  // up again (or the user clicks the hint). Otherwise the first scroll-up would
  // keep loading and the arrow would never be visible.
  useEffect(() => {
    const root = parentRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    let hintVisible = false;
    let atTop = false;
    let firstContactAt = 0;
    const SCROLL_IDLE_MS = 350;
    const onScroll = () => {
      const nowAtTop = root.scrollTop <= 2;
      if (!nowAtTop) {
        atTop = false;
        firstContactAt = 0;
        return;
      }
      if (!atTop) {
        // First contact with the top: only surface the hint, never load yet.
        atTop = true;
        firstContactAt = Date.now();
        return;
      }
      if (!hintVisible) return;
      // Same continuous gesture (still within the idle window): keep waiting,
      // the arrow stays visible. A fresh upward move after an idle pause loads.
      if (Date.now() - firstContactAt < SCROLL_IDLE_MS) return;
      if (hasOlderRef.current && !fetchingOlderRef.current) {
        firstContactAt = Date.now();
        loadOlderNow();
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        hintVisible = entries[0]?.isIntersecting === true;
      },
      { root, rootMargin: "0px 0px 0px 0px", threshold: 0 },
    );
    const sentinel = topSentinelRef.current;
    if (sentinel) observer.observe(sentinel);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", onScroll);
    };
  }, [loadOlderNow]);

  // Preserve the visual anchor across an older-page prepend: the scroll-height
  // delta (the content above the viewport grew by exactly the prepended height).
  const previousRowCountRef = useRef(rows.length);
  useLayoutEffect(() => {
    const el = parentRef.current;
    const previous = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (!el || prependHeightRef.current === null) return;
    if (rows.length > previous) {
      const delta = el.scrollHeight - prependHeightRef.current;
      prependHeightRef.current = null;
      if (delta > 0) el.scrollTop += delta;
    }
  }, [rows.length]);

  const isHomeEmpty = !sessionId && !isLive && rows.length === 0 && !transcript.error && !transcript.isFetchingInitial;
  return (
    <div
      className="transcript-region"
      style={{ position: "relative", display: "flex", flex: isHomeEmpty ? "0 0 auto" : "1 1 auto", minHeight: 0, minWidth: 0 }}
    >
      {isMobile ? null : (
        <ChatMinimap
          messages={messages as AgentMessage[]}
          streamingMessage={streamingPartial as Partial<AgentMessage> | null}
          scrollContainer={parentRef}
          messageRefs={messageRefs}
        />
      )}
      <div
        ref={parentRef}
        className="transcript-scroll chat-scroll-container"
        role="log"
        aria-label="Conversation transcript"
        aria-relevant="additions"
        style={{ scrollbarWidth: "none" }}
        onFocus={(event) => {
          const row = (event.target as HTMLElement).closest("[data-row-id]");
          setFocusedRowId(row ? row.getAttribute("data-row-id") : null);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget as HTMLElement | null;
          if (!next || !next.closest("[data-row-id]")) setFocusedRowId(null);
        }}
      >
        <div ref={topSentinelRef} data-upward-load-sentinel style={{ height: 1 }} />
        {loadOlderHint && transcript.hasOlder ? (
          <div
            className="transcript-load-older-hint"
            data-testid="load-older-hint"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "8px 0 2px",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            <button
              type="button"
              onClick={loadOlderNow}
              title={t("desktop.loadOlderMessages")}
              aria-label={t("desktop.loadOlderMessages")}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 10px", border: "1px solid var(--border)",
                borderRadius: 999, background: "var(--bg-panel)",
                color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
              }}
            >
              <ArrowUp size={14} weight="bold" aria-hidden="true" />
              {t("desktop.loadOlderMessages")}
            </button>
          </div>
        ) : null}
        <div
          className="transcript-inner"
          style={virtualizer.windowed ? { height: virtualizer.totalSize } : undefined}
        >
          {virtualizer.items.map((item) => {
            const row = rows[item.index]!;
            const assignMessageRef =
              row.visibleIndex === undefined
                ? undefined
                : (el: HTMLDivElement | null) => {
                    messageRefs.current[row.visibleIndex!] = el;
                  };
            return (
              <div
                key={item.key}
                data-index={item.index}
                data-row-id={row.key}
                ref={combineRefs(virtualizer.measureElement, assignMessageRef)}
                className="transcript-row transcript-row--chat"
                style={
                  virtualizer.windowed
                    ? {
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${item.start}px)`,
                      }
                    : undefined
                }
              >
                <ChatTranscriptRowView
                  row={row}
                  cwd={cwd}
                  pathFlavor={pathFlavor}
                  sessionId={effectiveSessionId ?? undefined}
                  toolResults={toolResults}
                  onOpenFile={onOpenFile}
                  onEditContent={handleEditContent}
                  mentionValidators={mentionValidators}
                  skillInfo={skillInfo}
                />
              </div>
            );
          })}
        </div>
        {isLive ? null : !canBrowseSessions ? (
          // UI-first: while the capability is being restored (weak link /
          // sessiond warming up) show a calm loading placeholder — never a
          // scary "unavailable" banner. Reconnect is silent in the background.
          <div className="transcript-empty" aria-busy="true"><span className="transcript-loading-dot" aria-hidden="true" />{t("desktop.loadingSession")}</div>
        ) : transcript.error && sessionId ? (
          // A REAL history-load error: distinct from loading (never
          // error-as-spinner) and i18n'd.
          <div className="transcript-empty" role="alert">{t("desktop.historyLoadError")}</div>
        ) : transcript.isFetchingInitial && sessionId ? (
          <div className="transcript-empty" aria-busy="true"><span className="transcript-loading-dot" aria-hidden="true" />{t("desktop.loadingSession")}</div>
        ) : rows.length === 0 ? (
          sessionId ? (
            <div className="transcript-empty">{t("desktop.noMessages")}</div>
          ) : (
            <div className="transcript-home" data-testid="transcript-home">
              <div className="transcript-home-logo" aria-hidden="true" />
              <h1 className="transcript-home-title">{t("desktop.startConversation")}</h1>
              <p className="transcript-home-copy">{t("desktop.startConversationHint")}</p>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

function ChatTranscriptRowView({
  row,
  cwd,
  pathFlavor,
  sessionId,
  toolResults,
  onOpenFile,
  onEditContent,
  mentionValidators,
  skillInfo,
}: {
  row: ChatTranscriptRow;
  cwd: string | undefined;
  pathFlavor: HostPathFlavor;
  sessionId: string | undefined;
  toolResults: Map<string, ToolResultMessage>;
  onOpenFile: ((filePath: string, options?: { initialDisplayMode?: "diff" }) => void) | undefined;
  onEditContent: (message: UserMessage) => void;
  mentionValidators: MentionValidators | undefined;
  skillInfo: ChatSkillIndex | null;
}): ReactNode {
  if (row.kind === "process") {
    return (
      <ProcessGroup
        blocks={row.blocks}
        isStreaming={row.isStreaming}
        {...(cwd === undefined ? {} : { cwd })}
        pathFlavor={pathFlavor}
        {...(onOpenFile === undefined ? {} : { onOpenFile })}
        {...(sessionId === undefined ? {} : { sessionId })}
      />
    );
  }
  // Source-dom notice rows (readonly banner / live phase pulse) keep the exact
  // styling of the source in-list status lines.
  if (row.message.role === "custom" && (row.message.customType === "readonlyNotice" || row.message.customType === "statusNotice")) {
    const content = typeof row.message.content === "string" ? row.message.content : "";
    return (
      <div className="py-2 text-[13px] text-text-muted" style={{ padding: "8px 0", fontSize: 13, color: "var(--text-muted)" }}>
        <span className="animate-[pulse_1.5s_infinite]">{content}</span>
      </div>
    );
  }
  return (
    <MessageView
      message={row.message}
      {...(row.isStreaming === undefined ? {} : { isStreaming: row.isStreaming })}
      toolResults={toolResults}
      {...(cwd === undefined ? {} : { cwd })}
      pathFlavor={pathFlavor}
      {...(onOpenFile === undefined ? {} : { onOpenFile })}
      {...(row.entryId === undefined ? {} : { entryId: row.entryId })}
      {...(row.prevAssistantEntryId === undefined ? {} : { prevAssistantEntryId: row.prevAssistantEntryId })}
      onEditContent={onEditContent}
      {...(row.showTimestamp === undefined ? {} : { showTimestamp: row.showTimestamp })}
      {...(row.prevTimestamp === undefined ? {} : { prevTimestamp: row.prevTimestamp })}
      {...(sessionId === undefined ? {} : { sessionId })}
      {...(row.writtenFiles === undefined ? {} : { writtenFiles: row.writtenFiles })}
      {...(mentionValidators === undefined ? {} : { mentionValidators })}
      skillInfo={skillInfo}
    />
  );
}
