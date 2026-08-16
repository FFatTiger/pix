/**
 * Chat transcript projection — a faithful port of the source ChatWindow
 * render loop (components/ChatWindow.tsx) onto virtualizer-friendly rows.
 *
 * The pix TranscriptList keeps its virtualized base; this module produces the
 * same grouping the source rendered inline:
 *  - non-user turns render one MessageView row per message;
 *  - a user turn groups its assistant process blocks into ONE ProcessGroup
 *    row followed by the final-answer MessageView row (with the turn's
 *    written files);
 *  - the live tail (agent running / streaming) collapses into a streaming
 *    ProcessGroup + streaming answer exactly like the source;
 *  - a retained compaction entry acts as a turn boundary so the first agent
 *    response after compaction still uses the ProcessGroup path.
 *
 * Pure data shaping — no React, no runtime imports.
 */
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolResultMessage } from "@fffattiger/pix-protocol";
import type { ProcessContentBlock } from "@/lib/process-content";
import { collectProcessContentBlocks, splitAssistantContentBlocks } from "@/lib/process-content";
import { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";

export interface ChatTranscriptMessageRow {
  kind: "message";
  key: string;
  message: AgentMessage;
  entryId?: string | undefined;
  /** Previous assistant entry id (user-message navigate target; live tail omits). */
  prevAssistantEntryId?: string | undefined;
  /** Written files attached to the turn's final answer (source behavior). */
  writtenFiles?: WrittenFile[] | undefined;
  showTimestamp?: boolean | undefined;
  prevTimestamp?: number | undefined;
  isStreaming?: boolean | undefined;
  /** Index among user/assistant messages — drives the minimap ref array. */
  visibleIndex?: number | undefined;
}

export interface ChatTranscriptProcessRow {
  kind: "process";
  key: string;
  blocks: ProcessContentBlock[];
  isStreaming: boolean;
  visibleIndex?: number | undefined;
}

export type ChatTranscriptRow = ChatTranscriptMessageRow | ChatTranscriptProcessRow;

export interface BuildChatTranscriptRowsInput {
  messages: readonly AgentMessage[];
  /** Entry id per message index ("" when unknown, e.g. live runtime rows). */
  entryIds: readonly string[];
  /** Live streaming partial (null in history mode / when idle). */
  streamingMessage: AgentMessage | null;
  /** True while the agent turn (prompt / tools / model) is running. */
  running: boolean;
  /** Session cwd — resolves relative file paths in rows. */
  cwd?: string | undefined;
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: readonly AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx]!)) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message).length > 0;
  }
  return message.role === "custom";
}

export function isCompactionBoundary(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function entryIdAt(entryIds: readonly string[], index: number): string | undefined {
  const id = entryIds[index];
  return id === undefined || id === "" ? undefined : id;
}

/** Rough initial height hints; the virtualizer measures the real DOM after. */
export function estimateChatRowHeight(row: ChatTranscriptRow): number {
  if (row.kind === "process") {
    // ProcessGroup: header row + a lane per ~4 blocks (measured after mount).
    return 96 + Math.ceil(row.blocks.length / 3) * 34;
  }
  switch (row.message.role) {
    case "user":
      return 88;
    case "bashExecution":
      return 132;
    case "custom":
      return 96;
    case "toolResult":
      return 72;
    default:
      return 132;
  }
}

export function buildChatTranscriptRows(input: BuildChatTranscriptRowsInput): ChatTranscriptRow[] {
  const { messages, entryIds, streamingMessage, running, cwd } = input;
  const toolResults = new Map<string, ToolResultMessage>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      toolResults.set(msg.toolCallId, msg);
    }
  }

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { lastUserIdx = i; break; }
  }

  const visibleRefIndexByMessage = new Map<number, number>();
  let refIdx = 0;
  messages.forEach((msg, idx) => {
    if (msg.role === "user" || msg.role === "assistant") {
      visibleRefIndexByMessage.set(idx, refIdx++);
    }
  });

  const rows: ChatTranscriptRow[] = [];

  // Defensive leaderless live tail: a runtime can stream an assistant turn
  // whose triggering user message is not in `messages` (e.g. a trimmed
  // compaction prompt or a synthetic projection). The source never hit this
  // because the user message commits before the assistant stream starts; pix
  // renders the tail standalone instead of dropping it.
  if (running && streamingMessage !== null && lastUserIdx === -1) {
    if (streamingMessage.role === "assistant") {
      const streamingAssistant = streamingMessage as AssistantMessage;
      const streamingSplit = splitFinalAssistantBlocks(streamingAssistant, { isStreaming: true });
      const streamingContent = splitAssistantContentBlocks(streamingAssistant, {
        messageIndex: messages.length,
        toolResults,
        isStreaming: true,
      });
      if (streamingContent.processBlocks.length > 0) {
        rows.push({
          kind: "process",
          key: "live-process-group-leaderless",
          blocks: streamingContent.processBlocks,
          isStreaming: true,
        });
      }
      if (streamingSplit.answerBlocks.length > 0) {
        rows.push({
          kind: "message",
          key: "live-answer-leaderless",
          message: withAssistantBlocks(streamingAssistant, streamingSplit.answerBlocks, { omitUsage: true }),
          isStreaming: true,
        });
      }
    } else {
      rows.push({ kind: "message", key: "live-partial-leaderless", message: streamingMessage, isStreaming: true });
    }
    return rows;
  }

  const renderMessage = (
    idx: number,
    options: {
      keyPrefix?: string;
      messageOverride?: AgentMessage;
      writtenFiles?: WrittenFile[];
      isStreaming?: boolean;
    } = {},
  ): ChatTranscriptMessageRow => {
    const msg = options.messageOverride ?? messages[idx]!;
    const prevAssistantEntryId =
      msg.role === "user" && idx > 0 && messages[idx - 1]!.role === "assistant"
        ? entryIdAt(entryIds, idx - 1)
        : undefined;
    const keyPrefix = options.keyPrefix ?? "message";
    let showTimestamp = false;
    if (msg.role === "assistant") {
      showTimestamp = true;
      for (let j = idx + 1; j < messages.length; j++) {
        const r = messages[j]!.role;
        if (r === "user") break;
        if (r === "assistant") { showTimestamp = false; break; }
      }
      // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
      if (showTimestamp && streamingMessage !== null && idx === messages.length - 1) {
        showTimestamp = false;
      }
    }
    const currentRefIdx = visibleRefIndexByMessage.get(idx);
    return {
      kind: "message",
      key: `${keyPrefix}-${idx}`,
      message: msg,
      ...(entryIdAt(entryIds, idx) === undefined ? {} : { entryId: entryIdAt(entryIds, idx) }),
      ...(running || prevAssistantEntryId === undefined ? {} : { prevAssistantEntryId }),
      ...(options.writtenFiles === undefined ? {} : { writtenFiles: options.writtenFiles }),
      showTimestamp,
      prevTimestamp: idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined,
      ...(options.isStreaming === undefined ? {} : { isStreaming: options.isStreaming }),
      ...(currentRefIdx === undefined ? {} : { visibleIndex: currentRefIdx }),
    };
  };

  for (let idx = 0; idx < messages.length;) {
    const msg = messages[idx]!;
    const startsCompactionTurn = isCompactionBoundary(msg);
    // The SDK may trim the user prompt that triggered compaction from the
    // rebuilt context. Treat the retained compaction entry as the turn
    // boundary so its first following agent response still uses the
    // ProcessGroup rendering path rather than the legacy message renderer.
    if (msg.role !== "user" && !startsCompactionTurn) {
      rows.push(renderMessage(idx));
      idx += 1;
      continue;
    }

    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && messages[endIdx]!.role !== "user") endIdx += 1;

    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    const isLiveTail = running
      && endIdx === messages.length
      && (userIdx === lastUserIdx || startsCompactionTurn);

    if (isLiveTail) {
      rows.push(renderMessage(userIdx));
      const hasStreamingAssistant = streamingMessage?.role === "assistant";
      const liveProcessIndices: number[] = [];
      const existingProcessEnd = !hasStreamingAssistant && finalAssistantIdx >= 0 ? finalAssistantIdx : endIdx;
      for (let processIdx = userIdx + 1; processIdx < existingProcessEnd; processIdx++) {
        if (hasDisplayableProcessMessage(messages[processIdx]!)) liveProcessIndices.push(processIdx);
      }
      let liveProcessBlocks = collectProcessContentBlocks(messages as AgentMessage[], [...entryIds], liveProcessIndices, toolResults);
      let liveAnswerMessage: AssistantMessage | null = null;

      if (!hasStreamingAssistant && finalAssistantIdx >= 0) {
        const existingAssistant = messages[finalAssistantIdx] as AssistantMessage;
        const existingSplit = splitFinalAssistantBlocks(existingAssistant, { isStreaming: true });
        const existingContent = splitAssistantContentBlocks(existingAssistant, {
          messageIndex: finalAssistantIdx,
          entryId: entryIdAt(entryIds, finalAssistantIdx),
          toolResults,
          isStreaming: true,
        });
        liveProcessBlocks = liveProcessBlocks.concat(existingContent.processBlocks);
        if (existingSplit.answerBlocks.length > 0) {
          liveAnswerMessage = withAssistantBlocks(existingAssistant, existingSplit.answerBlocks, { omitUsage: true });
        }
      }

      if (hasStreamingAssistant) {
        const streamingAssistant = streamingMessage as AssistantMessage;
        const streamingSplit = splitFinalAssistantBlocks(streamingAssistant, { isStreaming: true });
        const streamingContent = splitAssistantContentBlocks(streamingAssistant, {
          messageIndex: messages.length,
          toolResults,
          isStreaming: true,
        });
        liveProcessBlocks = liveProcessBlocks.concat(streamingContent.processBlocks);
        if (streamingSplit.answerBlocks.length > 0) {
          liveAnswerMessage = withAssistantBlocks(streamingAssistant, streamingSplit.answerBlocks, { omitUsage: true });
        }
      }
      if (liveProcessBlocks.length > 0) {
        const processRefIdx = liveProcessIndices
          .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
          .find((value): value is number => typeof value === "number");
        rows.push({
          kind: "process",
          key: `live-process-group-${userIdx}`,
          blocks: liveProcessBlocks,
          isStreaming: true,
          ...(processRefIdx === undefined ? {} : { visibleIndex: processRefIdx }),
        });
      }
      if (liveAnswerMessage) {
        rows.push({
          kind: "message",
          key: `live-answer-${userIdx}`,
          message: liveAnswerMessage,
          isStreaming: true,
        });
      }
      idx = endIdx;
      continue;
    }

    if (finalAssistantIdx === -1) {
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        rows.push(renderMessage(renderIdx));
      }
      idx = endIdx;
      continue;
    }

    rows.push(renderMessage(userIdx));

    const processIndices: number[] = [];
    for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
      processIndices.push(processIdx);
    }
    const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]!));
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
      : null;
    const finalAnswerMessage = finalSplit.answerBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
      : null;

    let processBlocks = collectProcessContentBlocks(messages as AgentMessage[], [...entryIds], visibleProcessIndices, toolResults);
    if (finalProcessMessage) {
      processBlocks = processBlocks.concat(splitAssistantContentBlocks(finalAssistant, {
        messageIndex: finalAssistantIdx,
        entryId: entryIdAt(entryIds, finalAssistantIdx),
        toolResults,
      }).processBlocks);
    }
    if (processBlocks.length > 0) {
      const processRefIdx = visibleProcessIndices
        .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
        .find((value): value is number => typeof value === "number")
        ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
      rows.push({
        kind: "process",
        key: `process-group-${userIdx}-${finalAssistantIdx}`,
        blocks: processBlocks,
        isStreaming: false,
        ...(processRefIdx === undefined ? {} : { visibleIndex: processRefIdx }),
      });
    }

    if (finalAnswerMessage) {
      // Each tool call is stored as its own assistant entry, so the final
      // answer alone carries no record of what the turn wrote. Gather the
      // turn's assistant blocks and derive the file list from the write/edit
      // calls among them.
      const turnContent: AssistantContentBlock[] = [];
      for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
        const m = messages[i];
        if (m?.role === "assistant") {
          for (const b of (m as AssistantMessage).content ?? []) turnContent.push(b);
        }
      }
      const writtenFiles = extractTurnWrittenFiles(turnContent, toolResults, cwd);
      rows.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage, writtenFiles }));
    }
    for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
      rows.push(renderMessage(renderIdx));
    }
    idx = endIdx;
  }

  return rows;
}
