import { useCallback, useEffect, useState } from "react";
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  readFontScale,
  writeFontScale,
} from "@/lib/ui-scale";

/**
 * Dedicated Text Size preference owner (replaces the font-scale handling that
 * used to live inside the removed theme controller).
 *
 * - `pi-font-scale` persistence + clamping + DOM application live here and in
 *   `lib/ui-scale.ts` (single runtime authority). Components never touch the
 *   key or the DOM directly.
 * - The pre-React bootstrap in index.html already applies the stored scale
 *   before first paint; this hook keeps the CSS `--app-ui-scale` in sync for
 *   runtime changes. It reads the persisted value on mount, so opening
 *   settings always reflects (and re-applies) the stored scale even if the
 *   inline bootstrap did not run.
 * - Provider-free: DisplayConfig is the only consumer, and the persisted value
 *   is applied pre-paint by the bootstrap — no global provider needed.
 */
export function useUiScale(): { fontScale: number; setFontScale: (scale: number) => void } {
  const [fontScale, setFontScaleState] = useState<number>(readFontScale);

  // Keep the CSS zoom in sync with the current scale (also re-applies the
  // stored value on mount).
  useEffect(() => {
    document.documentElement.style.setProperty("--app-ui-scale", String(fontScale));
  }, [fontScale]);

  const setFontScale = useCallback((scale: number) => {
    const clamped = Math.min(
      FONT_SCALE_MAX,
      Math.max(FONT_SCALE_MIN, Math.round(scale * 100) / 100),
    );
    setFontScaleState(clamped);
    writeFontScale(clamped);
  }, []);

  return { fontScale, setFontScale };
}
