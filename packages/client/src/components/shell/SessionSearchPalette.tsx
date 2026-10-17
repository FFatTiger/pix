import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactActivity } from "@/lib/i18n/format";
import { projectDisplayName, sessionActivityMs, sessionRowTitle } from "@/lib/session-row";
import { RunningSessionIndicator, SessionStatusDot } from "@/components/SessionStatusDot";

/** Recent sessions shown before any input (the panel's empty-query landing). */
const RECENT_LIMIT = 8;
/** Server page size for keyword search (the ⌘K panel's result window). */
const SEARCH_PAGE_SIZE = 20;
/** Input debounce before a keyword request fires. */
const INPUT_DEBOUNCE_MS = 150;

export interface SessionSearchPaletteProps {
  open: boolean;
  onClose: () => void;
  /**
   * Open a session — the SAME navigation callback the sidebar rows use
   * (AppShell's single navigation owner). The panel closes after opening.
   */
  onOpenSession: (sessionId: string, cwd?: string) => void;
  /** Session ids currently running (same source as the sidebar rows). */
  runningSessionIds: ReadonlySet<string>;
  /** Session ids stopped on unanswered user input (same source as sidebar). */
  waitingSessionIds: ReadonlySet<string>;
}

/** Split `text` around the first case-insensitive occurrence of `needle`. */
function firstMatch(text: string, needle: string): number {
  return text.toLowerCase().indexOf(needle.toLowerCase());
}

/** Render `text` with the first `needle` occurrence in a bold span. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (query.length === 0) return <>{text}</>;
  const at = firstMatch(text, query);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong>{text.slice(at, at + query.length)}</strong>
      {text.slice(at + query.length)}
    </>
  );
}

/** Bounded snippet around the match: ~10 chars before, ~16 after. */
function snippet(text: string, query: string): { before: string; match: string; after: string } {
  const at = firstMatch(text, query);
  const needle = at < 0 ? "" : text.slice(at, at + query.length);
  const start = Math.max(0, at - 10);
  const end = Math.min(text.length, at + needle.length + 16);
  return {
    before: `${start > 0 ? "…" : ""}${text.slice(start, at)}`,
    match: needle,
    after: `${text.slice(at + needle.length, end)}${end < text.length ? "…" : ""}`,
  };
}

/**
 * ⌘K session search palette — the single session-search surface (the sidebar's
 * old inline filter is gone). Server-side keyword search over title / project
 * name / first message via the typed sessions page transport; recent sessions
 * before any input. Opening a row goes through the exact sidebar navigation
 * callback, then closes.
 */
export function SessionSearchPalette({
  open,
  onClose,
  onOpenSession,
  runningSessionIds,
  waitingSessionIds,
}: SessionSearchPaletteProps) {
  const { t, locale } = useI18n();
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const { canBrowseSessions } = useCapabilities();

  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const trimmedInput = input.trim();

  // Debounce the query; an empty/whitespace input settles immediately.
  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      setDebounced("");
      return;
    }
    const timer = window.setTimeout(() => setDebounced(trimmed), INPUT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  // No input → the recent landing page; input → server keyword search. Both
  // are the SAME typed page transport; keepPreviousData keeps the last result
  // on screen while a new keyword settles (no empty-flash mid-typing).
  const searching = debounced.length > 0;
  const pageQuery = useQuery({
    ...options.sessions.page(
      1,
      searching ? SEARCH_PAGE_SIZE : RECENT_LIMIT,
      {
        ...(searching ? { query: debounced } : {}),
        enabled: open && canBrowseSessions,
      },
    ),
    placeholderData: keepPreviousData,
  });

  // Recent rows may still carry the merged archived flag (the server excludes
  // archived only from keyword pages) — hide them like the sidebar does.
  const rows = useMemo(() => {
    const sessions = (pageQuery.data?.sessions ?? []).filter((session) => session.archived !== true);
    return sessions as Array<SessionHeader>;
  }, [pageQuery.data]);
  const total = pageQuery.data?.total;
  const extraResults = searching && total !== undefined
    ? Math.max(0, total - (pageQuery.data?.sessions.length ?? 0))
    : 0;

  // Selection resets when the result identity changes (new query / new page).
  useEffect(() => {
    setActive(0);
  }, [debounced, open]);

  // Focus the input on open; return focus to the previously focused element on
  // close (accessibility: the dialog never strands keyboard focus).
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) return;
    restoreFocusRef.current?.focus?.();
    restoreFocusRef.current = null;
  }, [open]);

  // Keep the active row visible while arrowing through the list.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  if (!open) return null;

  const move = (delta: number) => {
    if (rows.length === 0) return;
    setActive((current) => (current + delta + rows.length) % rows.length);
  };

  const openSession = (session: SessionHeader) => {
    onOpenSession(session.sessionId, session.cwd);
    onClose();
  };

  const showInitialLoading = pageQuery.isLoading;
  const showError = pageQuery.isError;
  // A placeholder (previous result held while the new keyword settles) is
  // neither empty nor settled — the last rows stay on screen with no flash.
  const showEmpty = !showInitialLoading && !showError && !pageQuery.isPlaceholderData && rows.length === 0;

  return (
    <div
      className="search-palette-backdrop"
      onMouseDown={onClose}
      data-testid="search-palette-backdrop"
    >
      <div
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("desktop.searchSessions")}
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="search-palette"
      >
        <div className="search-palette-input-row">
          <MagnifyingGlass size={18} weight="regular" aria-hidden="true" />
          <input
            ref={inputRef}
            value={input}
            placeholder={t("desktop.searchSessions")}
            aria-label={t("desktop.searchSessions")}
            role="combobox"
            aria-expanded="true"
            aria-controls="search-palette-results"
            aria-activedescendant={rows[active] ? `search-palette-option-${rows[active].sessionId}` : undefined}
            aria-autocomplete="list"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Enter") {
                // IME composition confirms with Enter — never open a session
                // from a composition keystroke.
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                const session = rows[active];
                if (session) openSession(session);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
            data-testid="search-palette-input"
          />
          {input ? (
            <button
              type="button"
              className="search-palette-clear"
              aria-label={t("desktop.searchPalette.clear")}
              onClick={() => {
                setInput("");
                inputRef.current?.focus();
              }}
            >
              <X size={14} weight="bold" aria-hidden="true" />
            </button>
          ) : (
            <kbd className="search-palette-kbd">esc</kbd>
          )}
        </div>
        <div
          className="search-palette-results"
          id="search-palette-results"
          ref={listRef}
          role="listbox"
          aria-label={t("desktop.searchSessions")}
          data-testid="search-palette-results"
        >
          {showError ? (
            <div className="search-palette-status search-palette-status--error">{t("desktop.sessionsUnavailable")}</div>
          ) : showInitialLoading ? (
            <div className="search-palette-status">{t("desktop.loading")}</div>
          ) : showEmpty ? (
            <div className="search-palette-empty" data-testid="search-palette-empty">
              <p>{t("desktop.searchPalette.emptyTitle", { query: searching ? debounced : trimmedInput })}</p>
              <p>{t("desktop.searchPalette.emptyHint")}</p>
            </div>
          ) : (
            <>
              {!searching ? <div className="search-palette-group">{t("desktop.searchPalette.recent")}</div> : null}
              {rows.map((session, index) => {
                const title = sessionRowTitle(session);
                const projectName = projectDisplayName(session.projectRoot || session.cwd);
                const fromMessage = searching && session.matchSource === "message";
                const piece = fromMessage && session.firstMessage
                  ? snippet(session.firstMessage, debounced)
                  : null;
                const activity = sessionActivityMs(session);
                const running = runningSessionIds.has(session.sessionId);
                const waiting = waitingSessionIds.has(session.sessionId);
                return (
                  <button
                    key={session.sessionId}
                    id={`search-palette-option-${session.sessionId}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    data-active={index === active ? "true" : "false"}
                    data-session-id={session.sessionId}
                    className="search-palette-row"
                    onMouseMove={() => setActive(index)}
                    onClick={() => openSession(session)}
                  >
                    <span className="search-palette-title">
                      <Highlight text={title} query={searching && session.matchSource === "title" ? debounced : ""} />
                    </span>
                    {piece ? (
                      <span className="search-palette-meta">
                        {t("desktop.searchPalette.messagePrefix")}
                        {piece.before}<strong>{piece.match}</strong>{piece.after}
                      </span>
                    ) : (
                      <span className="search-palette-meta">
                        <Highlight text={projectName} query={searching && session.matchSource === "project" ? debounced : ""} />
                      </span>
                    )}
                    <span className="search-palette-aside">
                      {running ? <RunningSessionIndicator /> : waiting ? (
                        <SessionStatusDot status="waiting" />
                      ) : activity === undefined ? null : (
                        formatCompactActivity(activity, locale)
                      )}
                    </span>
                  </button>
                );
              })}
              {extraResults > 0 ? (
                <div className="search-palette-more">{t("desktop.searchPalette.more", { count: extraResults })}</div>
              ) : null}
            </>
          )}
        </div>
        <div className="search-palette-footer">
          <span><kbd className="search-palette-kbd">↑</kbd><kbd className="search-palette-kbd">↓</kbd> {t("desktop.searchPalette.footerSelect")}</span>
          <span className="search-palette-footer-dot">·</span>
          <span><kbd className="search-palette-kbd">↵</kbd> {t("desktop.searchPalette.footerOpen")}</span>
          <span className="search-palette-footer-dot">·</span>
          <span><kbd className="search-palette-kbd">esc</kbd> {t("desktop.searchPalette.footerClose")}</span>
        </div>
      </div>
    </div>
  );
}
