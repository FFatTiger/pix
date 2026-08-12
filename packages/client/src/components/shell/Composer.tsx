import { useState } from "react";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useRuntime } from "@/runtime";

/**
 * Runtime-aware composer. Send/Abort are driven by the live SessionStore:
 *  - Send is enabled only when attached AND the host advertises the `agent`
 *    capability AND no stream is in flight.
 *  - While streaming, an accessible Abort control issues the independent abort
 *    interrupt (never queued behind the running prompt).
 * The composer is honestly disabled (with a reason) when capability/attach is
 * missing — it does not fabricate a usable agent surface.
 */
export interface ComposerProps {
  /**
   * Explicit selection gate (history-switching fix). When `false` the selected
   * session is NOT the attached runtime (viewing history or a stale live
   * session), so the composer is honestly disabled even though a runtime may
   * still be attached to some OTHER session. When omitted the legacy behavior
   * applies: usable whenever the runtime is attached.
   */
  live?: boolean;
}

export function Composer({ live: liveProp }: ComposerProps) {
  const { canAgent } = useCapabilities();
  const runtime = useRuntime();
  const [text, setText] = useState("");

  // `live` is true only when the selected session IS the attached runtime.
  const live = liveProp ?? runtime.attached;
  // Only the SELECTED live session's stream controls this composer. When the
  // selection is not live (viewing history while some other session streams),
  // never show that stale session's streaming state or Abort control.
  const streaming = live && runtime.streaming;
  const canSend = canAgent && live && !streaming && text.trim().length > 0 && !runtime.sessionStopped;
  const disabledReason = runtime.sessionStopped
    ? "session stopped"
    : !canAgent
      ? "host has no agent capability"
      : !live
        ? runtime.attached
          ? "selected session is not live"
          : runtime.connection === "idle"
            ? "no project selected"
            : "runtime not attached"
        : streaming
          ? "agent is responding"
          : "";

  const handleSend = (): void => {
    if (!canSend) return;
    const message = text;
    setText("");
    void runtime.sendPrompt(message).catch(() => undefined);
  };

  const handleAbort = (): void => {
    void runtime.abort().catch(() => undefined);
  };

  return (
    <footer className={`composer${canSend ? "" : " composer--disabled"}`}>
      <div className="composer-inner">
        <textarea
          className="composer-input"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder={canAgent && live ? "Message the agent…" : "Composer disabled"}
          disabled={!canAgent || !live || streaming || runtime.sessionStopped}
          aria-disabled={!canAgent || !live}
          aria-label="Message the agent"
        />
        <div className="composer-toolbar">
          <span className="composer-status" aria-live="polite">
            {streaming ? "streaming" : live ? "ready" : disabledReason || "readonly"}
          </span>
          {streaming ? (
            <button type="button" className="composer-abort" onClick={handleAbort} aria-label="Abort the running response">
              Abort
            </button>
          ) : null}
          <button type="button" className="composer-send" onClick={handleSend} disabled={!canSend}>
            Send
          </button>
        </div>
      </div>
    </footer>
  );
}
