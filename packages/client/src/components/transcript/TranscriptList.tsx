import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { ArticleIcon } from "@phosphor-icons/react/Article";
import { useQuery } from "@tanstack/react-query";
import type { AgentMessage, ToolResultMessage } from "@fffattiger/pix-protocol";
import { useVirtualList } from "@/lib/virtual-list";
import { createDeferredThinkingLoader } from "@/api/session-history";
import {
  buildChatTranscriptRows,
  estimateChatRowHeight,
  type ChatTranscriptRow,
} from "./chat-projection";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
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
import type {
  ChatFileIndexSnapshot,
  ChatSkillIndex,
  DeferredThinkingLoader,
  UserMessage,
} from "@/lib/chat-view-model";
import type { MentionValidators } from "@/lib/mention-tokens";

/**
 * Local older-row reveal window (server paging removed). The complete branch
 * arrives in ONE deferred history response; rendering still opens bounded:
 * initially only the final INITIAL_TRANSCRIPT_ROWS rendered rows mount, and
 * reaching the top reveals TRANSCRIPT_REVEAL_ROWS more LOCALLY (no second
 * request ever fires).
 */
export const INITIAL_TRANSCRIPT_ROWS = 50;
/** Rows revealed per local upward load. */
export const TRANSCRIPT_REVEAL_ROWS = 50;

export interface TranscriptListProps {
  sessionId?: string;
  overscan?: number;
  /**
   * Explicit selection gate (history-switching fix). When `true` the SELECTED
   * session is the attached runtime, so rows come from the exact live runtime
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

const JUMP_TO_BOTTOM_THRESHOLD_PX = 160;

export function TranscriptList({ sessionId, overscan = 8, live: liveProp }: TranscriptListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Row that currently owns DOM focus (kept mounted so focus follows content).
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const http = useHttpClient();
  const { isReadonly, canBrowseSessions, can } = useCapabilities();
  // Exact per-session runtime (4A.3.2b1a): TranscriptList already receives a
  // sessionId prop, so it binds useRuntime(sessionId) directly (null when no
  // selection — home). exact.attached is PER-SESSION, which internally
  // eliminates the old facade-current mismatch where the GLOBAL attached flag
  // of a different session could gate this list live.
  const exact = useRuntime(sessionId ?? null);
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
  // the exact per-session attached state (legacy "live whenever the runtime is
  // attached" becomes "live whenever THIS session is attached" — the facade
  // could wrongly report another session's attachment here). A non-selected
  // attached session never contributes rows.
  const isLive = (liveProp ?? exact?.attached ?? false) === true;
  // Protocol v2: persisted history arrives as ONE complete deferred context
  // response; committed live entries come from the exact controller history
  // layer. The single shared hook merges both by persisted entryId.
  const transcript = useSessionTranscript({
    sessionId: sessionId ?? null,
    enabled: Boolean(sessionId) && canBrowseSessions,
    live: isLive,
  });

  const snapshot = isLive ? (exact?.snapshot ?? null) : null;
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

  const streamingPartial = isLive ? (exact?.partial ?? null) : null;
  // Authoritative live-tail phase: proves the turn is mid-flight during
  // segment-flush gaps where the partial is briefly absent (chat-projection
  // keys live/settled on it).
  const turnPhase = isLive ? (snapshot?.streaming?.phase ?? null) : null;
  const streamingMessage = (streamingPartial ?? null) as AgentMessage | null;
  const cwd = isLive ? snapshot?.cwd : undefined;
  const effectiveSessionId = isLive ? (exact?.sessionId ?? null) : sessionId;
  // Scroll-owner identity: the selected session + live/history mode ONLY.
  // History revisions (activation, turn-end leaf fence, refetch, branch
  // navigate) are NOT conversation switches — they must never re-own the
  // viewport. See the reveal-window/virtualizer wiring below.
  const sessionModeIdentity = `${effectiveSessionId ?? ""}:${isLive ? "live" : "history"}`;
  // Typed deferred-thinking loader (persisted history blocks marked
  // `deferred:true` by the deferred context response): transport assembly
  // lives in the api layer; MessageView/ProcessGroup own single-flight/LRU.
  const loadDeferredThinking = useMemo(() => createDeferredThinkingLoader(http), [http]);

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
      const lower = file.toLowerCase();
      paths.add(lower);
      const slash = lower.lastIndexOf("/");
      if (slash > 0) dirs.add(lower.slice(0, slash));
    }
    return { cwd, paths, dirs, truncated: data.truncated };
  }, [filesIndexQuery.data, cwd]);

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
              const key = path.toLowerCase();
              return fileIndexSnapshot.paths.has(key) || fileIndexSnapshot.dirs.has(key);
            },
          }
        : {}),
      ...(skillNames ? { isSkill: (name: string) => skillNames.has(name) } : {}),
    };
  }, [fileIndexSnapshot, skillNames]);

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
        turnPhase,
        ...(cwd === undefined ? {} : { cwd }),
      }),
    [messages, entryIds, streamingMessage, running, turnPhase, cwd],
  );

  // ── Scroll-owner policy ────────────────────────────────────────────────
  // The transcript's DEFAULT view is the conversation bottom and the
  // virtualizer's stick-to-bottom owns the whole scroll lifecycle (pinned
  // while at the bottom, released on any upward scroll). The only events
  // allowed to MOVE the user are a session or live/history-mode switch
  // (`sessionModeIdentity`): both the sticky bottom re-pin and the local
  // reveal-window reset key on it. A history revision — activation, turn-end
  // leaf fence, refetch, branch navigate, an optimistic tail replaced by its
  // authoritative entry — is NOT a switch: the query keeps serving the same
  // session's snapshot, so nothing re-windows and nothing re-pins. Reading a
  // different branch therefore keeps the user's position; the return-to-bottom
  // affordance remains the explicit way down.
  const chatRowCount = chatRows.length;

  // ── Local older-row reveal window (server paging removed) ──────────────
  // The complete branch arrives in ONE deferred response; rendering still
  // opens bounded: initially only the FINAL INITIAL_TRANSCRIPT_ROWS rendered
  // rows mount, and reaching the top reveals TRANSCRIPT_REVEAL_ROWS more
  // locally. The window is a count of LEADING chat rows hidden from the top,
  // so appends at the tail never re-hide revealed history. It resets only on
  // the session/mode switch above.
  const [loadOlderHint, setLoadOlderHint] = useState(false);
  const [revealWindow, setRevealWindow] = useState<{ sessionMode: string; hiddenRows: number }>(() => ({
    sessionMode: sessionModeIdentity,
    hiddenRows: Number.POSITIVE_INFINITY,
  }));
  if (revealWindow.sessionMode !== sessionModeIdentity) {
    // Adjusting state during render (React's reset-on-change pattern): a new
    // conversation restarts from the final-rows tail window.
    setRevealWindow({ sessionMode: sessionModeIdentity, hiddenRows: Number.POSITIVE_INFINITY });
    setLoadOlderHint(false);
  }
  const windowMatchesSessionMode = revealWindow.sessionMode === sessionModeIdentity;
  const hiddenRowCount = !windowMatchesSessionMode || !Number.isFinite(revealWindow.hiddenRows)
    ? Math.max(0, chatRowCount - INITIAL_TRANSCRIPT_ROWS)
    // Safety clamp: a refetch/branch change can shrink the list below the
    // previously hidden count — never render an empty window.
    : Math.min(revealWindow.hiddenRows, Math.max(0, chatRowCount - 1));
  const visibleChatRows = hiddenRowCount > 0 ? chatRows.slice(hiddenRowCount) : chatRows;
  const hasOlderRows = hiddenRowCount > 0;

  // Live in-flight bash projection (source pendingBash row) — only while the
  // runtime reports bash running, so the completed bashExecution message that
  // lands in `messages` never duplicates it.
  const liveBash = isLive ? liveState?.bash : undefined;
  const bashRunning = isLive && liveState?.isBashRunning === true;

  // Terminal status line for compaction / in-flight bash without a live row.
  // The authoritative compaction projection distinguishes automatic work from
  // a manual command; never infer that distinction from surrounding text.
  const statusContent = liveState?.isCompacting === true
    ? liveState.compaction?.reason === "auto"
      ? t("desktop.autoCompactingContext")
      : t("desktop.manualCompactingContext")
    : bashRunning && !liveBash
      ? t("desktop.runningShellCommand")
      : null;
  const statusCustomType = liveState?.isCompacting === true ? "compactionStatusNotice" : "statusNotice";

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
    next.push(...visibleChatRows);
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
    if (statusContent !== null) {
      next.push({
        kind: "message",
        key: "row:live:status",
        message: { role: "custom", customType: statusCustomType, content: statusContent, display: true },
      });
    }
    return next;
  }, [isLive, isReadonly, visibleChatRows, liveBash, bashRunning, statusContent, statusCustomType]);

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
    // Bottom-first default view: the latest rows are what the user opens a
    // transcript to see. The sticky lifecycle is the single scroll owner —
    // growth keeps the bottom pinned while the user is at it, scrolling up
    // releases it, and only a session or live/history-mode switch
    // (sessionModeIdentity, shared with the reveal window above) re-pins.
    // History revisions never re-own the viewport. ProcessGroup keeps its own
    // INNER streaming follow (its capped scroller), which never touches this
    // element.
    stickToBottom: true,
    stickToBottomKey: sessionModeIdentity,
  });

  // Back-to-bottom affordance: visible whenever the viewport sits more than a
  // viewport-notch above the CONTENT bottom (the scroll element's own height —
  // no synthetic filler below the last row). Re-evaluated on scroll and on
  // layout changes so streaming output reveals it.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const evaluateJumpToBottom = useCallback((): void => {
    const root = parentRef.current;
    if (!root) return;
    setShowJumpToBottom(root.scrollHeight - root.scrollTop - root.clientHeight > JUMP_TO_BOTTOM_THRESHOLD_PX);
  }, []);
  // Re-evaluate on scroll directly (a scroll event may not change React
  // state — e.g. scrollTop stays 0 while content grows) and on layout changes.
  useEffect(() => {
    const root = parentRef.current;
    if (!root) return;
    const onScroll = (): void => evaluateJumpToBottom();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [evaluateJumpToBottom]);
  useLayoutEffect(() => {
    evaluateJumpToBottom();
  }, [evaluateJumpToBottom, virtualizer.scrollTop, virtualizer.totalSize, virtualizer.viewportSize]);

  // One click lands on the real content bottom and STAYS there: the
  // virtualizer re-pins its sticky state (so later row measurements / row
  // growth re-apply the bottom) instead of writing a one-off scrollTop that
  // the next measurement invalidates.
  const jumpToBottom = useCallback((): void => {
    virtualizer.scrollToBottom();
    evaluateJumpToBottom();
  }, [virtualizer, evaluateJumpToBottom]);

  // Upward loading is LOCAL: a top sentinel observes the scroll container.
  // Reaching the top shows a hint (up arrow) instead of auto-refreshing;
  // clicking it — or scrolling up again past the top — reveals
  // TRANSCRIPT_REVEAL_ROWS more already-fetched rows at the top. No request.
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  // ScrollHeight of the scroll container captured BEFORE older rows prepend;
  // used to preserve the visual anchor (scroll-height delta fallback).
  const prependHeightRef = useRef<number | null>(null);
  const hasOlderRowsRef = useRef(hasOlderRows);
  hasOlderRowsRef.current = hasOlderRows;
  const chatRowCountRef = useRef(chatRowCount);
  chatRowCountRef.current = chatRowCount;
  const revealOlderRows = useCallback(() => {
    if (!hasOlderRowsRef.current) return;
    prependHeightRef.current = parentRef.current?.scrollHeight ?? null;
    setLoadOlderHint(false);
    setRevealWindow((current) => {
      const hidden = Number.isFinite(current.hiddenRows)
        ? Math.min(current.hiddenRows, Math.max(0, chatRowCountRef.current - 1))
        : Math.max(0, chatRowCountRef.current - INITIAL_TRANSCRIPT_ROWS);
      return { ...current, hiddenRows: Math.max(0, hidden - TRANSCRIPT_REVEAL_ROWS) };
    });
  }, []);

  useEffect(() => {
    const root = parentRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        // At the top: surface the reveal-older hint (no auto-reveal). The user
        // clicks it or scrolls up again to reveal the previous rows.
        if (entries[0]?.isIntersecting === true) {
          if (hasOlderRowsRef.current) setLoadOlderHint(true);
        } else {
          setLoadOlderHint(false);
        }
      },
      { root, rootMargin: "0px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Scroll-up again while at the top also reveals the older rows. A continuous
  // wheel gesture fires many scroll events while scrollTop is pinned at 0, so
  // the reveal is DEBOUNCED: the first contact only surfaces the hint, and a
  // reveal fires only after the scroll has been idle for a beat and then moved
  // up again (or the user clicks the hint). Otherwise the first scroll-up would
  // keep revealing and the arrow would never be visible.
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
        // First contact with the top: only surface the hint, never reveal yet.
        atTop = true;
        firstContactAt = Date.now();
        return;
      }
      if (!hintVisible) return;
      // Same continuous gesture (still within the idle window): keep waiting,
      // the arrow stays visible. A fresh upward move after an idle pause reveals.
      if (Date.now() - firstContactAt < SCROLL_IDLE_MS) return;
      if (hasOlderRowsRef.current) {
        firstContactAt = Date.now();
        revealOlderRows();
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
  }, [revealOlderRows]);

  // Preserve the visual anchor across a local reveal prepend: the scroll-height
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
        {loadOlderHint && hasOlderRows ? (
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
              onClick={revealOlderRows}
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
                  sessionId={effectiveSessionId ?? undefined}
                  toolResults={toolResults}
                  onOpenFile={onOpenFile}
                  onEditContent={handleEditContent}
                  mentionValidators={mentionValidators}
                  skillInfo={skillInfo}
                  loadDeferredThinking={loadDeferredThinking}
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
        {showJumpToBottom ? (
          <button
            type="button"
            className="transcript-jump-bottom"
            data-testid="transcript-jump-bottom"
            onClick={jumpToBottom}
            title={t("desktop.scrollBottom")}
            aria-label={t("desktop.scrollBottom")}
          >
            <ArrowDown size={16} weight="regular" aria-hidden="true" />
          </button>
        ) : null}
    </div>
  );
}

function ChatTranscriptRowView({
  row,
  cwd,
  sessionId,
  toolResults,
  onOpenFile,
  onEditContent,
  mentionValidators,
  skillInfo,
  loadDeferredThinking,
}: {
  row: ChatTranscriptRow;
  cwd: string | undefined;
  sessionId: string | undefined;
  toolResults: Map<string, ToolResultMessage>;
  onOpenFile: ((filePath: string, options?: { initialDisplayMode?: "diff" }) => void) | undefined;
  onEditContent: (message: UserMessage) => void;
  mentionValidators: MentionValidators | undefined;
  skillInfo: ChatSkillIndex | null;
  /** Typed deferred-thinking loader (persisted history blocks only). */
  loadDeferredThinking: DeferredThinkingLoader;
}): ReactNode {
  if (row.kind === "process") {
    return (
      <ProcessGroup
        blocks={row.blocks}
        isStreaming={row.isStreaming}
        {...(row.startedAt === undefined ? {} : { startedAt: row.startedAt })}
        {...(row.completedAt === undefined ? {} : { completedAt: row.completedAt })}
        {...(row.isAnswerStreaming === undefined ? {} : { isAnswerStreaming: row.isAnswerStreaming })}
        {...(cwd === undefined ? {} : { cwd })}
        {...(onOpenFile === undefined ? {} : { onOpenFile })}
        {...(sessionId === undefined ? {} : { sessionId })}
        loadDeferredThinking={loadDeferredThinking}
      />
    );
  }
  // Source-dom notice rows (readonly banner / live phase pulse) keep the exact
  // styling of the source in-list status lines.
  if (row.message.role === "custom" && row.message.customType === "compactionStatusNotice") {
    const content = typeof row.message.content === "string" ? row.message.content : "";
    return (
      <div className="transcript-compaction-status" role="status" aria-live="polite">
        <ArticleIcon size={17} aria-hidden="true" />
        <span>{content}</span>
      </div>
    );
  }
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
      loadDeferredThinking={loadDeferredThinking}
    />
  );
}
