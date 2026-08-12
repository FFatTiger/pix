import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  AgentMessage,
  BashProjection,
  SessionEntry,
  StreamingAgentMessage,
} from "@fffattiger/pix-protocol";
import {
  buildTranscriptRows,
  estimateRowHeight,
  flattenTranscriptParts,
  getTranscriptRowKey,
  type TranscriptMessageInput,
  type TranscriptPart,
  type TranscriptRow,
} from "./row-model";
import {
  flattenBashViewModel,
  LIVE_BASH_ROW_ID,
  projectBashViewModel,
  type BashViewModel,
} from "./bash-view-model";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useRuntime } from "@/runtime";

export interface TranscriptListProps {
  sessionId?: string;
  rows?: TranscriptRow[];
  overscan?: number;
  /**
   * Explicit selection gate (history-switching fix). When `true` the SELECTED
   * session is the attached runtime, so rows come from the live SessionStore
   * projection. When `false` rows come from session history even if some OTHER
   * session happens to be attached (never show a non-selected live stream). When
   * omitted the legacy behavior applies: live whenever the runtime is attached.
   */
  live?: boolean;
}

type AssistantBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];

/**
 * Shared block-aware projector for history entries, live completed messages,
 * and the live streaming partial. Preserves interleaving order of text/thinking
 * (and tool/image fallbacks). Empty thinking never becomes a visible part.
 *
 * Adjacent same-type text/thinking blocks are concatenated for display only:
 * the wire/runtime projection appends delta chunks without merging, so a pure
 * 1:1 mapping would fragment one streaming thought into many collapsibles.
 * Concatenation does not trim or rewrite characters — only joins adjacent peers.
 */
export function projectAssistantBlocks(
  content: readonly AssistantBlock[] | undefined,
  options: { streaming?: boolean } = {},
): TranscriptPart[] {
  if (!content) return [];
  const parts: TranscriptPart[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text": {
        const last = parts[parts.length - 1];
        if (last?.type === "text") {
          last.text = `${last.text}${block.text}`;
        } else {
          parts.push({ type: "text", text: block.text });
        }
        break;
      }
      case "thinking": {
        // Empty thinking must not produce a visible container. Non-empty raw
        // content is preserved as-is (no trim / rewrite of characters).
        if (block.thinking.length === 0) break;
        const last = parts[parts.length - 1];
        if (last?.type === "thinking") {
          last.thinking = `${last.thinking}${block.thinking}`;
          if (options.streaming) last.streaming = true;
        } else {
          parts.push({
            type: "thinking",
            thinking: block.thinking,
            ...(options.streaming ? { streaming: true } : {}),
          });
        }
        break;
      }
      case "toolCall":
        parts.push({
          type: "toolCall",
          text: `${block.toolName}(${JSON.stringify(block.input)})`,
        });
        break;
      case "image":
        parts.push({ type: "image", text: "[image]" });
        break;
      default: {
        const _exhaustive: never = block;
        void _exhaustive;
        break;
      }
    }
  }
  return parts;
}

function assistantBlocksText(content: AssistantBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "thinking":
      return content.thinking;
    case "toolCall":
      return `${content.toolName}(${JSON.stringify(content.input)})`;
    case "image":
      return "[image]";
    default:
      return "";
  }
}

function textOf(message: AgentMessage): string {
  if (message.role === "bashExecution") {
    return flattenBashViewModel(projectBashViewModel(message));
  }
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  if (message.role === "assistant") {
    return flattenTranscriptParts(projectAssistantBlocks(message.content));
  }
  return message.content.map((block) => assistantBlocksText(block as AssistantBlock)).join("\n");
}

function streamingTextOf(message: StreamingAgentMessage): string {
  if (message.role === "bashExecution") {
    return flattenBashViewModel(
      projectBashViewModel(message, {
        running: message.exitCode === undefined && message.cancelled !== true,
        completed: message.exitCode !== undefined || message.cancelled === true,
      }),
    );
  }
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  if (message.role === "assistant") {
    return flattenTranscriptParts(projectAssistantBlocks(message.content, { streaming: true }));
  }
  return message.content.map((block) => assistantBlocksText(block as AssistantBlock)).join("\n");
}

function roleOf(message: AgentMessage | StreamingAgentMessage): TranscriptMessageInput["role"] {
  if (message.role === "toolResult") return "tool";
  if (message.role === "custom") return "system";
  if (message.role === "bashExecution") return "bash";
  return message.role;
}

function partsOf(
  message: AgentMessage | StreamingAgentMessage,
  options: { streaming?: boolean } = {},
): TranscriptPart[] | undefined {
  if (message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) return undefined;
  return projectAssistantBlocks(message.content, options);
}

function bashOf(message: AgentMessage | StreamingAgentMessage): BashViewModel | undefined {
  if (message.role !== "bashExecution") return undefined;
  // History / completed runtime messages are settled; live lifecycle comes from state.bash.
  return projectBashViewModel(message);
}

function projectLiveBashState(
  bash: BashProjection,
  isBashRunning: boolean,
): BashViewModel {
  return projectBashViewModel(bash, {
    running: isBashRunning || bash.completed === false,
    completed: bash.completed === true,
  });
}

function toTranscript(entry: SessionEntry): TranscriptMessageInput {
  const message = entry.message;
  const parts = partsOf(message);
  const bash = bashOf(message);
  return {
    id: entry.entryId,
    role: roleOf(message),
    text: textOf(message),
    ...(parts === undefined ? {} : { parts }),
    ...(bash === undefined ? {} : { bash }),
    ...(message.role === "toolResult" && message.toolName ? { toolName: message.toolName } : {}),
    ...(message.timestamp === undefined ? {} : { createdAt: new Date(message.timestamp).toISOString() }),
  };
}

function runtimeMessageToInput(message: AgentMessage, index: number): TranscriptMessageInput {
  const parts = partsOf(message);
  const bash = bashOf(message);
  return {
    id: `row:msg:${index}`,
    role: roleOf(message),
    text: textOf(message),
    ...(parts === undefined ? {} : { parts }),
    ...(bash === undefined ? {} : { bash }),
    ...(message.role === "toolResult" && message.toolName ? { toolName: message.toolName } : {}),
    ...(message.timestamp === undefined ? {} : { createdAt: new Date(message.timestamp).toISOString() }),
  };
}

function streamingMessageToInput(message: StreamingAgentMessage): TranscriptMessageInput {
  const parts = partsOf(message, { streaming: true });
  const bash = bashOf(message);
  return {
    id: "row:partial",
    role: roleOf(message),
    text: streamingTextOf(message),
    ...(parts === undefined ? {} : { parts }),
    ...(bash === undefined ? {} : { bash }),
  };
}

function liveBashStateToInput(
  bash: BashProjection,
  isBashRunning: boolean,
): TranscriptMessageInput {
  const view = projectLiveBashState(bash, isBashRunning);
  return {
    id: LIVE_BASH_ROW_ID,
    role: "bash",
    text: flattenBashViewModel(view),
    bash: view,
  };
}

export function TranscriptList({ sessionId, rows: rowsProp, overscan = 8, live: liveProp }: TranscriptListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const http = useHttpClient();
  const { isReadonly, canBrowseSessions } = useCapabilities();
  const runtime = useRuntime();
  // The live projection is shown ONLY when the caller explicitly gates it (the
  // selected session IS the attached runtime). Without the prop, fall back to
  // the legacy behavior (live whenever attached) so standalone mounts keep
  // working. A non-selected attached session never contributes rows here.
  const isLive = (liveProp ?? runtime.attached) && rowsProp === undefined;
  // Fetch session history only when the host actually serves it (sessiond
  // connected) AND the selected session is not the live projection.
  // Intentionally uses sessions.context only — never bash-output or /thinking.
  const sessionsEnabled = rowsProp === undefined && Boolean(sessionId) && canBrowseSessions && !isLive;
  const context = useQuery({ ...createQueryOptions(http).sessions.context(sessionId ?? ""), enabled: sessionsEnabled });

  const liveBash = isLive ? runtime.snapshot?.state.bash : undefined;
  const liveIsBashRunning = isLive ? runtime.snapshot?.state.isBashRunning === true : false;

  const rows = useMemo(() => {
    if (rowsProp) return rowsProp;
    if (isLive) {
      // Live runtime: keep every runtime.messages entry (no role/position hide).
      // If state.bash is present, also append the stable row:state:bash.
      // No authoritative execution id => NEVER dedupe/hide (duplicates ok).
      const inputs: TranscriptMessageInput[] = runtime.messages.map((message, index) =>
        runtimeMessageToInput(message, index),
      );
      if (runtime.streamingPartial) {
        inputs.push(streamingMessageToInput(runtime.streamingPartial));
      }
      if (liveBash) {
        inputs.push(liveBashStateToInput(liveBash, liveIsBashRunning));
      }
      return buildTranscriptRows(inputs, { readonlyBanner: false });
    }
    const messages = context.data ? context.data.context.entries.map(toTranscript) : [];
    return buildTranscriptRows(messages, { readonlyBanner: isReadonly });
  }, [
    rowsProp,
    isLive,
    runtime.messages,
    runtime.streamingPartial,
    liveBash,
    liveIsBashRunning,
    context.data,
    isReadonly,
  ]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateRowHeight(rows[index]!),
    overscan,
    getItemKey: (index) => getTranscriptRowKey(rows[index]!),
  });
  return (
    <div ref={parentRef} className="transcript-scroll" role="log" aria-label="Conversation transcript" aria-relevant="additions">
      <div className="transcript-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={item.key}
              data-index={item.index}
              data-row-id={row.id}
              ref={virtualizer.measureElement}
              className={`transcript-row transcript-row--${row.kind}`}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
            >
              <TranscriptRowView row={row} />
            </div>
          );
        })}
      </div>
      {isLive ? null : context.isError && sessionId ? (
        <div className="transcript-empty">Session history unavailable</div>
      ) : rows.length === 0 ? (
        <div className="transcript-empty">
          {sessionId ? "No messages" : "Select a session or open a deep link with ?session=…"}
        </div>
      ) : null}
    </div>
  );
}

function TranscriptRowView({ row }: { row: TranscriptRow }) {
  if (row.kind === "bash" && row.bash) {
    return <BashRowView bash={row.bash} />;
  }
  const label = row.kind === "tool" && row.meta?.toolName ? row.meta.toolName : row.kind;
  return (
    <article className="transcript-row-card">
      <header className="transcript-row-meta">
        <span className="transcript-row-kind">{label}</span>
      </header>
      <div className="transcript-row-body">
        {row.parts && row.parts.length > 0 ? (
          row.parts.map((part, index) => <TranscriptPartView key={`${row.id}:part:${index}`} part={part} />)
        ) : (
          row.text
        )}
      </div>
    </article>
  );
}

/**
 * Dedicated bash card. React pure-text only — command/output never placed in
 * attributes, titles, data-*, or logs. fullOutputPath is never on the view-model.
 */
function BashRowView({ bash }: { bash: BashViewModel }) {
  return (
    <article className="transcript-row-card transcript-bash">
      <header className="transcript-row-meta">
        <span className="transcript-row-kind">bash</span>
        {bash.statusLabels.map((label) => (
          <span key={label} className="transcript-bash-status">
            {label}
          </span>
        ))}
      </header>
      <div className="transcript-bash-command">{`$ ${bash.command}`}</div>
      <pre className="transcript-bash-output">{bash.output}</pre>
    </article>
  );
}

function TranscriptPartView({ part }: { part: TranscriptPart }) {
  switch (part.type) {
    case "thinking":
      return <ThinkingPart thinking={part.thinking} streaming={part.streaming === true} />;
    case "text":
      return <div className="transcript-part transcript-part--text">{part.text}</div>;
    case "toolCall":
      return <div className="transcript-part transcript-part--tool">{part.text}</div>;
    case "image":
      return <div className="transcript-part transcript-part--image">{part.text}</div>;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

/**
 * Native details/summary with initial open state from streaming flag.
 * Openness is local state so the user can manually collapse while streaming;
 * completed rows mount with streaming=false and therefore start closed.
 * React pure-text children only — never dangerouslySetInnerHTML.
 */
function ThinkingPart({ thinking, streaming }: { thinking: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  return (
    <details
      className="transcript-thinking"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="transcript-thinking-summary">Thinking</summary>
      <div className="transcript-thinking-body">{thinking}</div>
    </details>
  );
}
