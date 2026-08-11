import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentMessage, SessionEntry } from "@fffattiger/pix-protocol";
import { buildTranscriptRows, estimateRowHeight, getTranscriptRowKey, type TranscriptMessageInput, type TranscriptRow } from "./row-model";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";

export interface TranscriptListProps { sessionId?: string; rows?: TranscriptRow[]; overscan?: number }

function textOf(message: AgentMessage): string {
  if (message.role === "bashExecution") return message.output;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "thinking") return [block.thinking];
    if (block.type === "toolCall") return [`${block.toolName}(${JSON.stringify(block.input)})`];
    return ["[image]"];
  }).join("\n");
}

function toTranscript(entry: SessionEntry): TranscriptMessageInput {
  const message = entry.message;
  const role = message.role === "toolResult" ? "tool" : message.role === "custom" || message.role === "bashExecution" ? "system" : message.role;
  return {
    id: entry.entryId,
    role,
    text: textOf(message),
    ...(message.role === "toolResult" && message.toolName ? { toolName: message.toolName } : {}),
    ...(message.timestamp === undefined ? {} : { createdAt: new Date(message.timestamp).toISOString() }),
  };
}

export function TranscriptList({ sessionId, rows: rowsProp, overscan = 8 }: TranscriptListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const http = useHttpClient();
  const { isReadonly, canBrowseSessions } = useCapabilities();
  // Only fetch session history when the host actually serves it (sessiond
  // connected). In M1 no sessions endpoint exists, so this never fires and the
  // console stays free of expected 404s.
  const sessionsEnabled = rowsProp === undefined && Boolean(sessionId) && canBrowseSessions;
  const context = useQuery({ ...createQueryOptions(http).sessions.context(sessionId ?? ""), enabled: sessionsEnabled });
  const rows = useMemo(() => {
    if (rowsProp) return rowsProp;
    const messages = context.data ? context.data.context.entries.map(toTranscript) : [];
    return buildTranscriptRows(messages, { readonlyBanner: isReadonly });
  }, [rowsProp, context.data, isReadonly]);

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: (index) => estimateRowHeight(rows[index]!), overscan, getItemKey: (index) => getTranscriptRowKey(rows[index]!) });
  return (
    <div ref={parentRef} className="transcript-scroll" role="log" aria-label="Conversation transcript" aria-relevant="additions">
      <div className="transcript-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return <div key={item.key} data-index={item.index} data-row-id={row.id} ref={virtualizer.measureElement} className={`transcript-row transcript-row--${row.kind}`} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}><TranscriptRowView row={row} /></div>;
        })}
      </div>
      {context.isError && sessionId ? <div className="transcript-empty">Session history unavailable</div> : rows.length === 0 ? <div className="transcript-empty">{sessionId ? "No messages" : "Select a session or open a deep link with ?session=…"}</div> : null}
    </div>
  );
}

function TranscriptRowView({ row }: { row: TranscriptRow }) {
  const label = row.kind === "tool" && row.meta?.toolName ? row.meta.toolName : row.kind;
  return <article className="transcript-row-card"><header className="transcript-row-meta"><span className="transcript-row-kind">{label}</span></header><div className="transcript-row-body">{row.text}</div></article>;
}
