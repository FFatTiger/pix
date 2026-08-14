import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ThinkingLevelSchema, type ThinkingLevel } from "@fffattiger/pix-protocol";
import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "@/runtime";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useHttpClient } from "@/app/http-context";
import { createQueryOptions } from "@/api/query-keys";

/**
 * SessionActions — D2-P1/P2/P3 minimal runtime inspection/mutation panel.
 *
 * While attached AND the selected session matches the live runtime:
 *  - always-available queries: state / commands / last assistant text;
 *  - capability-gated actions shown ONLY when the runtime advertises them:
 *    session stats (`runtime.stats`), thinking level (`runtime.thinking.set`),
 *    model (`runtime.model.set`).
 *
 * The runtime rename (`runtime.session.rename`) surface is intentionally NOT
 * rendered here — the Sidebar is the single visible rename product surface
 * (D4, Host `session.write` PATCH). The lower-level `runtime.setSessionName`
 * helper and its SessionStore tests are preserved unchanged.
 *
 * Success / error / loading are surfaced inline. Mutating actions resolve on
 * the runtime command result and then refresh the snapshot (fetchSnapshot) so
 * the new state is visible; they NEVER write a history/catalog projection —
 * session persistence is the runtime's job, not the client's.
 *
 * Race / identity:
 *  - singleflight via `busy` disables concurrent submits;
 *  - request identity is captured at submit; late settles from a previous
 *    session / unmount / capability revoke / cwd switch never update UI or
 *    surface errors for the new view;
 *  - render never issues a runtime command (the model control issues only the
 *    read-only Models HTTP query, gated on Host `models` capability).
 */

/** Protocol-derived thinking levels — never a free-form string union. */
const THINKING_LEVELS = ThinkingLevelSchema.options;

/** Fixed safe UI copy — never render raw ProtocolError.message for thinking. */
const THINKING_ERROR_MESSAGE = "Failed to update thinking level.";

/** Fixed safe UI copy — never render raw ProtocolError message/body/cause. */
const MODEL_ERROR_MESSAGE = "Failed to change model.";
const MODEL_UNAVAILABLE_MESSAGE = "Model is unavailable.";
const MODEL_AUTH_MESSAGE = "Provider is not authenticated.";

/**
 * Model control error copy is structured-code-driven, never raw. Unknown /
 * not_found / unavailable collapse to a fixed “unavailable”; auth maps to a
 * fixed auth hint; everything else is the generic fixed failure.
 */
function describeModelError(cause: unknown): string {
  const rec = cause && typeof cause === "object" ? (cause as Record<string, unknown>) : {};
  const code = typeof rec.code === "string" ? rec.code : "";
  const causeRec = rec.cause && typeof rec.cause === "object" ? (rec.cause as Record<string, unknown>) : {};
  const kind = typeof causeRec.kind === "string" ? causeRec.kind : "";
  if (code === "auth" || kind === "auth") return MODEL_AUTH_MESSAGE;
  if (code === "invalid_input" || code === "not_found" || code === "unavailable") return MODEL_UNAVAILABLE_MESSAGE;
  return MODEL_ERROR_MESSAGE;
}

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
  const { can } = useCapabilities();
  const http = useHttpClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinkingDraft, setThinkingDraft] = useState<ThinkingLevel | "">("");
  const [modelDraft, setModelDraft] = useState("");

  // Identity for race-safe late settles: session + mount generation.
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(runtime.sessionId);
  const selectionLiveRef = useRef(live !== false);
  const requestGenRef = useRef(0);
  // Model submit gate (cwd + capability revoke) must be observable from the
  // in-flight async continuation via a ref — render-scope values are stale by
  // the time a late settle runs.
  const modelGateRef = useRef({ live: live !== false, cwd: runtime.snapshot?.cwd ?? null, modelSet: false, canModels: false });

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
    setModelDraft("");
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
    setModelDraft("");
  }, [live]);

  const capabilities = runtime.capabilities?.capabilities ?? [];
  const hasStats = capabilities.includes("runtime.stats");
  const hasThinking = capabilities.includes("runtime.thinking.set");
  const hasModelSet = capabilities.includes("runtime.model.set");

  // Model control gating: the RUNTIME set capability is distinct from the HOST
  // `models` catalog capability. Fetch happens only when the Host advertises
  // `models` (via CapabilityProvider) AND the runtime advertises set AND live.
  // The models query is keyed on the RUNTIME snapshot cwd — never the selected
  // history cwd and never hardcoded.
  const canModels = can("models");
  const runtimeCwd = runtime.snapshot?.cwd ?? null;
  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(runtimeCwd ?? ""),
    enabled: hasModelSet && canModels && live !== false && Boolean(runtimeCwd),
  });
  const modelOptions = useMemo(
    () =>
      (modelsQuery.data?.models ?? []).map((model, index) => ({
        // Collision-free option encoding: index key, NOT `provider:model` (a
        // provider/model id may legally contain a colon). Provider+modelId are
        // read back from the option by key at submit.
        key: String(index),
        provider: model.provider,
        modelId: model.id,
      })),
    [modelsQuery.data],
  );

  // Keep the draft valid against the current option list (refetch may drop the
  // previously selected model; a stale key must never be submitted).
  useEffect(() => {
    if (modelDraft !== "" && !modelOptions.some((option) => option.key === modelDraft)) setModelDraft("");
  }, [modelOptions, modelDraft]);

  // Capability/cwd revoke invalidates pending local model UI and keeps the gate
  // ref in sync for late-settle checks.
  useLayoutEffect(() => {
    modelGateRef.current = { live: live !== false, cwd: runtimeCwd, modelSet: hasModelSet, canModels };
    if (!hasModelSet || !canModels || runtimeCwd === null) {
      requestGenRef.current += 1;
      setBusy(null);
      setError(null);
      setOutput(null);
      setModelDraft("");
    }
  }, [live, hasModelSet, canModels, runtimeCwd]);

  // Selection gate AFTER all hooks (Rules of Hooks): never offer runtime actions
  // for a session that is not the one being viewed (e.g. still attached to A
  // while showing B), or on a read-only history view.
  if (live === false) return null;

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

  // Authoritative current model from the runtime snapshot (never optimistic).
  const currentModel = runtime.snapshot?.state.model ?? null;
  const currentKey =
    currentModel === null
      ? ""
      : (modelOptions.find((option) => option.provider === currentModel.provider && option.modelId === currentModel.id)?.key ?? "");
  const selectedKey = modelDraft !== "" ? modelDraft : currentKey;
  const selectedOption = modelOptions.find((option) => option.key === selectedKey);
  const isSameCurrent =
    selectedOption !== undefined &&
    currentModel !== null &&
    selectedOption.provider === currentModel.provider &&
    selectedOption.modelId === currentModel.id;
  const modelSelectDisabled =
    busy !== null ||
    modelOptions.length === 0 ||
    modelsQuery.isLoading ||
    !canModels;
  const modelSubmitDisabled =
    busy !== null ||
    selectedOption === undefined ||
    isSameCurrent;

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

  // Model submit additionally fails closed when the runtime set capability, Host
  // models capability or runtime cwd changed after the submit started.
  const isCurrentModelRequest = (gen: number, sessionId: string | null): boolean =>
    isCurrentRequest(gen, sessionId) &&
    modelGateRef.current.modelSet &&
    modelGateRef.current.canModels &&
    modelGateRef.current.cwd !== null;

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

  const handleModelSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy !== null || selectedOption === undefined || isSameCurrent) return;
    const provider = selectedOption.provider;
    const modelId = selectedOption.modelId;
    const sessionId = sessionIdRef.current;
    const gen = ++requestGenRef.current;
    setBusy("model");
    setError(null);
    setOutput(null);
    try {
      await runtime.setModel(provider, modelId);
      // Three guards BEFORE fetchSnapshot: mounted/selection/requestGen (via
      // isCurrentRequest) plus cwd/capability revoke (via modelGateRef) — a late
      // settle never refreshes, never writes status for the new view.
      if (!isCurrentModelRequest(gen, sessionId)) return;
      await runtime.fetchSnapshot();
      if (!isCurrentModelRequest(gen, sessionId)) return;
      // The snapshot now carries the authoritative new model AND the re-clamped
      // thinkingLevel/thinkingLevelPinned (adapter reapplies pinned thinking).
      setModelDraft("");
      setOutput(`Model set to "${provider}/${modelId}".`);
    } catch (cause) {
      // Fixed structured copy only — never render raw ProtocolError for model.
      if (!isCurrentModelRequest(gen, sessionId)) return;
      setError(describeModelError(cause));
    } finally {
      if (isCurrentModelRequest(gen, sessionId)) setBusy(null);
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
      {hasModelSet ? (
        <form className="session-actions-model" onSubmit={handleModelSubmit}>
          <label className="session-actions-model-label">
            Model
            <select
              aria-label="Model"
              value={selectedKey}
              disabled={modelSelectDisabled}
              onChange={(event) => {
                setModelDraft(event.target.value);
                if (error) setError(null);
              }}
            >
              {selectedKey === "" ? (
                <option value="" disabled>
                  {currentModel === null
                    ? "Select model…"
                    : "Current model not listed"}
                </option>
              ) : null}
              {modelOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.provider}/{option.modelId}
                </option>
              ))}
            </select>
          </label>
          <span className="session-actions-model-meta" aria-live="polite">
            {!canModels
              ? "Model catalog is unavailable."
              : modelsQuery.isLoading
                ? "Loading models…"
                : modelsQuery.isError
                  ? "Model list unavailable."
                  : modelOptions.length === 0
                    ? "No models available."
                    : currentModel === null
                      ? "current: —"
                      : `current: ${currentModel.provider}/${currentModel.id}`}
          </span>
          <button
            type="submit"
            className="text-btn"
            disabled={modelSubmitDisabled}
          >
            Set model
          </button>
        </form>
      ) : null}
      {busy !== null ? <p className="session-actions-status" role="status">Loading…</p> : null}
      {output !== null ? <p className="session-actions-ok" role="status">{output}</p> : null}
      {error !== null ? <p className="session-actions-error" role="alert">{error}</p> : null}
    </section>
  );
}
