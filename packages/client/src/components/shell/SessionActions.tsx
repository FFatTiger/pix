import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ThinkingLevelSchema, type ThinkingLevel } from "@fffattiger/pix-protocol";
import { useRuntime } from "@/runtime";

/**
 * SessionActions — D2-P1/D2-P2 minimal runtime inspection/mutation panel.
 *
 * While attached AND the selected session matches the live runtime:
 *  - always-available queries: state / commands / last assistant text;
 *  - capability-gated actions shown ONLY when the runtime advertises them:
 *    session stats (`runtime.stats`), rename (`runtime.session.rename`),
 *    thinking level (`runtime.thinking.set`).
 *
 * Success / error / loading are surfaced inline. Mutating actions resolve on
 * the runtime command result and then refresh the snapshot (fetchSnapshot) so
 * the new state is visible; they NEVER write a history/catalog projection —
 * session persistence is the runtime's job, not the client's.
 *
 * Race / identity:
 *  - singleflight via `busy` disables concurrent submits;
 *  - request identity is captured at submit; late settles from a previous
 *    session / unmount never update UI or surface errors for the new view.
 */

/** Protocol-derived thinking levels — never a free-form string union. */
const THINKING_LEVELS = ThinkingLevelSchema.options;

/** Fixed safe UI copy — never render raw ProtocolError.message for thinking. */
const THINKING_ERROR_MESSAGE = "Failed to update thinking level.";

function describeError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
}

export interface SessionActionsProps {
  /**
   * Explicit selection gate (history-switching fix). When `false` the selected
   * session is NOT the attached runtime (viewing history or a stale live
   * session), so the panel is HIDDEN — runtime actions never apply to a
   * non-selected session. When omitted the legacy behavior applies (shown
   * whenever the runtime is attached, otherwise a hint).
   */
  live?: boolean;
}

export function SessionActions({ live }: SessionActionsProps) {
  const runtime = useRuntime();
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [thinkingDraft, setThinkingDraft] = useState<ThinkingLevel | "">("");

  // Identity for race-safe late settles: session + mount generation.
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(runtime.sessionId);
  const selectionLiveRef = useRef(live !== false);
  const requestGenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenRef.current += 1; // invalidate any in-flight UI settle
    };
  }, []);

  useEffect(() => {
    sessionIdRef.current = runtime.sessionId;
    // Runtime session switch: drop stale status so old errors cannot stick to a
    // new session, and bump gen so late settles fail-closed.
    requestGenRef.current += 1;
    setBusy(null);
    setError(null);
    setOutput(null);
    setThinkingDraft("");
  }, [runtime.sessionId]);

  // The selected view can leave the attached runtime without changing
  // runtime.sessionId (attached A → history B). Invalidate requests during the
  // layout phase so an old settle cannot fetch A/new state while the panel is
  // hidden, then reappear with stale status when the user returns to A.
  useLayoutEffect(() => {
    selectionLiveRef.current = live !== false;
    requestGenRef.current += 1;
    setBusy(null);
    setError(null);
    setOutput(null);
    setThinkingDraft("");
  }, [live]);

  // Selection gate AFTER all hooks (Rules of Hooks): never offer runtime actions
  // for a session that is not the one being viewed (e.g. still attached to A
  // while showing B), or on a read-only history view.
  if (live === false) return null;

  const capabilities = runtime.capabilities?.capabilities ?? [];
  const hasStats = capabilities.includes("runtime.stats");
  const hasRename = capabilities.includes("runtime.session.rename");
  const hasThinking = capabilities.includes("runtime.thinking.set");

  // Snapshot is the authority (sessiond refreshes worker.getSnapshot after a
  // successful set_thinking_level so thinkingLevel/thinkingLevelPinned land
  // before the client command promise settles).
  const snapshotThinking = runtime.snapshot?.state.thinkingLevel;
  const snapshotPinned = runtime.snapshot?.state.thinkingLevelPinned === true;
  const selectedThinking: ThinkingLevel | "" =
    thinkingDraft !== ""
      ? thinkingDraft
      : snapshotThinking !== undefined
        ? snapshotThinking
        : "";

  /**
   * Identity guard uses only refs — never a closed-over `runtime` snapshot from
   * the render that started the request. A session switch bumps requestGen and
   * rewrites sessionIdRef; unmount clears mountedRef. Late settles then fail-closed.
   */
  const isCurrentRequest = (gen: number, sessionId: string | null): boolean =>
    mountedRef.current &&
    selectionLiveRef.current &&
    gen === requestGenRef.current &&
    sessionId !== null &&
    sessionId === sessionIdRef.current;

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    render: (value: unknown) => string,
  ): Promise<void> => {
    if (busy !== null) return;
    const sessionId = sessionIdRef.current;
    const gen = ++requestGenRef.current;
    setBusy(key);
    setError(null);
    setOutput(null);
    try {
      const value = await action();
      if (!isCurrentRequest(gen, sessionId)) return;
      setOutput(render(value));
    } catch (cause) {
      // Bound consumption: rejections from dispose / session switch never escape.
      if (!isCurrentRequest(gen, sessionId)) return;
      setError(describeError(cause));
    } finally {
      if (isCurrentRequest(gen, sessionId)) setBusy(null);
    }
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy !== null) return;
    const sessionId = sessionIdRef.current;
    const gen = ++requestGenRef.current;
    setBusy("rename");
    setError(null);
    setOutput(null);
    try {
      // Honest rename: resolve on the runtime command result, then refresh the
      // snapshot so the new sessionName is visible. No catalog write here.
      await runtime.setSessionName(trimmed);
      // Identity guard BEFORE fetchSnapshot so a late settle never refreshes
      // (or errors on) a different session after selection switch.
      if (!isCurrentRequest(gen, sessionId)) return;
      await runtime.fetchSnapshot();
      if (!isCurrentRequest(gen, sessionId)) return;
      setName("");
      setOutput(`Renamed session to "${trimmed}".`);
    } catch (cause) {
      // Bound consumption of store rejections (dispose / transport / capability).
      if (!isCurrentRequest(gen, sessionId)) return;
      setError(describeError(cause));
    } finally {
      if (isCurrentRequest(gen, sessionId)) setBusy(null);
    }
  };

  const handleThinkingSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy !== null || selectedThinking === "") return;
    const level = selectedThinking;
    const sessionId = sessionIdRef.current;
    const gen = ++requestGenRef.current;
    setBusy("thinking");
    setError(null);
    setOutput(null);
    try {
      await runtime.setThinkingLevel(level);
      // Identity guard BEFORE fetchSnapshot: selection/session switch or unmount
      // must fail-closed (no snapshot refresh, no status write for the new view).
      // sessiond already refreshed worker.getSnapshot before resolving the
      // command, so this client fetch observes the authoritative thinking pin.
      if (!isCurrentRequest(gen, sessionId)) return;
      await runtime.fetchSnapshot();
      if (!isCurrentRequest(gen, sessionId)) return;
      setThinkingDraft("");
      setOutput(`Thinking level set to "${level}".`);
    } catch {
      // Fixed safe copy only — never render raw ProtocolError for thinking.
      // Also bounds dispose/session-switch rejections so they are not unhandled.
      if (!isCurrentRequest(gen, sessionId)) return;
      setError(THINKING_ERROR_MESSAGE);
    } finally {
      if (isCurrentRequest(gen, sessionId)) setBusy(null);
    }
  };

  if (!runtime.attached) {
    return (
      <section className="session-actions" aria-label="Session actions">
        <p className="session-actions-hint">Attach a runtime session to inspect state, commands, stats and naming.</p>
      </section>
    );
  }

  return (
    <section className="session-actions" aria-label="Session actions">
      <div className="session-actions-row">
        <button
          type="button"
          className="text-btn"
          disabled={busy !== null}
          onClick={() => void run("state", () => runtime.getState(), (value) => {
            const state = value as { messageCount?: number; sessionName?: string; isStreaming?: boolean };
            return `state: messageCount=${state.messageCount ?? 0}${state.sessionName ? `, name="${state.sessionName}"` : ""}, streaming=${state.isStreaming === true}`;
          })}
        >
          State
        </button>
        <button
          type="button"
          className="text-btn"
          disabled={busy !== null}
          onClick={() => void run("commands", () => runtime.getCommands(), (value) => {
            const commands = value as readonly { name?: string }[];
            return `commands (${commands.length}): ${commands.slice(0, 4).map((command) => command.name ?? "?").join(", ") || "none"}`;
          })}
        >
          Commands
        </button>
        <button
          type="button"
          className="text-btn"
          disabled={busy !== null}
          onClick={() => void run("lastText", () => runtime.getLastAssistantText(), (value) => {
            const text = String(value);
            return `last assistant text: ${text.length > 0 ? `"${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"` : "(none)"}`;
          })}
        >
          Last text
        </button>
        {hasStats ? (
          <button
            type="button"
            className="text-btn"
            disabled={busy !== null}
            onClick={() => void run("stats", () => runtime.getSessionStats(), (value) => {
              const stats = value as { messageCount?: number; tokenCount?: number };
              return `stats: messageCount=${stats.messageCount ?? 0}${stats.tokenCount === undefined ? "" : `, tokens=${stats.tokenCount}`}`;
            })}
          >
            Stats
          </button>
        ) : null}
      </div>
      {hasRename ? (
        <form className="session-actions-rename" onSubmit={handleRename}>
          <input
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            aria-label="Session name"
            placeholder="Rename session…"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
          />
          <button
            type="submit"
            className="text-btn"
            disabled={busy !== null || name.trim().length === 0}
          >
            Rename
          </button>
        </form>
      ) : null}
      {hasThinking ? (
        <form className="session-actions-thinking" onSubmit={handleThinkingSubmit}>
          <label className="session-actions-thinking-label">
            Thinking
            <select
              aria-label="Thinking level"
              value={selectedThinking}
              disabled={busy !== null}
              onChange={(event) => {
                setThinkingDraft(event.target.value as ThinkingLevel);
                if (error) setError(null);
              }}
            >
              {selectedThinking === "" ? (
                <option value="" disabled>
                  Select…
                </option>
              ) : null}
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <span className="session-actions-thinking-meta" aria-live="polite">
            {snapshotThinking !== undefined ? `current: ${snapshotThinking}` : "current: —"}
            {snapshotPinned ? " · pinned" : " · not pinned"}
          </span>
          <button
            type="submit"
            className="text-btn"
            disabled={busy !== null || selectedThinking === ""}
          >
            Set thinking
          </button>
        </form>
      ) : null}
      {busy !== null ? <p className="session-actions-status" role="status">Loading…</p> : null}
      {output !== null ? <p className="session-actions-ok" role="status">{output}</p> : null}
      {error !== null ? <p className="session-actions-error" role="alert">{error}</p> : null}
    </section>
  );
}
