import { useState, type RefObject } from "react";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useRuntime } from "@/runtime";
import { EXTENSION_UI_CAPABILITY, hasPendingInteractiveRequest } from "@/features/extension-request/extension-request";

/**
 * Runtime-aware composer. Send/Abort are driven by the live SessionStore:
 *  - idle: Send issues an ordinary prompt (enabled only when attached AND the
 *    host advertises the `agent` capability AND no stream is in flight).
 *  - while streaming (authoritative `snapshot.state.isStreaming` /
 *    `isPromptRunning`): an accessible Abort control issues the independent
 *    abort interrupt; with the `runtime.follow_up` capability the textarea and
 *    Send stay usable and Send/Enter send a follow_up (safe default); with the
 *    `runtime.steer` capability a compact Steer button sends the same draft as
 *    a steering message. Without those capabilities the composer keeps the
 *    existing disabled-while-streaming behavior.
 *  - queue display reads the authoritative `snapshot.state.queuedMessages` and
 *    shows each steering/follow-up text (image data is never rendered — only a
 *    fixed count placeholder). "Clear queue" appears only when the queue is
 *    non-empty AND the runtime advertises `runtime.queue`; capability revoke
 *    hides it immediately.
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
  /**
   * Explicit ref to the composer textarea (D2-P8). ExtensionRequests restores
   * focus here after the final extension request closes/cancels. No document
   * queries.
   */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

function imageCountLabel(count: number): string {
  return ` (${count} image${count === 1 ? "" : "s"})`;
}

/**
 * A queued-turn promise resolves with the correlated result (the transport
 * `ok:true` wire frame) even when the runtime outcome is `ok:false`
 * (e.g. unsupported_capability / external error). The draft is cleared only
 * when the RUNTIME outcome is actually ok.
 */
function isOkResult(value: unknown): boolean {
  const correlated = value as { result?: { ok?: boolean } } | null;
  return correlated?.result?.ok === true;
}

export function Composer({ live: liveProp, textareaRef }: ComposerProps) {
  const { canAgent } = useCapabilities();
  const runtime = useRuntime();
  const [text, setText] = useState("");

  // `live` is true only when the selected session IS the attached runtime.
  const live = liveProp ?? runtime.attached;
  // Only the SELECTED live session's stream controls this composer. When the
  // selection is not live (viewing history while some other session streams),
  // never show that stale session's streaming state or Abort control.
  const streaming = live && runtime.streaming;
  const sessionStopped = runtime.sessionStopped;

  // D2-P4: the authoritative prompt-running state comes from the snapshot
  // (isStreaming / isPromptRunning) — never inferred. Steer/follow-up/queue
  // behavior only changes when this selected live session is actually running.
  const promptRunning = live && (runtime.snapshot?.state.isStreaming === true || runtime.snapshot?.state.isPromptRunning === true);

  const capabilities = runtime.capabilities?.capabilities ?? [];
  const hasSteer = live && capabilities.includes("runtime.steer");
  const hasFollowUp = live && capabilities.includes("runtime.follow_up");
  const hasQueue = live && capabilities.includes("runtime.queue");
  // At most one queued turn (steer/follow_up) may be in flight; while one is
  // pending, Send and Steer are disabled (the draft stays editable).
  const queuedTurnPending = live && runtime.queuedTurnPending;

  // D2-P8: while at least one interactive extension request is pending for the
  // attached live session (and the runtime still advertises extension_ui), the
  // composer is disabled — the extension is blocking the turn awaiting input.
  const extensionUiWaiting =
    live &&
    runtime.capabilities?.capabilities.includes(EXTENSION_UI_CAPABILITY) === true &&
    hasPendingInteractiveRequest(runtime.snapshot);

  const baseDisabled = !canAgent || !live || sessionStopped;
  // Without follow_up capability, the input/Send stay disabled while streaming
  // (existing behavior); with it they remain usable and Send follows up.
  const streamingBlocksSend = promptRunning && !hasFollowUp;
  const textareaDisabled = baseDisabled || extensionUiWaiting || streamingBlocksSend;
  const textNonEmpty = text.trim().length > 0;
  const canSend = !baseDisabled && !queuedTurnPending && !extensionUiWaiting && textNonEmpty && !streamingBlocksSend;
  const sendIsFollowUp = promptRunning && hasFollowUp;
  const canSteer = !baseDisabled && promptRunning && hasSteer && !queuedTurnPending && !extensionUiWaiting && textNonEmpty;
  // Show the compact Steer control whenever the live streaming session
  // advertises `runtime.steer`; it is disabled when there is no draft or a
  // queued turn is already in flight.
  const showSteer = promptRunning && hasSteer;

  const disabledReason = sessionStopped
    ? "session stopped"
    : !canAgent
      ? "host has no agent capability"
      : !live
        ? runtime.attached
          ? "selected session is not live"
          : runtime.connection === "idle"
            ? "no project selected"
            : "runtime not attached"
        : extensionUiWaiting
          ? "Extension is waiting for input."
          : streamingBlocksSend
            ? "agent is responding"
            : "";

  const handleSend = (): void => {
    if (!canSend) return;
    const message = text;
    if (sendIsFollowUp) {
      // Follow-up draft clears only on a confirmed ok outcome (failure keeps the text).
      void runtime.followUp(message).then((value) => { if (isOkResult(value)) setText(""); }).catch(() => undefined);
    } else {
      setText("");
      void runtime.sendPrompt(message).catch(() => undefined);
    }
  };

  const handleSteer = (): void => {
    if (!canSteer) return;
    const message = text;
    // Steer draft clears only on a confirmed ok outcome (failure keeps the text).
    void runtime.steer(message).then((value) => { if (isOkResult(value)) setText(""); }).catch(() => undefined);
  };

  const handleClearQueue = (): void => {
    void runtime.clearQueue().catch(() => undefined);
  };

  // Authoritative queue projection (D2-P4). Images are NEVER rendered — only a
  // fixed count placeholder, so image data never leaks into the DOM.
  const queue = runtime.snapshot?.state.queuedMessages;
  const steering = queue?.steering ?? [];
  const followUpItems = queue?.followUp ?? [];
  const queueNonEmpty = steering.length > 0 || followUpItems.length > 0;

  return (
    <footer className={`composer${baseDisabled || queuedTurnPending || extensionUiWaiting ? " composer--disabled" : ""}`}>
      <div className="composer-inner">
        {live && queueNonEmpty ? (
          <div className="composer-queue">
            <div className="composer-queue-list" aria-label="Queued turns">
              {steering.map((turn, index) => (
                <span key={`steer-${index}`} className="composer-queue-item composer-queue-item--steer">
                  <span className="composer-queue-label">Steer</span>
                  <span className="composer-queue-text">{turn.message}</span>
                  {turn.images !== undefined && turn.images.length > 0 ? <span className="composer-queue-images">{imageCountLabel(turn.images.length)}</span> : null}
                </span>
              ))}
              {followUpItems.map((turn, index) => (
                <span key={`followup-${index}`} className="composer-queue-item composer-queue-item--followup">
                  <span className="composer-queue-label">Follow up</span>
                  <span className="composer-queue-text">{turn.message}</span>
                  {turn.images !== undefined && turn.images.length > 0 ? <span className="composer-queue-images">{imageCountLabel(turn.images.length)}</span> : null}
                </span>
              ))}
            </div>
            {hasQueue ? (
              <button type="button" className="composer-clear-queue" onClick={handleClearQueue} aria-label="Clear the queued turns">
                Clear queue
              </button>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
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
          disabled={textareaDisabled}
          aria-disabled={!canAgent || !live}
          aria-label="Message the agent"
        />
        <div className="composer-toolbar">
          <span className="composer-status" aria-live="polite">
            {streaming ? (sendIsFollowUp ? "streaming — Send follows up" : "streaming") : extensionUiWaiting ? "Extension is waiting for input." : live ? "ready" : disabledReason || "readonly"}
          </span>
          <span className="composer-actions">
            {streaming ? (
              <button type="button" className="composer-abort" onClick={() => { void runtime.abort().catch(() => undefined); }} aria-label="Abort the running response">
                Abort
              </button>
            ) : null}
            {showSteer ? (
              <button type="button" className="composer-steer" onClick={handleSteer} disabled={!canSteer} aria-label="Steer the running response">
                Steer
              </button>
            ) : null}
            <button type="button" className="composer-send" onClick={handleSend} disabled={!canSend} aria-label={sendIsFollowUp ? "Send a follow-up" : "Send"}>
              Send
            </button>
          </span>
        </div>
      </div>
    </footer>
  );
}
