import { useCallback, useEffect, useRef, useState } from "react";

/**
 * LobeUI Streamdown-style stream smoothing (ported from
 * lobe-ui useSmoothStreamContent, "balanced" preset).
 *
 * Streamed tokens arrive in bursts (publish throttles, network batching).
 * Rendering each burst directly makes the fade timeline jump: chars appear
 * dozens at a time and their animation-delay is recomputed per render, so
 * mid-flight CSS animations visibly snap. This hook decouples arrival from
 * display: the target string grows in bursts, but the DISPLAYED string grows
 * via a requestAnimationFrame loop that reveals 1-3 chars per frame at an
 * EMA-smoothed characters-per-second rate. Re-renders then happen at frame
 * cadence with tiny appends, which is what keeps the per-char fade smooth.
 *
 * - Append-only streams are smoothed; rewrites flush instantly (sync).
 * - Very large appends (>= 120 chars) flush instantly — no typewriter backlog.
 * - When input goes idle the backlog drains within a bounded window.
 */
const PRESET = {
  activeInputWindowMs: 220,
  defaultCps: 38,
  emaAlpha: 0.2,
  flushCps: 120,
  largeAppendChars: 120,
  maxActiveCps: 132,
  maxCps: 72,
  maxFlushCps: 280,
  minCps: 18,
  settleAfterMs: 360,
  settleDrainMaxMs: 520,
  settleDrainMinMs: 180,
  targetBufferMs: 120,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countChars(text: string): number {
  return [...text].length;
}

function getNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function useSmoothStream(content: string, enabled: boolean): string {
  const [displayedContent, setDisplayedContent] = useState(content);

  const displayedContentRef = useRef(content);
  const displayedCountRef = useRef(countChars(content));

  const targetContentRef = useRef(content);
  const targetCharsRef = useRef<string[]>([...content]);
  const targetCountRef = useRef(targetCharsRef.current.length);

  const emaCpsRef = useRef<number>(PRESET.defaultCps);
  const lastInputTsRef = useRef(0);
  const lastInputCountRef = useRef(targetCountRef.current);
  const chunkSizeEmaRef = useRef<number>(1);
  const arrivalCpsEmaRef = useRef<number>(PRESET.defaultCps);

  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startFrameLoopRef = useRef<() => void>(() => {});

  const clearWakeTimer = useCallback(() => {
    if (wakeTimerRef.current !== null) {
      clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
  }, []);

  const stopFrameLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastFrameTsRef.current = null;
  }, []);

  const stopScheduling = useCallback(() => {
    stopFrameLoop();
    clearWakeTimer();
  }, [clearWakeTimer, stopFrameLoop]);

  const syncImmediate = useCallback(
    (nextContent: string) => {
      stopScheduling();

      const chars = [...nextContent];
      const now = getNow();

      targetContentRef.current = nextContent;
      targetCharsRef.current = chars;
      targetCountRef.current = chars.length;

      displayedContentRef.current = nextContent;
      displayedCountRef.current = chars.length;
      setDisplayedContent(nextContent);

      emaCpsRef.current = PRESET.defaultCps;
      chunkSizeEmaRef.current = 1;
      arrivalCpsEmaRef.current = PRESET.defaultCps;
      lastInputTsRef.current = now;
      lastInputCountRef.current = chars.length;
    },
    [stopScheduling],
  );

  const scheduleFrameWake = useCallback(
    (delayMs: number) => {
      clearWakeTimer();
      wakeTimerRef.current = setTimeout(() => {
        wakeTimerRef.current = null;
        startFrameLoopRef.current();
      }, Math.max(1, Math.ceil(delayMs)));
    },
    [clearWakeTimer],
  );

  const startFrameLoop = useCallback(() => {
    clearWakeTimer();
    if (rafRef.current !== null) return;

    const tick = (ts: number) => {
      if (lastFrameTsRef.current === null) {
        lastFrameTsRef.current = ts;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const frameIntervalMs = Math.max(0, ts - lastFrameTsRef.current);
      const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.05));
      lastFrameTsRef.current = ts;

      const targetCount = targetCountRef.current;
      const displayedCount = displayedCountRef.current;
      const backlog = targetCount - displayedCount;

      if (backlog <= 0) {
        stopFrameLoop();
        return;
      }

      const now = getNow();
      const idleMs = now - lastInputTsRef.current;
      const inputActive = idleMs <= PRESET.activeInputWindowMs;
      const settling = !inputActive && idleMs >= PRESET.settleAfterMs;

      const baseCps = clamp(emaCpsRef.current, PRESET.minCps, PRESET.maxCps);
      const baseLagChars = Math.max(1, Math.round((baseCps * PRESET.targetBufferMs) / 1000));
      const lagUpperBound = Math.max(baseLagChars + 2, baseLagChars * 3);
      const targetLagChars = inputActive
        ? Math.round(
          clamp(baseLagChars + chunkSizeEmaRef.current * 0.35, baseLagChars, lagUpperBound),
        )
        : 0;
      const desiredDisplayed = Math.max(0, targetCount - targetLagChars);

      let currentCps: number;
      if (inputActive) {
        const backlogPressure = targetLagChars > 0 ? backlog / targetLagChars : 1;
        const chunkPressure = targetLagChars > 0 ? chunkSizeEmaRef.current / targetLagChars : 1;
        const arrivalPressure = arrivalCpsEmaRef.current / Math.max(baseCps, 1);
        const combinedPressure = clamp(
          backlogPressure * 0.6 + chunkPressure * 0.25 + arrivalPressure * 0.15,
          1,
          4.5,
        );
        const activeCap = clamp(
          PRESET.maxActiveCps + chunkSizeEmaRef.current * 6,
          PRESET.maxActiveCps,
          PRESET.maxFlushCps,
        );
        currentCps = clamp(baseCps * combinedPressure, PRESET.minCps, activeCap);
      } else if (settling) {
        // Input likely ended: cap the remaining drain so old backlog does not
        // keep replaying for seconds after the stream finished.
        const drainTargetMs = clamp(
          backlog * 8,
          PRESET.settleDrainMinMs,
          PRESET.settleDrainMaxMs,
        );
        const settleCps = (backlog * 1000) / drainTargetMs;
        currentCps = clamp(settleCps, PRESET.flushCps, PRESET.maxFlushCps);
      } else {
        const idleFlushCps = Math.max(
          PRESET.flushCps,
          baseCps * 1.8,
          arrivalCpsEmaRef.current * 0.8,
        );
        currentCps = clamp(idleFlushCps, PRESET.flushCps, PRESET.maxFlushCps);
      }

      const urgentBacklog = inputActive && targetLagChars > 0 && backlog > targetLagChars * 2.2;
      const burstyInput = inputActive && chunkSizeEmaRef.current >= targetLagChars * 0.9;
      const minRevealChars = inputActive ? (urgentBacklog || burstyInput ? 2 : 1) : 2;
      let revealChars = Math.max(minRevealChars, Math.round(currentCps * dtSeconds));

      if (inputActive) {
        const shortfall = desiredDisplayed - displayedCount;
        if (shortfall <= 0) {
          stopFrameLoop();
          scheduleFrameWake(PRESET.activeInputWindowMs - idleMs);
          return;
        }
        revealChars = Math.min(revealChars, shortfall, backlog);
      } else {
        revealChars = Math.min(revealChars, backlog);
      }

      const nextCount = displayedCount + revealChars;
      const segment = targetCharsRef.current.slice(displayedCount, nextCount).join("");

      if (segment) {
        const nextDisplayed = displayedContentRef.current + segment;
        displayedContentRef.current = nextDisplayed;
        displayedCountRef.current = nextCount;
        setDisplayedContent(nextDisplayed);
      } else {
        displayedContentRef.current = targetContentRef.current;
        displayedCountRef.current = targetCount;
        setDisplayedContent(targetContentRef.current);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [clearWakeTimer, scheduleFrameWake, stopFrameLoop]);
  startFrameLoopRef.current = startFrameLoop;

  useEffect(() => {
    if (!enabled) {
      if (displayedContentRef.current !== content) syncImmediate(content);
      return;
    }

    const prevTargetContent = targetContentRef.current;
    if (content === prevTargetContent) return;

    const now = getNow();
    const appendOnly = content.startsWith(prevTargetContent);

    if (!appendOnly) {
      syncImmediate(content);
      return;
    }

    const appended = content.slice(prevTargetContent.length);
    const appendedChars = [...appended];
    const appendedCount = appendedChars.length;

    if (appendedCount > PRESET.largeAppendChars) {
      syncImmediate(content);
      return;
    }

    targetContentRef.current = content;
    targetCharsRef.current = [...targetCharsRef.current, ...appendedChars];
    targetCountRef.current += appendedCount;

    const deltaChars = targetCountRef.current - lastInputCountRef.current;
    const deltaMs = Math.max(1, now - lastInputTsRef.current);

    if (deltaChars > 0) {
      const instantCps = (deltaChars * 1000) / deltaMs;
      const normalizedInstantCps = clamp(instantCps, PRESET.minCps, PRESET.maxFlushCps * 2);
      const chunkEmaAlpha = 0.35;
      chunkSizeEmaRef.current =
        chunkSizeEmaRef.current * (1 - chunkEmaAlpha) + appendedCount * chunkEmaAlpha;
      arrivalCpsEmaRef.current =
        arrivalCpsEmaRef.current * (1 - chunkEmaAlpha) + normalizedInstantCps * chunkEmaAlpha;

      const clampedCps = clamp(instantCps, PRESET.minCps, PRESET.maxActiveCps);
      emaCpsRef.current = emaCpsRef.current * (1 - PRESET.emaAlpha) + clampedCps * PRESET.emaAlpha;
    }

    lastInputTsRef.current = now;
    lastInputCountRef.current = targetCountRef.current;

    startFrameLoop();
  }, [content, enabled, startFrameLoop, syncImmediate]);

  useEffect(() => stopScheduling, [stopScheduling]);

  return displayedContent;
}
