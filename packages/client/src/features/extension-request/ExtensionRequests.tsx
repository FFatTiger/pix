/**
 * ExtensionRequests — D2-P8 pending extension-UI request panel.
 *
 * Mounted by AppShell between TranscriptList and Composer when the selected
 * session is live. Renders pending INTERACTIVE requests (select/confirm/input/
 * editor/custom) in deterministic projection order; only the FIRST is operable
 * and is the focus target, later requests are visibly disabled with a fixed
 * waiting note. Unknown/non-interactive pending requests (defensive) render as
 * a passive fixed notice only — they NEVER produce a response command.
 *
 * The reply travels through the dedicated SessionStore slot
 * ({@link SessionStore.respondExtensionUi}) — final response ONLY, never
 * incremental `extension_ui_input`.
 *
 * Race/security/accessibility:
 *  - synchronous busyRef blocks same-tick double click before state commit;
 *  - mounted/generation/session/live/capability refs (patterned after
 *    SessionActions / D4 Sidebar) make late success/error after detach /
 *    reconnect / session switch / capability loss / request close inert;
 *  - errors are keyed by the request CONTENT (not id), so request-id reuse can
 *    never write into a new form's state;
 *  - editor prefill is seeded ONCE per request identity (replays never reset the
 *    user's draft);
 *  - fixed describeExtensionUiError copy; no modal/window.confirm; inline
 *    region keeps the transcript readable; polite arrival/status, form labels,
 *    aria-busy/disabled; no entrance animation.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ExtensionUiRequest } from "@fffattiger/pix-protocol";
import { useRuntime } from "@/runtime";
import {
  EXTENSION_UI_CAPABILITY,
  activeInteractiveRequests,
  describeExtensionUiError,
  isExtensionReplyCompatible,
  isInteractiveRequest,
  type ExtensionUiReply,
  type InteractiveExtensionUiRequest,
} from "./extension-request";

export interface ExtensionRequestsProps {
  /**
   * Selection gate (history-switching fix): true only when the selected session
   * IS the attached runtime. The panel never renders for a non-live view.
   */
  live: boolean;
  /**
   * Explicit composer-textarea ref (no document queries). After the final
   * request closes/cancels, focus returns here when still same session/live/
   * capability and the textarea is usable.
   */
  composerTextareaRef?: RefObject<HTMLTextAreaElement | null>;
}

interface CardProps {
  request: InteractiveExtensionUiRequest;
  operable: boolean;
  waiting: boolean;
  replyPending: boolean;
  draft: string;
  onDraftChange: (id: string, value: string) => void;
  onRespond: (request: InteractiveExtensionUiRequest, reply: ExtensionUiReply) => void;
  error: string | null;
  cancelRef: (el: HTMLButtonElement | null) => void;
}

function ExtensionRequestCard({ request, operable, waiting, replyPending, draft, onDraftChange, onRespond, error, cancelRef }: CardProps) {
  const disabled = !operable || replyPending;
  const submit = (reply: ExtensionUiReply): void => {
    if (disabled || !isExtensionReplyCompatible(request, reply)) return;
    onRespond(request, reply);
  };

  let body: React.ReactNode;
  switch (request.method) {
    case "confirm":
      body = (
        <div className="extension-request-form">
          <p className="extension-request-message">{request.message}</p>
          <div className="extension-request-actions">
            <button type="button" className="extension-request-btn extension-request-btn--primary" disabled={disabled} aria-busy={replyPending} onClick={() => submit({ responseKind: "confirmed", confirmed: true })}>
              Confirm
            </button>
            <button type="button" className="extension-request-btn" disabled={disabled} ref={cancelRef} onClick={() => submit({ responseKind: "cancelled", cancelled: true })}>
              Cancel
            </button>
          </div>
        </div>
      );
      break;
    case "select":
      body = (
        <div className="extension-request-form">
          <ul className="extension-request-options" aria-label={request.title}>
            {request.options.map((option, index) => (
              <li key={`${request.id}:${index}`}>
                <button type="button" className="extension-request-option" disabled={disabled} onClick={() => submit({ responseKind: "selected", selected: option })}>
                  {option}
                </button>
              </li>
            ))}
          </ul>
          <div className="extension-request-actions">
            <button type="button" className="extension-request-btn" disabled={disabled} ref={cancelRef} onClick={() => submit({ responseKind: "cancelled", cancelled: true })}>
              Cancel
            </button>
          </div>
        </div>
      );
      break;
    case "input":
      body = (
        <div className="extension-request-form">
          <input
            type="text"
            className="extension-request-input"
            value={draft}
            onChange={(event) => onDraftChange(request.id, event.target.value)}
            placeholder={request.placeholder}
            aria-label={request.title}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (event.nativeEvent.isComposing) return; // IME composition Enter must not submit
              if (draft.length > 0) submit({ responseKind: "value", value: draft });
            }}
          />
          <div className="extension-request-actions">
            <button type="button" className="extension-request-btn extension-request-btn--primary" disabled={disabled} aria-busy={replyPending} onClick={() => submit({ responseKind: "value", value: draft })}>
              Submit
            </button>
            <button type="button" className="extension-request-btn" disabled={disabled} ref={cancelRef} onClick={() => submit({ responseKind: "cancelled", cancelled: true })}>
              Cancel
            </button>
          </div>
        </div>
      );
      break;
    case "editor":
      body = (
        <div className="extension-request-form">
          <textarea
            className="extension-request-input"
            rows={5}
            value={draft}
            onChange={(event) => onDraftChange(request.id, event.target.value)}
            aria-label={request.title}
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing) return; // IME guard: never submit mid-composition
              if (event.metaKey || event.ctrlKey) {
                event.preventDefault(); // Cmd/Ctrl+Enter submits; plain Enter is a newline
                submit({ responseKind: "value", value: draft });
              }
            }}
          />
          <div className="extension-request-actions">
            <button type="button" className="extension-request-btn extension-request-btn--primary" disabled={disabled} aria-busy={replyPending} onClick={() => submit({ responseKind: "value", value: draft })}>
              Submit
            </button>
            <button type="button" className="extension-request-btn" disabled={disabled} ref={cancelRef} onClick={() => submit({ responseKind: "cancelled", cancelled: true })}>
              Cancel
            </button>
          </div>
        </div>
      );
      break;
    case "custom": {
      const hasLines = request.lines.length > 0;
      body = (
        <div className="extension-request-form">
          <div className="extension-request-lines">
            {hasLines
              ? request.lines.map((line, index) => <p key={index} className="extension-request-line">{line}</p>)
              : <p className="extension-request-line extension-request-line--empty">(no content)</p>}
          </div>
          <input
            type="text"
            className="extension-request-input"
            value={draft}
            onChange={(event) => onDraftChange(request.id, event.target.value)}
            aria-label="Custom request answer"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (event.nativeEvent.isComposing) return;
              if (draft.length > 0) submit({ responseKind: "value", value: draft });
            }}
          />
          <div className="extension-request-actions">
            <button type="button" className="extension-request-btn extension-request-btn--primary" disabled={disabled} aria-busy={replyPending} onClick={() => submit({ responseKind: "value", value: draft })}>
              Submit
            </button>
            <button type="button" className="extension-request-btn" disabled={disabled} ref={cancelRef} onClick={() => submit({ responseKind: "cancelled", cancelled: true })}>
              Cancel
            </button>
          </div>
        </div>
      );
      break;
    }
  }

  // custom has no `title` in the Protocol schema — use a fixed neutral heading.
  const heading = request.method === "custom" ? "Custom request" : request.title;

  return (
    <article className={`extension-request-card${operable ? " extension-request-card--active" : ""}`} aria-busy={replyPending}>
      <h3 className="extension-request-title">{heading}</h3>
      {body}
      {waiting ? <p className="extension-request-waiting" role="status">Waiting for the previous extension request to finish.</p> : null}
      {error !== null ? <p className="extension-request-error" role="alert">{error}</p> : null}
    </article>
  );
}

export function ExtensionRequests({ live, composerTextareaRef }: ExtensionRequestsProps) {
  const runtime = useRuntime();

  // Race-safe identity refs (SessionActions / D4 Sidebar pattern).
  const mountedRef = useRef(true);
  const liveRef = useRef(live);
  const sessionIdRef = useRef<string | null>(runtime.sessionId);
  const capabilityRef = useRef(false);
  const requestGenRef = useRef(0);
  /** Synchronous same-tick singleflight: React state is async, this ref is not. */
  const busyRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenRef.current += 1; // invalidate any in-flight UI settle
    };
  }, []);

  useLayoutEffect(() => {
    liveRef.current = live;
    if (!live) requestGenRef.current += 1;
  }, [live]);
  useLayoutEffect(() => {
    if (sessionIdRef.current !== runtime.sessionId) {
      sessionIdRef.current = runtime.sessionId;
      requestGenRef.current += 1;
    }
  }, [runtime.sessionId]);

  const capability = runtime.capabilities?.capabilities.includes(EXTENSION_UI_CAPABILITY) === true;
  const gated = live && capability;
  const pending = gated ? (runtime.snapshot?.state.pendingExtensionUi ?? []) : [];
  const interactive = activeInteractiveRequests(gated ? runtime.snapshot : null);
  // Defensive: known non-interactive OR unknown methods get a passive notice only.
  const noninteractive = pending.filter((request) => !isInteractiveRequest(request));

  useLayoutEffect(() => {
    capabilityRef.current = capability;
    if (!capability) requestGenRef.current += 1;
  }, [capability]);

  // --- editor prefill: seed ONCE per request identity; replays/re-emits never reset ---
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const seededRef = useRef(new Map<string, string>()); // requestId → request content hash
  // Collision-proof identity key (ids are opaque strings; never joined with a
  // delimiter that could appear inside an id).
  const pendingKey = JSON.stringify(interactive.map((request) => request.id));

  const [error, setError] = useState<{ requestContent: string; message: string } | null>(null);

  useLayoutEffect(() => {
    if (!gated) return;
    const seen = new Set<string>();
    // Only a CLOSE or a same-id REUSE invalidates in-flight settles. A fresh
    // request appended BEHIND the current first must NOT invalidate the current
    // request's in-flight reply (its settle is still relevant to its own card).
    let landscapeChanged = false;
    for (const request of interactive) {
      seen.add(request.id);
      const hash = JSON.stringify(request);
      const prevHash = seededRef.current.get(request.id);
      const seed = request.method === "editor" ? (request.prefill ?? "") : "";
      if (prevHash === undefined) {
        seededRef.current.set(request.id, hash);
        setDrafts((prev) => ({ ...prev, [request.id]: seed }));
      } else if (prevHash !== hash) {
        // Same id re-used with different content (closed then re-issued): re-seed
        // and invalidate any in-flight settle for the OLD content.
        seededRef.current.set(request.id, hash);
        landscapeChanged = true;
        setDrafts((prev) => ({ ...prev, [request.id]: seed }));
      }
    }
    for (const id of [...seededRef.current.keys()]) {
      if (!seen.has(id)) {
        seededRef.current.delete(id);
        landscapeChanged = true; // request close invalidates in-flight settles
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    }
    if (landscapeChanged) requestGenRef.current += 1;
    // Errors bound to a closed/re-used request are dropped on the next pass.
    setError((prev) => (prev !== null && interactive.some((request) => JSON.stringify(request) === prev.requestContent) ? prev : null));
  }, [pendingKey, gated]);

  // --- focus management ---
  const cancelRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeRequestIdRef = useRef<string | null>(null);
  const firstRequestId = interactive[0]?.id ?? null;

  useLayoutEffect(() => {
    if (!gated) {
      activeRequestIdRef.current = null;
      return;
    }
    const prevActive = activeRequestIdRef.current;
    if (firstRequestId === null) {
      // All requests closed/cancelled: restore focus to the Composer textarea
      // once, only while still mounted + same live session + capability.
      if (prevActive !== null) {
        activeRequestIdRef.current = null;
        const textarea = composerTextareaRef?.current;
        if (textarea !== null && textarea !== undefined && mountedRef.current && liveRef.current && capabilityRef.current && sessionIdRef.current === runtime.sessionId) {
          textarea.focus();
        }
      }
      return;
    }
    if (prevActive !== firstRequestId) {
      // A request became the first/operable target (arrival or the previous one
      // closed). Focus its safe Cancel control — never stolen on plain re-renders.
      activeRequestIdRef.current = firstRequestId;
      cancelRefs.current.get(firstRequestId)?.focus();
    }
  }, [firstRequestId, gated, runtime.sessionId, runtime.attached]);

  if (!gated) return null;
  if (interactive.length === 0 && noninteractive.length === 0) return null;

  const replyPending = runtime.extensionUiReplyPending;
  const statusText = interactive.length === 0
    ? ""
    : replyPending
      ? "Sending response…"
      : interactive.length === 1
        ? "Extension is waiting for a response."
        : `${interactive.length} extension requests pending.`;

  const isCurrent = (gen: number, sessionId: string | null): boolean =>
    mountedRef.current &&
    liveRef.current &&
    capabilityRef.current &&
    gen === requestGenRef.current &&
    sessionId !== null &&
    sessionId === sessionIdRef.current;

  const runRespond = (request: ExtensionUiRequest, reply: ExtensionUiReply): void => {
    // Only the first/operable request may answer; disabled controls never reach here.
    if (busyRef.current !== null) return;
    if (!mountedRef.current || !liveRef.current || !capabilityRef.current) return;
    if (replyPending) return;
    if (activeRequestIdRef.current !== request.id) return;
    const sessionId = sessionIdRef.current;
    const gen = ++requestGenRef.current;
    const requestContent = JSON.stringify(request);
    busyRef.current = request.id;
    setError(null);
    void runtime.respondExtensionUi(request, reply).then(
      () => {
        // Late success after close/reuse/session/cap loss is inert.
        if (isCurrent(gen, sessionId)) setError(null);
      },
      (cause: unknown) => {
        if (isCurrent(gen, sessionId)) setError({ requestContent, message: describeExtensionUiError(cause) });
      },
    ).finally(() => {
      if (busyRef.current === request.id) busyRef.current = null;
    });
  };

  const handleRegionKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    const target = event.target as HTMLElement;
    // Never cancel from inside a text field (IME-safe; Escape there is editing).
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const first = interactive[0];
    if (first === undefined) return;
    event.preventDefault();
    runRespond(first, { responseKind: "cancelled", cancelled: true });
  };

  const errorFor = (request: ExtensionUiRequest): string | null =>
    error !== null && error.requestContent === JSON.stringify(request) ? error.message : null;

  const setDraft = (id: string, value: string): void => {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  };

  return (
    <section className="extension-requests" role="region" aria-label="Extension request" onKeyDown={handleRegionKeyDown}>
      {interactive.length > 0 ? (
        <ol className="extension-request-list">
          {interactive.map((request, index) => (
            <li key={request.id} className="extension-request-item">
              <ExtensionRequestCard
                request={request}
                operable={index === 0}
                waiting={index > 0}
                replyPending={replyPending}
                draft={drafts[request.id] ?? ""}
                onDraftChange={setDraft}
                onRespond={runRespond}
                error={errorFor(request)}
                cancelRef={(el) => {
                  if (el) cancelRefs.current.set(request.id, el);
                  else cancelRefs.current.delete(request.id);
                }}
              />
            </li>
          ))}
        </ol>
      ) : null}
      {noninteractive.length > 0 ? (
        <p className="extension-request-notice" role="status">The extension updated its status without a request.</p>
      ) : null}
      {statusText !== "" ? <p className="extension-request-status" role="status" aria-live="polite">{statusText}</p> : null}
    </section>
  );
}
