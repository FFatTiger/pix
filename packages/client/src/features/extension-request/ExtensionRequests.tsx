/**
 * ExtensionRequests — exact extension UI surface for the live session.
 *
 * Replaces the former pix inline extension cards with the components migrated
 * verbatim from the source ChatWindow:
 *  - a pending `custom` request renders the ExtensionCustomPanel
 *    (custom-ui-terminal): every keydown travels as raw terminal data through
 *    {@link SessionStore.sendExtensionUiInput} — the store's dedicated FIFO
 *    lane preserves exact per-key order while the final-response slot stays
 *    independent; Close sends `\x03` exactly like the source.
 *  - every other interactive request (select/confirm/input/editor) renders the
 *    source ExtensionDialog; its reply travels through the dedicated
 *    {@link SessionStore.respondExtensionUi} final-response slot.
 *
 * Only the FIRST pending interactive request is operable (projection order is
 * deterministic); later requests wait — the runtime would answer
 * `session_busy` anyway. Non-interactive pending requests never produce a
 * response command (defensive; the projection only stores interactive ones
 * plus status tombstones).
 *
 * Focus restore: when the last request closes/cancels, focus returns to the
 * composer textarea (the AppShell-owned ref) while still same session/live/
 * capability — no document queries.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useRuntime } from "@/runtime";
import { ExtensionDialog, type ExtensionDialogRequest, type ExtensionDialogResponse } from "@/components/chat/ExtensionDialog";
import { ExtensionCustomPanel, type ExtensionCustomRequest } from "@/components/chat/ExtensionCustomPanel";
import {
  EXTENSION_UI_CAPABILITY,
  activeInteractiveRequests,
  describeExtensionUiError,
} from "./extension-request";
import type { ExtensionUiReply } from "./extension-request";

export interface ExtensionRequestsProps {
  /**
   * Selection gate (history-switching fix): true only when the selected session
   * IS the attached runtime. The surface never renders for a non-live view.
   */
  live: boolean;
  /**
   * Explicit composer-textarea ref (no document queries). After the final
   * request closes/cancels, focus returns here when still same session/live/
   * capability and the textarea is usable.
   */
  composerTextareaRef?: RefObject<HTMLTextAreaElement | null>;
}

function toReply(request: ExtensionDialogRequest, response: ExtensionDialogResponse): ExtensionUiReply {
  if ("cancelled" in response) return { responseKind: "cancelled", cancelled: true };
  if ("confirmed" in response) return { responseKind: "confirmed", confirmed: response.confirmed };
  // select requests answer with their chosen option; input/editor with the value.
  if (request.method === "select") return { responseKind: "selected", selected: response.value };
  return { responseKind: "value", value: response.value };
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
  const [error, setError] = useState<string | null>(null);

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
  useLayoutEffect(() => {
    capabilityRef.current = capability;
    if (!capability) requestGenRef.current += 1;
  }, [capability]);

  const gated = live && capability;
  const interactive = activeInteractiveRequests(gated ? runtime.snapshot : null);
  const first = interactive[0] ?? null;

  // Drop a stale error as soon as the request landscape changes.
  const pendingKey = JSON.stringify(interactive.map((request) => request.id));
  useEffect(() => {
    setError(null);
  }, [pendingKey]);

  // --- focus management ---
  const activeRequestIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!gated) {
      activeRequestIdRef.current = null;
      return;
    }
    const prevActive = activeRequestIdRef.current;
    if (first === null) {
      // All requests closed/cancelled: restore focus to the composer textarea
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
    activeRequestIdRef.current = first.id;
  }, [first, gated, runtime.sessionId, runtime.attached]);

  if (!gated || first === null) return null;

  const isCurrent = (gen: number, sessionId: string | null): boolean =>
    mountedRef.current &&
    liveRef.current &&
    capabilityRef.current &&
    gen === requestGenRef.current &&
    sessionId !== null &&
    sessionId === sessionIdRef.current;

  const runRespond = (request: ExtensionDialogRequest, response: ExtensionDialogResponse): void => {
    if (busyRef.current !== null) return;
    if (!mountedRef.current || !liveRef.current || !capabilityRef.current) return;
    if (runtime.extensionUiReplyPending) return;
    if (activeRequestIdRef.current !== request.id) return;
    const sessionId = sessionIdRef.current;
    const gen = ++requestGenRef.current;
    busyRef.current = request.id;
    setError(null);
    void runtime.respondExtensionUi(request, toReply(request, response)).then(
      () => {
        if (isCurrent(gen, sessionId)) setError(null);
      },
      (cause: unknown) => {
        if (isCurrent(gen, sessionId)) setError(describeExtensionUiError(cause));
      },
    ).finally(() => {
      if (busyRef.current === request.id) busyRef.current = null;
    });
  };

  const runInput = (request: ExtensionCustomRequest, data: string): void => {
    if (!mountedRef.current || !liveRef.current || !capabilityRef.current) return;
    // Per-key FIFO ordering, overflow handling and same-epoch resend are owned
    // by the store's extension-UI input lane; the panel never awaits an ack.
    void runtime.sendExtensionUiInput(request, data).catch(() => undefined);
  };

  return (
    <section className="extension-requests" aria-label="Extension request">
      {first.method === "custom" ? (
        <ExtensionCustomPanel request={first} onInput={runInput} />
      ) : (
        <ExtensionDialog request={first} onRespond={runRespond} />
      )}
      {error !== null ? (
        <p className="extension-request-error" role="alert" style={{ margin: 0 }}>{error}</p>
      ) : null}
    </section>
  );
}
