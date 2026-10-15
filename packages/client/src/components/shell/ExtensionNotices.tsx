import { useCallback, useEffect, useRef, useState } from "react";
import { BellSimple, X } from "@phosphor-icons/react";
import type { ExtensionNotificationItem } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";

/** How long a new notice stays before it starts fading. Hover pauses it. */
const TOAST_AUTO_HIDE_MS = 6000;
/** Must match the toast opacity transition. */
const TOAST_FADE_MS = 200;

function noticeUrl(message: string): string | null {
  return /https?:\/\/\S+/.exec(message)?.[0] ?? null;
}

function noticeKey(notice: ExtensionNotificationItem): string {
  return `${notice.at}:${notice.message}`;
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
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
    setCopiedKey(null);
    setPhase("visible");
    setListOpen(false);
    return clearTimers;
  }, [clearTimers, latestKey]);

  useEffect(() => {
    if (phase !== "visible" || listOpen || paused || latestKey === null) return;
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
  }, [beginFade, latestKey, listOpen, paused, phase]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  if (latest === undefined) return null;

  const copy = (url: string, key: string) => {
    void copyText(url).then(() => setCopiedKey(key));
  };

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
          role="status"
          aria-label={latest.message}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <span className="extension-notice-message" title={latest.message}>{latest.message}</span>
          {noticeUrl(latest.message) ? (
            <button
              type="button"
              className="extension-notice-copy"
              onClick={() => copy(noticeUrl(latest.message)!, noticeKey(latest))}
            >
              {copiedKey === noticeKey(latest) ? t("desktop.extensionNoticeCopied") : t("desktop.extensionNoticeCopy")}
            </button>
          ) : null}
          <button
            type="button"
            className="extension-notice-dismiss"
            aria-label={t("desktop.close")}
            onClick={beginFade}
          >
            <X size={12} aria-hidden="true" />
          </button>
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
          {recent.map((notice) => {
            const key = noticeKey(notice);
            const url = noticeUrl(notice.message);
            return (
              <div key={key} className="extension-notice-row" data-level={notice.level}>
                <span className="extension-notice-level-dot" aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{notice.message}</span>
                {url ? (
                  <button type="button" className="extension-notice-copy" onClick={() => copy(url, key)}>
                    {copiedKey === key ? t("desktop.extensionNoticeCopied") : t("desktop.extensionNoticeCopy")}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
