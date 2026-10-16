import type { AgentMessage } from "@fffattiger/pix-protocol";

/**
 * Effects a tool result should fire in the UI the moment it arrives live.
 *
 * History replay, reconnect resync and page refresh all deliver results that
 * were already present when the view mounted — those must not reopen a pane
 * or a tab. Only a toolCallId first observed AFTER mount qualifies, and each
 * id fires at most once.
 */
export interface LiveToolEffect {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  details: unknown;
}

export interface LiveToolEffectScan {
  /** Ids observed in this batch, including ones that do not qualify. */
  seen: string[];
  /** Results that arrived after mount and have not fired yet. */
  fresh: LiveToolEffect[];
}

function effectOf(message: AgentMessage): LiveToolEffect | null {
  if (message.role !== "toolResult") return null;
  const id = message.toolCallId;
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    toolCallId: id,
    toolName: typeof message.toolName === "string" ? message.toolName : "",
    isError: message.isError === true,
    details: message.details,
  };
}

/**
 * Scan the current live entries. `primed` is false on the first scan of a
 * mount: every id present then is remembered and nothing fires. Later scans
 * return only ids never seen before.
 */
export function scanLiveToolEffects(
  messages: readonly AgentMessage[],
  seen: ReadonlySet<string>,
  primed: boolean,
): LiveToolEffectScan {
  const fresh: LiveToolEffect[] = [];
  const now: string[] = [];
  for (const message of messages) {
    const effect = effectOf(message);
    if (effect === null || now.includes(effect.toolCallId)) continue;
    now.push(effect.toolCallId);
    if (primed && !seen.has(effect.toolCallId)) fresh.push(effect);
  }
  return { seen: now, fresh };
}

/** Absolute path `show_files` asked to open, or null when it named none. */
export function showFilesOpenPath(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const open = (details as { open?: unknown }).open;
  return typeof open === "string" && open.length > 0 ? open : null;
}

export interface OpenSessionTarget {
  sessionId: string;
  cwd: string;
  title?: string;
}

/** Session tab `open_session` asked to open, or null when the details are incomplete. */
export function openSessionTarget(details: unknown): OpenSessionTarget | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as { sessionId?: unknown; cwd?: unknown; title?: unknown };
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
  if (typeof record.cwd !== "string" || record.cwd.length === 0) return null;
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    ...(typeof record.title === "string" && record.title.length > 0 ? { title: record.title } : {}),
  };
}
