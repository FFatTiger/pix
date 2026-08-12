import { useState, type FormEvent } from "react";
import { useRuntime } from "@/runtime";

/**
 * SessionActions — D2-P1 minimal runtime inspection/mutation panel.
 *
 * While attached:
 *  - always-available queries: state / commands / last assistant text;
 *  - capability-gated actions shown ONLY when the runtime advertises them:
 *    session stats (`runtime.stats`) and rename (`runtime.session.rename`).
 *
 * Success / error / loading are surfaced inline. Rename resolves on the runtime
 * command result and then refreshes the snapshot (fetchSnapshot) so the new
 * sessionName is visible; it NEVER writes a history/catalog projection — session
 * persistence is the runtime's job, not the client's.
 */
function describeError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
}

export function SessionActions() {
  const runtime = useRuntime();
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const capabilities = runtime.capabilities?.capabilities ?? [];
  const hasStats = capabilities.includes("runtime.stats");
  const hasRename = capabilities.includes("runtime.session.rename");

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    render: (value: unknown) => string,
  ): Promise<void> => {
    setBusy(key);
    setError(null);
    setOutput(null);
    try {
      setOutput(render(await action()));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy !== null) return;
    setBusy("rename");
    setError(null);
    setOutput(null);
    try {
      // Honest rename: resolve on the runtime command result, then refresh the
      // snapshot so the new sessionName is visible. No catalog write here.
      await runtime.setSessionName(trimmed);
      await runtime.fetchSnapshot();
      setName("");
      setOutput(`Renamed session to "${trimmed}".`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
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
      {busy !== null ? <p className="session-actions-status" role="status">Loading…</p> : null}
      {output !== null ? <p className="session-actions-ok" role="status">{output}</p> : null}
      {error !== null ? <p className="session-actions-error" role="alert">{error}</p> : null}
    </section>
  );
}
