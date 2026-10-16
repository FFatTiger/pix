/**
 * Coalesces store notifications on their way to React.
 *
 * The first couple of updates in a frame pass straight through, so a single
 * event still renders the moment it arrives. Anything beyond that before the
 * next frame — a reconnect replaying thousands of journal events — is
 * delivered once, on that frame. Counting per frame rather than per time
 * window matters: a burst keeps the main thread busy, frames stop arriving,
 * and the burst stays coalesced however long each render takes. Rendering the
 * whole session view synchronously per event instead stalls the page and
 * trips React's nested-update limit (minified error #185), which is what
 * blanked the app after a phone resumed the PWA mid-turn.
 */
export interface BurstCoalescerDeps {
  /** Run once at the next frame boundary. */
  schedule(onFrame: () => void): void;
}

export interface CoalescedListener {
  notify(): void;
  /** Drop a pending delivery (the subscriber is going away). */
  cancel(): void;
}

export function coalesceBursts(
  listener: () => void,
  deps: BurstCoalescerDeps = { schedule: scheduleFrame },
  perFrame = 2,
): CoalescedListener {
  let count = 0;
  let frameArmed = false;
  let pending = false;
  let cancelled = false;
  const onFrame = (): void => {
    frameArmed = false;
    count = 0;
    if (!pending) return;
    pending = false;
    if (!cancelled) listener();
  };
  return {
    notify() {
      if (cancelled) return;
      if (!frameArmed) {
        frameArmed = true;
        deps.schedule(onFrame);
      }
      if (pending) return;
      count += 1;
      if (count <= perFrame) listener();
      else pending = true;
    },
    cancel() {
      cancelled = true;
    },
  };
}

function scheduleFrame(onFrame: () => void): void {
  // A hidden page gets no animation frames; a short timer still delivers the
  // burst's final state.
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  if (visible && typeof requestAnimationFrame === "function") requestAnimationFrame(onFrame);
  else setTimeout(onFrame, 16);
}
