import { useI18n } from "@/hooks/useI18n";

/** Small-marker status vocabulary shared by session rows, tabs, and the Pixie entries. */
export type SessionDisplayStatus = "running" | "waiting" | "error";

/**
 * Single shared status-resolution rule: error > waiting > running. Every
 * surface (sidebar rows, workspace tabs, the Pixie entry) resolves through
 * this exact function so a session and Pixie can never disagree on which
 * marker wins when states coexist.
 */
export function resolveSessionDisplayStatus(input: {
  error?: boolean;
  waiting?: boolean;
  running?: boolean;
}): SessionDisplayStatus | undefined {
  if (input.error === true) return "error";
  if (input.waiting === true) return "waiting";
  if (input.running === true) return "running";
  return undefined;
}

/**
 * The one small status marker used next to session rows, workspace tabs, and
 * the Pixie entries. Same geometry everywhere; the variant differs only by
 * color/motion through `data-status` (running keeps the busy pulse, waiting
 * and error are quiet static dots).
 */
export function SessionStatusDot({
  status,
  label,
}: {
  status: SessionDisplayStatus;
  /** Accessible label; defaults to the shared per-status copy. */
  label?: string | undefined;
}) {
  const { t } = useI18n();
  const text = label ?? t(`desktop.sessionStatus.${status}`);
  return (
    <span
      className="session-status-dot"
      data-status={status}
      title={text}
      aria-label={text}
    />
  );
}
