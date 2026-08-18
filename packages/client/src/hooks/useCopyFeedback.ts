import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";

export type CopyFeedback = "idle" | "copied" | "failed";

/**
 * Visible copy outcome. Failures stay `failed` until the timer clears; they
 * are never treated as success and never swallowed.
 */
export function useCopyFeedback(resetMs = 1500): {
  status: CopyFeedback;
  copy: (text: string) => Promise<void>;
} {
  const [status, setStatus] = useState<CopyFeedback>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await copyText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    timerRef.current = setTimeout(() => setStatus("idle"), resetMs);
  }, [resetMs]);

  return { status, copy };
}
