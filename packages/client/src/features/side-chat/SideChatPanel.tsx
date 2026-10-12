import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { createQueryOptions } from "@/api/query-keys";
import { MarkdownBody } from "@/components/chat/MarkdownBody";
import { ModelSelector, ThinkingLevelSelector } from "@/components/chat/composer-selectors";
import { useHttpClient } from "@/app/http-context";
import { useI18n } from "@/hooks/useI18n";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";
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

  // Model catalog for the selector — the same Host models query the main
  // composer uses (never a forked list source).
  const http = useHttpClient();
  const modelsQuery = useQuery({ ...createQueryOptions(http).models.list() });
  const modelList = useMemo(
    () => (modelsQuery.data?.models ?? []).map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.displayName ?? model.id,
    })),
    [modelsQuery.data],
  );
  const selectorsIdle = state !== null && state.status === "idle" && pending === null;
  const applyModel = (provider: string, modelId: string, thinkingLevel: ThinkingLevelOption): void => {
    if (state === null || thinkingLevel === "auto") return;
    void run("model", () => runtime.sideChatSetModel(state.conversationId, provider, modelId, thinkingLevel));
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
      <div className="side-chat-toolbar">
        <span className="side-chat-toolbar-spacer" />
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
        <div className="side-chat-composer-toolbar">
          <ThinkingLevelSelector
            thinkingLevel={state.thinkingLevel}
            onThinkingLevelChange={(level) => applyModel(state.model.provider, state.model.id, level)}
            disabled={!selectorsIdle}
            includeAuto={false}
            {...(selectorsIdle ? {} : { title: t("desktop.sideChatModelLocked") })}
          />
          <span className="side-chat-composer-actions">
            <ModelSelector
              model={{ provider: state.model.provider, modelId: state.model.id }}
              modelList={modelList}
              onModelChange={(provider, modelId) => applyModel(provider, modelId, state.thinkingLevel)}
              disabled={!selectorsIdle}
              {...(selectorsIdle ? {} : { title: t("desktop.sideChatModelLocked") })}
            />
            {state.status === "running" ? (
              <button type="button" className="side-chat-send" aria-label={t("desktop.sideChatStop")} title={t("desktop.sideChatStop")} disabled={pending !== null} onClick={() => void run("abort", () => runtime.abortSideChat(state.conversationId))}>
                <StopIcon size={15} weight="fill" aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className="side-chat-send" aria-label={t("desktop.sideChatSend")} title={t("desktop.sideChatSend")} disabled={pending !== null || draft.trim().length === 0}>
                <PaperPlaneTiltIcon size={16} weight="fill" aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      </form>
    </section>
  );
}
