import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentMessage, SessionEntry, StreamingAgentMessage } from "@fffattiger/pix-protocol";
import { buildTranscriptRows, estimateRowHeight, getTranscriptRowKey, type TranscriptMessageInput, type TranscriptRow } from "./row-model";
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

function assistantBlocksText(content: AssistantBlock): string {
  switch (content.type) {
    case "text": return content.text;
    case "thinking": return content.thinking;
    case "toolCall": return `${content.toolName}(${JSON.stringify(content.input)})`;
    case "image": return "[image]";
    default: return "";
  }
}

function textOf(message: AgentMessage): string {
  if (message.role === "bashExecution") return message.output;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => assistantBlocksText(block)).join("\n");
}

function streamingTextOf(message: StreamingAgentMessage): string {
  if (message.role === "bashExecution") return message.output ?? "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((block) => assistantBlocksText(block)).join("\n");
}

function roleOf(message: AgentMessage | StreamingAgentMessage): TranscriptMessageInput["role"] {
  if (message.role === "toolResult") return "tool";
  if (message.role === "custom" || message.role === "bashExecution") return "system";
  return message.role;
}

function toTranscript(entry: SessionEntry): TranscriptMessageInput {
  const message = entry.message;
  return {
    id: entry.entryId,
    role: roleOf(message),
    text: textOf(message),
    ...(message.role === "toolResult" && message.toolName ? { toolName: message.toolName } : {}),
    ...(message.timestamp === undefined ? {} : { createdAt: new Date(message.timestamp).toISOString() }),
  };
}

function runtimeMessageToInput(message: AgentMessage, index: number): TranscriptMessageInput {
  return {
    id: `row:msg:${index}`,
    role: roleOf(message),
    text: textOf(message),
    ...(message.role === "toolResult" && message.toolName ? { toolName: message.toolName } : {}),
    ...(message.timestamp === undefined ? {} : { createdAt: new Date(message.timestamp).toISOString() }),
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
  const sessionsEnabled = rowsProp === undefined && Boolean(sessionId) && canBrowseSessions && !isLive;
  const context = useQuery({ ...createQueryOptions(http).sessions.context(sessionId ?? ""), enabled: sessionsEnabled });

  const rows = useMemo(() => {
    if (rowsProp) return rowsProp;
    if (isLive) {
      // Live runtime: rows come from the SessionStore projection + active partial.
      const inputs = runtime.messages.map(runtimeMessageToInput);
      if (runtime.streamingPartial) {
        inputs.push({ id: "row:partial", role: roleOf(runtime.streamingPartial), text: streamingTextOf(runtime.streamingPartial) });
      }
      return buildTranscriptRows(inputs, { readonlyBanner: false });
    }
    const messages = context.data ? context.data.context.entries.map(toTranscript) : [];
    return buildTranscriptRows(messages, { readonlyBanner: isReadonly });
  }, [rowsProp, isLive, runtime.messages, runtime.streamingPartial, context.data, isReadonly]);

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: (index) => estimateRowHeight(rows[index]!), overscan, getItemKey: (index) => getTranscriptRowKey(rows[index]!) });
  return (
    <div ref={parentRef} className="transcript-scroll" role="log" aria-label="Conversation transcript" aria-relevant="additions">
      <div className="transcript-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return <div key={item.key} data-index={item.index} data-row-id={row.id} ref={virtualizer.measureElement} className={`transcript-row transcript-row--${row.kind}`} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}><TranscriptRowView row={row} /></div>;
        })}
      </div>
      {isLive ? null : context.isError && sessionId ? <div className="transcript-empty">Session history unavailable</div> : rows.length === 0 ? <div className="transcript-empty">{sessionId ? "No messages" : "Select a session or open a deep link with ?session=…"}</div> : null}
    </div>
  );
}

function TranscriptRowView({ row }: { row: TranscriptRow }) {
  const label = row.kind === "tool" && row.meta?.toolName ? row.meta.toolName : row.kind;
  return <article className="transcript-row-card"><header className="transcript-row-meta"><span className="transcript-row-kind">{label}</span></header><div className="transcript-row-body">{row.text}</div></article>;
}
