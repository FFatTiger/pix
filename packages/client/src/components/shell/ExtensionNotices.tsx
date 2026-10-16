import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BellSimple, X } from "@phosphor-icons/react";
import type { ExtensionNotificationItem } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";

/** How long a new notice stays before it starts fading. Hover pauses it. */
const TOAST_AUTO_HIDE_MS = 6000;
/** Must match the toast opacity transition. */
const TOAST_FADE_MS = 200;

const URL_PATTERN = /https?:\/\/\S+/g;

function noticeKey(notice: ExtensionNotificationItem): string {
  return `${notice.at}:${notice.message}`;
}

/** Message text with its URLs turned into links that open in a new window. */
function noticeBody(message: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of message.matchAll(URL_PATTERN)) {
    const url = match[0];
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(message.slice(cursor, start));
    nodes.push(
      <a key={start} href={url} target="_blank" rel="noopener noreferrer">{url}</a>,
    );
    cursor = start + url.length;
  }
  if (cursor < message.length) nodes.push(message.slice(cursor));
  return nodes;
}

/**
 * Latest extension notice (`ctx.ui.notify` info/warning) as a floating pill
 * over the content surface. It fades on its own; a quiet bell then reopens
 * the same bounded projection history. Display only — the ring itself stays
 * in the runtime projection.
 */
export function ExtensionNotices({ notices }: { notices: readonly ExtensionNotificationItem[] }) {
  const { t } = useI18n();
  const latest = notices.at(-1);
  const latestKey = latest === undefined ? null : noticeKey(latest);
  const [phase, setPhase] = useState<"visible" | "fading" | "hidden">("visible");
  const [listOpen, setListOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  // Expanded shows the full message in a card under the pill; auto-hide stays paused while on.
  const [expanded, setExpanded] = useState(false);
  const autoHideTimer = useRef<number | null>(null);
  const fadeTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (autoHideTimer.current !== null) {
      window.clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
    if (fadeTimer.current !== null) {
      window.clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }
  }, []);

  const beginFade = useCallback(() => {
    clearTimers();
    setPhase("fading");
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      setPhase("hidden");
    }, TOAST_FADE_MS);
  }, [clearTimers]);

  useEffect(() => {
    setPhase("visible");
    setListOpen(false);
    setExpanded(false);
    return clearTimers;
  }, [clearTimers, latestKey]);

  useEffect(() => {
    if (phase !== "visible" || listOpen || paused || expanded || latestKey === null) return;
    autoHideTimer.current = window.setTimeout(() => {
      autoHideTimer.current = null;
      beginFade();
    }, TOAST_AUTO_HIDE_MS);
    return () => {
      if (autoHideTimer.current !== null) {
        window.clearTimeout(autoHideTimer.current);
        autoHideTimer.current = null;
      }
    };
  }, [beginFade, expanded, latestKey, listOpen, paused, phase]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  if (latest === undefined) return null;

  const toggleExpanded = () => setExpanded((current) => !current);

  const showToast = phase !== "hidden" && !listOpen;
  const recent = [...notices].reverse();

  return (
    <>
      {showToast ? (
        <div
          className="extension-notice-toast"
          data-testid="extension-notices"
          data-level={latest.level}
          data-phase={phase}
          data-expanded={expanded ? "true" : undefined}
          role="status"
          aria-label={latest.message}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <span className="extension-notice-level-dot" aria-hidden="true" />
          <span
            className="extension-notice-message"
            title={latest.message}
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onClick={toggleExpanded}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleExpanded();
              }
            }}
          >
            {latest.message}
          </span>
          <button
            type="button"
            className="extension-notice-dismiss"
            aria-label={t("desktop.close")}
            onClick={beginFade}
          >
            <X size={12} aria-hidden="true" />
          </button>
          {expanded ? (
            <div className="extension-notice-detail" data-testid="extension-notice-detail">
              {noticeBody(latest.message)}
            </div>
          ) : null}
        </div>
      ) : null}
      {phase === "hidden" && !listOpen ? (
        <button
          type="button"
          className="extension-notice-dot"
          data-testid="extension-notices-dot"
          title={t("desktop.extensionNoticesOpen")}
          aria-label={t("desktop.extensionNoticesOpen")}
          onClick={() => setListOpen(true)}
        >
          <BellSimple size={14} aria-hidden="true" />
        </button>
      ) : null}
      {listOpen ? (
        <div
          className="extension-notice-list"
          data-testid="extension-notices-list"
          role="dialog"
          aria-label={t("desktop.extensionNoticesLabel")}
          onKeyDown={(event) => {
            if (event.key === "Escape") setListOpen(false);
          }}
        >
          <div className="extension-notice-list-head">
            <span>{t("desktop.extensionNoticesLabel")}</span>
            <button
              type="button"
              className="extension-notice-list-close"
              aria-label={t("desktop.close")}
              onClick={() => setListOpen(false)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          {recent.map((notice) => (
            <div key={noticeKey(notice)} className="extension-notice-row" data-level={notice.level}>
              <span className="extension-notice-level-dot" aria-hidden="true" />
              <span className="extension-notice-row-text">{noticeBody(notice.message)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
