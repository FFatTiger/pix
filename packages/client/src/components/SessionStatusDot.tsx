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

/**
 * The one busy spinner used next to session rows, workspace tabs, the Pixie
 * entries and the ⌘K search panel — identical markup/animation everywhere.
 */
export function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      className="sidebar-row-status"
      title={t("desktop.agentRunning")}
      aria-label={t("desktop.agentRunningLabel")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}
