import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { MAX_SIDE_CHAT_MESSAGE_CHARS, type ProtocolError, type ToolResultMessage } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { ChatInput, type ChatInputHandle } from "@/components/chat/ChatInput";
import { ChatTranscriptRowView } from "@/components/transcript/TranscriptList";
import { buildChatTranscriptRows } from "@/components/transcript/chat-projection";
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
  const [pendingOperation, setPendingOperation] = useState<{ id: number; scope: string; name: string } | null>(null);
  const [initializing, setInitializing] = useState(state === null);
  const [operationError, setOperationError] = useState<{ scope: string; message: string } | null>(null);
  const conversationId = state?.conversationId ?? "none";
  const scope = `${runtime.sessionId}:${runtime.epoch ?? "none"}:${runtime.attachGeneration}:${conversationId}`;
  const draftOwner = `${runtime.sessionId}:${conversationId}`;
  const pending = pendingOperation?.scope === scope ? pendingOperation.name : null;
  const error = operationError?.scope === scope ? operationError.message : null;
  const scopeRef = useRef(scope);
  const operationIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ChatInputHandle | null>(null);
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
  }, [state?.revision, state?.partialMessage]);

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
  const modelNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const model of modelList) names[`${model.provider}:${model.id}`] = model.name;
    return names;
  }, [modelList]);
  // Main-transcript projection over the side state (bounded by the wire
  // contract; identical rendering rules to the session transcript).
  const sideToolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of state?.messages ?? []) {
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    }
    return map;
  }, [state?.messages]);
  const sideChatRows = useMemo(() => {
    if (state === null) return [];
    return buildChatTranscriptRows({
      messages: state.messages,
      entryIds: state.messages.map((_message, index) => `side-${state.conversationId}-${index}`),
      // Same cast TranscriptList applies: the streaming partial feeds the
      // row projection as the live tail message.
      streamingMessage: (state.partialMessage ?? null) as Parameters<typeof buildChatTranscriptRows>[0]["streamingMessage"],
      running: state.status === "running",
      cwd,
    });
  }, [state?.conversationId, state?.messages, state?.partialMessage, state?.status, cwd]);
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
        <span className="side-chat-heading">{t("desktop.sideChat")}</span>
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
        {state.messages.length === 0 && state.partialMessage === null ? (
          <div className="side-chat-empty">{t("desktop.sideChatEmpty")}</div>
        ) : null}
        {/* Main-session rendering pipeline: the same row projection and row
            renderer as TranscriptList (process groups, thinking blocks, tool
            rows with arguments/results, model labels, streaming tail). */}
        {sideChatRows.map((row) => (
          <div key={row.key} className="transcript-row transcript-row--chat">
            <ChatTranscriptRowView
              row={row}
              cwd={cwd}
              sessionId={undefined}
              toolResults={sideToolResults}
              onOpenFile={onOpenFile === undefined ? undefined : (filePath) => onOpenFile(filePath)}
              modelNames={modelNames}
              mentionValidators={undefined}
              skillInfo={null}
            />
          </div>
        ))}
        {state.messagesTruncated || state.totalCharsTruncated ? <TruncationNotice /> : null}
        {state.error ? (
          <div className="side-chat-error" role="alert"><WarningCircleIcon size={15} aria-hidden="true" />{t("desktop.sideChatRunFailed")}</div>
        ) : null}
        {error ? <div className="side-chat-error" role="alert"><WarningCircleIcon size={15} aria-hidden="true" />{error}</div> : null}
      </div>

      {/* Same ChatInput as the main session (variant="side"): one component,
          one look; side chat simply has no attachments, slash commands or bash. */}
      <div className="side-chat-composer">
        <ChatInput
          ref={inputRef}
          variant="side"
          labels={{
            input: t("desktop.sideChatMessage"),
            send: t("desktop.sideChatSend"),
            stop: t("desktop.sideChatStop"),
            locked: t("desktop.sideChatModelLocked"),
          }}
          controlsLocked={!selectorsIdle}
          draftKey={`side-chat:${draftOwner}`}
          placeholder={t("desktop.sideChatPlaceholder")}
          onSend={(message: string) => {
            const text = message.trim();
            if (state.status !== "idle" || pending !== null || text.length === 0) return false;
            let sent = false;
            const sendScope = scope;
            void run("send", async () => {
              await runtime.sideChatSend(state.conversationId, text.slice(0, MAX_SIDE_CHAT_MESSAGE_CHARS));
              sent = true;
            }).then(() => {
              // A rejected send gives the text back instead of losing it.
              if (!sent && scopeRef.current === sendScope) inputRef.current?.insertIfEmpty(text);
            });
            return true;
          }}
          onAbort={() => void run("abort", () => runtime.abortSideChat(state.conversationId))}
          isStreaming={state.status === "running"}
          sendDisabled={pending !== null || state.status !== "idle"}
          model={{ provider: state.model.provider, modelId: state.model.id }}
          modelList={modelList}
          onModelChange={(provider: string, modelId: string) => applyModel(provider, modelId, state.thinkingLevel)}
          thinkingLevel={state.thinkingLevel}
          onThinkingLevelChange={(level: ThinkingLevelOption) => applyModel(state.model.provider, state.model.id, level)}
          availableThinkingLevels={["off", "minimal", "low", "medium", "high", "xhigh", "max"]}
          {...(modelNames === undefined ? {} : { modelNames })}
        />
      </div>
    </section>
  );
}
