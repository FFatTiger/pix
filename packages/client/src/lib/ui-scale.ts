/**
 * UI/text scale helpers (Text Size setting).
 *
 * This module is the SINGLE RUNTIME OWNER of the Text Size preference
 * (`pi-font-scale`): readFontScale/writeFontScale clamp and persist it, and
 * the pre-React bootstrap in index.html applies it before first paint (it
 * cannot import a module — keep the key spelling here in sync with that
 * script). The dedicated `useUiScale` hook owns the React-side apply.
 *
 * The app applies the user's scale via `zoom: var(--app-ui-scale, 1)` on the
 * root element. Under CSS `zoom`, Chromium keeps JS viewport APIs
 * (`clientX`/`clientY`, `getBoundingClientRect()`, `innerWidth`/`innerHeight`,
 * `visualViewport`) reporting *physical* pixels, while CSS pixel lengths —
 * including `position: fixed` overlay offsets — are painted at `zoom` × their
 * value. An overlay positioned from raw JS numbers therefore drifts by
 * `(zoom - 1)` × offset (e.g. 25% at 125% scale).
 *
 * Fixed overlays that anchor to the viewport or to a JS-measured rect must
 * convert their physical inputs to CSS space *once* (via `cssPx` /
 * `cssViewportSize`), after which all math — anchoring, clamping, overflow
 * checks — stays in CSS pixels and the final paint scales back to the exact
 * physical position. Pure-CSS `position: absolute` overlays (anchored to a
 * positioned ancestor) need no conversion: ancestor and overlay share the CSS
 * coordinate system and zoom scales them together.
 */
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.5;

/** Stored Text Size scale, clamped to [FONT_SCALE_MIN, FONT_SCALE_MAX]. */
export function readFontScale(): number {
  try {
    const v = localStorage.getItem("pi-font-scale");
    if (v !== null) {
      const n = parseFloat(v);
      if (!isNaN(n) && n >= FONT_SCALE_MIN && n <= FONT_SCALE_MAX) return n;
    }
  } catch {}
  return 1;
}

export function writeFontScale(scale: number): void {
  try { localStorage.setItem("pi-font-scale", String(scale)); } catch {}
}

export function getUiScale(): number {
  if (typeof document === "undefined") return 1;
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}

/** Convert a physical-pixel measurement (JS viewport API result) to CSS pixels. */
export function cssPx(physical: number): number {
  return physical / getUiScale();
}

/** Viewport size in CSS pixels (what `window.innerWidth`/`innerHeight` would
 *  report if CSS `zoom` behaved like real page zoom). */
export function cssViewportSize(): { width: number; height: number } {
  const s = getUiScale();
  return { width: window.innerWidth / s, height: window.innerHeight / s };
}
