import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowsClockwiseIcon,
  CheckIcon,
  CircleNotchIcon,
  PaperPlaneTiltIcon,
  StopIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { MAX_SIDE_CHAT_MESSAGE_CHARS, type ProtocolError } from "@fffattiger/pix-protocol";
import { MarkdownBody } from "@/components/chat/MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import type { ExactRuntimeApi } from "@/runtime";

type Translate = ReturnType<typeof useI18n>["t"];

export function describeSideChatError(error: unknown, t: Translate): string {
  const code = error !== null && typeof error === "object" ? (error as Partial<ProtocolError>).code : undefined;
  switch (code) {
    case "invalid_input": return t("desktop.sideChatErrorInvalid");
    case "session_busy": return t("desktop.sideChatErrorBusy");
    case "timeout": return t("desktop.sideChatErrorTimeout");
    case "unsupported_capability": return t("desktop.sideChatUnavailable");
    case "interrupted": return t("desktop.sideChatErrorInterrupted");
    case "unavailable": return t("desktop.sideChatErrorTransport");
    default: return t("desktop.sideChatErrorGeneric");
  }
}

export interface SideChatPanelProps {
  runtime: ExactRuntimeApi;
  cwd?: string | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
}

function TruncationNotice() {
  const { t } = useI18n();
  return <div className="side-chat-truncation" role="note">{t("desktop.sideChatTruncated")}</div>;
}

export function SideChatPanel({ runtime, cwd, onOpenFile }: SideChatPanelProps) {
  const { t } = useI18n();
  const state = runtime.snapshot?.state.sideChat ?? null;
  const [draftState, setDraftState] = useState<{ owner: string; value: string } | null>(null);
  const [pendingOperation, setPendingOperation] = useState<{ id: number; scope: string; name: string } | null>(null);
  const [initializing, setInitializing] = useState(state === null);
  const [operationError, setOperationError] = useState<{ scope: string; message: string } | null>(null);
  const conversationId = state?.conversationId ?? "none";
  const scope = `${runtime.sessionId}:${runtime.epoch ?? "none"}:${runtime.attachGeneration}:${conversationId}`;
  const draftOwner = `${runtime.sessionId}:${conversationId}`;
  const draft = draftState?.owner === draftOwner ? draftState.value : "";
  const pending = pendingOperation?.scope === scope ? pendingOperation.name : null;
  const error = operationError?.scope === scope ? operationError.message : null;
  const scopeRef = useRef(scope);
  const operationIdRef = useRef(0);
  const composingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  scopeRef.current = scope;

  useEffect(() => {
    scopeRef.current = scope;
    setPendingOperation((current) => current?.scope === scope ? current : null);
    setOperationError((current) => current?.scope === scope ? current : null);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = `stale:${scope}`;
    };
  }, [scope]);

  useEffect(() => {
    let active = true;
    if (state !== null) {
      setInitializing(false);
      return () => { active = false; };
    }
    const expectedScope = scope;
    setInitializing(true);
    setOperationError(null);
    void runtime.sideChatStart().then(
      () => { if (active && scopeRef.current === expectedScope) setInitializing(false); },
      (cause: unknown) => {
        if (!active || scopeRef.current !== expectedScope) return;
        setInitializing(false);
        setOperationError({ scope: expectedScope, message: describeSideChatError(cause, t) });
      },
    );
    return () => { active = false; };
  }, [runtime.sideChatStart, scope, state, t]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state?.revision, state?.stream.text, state?.stream.thinking]);

  const run = async (name: string, action: () => Promise<unknown>, onSuccess?: () => void): Promise<void> => {
    if (pending !== null) return;
    const operation = { id: ++operationIdRef.current, scope, name };
    setPendingOperation(operation);
    setOperationError(null);
    try {
      await action();
      if (scopeRef.current === operation.scope) onSuccess?.();
    } catch (cause) {
      if (scopeRef.current === operation.scope) {
        setOperationError({ scope: operation.scope, message: describeSideChatError(cause, t) });
      }
    } finally {
      setPendingOperation((current) => current?.id === operation.id && current.scope === operation.scope ? null : current);
    }
  };

  const send = (event?: FormEvent): void => {
    event?.preventDefault();
    const message = draft.trim();
    if (!state || state.status !== "idle" || pending !== null || message.length === 0) return;
    void run("send", () => runtime.sideChatSend(state.conversationId, message), () => {
      setDraftState((current) => current?.owner === draftOwner ? { owner: draftOwner, value: "" } : current);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || composingRef.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  if (state === null) {
    return (
      <section className="side-chat-panel" aria-label={t("desktop.sideChat")} data-testid="side-chat-panel">
        <div className="side-chat-empty" aria-busy={initializing || undefined}>
          {error ? <div className="side-chat-error" role="alert">{error}</div> : t("desktop.sideChatInitializing")}
        </div>
      </section>
    );
  }

  return (
    <section className="side-chat-panel" aria-label={t("desktop.sideChat")} data-testid="side-chat-panel">
      <header className="side-chat-context">
        <div className="side-chat-context-row">
          <strong>{state.capturedModel.provider}/{state.capturedModel.id}</strong>
          <span>{state.capturedThinkingLevel}</span>
        </div>
        <div>{t("desktop.sideChatLifetime")}</div>
      </header>

      <div className="side-chat-toolbar">
        <div className="side-chat-modes" role="group" aria-label={t("desktop.sideChatMode")}>
          <button
            type="button"
            className={state.mode === "read_only" ? "is-active" : undefined}
            aria-pressed={state.mode === "read_only"}
            disabled={pending !== null}
            onClick={() => void run("mode", () => runtime.sideChatSetMode(state.conversationId, "read_only"))}
          >
            {t("desktop.sideChatDiscussion")}
          </button>
          <button
            type="button"
            className={state.mode === "edit" ? "is-active" : undefined}
            aria-pressed={state.mode === "edit"}
            disabled={pending !== null}
            onClick={() => void run("mode", () => runtime.sideChatSetMode(state.conversationId, "edit"))}
          >
            {t("desktop.sideChatEdit")}
          </button>
        </div>
        <button
          type="button"
          className="side-chat-icon-button"
          title={t("desktop.sideChatRefork")}
          aria-label={t("desktop.sideChatRefork")}
          disabled={pending !== null}
          onClick={() => void run("refork", () => runtime.sideChatReset(state.conversationId, "refork"))}
        >
          <ArrowsClockwiseIcon size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="side-chat-icon-button"
          title={t("desktop.sideChatClear")}
          aria-label={t("desktop.sideChatClear")}
          disabled={pending !== null}
          onClick={() => void run("clear", () => runtime.sideChatReset(state.conversationId, "clear"))}
        >
          <TrashIcon size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="side-chat-mode-note">{state.mode === "read_only" ? t("desktop.sideChatDiscussionNote") : t("desktop.sideChatEditNote")}</div>

      <div className="side-chat-messages" ref={scrollRef} data-testid="side-chat-scroll">
        {state.messages.length === 0 && state.stream.text.length === 0 && state.stream.thinking.length === 0 ? (
          <div className="side-chat-empty">{t("desktop.sideChatEmpty")}</div>
        ) : null}
        {state.messages.map((message) => (
          <article key={message.id} className={`side-chat-message is-${message.role}${message.isError ? " is-error" : ""}`}>
            <div className="side-chat-message-label">
              {message.role === "user" ? t("desktop.sideChatYou") : message.role === "assistant" ? t("desktop.sideChatAssistant") : (message.toolName ?? t("desktop.sideChatTool"))}
            </div>
            {message.thinking ? (
              <details className="side-chat-thinking">
                <summary>{t("desktop.sideChatThinking")}</summary>
                <div>{message.thinking}</div>
                {message.thinkingTruncated ? <TruncationNotice /> : null}
              </details>
            ) : null}
            {message.role === "assistant" ? (
              <MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{message.text}</MarkdownBody>
            ) : (
              <div className="side-chat-plain-text">{message.text}</div>
            )}
            {message.textTruncated ? <TruncationNotice /> : null}
          </article>
        ))}
        {state.stream.thinking ? (
          <details className="side-chat-thinking" open>
            <summary>{t("desktop.sideChatThinking")}</summary>
            <div>{state.stream.thinking}</div>
            {state.stream.thinkingTruncated ? <TruncationNotice /> : null}
          </details>
        ) : null}
        {state.stream.text ? (
          <article className="side-chat-message is-assistant is-streaming">
            <div className="side-chat-message-label">{t("desktop.sideChatAssistant")}</div>
            <MarkdownBody isStreaming cwd={cwd} onOpenFile={onOpenFile}>{state.stream.text}</MarkdownBody>
            {state.stream.textTruncated ? <TruncationNotice /> : null}
          </article>
        ) : null}
        {state.tools.map((tool) => (
          <div key={tool.toolCallId} className={`side-chat-tool is-${tool.status}`}>
            {tool.status === "running" ? <CircleNotchIcon className="side-chat-spin" size={14} aria-hidden="true" /> : tool.status === "completed" ? <CheckIcon size={14} aria-hidden="true" /> : <XIcon size={14} aria-hidden="true" />}
            <span>{tool.name}</span>
            <span>{t(`desktop.sideChatToolStatus.${tool.status}`)}</span>
            {tool.nameTruncated ? <span title={t("desktop.sideChatTruncated")}>…</span> : null}
          </div>
        ))}
        {state.messagesTruncated || state.totalCharsTruncated ? <TruncationNotice /> : null}
        {state.error ? (
          <div className="side-chat-error" role="alert"><WarningCircleIcon size={15} aria-hidden="true" />{t("desktop.sideChatRunFailed")}</div>
        ) : null}
        {error ? <div className="side-chat-error" role="alert"><WarningCircleIcon size={15} aria-hidden="true" />{error}</div> : null}
        {state.pendingOverlap ? (
          <div className="side-chat-overlap" role="alert">
            <strong>{t("desktop.sideChatOverlapTitle")}</strong>
            <span>{state.pendingOverlap.path}</span>
            {state.pendingOverlap.pathTruncated ? <TruncationNotice /> : null}
            <div>
              <button type="button" disabled={pending !== null} onClick={() => void run("overlap", () => runtime.sideChatRespondOverlap(state.conversationId, state.pendingOverlap!.id, false))}>
                <XIcon size={14} aria-hidden="true" />{t("desktop.sideChatDeny")}
              </button>
              <button type="button" disabled={pending !== null} onClick={() => void run("overlap", () => runtime.sideChatRespondOverlap(state.conversationId, state.pendingOverlap!.id, true))}>
                <CheckIcon size={14} aria-hidden="true" />{t("desktop.sideChatApprove")}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <form className="side-chat-composer" onSubmit={send}>
        <textarea
          value={draft}
          maxLength={MAX_SIDE_CHAT_MESSAGE_CHARS}
          placeholder={t("desktop.sideChatPlaceholder")}
          aria-label={t("desktop.sideChatMessage")}
          disabled={pending !== null || state.status !== "idle"}
          onChange={(event) => setDraftState({ owner: draftOwner, value: event.target.value })}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
        />
        {state.status === "running" || state.status === "awaiting_overlap" ? (
          <button type="button" className="side-chat-send" aria-label={t("desktop.sideChatStop")} title={t("desktop.sideChatStop")} disabled={pending !== null} onClick={() => void run("abort", () => runtime.abortSideChat(state.conversationId))}>
            <StopIcon size={15} weight="fill" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="side-chat-send" aria-label={t("desktop.sideChatSend")} title={t("desktop.sideChatSend")} disabled={pending !== null || draft.trim().length === 0}>
            <PaperPlaneTiltIcon size={16} weight="fill" aria-hidden="true" />
          </button>
        )}
      </form>
    </section>
  );
}
