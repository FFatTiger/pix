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
import { collectProcessContentBlocks, messageToProcessContentBlocks, splitAssistantContentBlocks } from "@/lib/process-content";
import { getAssistantErrorMessage, getDisplayableAssistantBlocks, lastContiguousTextRun, splitFinalAssistantBlocks } from "@/lib/message-display";
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
  /** Wall-clock bounds for the whole turn, used by the shared outer title. */
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  /** The final answer is streaming in a separate row, so pending thought UI must stop. */
  isAnswerStreaming?: boolean | undefined;
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
  /**
   * Authoritative runtime streaming phase for the live tail (null in history
   * mode or when unknown). A non-idle phase proves the turn is still mid-flight
   * even when no streaming partial is currently held (segment-flush gaps,
   * stop-reason segments followed by further toolUse work).
   */
  turnPhase?: string | null | undefined;
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

/**
 * True when the turn already contains a TERMINAL assistant commit: an answer
 * block with a non-`toolUse` stop reason ("stop", error, length…). While a
 * turn runs, the SDK flushes each completed segment as its own assistant
 * entry with stopReason "toolUse" — those are interim commits, the turn keeps
 * going, and the projection must stay live across streaming-partial gaps
 * (tool/text flush windows where `streamingMessage` is briefly null).
 */
function hasTurnTerminalAnswer(messages: readonly AgentMessage[], userIdx: number, endIdx: number): boolean {
  for (let idx = endIdx - 1; idx > userIdx; idx--) {
    const message = messages[idx]!;
    if (
      message.role === "assistant"
      && hasFinalAssistantAnswer(message)
      && message.stopReason !== "toolUse"
    ) {
      return true;
    }
  }
  return false;
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

function validTimestamp(message: AgentMessage | null | undefined): number | undefined {
  const timestamp = message?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0
    ? timestamp
    : undefined;
}

function processTiming(
  source: readonly AgentMessage[],
  fromIdx: number,
  endIdx: number,
  extraMessage?: AgentMessage | null,
): { startedAt?: number | undefined; completedAt?: number | undefined } {
  const timestamps: number[] = [];
  for (let index = fromIdx; index < endIdx; index += 1) {
    const timestamp = validTimestamp(source[index]);
    if (timestamp !== undefined) timestamps.push(timestamp);
  }
  const extraTimestamp = validTimestamp(extraMessage);
  if (extraTimestamp !== undefined) timestamps.push(extraTimestamp);
  if (timestamps.length === 0) return {};
  return {
    startedAt: timestamps[0],
    completedAt: Math.max(...timestamps),
  };
}

function liveProcessTiming(
  source: readonly AgentMessage[],
  fromIdx: number,
  endIdx: number,
  extraMessage?: AgentMessage | null,
): { startedAt?: number | undefined } {
  const { startedAt } = processTiming(source, fromIdx, endIdx, extraMessage);
  return startedAt === undefined ? {} : { startedAt };
}

/** Rough initial height hints; the virtualizer measures the real DOM after. */
export function estimateChatRowHeight(row: ChatTranscriptRow): number {
  if (row.kind === "process") {
    // Settled ProcessGroups mount collapsed regardless of block count. Estimating
    // them as fully expanded made long tool turns shrink by hundreds of pixels
    // when first measured, forcing scrollTop corrections and visible flashes.
    if (!row.isStreaming) return 60;
    // The live group is expanded while streaming and grows with its steps.
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
  // A standalone toolResult row always renders as null (MessageView renders
  // results inline under their toolCall), so it must not occupy a virtual row
  // slot — otherwise it becomes a stray empty 10px row at turn boundaries.
  const isStandaloneRenderable = (message: AgentMessage): boolean => message.role !== "toolResult";

  // Assistant content ALWAYS renders through ProcessGroup (timeline/tabs) —
  // never through the legacy bare message renderer, even when the content is
  // incomplete (leaderless committed assistant, mid-turn after compaction,
  // a turn with no final answer). Collect the whole leading fragment
  // (assistant + toolResult + custom, up to the next user message) into ONE
  // process row (+ the final answer row when an answer exists). Process keys
  // use branch-local turn indexes: the complete-branch model keeps them stable
  // while a live empty/local entry id is replaced by its persisted id, so the
  // same ProcessGroup observes streaming true → false and auto-collapses.
  const pushLeaderlessAssistantRows = (
    rows: ChatTranscriptRow[],
    fromIdx: number,
    endIdx: number,
  ): number => {
    let j = fromIdx;
    while (j < endIdx && messages[j]!.role !== "user") j += 1;
    const fragmentIndices: number[] = [];
    for (let k = fromIdx; k < j; k++) fragmentIndices.push(k);
    const processBlocks: ProcessContentBlock[] = [];
    let answerMessage: AssistantMessage | null = null;
    for (const k of fragmentIndices) {
      const m = messages[k]!;
      if (m.role === "assistant") {
        const assistant = m as AssistantMessage;
        const content = splitAssistantContentBlocks(assistant, {
          messageIndex: k,
          entryId: entryIdAt(entryIds, k),
          toolResults,
        });
        processBlocks.push(...content.processBlocks);
        const split = splitFinalAssistantBlocks(assistant);
        if (answerMessage === null && split.answerBlocks.length > 0) {
          answerMessage = withAssistantBlocks(assistant, split.answerBlocks, { omitUsage: true });
        }
      } else if (m.role === "custom") {
        processBlocks.push(...messageToProcessContentBlocks(m, {
          messageIndex: k,
          entryId: entryIdAt(entryIds, k),
          phase: "process",
          toolResults,
        }));
      }
    }
    if (processBlocks.length > 0) {
      const timing = processTiming(messages, fromIdx, j);
      rows.push({
        kind: "process",
        key: `leaderless-process-idx${fromIdx}`,
        blocks: processBlocks,
        isStreaming: false,
        ...timing,
      });
    }
    if (answerMessage) {
      rows.push({
        kind: "message",
        key: `leaderless-answer-${entryIdAt(entryIds, fromIdx) ?? `idx${fromIdx}`}`,
        message: answerMessage,
      });
    }
    return j;
  };

  // Defensive leaderless live tail: a runtime can stream an assistant turn
  // whose triggering user message is not in `messages` (e.g. a trimmed
  // compaction prompt or a synthetic projection). The source never hit this
  // because the user message commits before the assistant stream starts; pix
  // renders the tail standalone instead of dropping it.
  if (running && lastUserIdx === -1) {
    // Pagination/rebase may temporarily omit the user entry that owns this
    // live turn. The already-committed assistant/custom fragment is still part
    // of the SAME ProcessGroup and must be accumulated before the current
    // partial. Rendering only `streamingMessage` here made the summary collapse
    // from dozens of tools/thoughts to the few blocks in the newest partial,
    // then recover whenever the partial briefly cleared or another page landed.
    const processBlocks: ProcessContentBlock[] = [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex]!;
      if (message.role === "assistant") {
        processBlocks.push(...messageToProcessContentBlocks(message, {
          messageIndex,
          entryId: entryIdAt(entryIds, messageIndex),
          phase: "process",
          toolResults,
        }));
      } else if (message.role === "custom") {
        processBlocks.push(...messageToProcessContentBlocks(message, {
          messageIndex,
          entryId: entryIdAt(entryIds, messageIndex),
          phase: "process",
          toolResults,
        }));
      }
    }

    if (streamingMessage?.role === "assistant") {
      const streamingAssistant = streamingMessage as AssistantMessage;
      const streamingSplit = splitFinalAssistantBlocks(streamingAssistant, { isStreaming: true });
      const streamingContent = splitAssistantContentBlocks(streamingAssistant, {
        messageIndex: messages.length,
        toolResults,
        isStreaming: true,
      });
      processBlocks.push(...streamingContent.processBlocks);
      if (processBlocks.length > 0) {
        const liveTiming = liveProcessTiming(messages, 0, messages.length, streamingMessage);
        rows.push({
          kind: "process",
          key: "leaderless-process-idx0",
          blocks: processBlocks,
          isStreaming: true,
          isAnswerStreaming: streamingSplit.answerBlocks.length > 0,
          ...liveTiming,
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
      if (processBlocks.length > 0 || streamingMessage === null) {
        const liveTiming = liveProcessTiming(messages, 0, messages.length, streamingMessage);
        rows.push({
          kind: "process",
          key: "leaderless-process-idx0",
          blocks: processBlocks,
          isStreaming: true,
          ...liveTiming,
        });
      }
      if (streamingMessage !== null) {
        rows.push({ kind: "message", key: "live-partial-leaderless", message: streamingMessage, isStreaming: true });
      }
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
    const stableId = entryIdAt(entryIds, idx) ?? `idx${idx}`;
    return {
      kind: "message",
      key: `${keyPrefix}-${stableId}`,
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
      // Assistant content always goes through ProcessGroup (timeline/tabs),
      // even standalone — never the legacy bare message renderer.
      if (msg.role === "assistant") {
        idx = pushLeaderlessAssistantRows(rows, idx, messages.length);
        continue;
      }
      if (isStandaloneRenderable(msg)) rows.push(renderMessage(idx));
      idx += 1;
      continue;
    }

    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && messages[endIdx]!.role !== "user") endIdx += 1;

    const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    // A turn is live only while it can still produce content. Signals, in
    // order of authority:
    //   1. an in-flight ASSISTANT partial → live;
    //   2. a USER partial → the NEXT turn is already streaming its user
    //      message while its user entry has not landed in `messages` — the
    //      turn at `lastUserIdx` is finished and must stay settled;
    //   3. a non-idle authoritative runtime phase → the turn is mid-flight
    //      even with no partial held (segment-flush gaps; `stop`-reason
    //      segments that are followed by more toolUse work / subagent
    //      notifications). Keyed on phase, NOT on message shape: a stop
    //      segment is not a turn terminal.
    //   4. otherwise fall back to message shape: no terminal answer commit
    //      (non-toolUse stop reason) → still live.
    const streamingIsUser = streamingMessage?.role === "user";
    const turnStillActive = streamingMessage !== null && !streamingIsUser
      ? true
      : input.turnPhase != null && input.turnPhase !== "idle"
        ? true
        : !hasTurnTerminalAnswer(messages, userIdx, endIdx);
    const isLiveTail = running
      && endIdx === messages.length
      && (userIdx === lastUserIdx || startsCompactionTurn)
      && !streamingIsUser
      && turnStillActive;

    if (isLiveTail) {
      rows.push(renderMessage(userIdx));
      const hasStreamingAssistant = streamingMessage?.role === "assistant";
      const liveProcessIndices: number[] = [];
      for (let processIdx = userIdx + 1; processIdx < endIdx; processIdx++) {
        if (hasDisplayableProcessMessage(messages[processIdx]!)) liveProcessIndices.push(processIdx);
      }
      let liveProcessBlocks = collectProcessContentBlocks(messages as AgentMessage[], [...entryIds], liveProcessIndices, toolResults);
      let liveAnswerMessage: AssistantMessage | null = null;

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
        const liveTiming = liveProcessTiming(messages, userIdx, endIdx, streamingMessage);
        rows.push({
          kind: "process",
          key: `process-group-turn-${userIdx}`,
          blocks: liveProcessBlocks,
          isStreaming: true,
          isAnswerStreaming: liveAnswerMessage !== null,
          ...liveTiming,
          ...(processRefIdx === undefined ? {} : { visibleIndex: processRefIdx }),
        });
      } else if (!liveAnswerMessage) {
        const liveTiming = liveProcessTiming(messages, userIdx, endIdx, streamingMessage);
        rows.push({
          kind: "process",
          key: `process-group-turn-${userIdx}`,
          blocks: [],
          isStreaming: true,
          ...liveTiming,
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
      // No committed final answer in the turn (interrupted turns): render the
      // whole turn's displayable process content — custom notifications
      // included — as ONE settled process group, mirroring the live tail's
      // collection so group membership never differs across live↔settled.
      rows.push(renderMessage(userIdx));
      const interruptedIndices: number[] = [];
      for (let i = userIdx + 1; i < endIdx; i++) {
        if (hasDisplayableProcessMessage(messages[i]!)) interruptedIndices.push(i);
      }
      const interruptedBlocks = collectProcessContentBlocks(messages as AgentMessage[], [...entryIds], interruptedIndices, toolResults);
      if (interruptedBlocks.length > 0) {
        const timing = processTiming(messages, userIdx, endIdx);
        rows.push({
          kind: "process",
          key: `process-group-turn-${userIdx}`,
          blocks: interruptedBlocks,
          isStreaming: false,
          ...timing,
        });
      }
      idx = endIdx;
      continue;
    }

    rows.push(renderMessage(userIdx));

    const processIndices: number[] = [];
    // Collect the whole turn (to endIdx), NOT just up to the final assistant:
    // custom entries (subagent notifications) and further assistant segments
    // can land after the final answer. Matching the live tail's collection
    // range keeps group membership identical across live↔settled transitions,
    // so those entries never bounce between the codex group and the legacy
    // standalone card. The final assistant itself is excluded here — its
    // process blocks are appended via `finalProcessMessage` below.
    for (let processIdx = userIdx + 1; processIdx < endIdx; processIdx++) {
      if (processIdx !== finalAssistantIdx) processIndices.push(processIdx);
    }
    const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]!));
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
      : null;
    // Legacy-web parity: a provider-failed turn (stopReason "error") always
    // renders its answer row (error text) even without answer blocks.
    const finalError = getAssistantErrorMessage(finalAssistant);
    // Interrupted-turn fallback (pix): no answer blocks AND no error — the
    // final assistant message still carries the last generated text before
    // its trailing tool calls. Surface that run instead of folding it away so
    // the agent's last words remain visible after the turn ended abruptly
    // (worker restart / kill mid-flight).
    const fallbackAnswerBlocks = finalSplit.answerBlocks.length === 0 && finalError === null
      ? lastContiguousTextRun(finalAssistant)
      : finalSplit.answerBlocks;
    const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || finalError !== null || fallbackAnswerBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, fallbackAnswerBlocks)
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
      const timing = processTiming(messages, userIdx, endIdx);
      rows.push({
        kind: "process",
        key: `process-group-turn-${userIdx}`,
        blocks: processBlocks,
        isStreaming: false,
        ...timing,
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
    // Trailing entries after the final assistant (custom notifications,
    // further assistant segments, toolResults) are all collected into the
    // turn's process group above — the live tail renders them the same way,
    // so nothing re-renders as a legacy standalone row here.

    idx = endIdx;
  }

  return rows;
}
