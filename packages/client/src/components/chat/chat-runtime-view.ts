/**
 * Runtime → chat view adapters (pure, read-only).
 *
 * Maps the pix RuntimeApi/protocol projections onto the narrow shapes the
 * ported exact chat components consume. No store/state writes, no protocol
 * semantics — just data shaping shared by Composer / TranscriptList /
 * SessionInfoBar so each surface stays honest about what pix actually has.
 */
import type {
  AgentMessage,
  ContextUsage,
  ImageAttachment,
  QueuedMessages,
  RuntimeState,
  SessionStats,
  ToolResultMessage,
} from "@fffattiger/pix-protocol";
import type { SessionTreeNode as ProtocolSessionTreeNode } from "@/lib/session-tree";
import type {
  ProcessContentBlock,
} from "@/lib/process-content";
import {
  collectProcessContentBlocks,
  splitAssistantContentBlocks,
} from "@/lib/process-content";
import { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { buildProcessSteps } from "./ProcessGroup";
import type { AttachedImage } from "./ChatInput";
import type { QueuedMessages as QueuedMessagesView } from "@/lib/chat-view-model";
import type { SessionTreeNode } from "@/lib/chat-view-model";

/**
 * Narrow session-stats shape consumed by the ported SessionInfoBar (source
 * `SessionStatsInfo`). pix fills it from the authoritative RuntimeSnapshot;
 * fields the runtime does not carry stay at their empty values so the bar
 * renders only real data.
 */
export interface ChatSessionStatsView {
  sessionId: string;
  sessionFile?: string | undefined;
  sessionName?: string | undefined;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /** Optional accumulated active time (ms); omitted when the runtime has none. */
  totalActiveMs?: number | undefined;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
}

/**
 * Build the SessionInfoBar stats view from the authoritative runtime state.
 *
 * `stats` is the optional Protocol {@link SessionStats} (runtime `get_session_stats`)
 * and is mapped HONESTLY: `tokenCount` lands in `tokens.total` only; pix has no
 * input/output/cache/cost split, so those stay 0 (never fabricated).
 * `contextUsage` prefers the stats projection and falls back to the snapshot
 * state. Message totals prefer the worker's authoritative `messageCount` and
 * fall back to the live projection length.
 */
export function buildTranscriptSessionStatsView(
  sessionId: string,
  messages: readonly AgentMessage[],
): ChatSessionStatsView {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    else if (message.role === "assistant") {
      assistantMessages += 1;
      if (message.content && Array.isArray(message.content)) {
        toolCalls += message.content.filter((block) => block.type === "toolCall").length;
      }
      if (message.usage) {
        input += message.usage.input;
        output += message.usage.output;
        cacheRead += message.usage.cacheRead;
        cacheWrite += message.usage.cacheWrite;
        cost += message.usage.cost.total;
      }
    } else if (message.role === "toolResult") toolResults += 1;
  }
  return {
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: messages.length,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    cost,
    contextUsage: null,
  };
}

export function buildSessionStatsView(
  state: RuntimeState,
  messages: readonly AgentMessage[],
  stats?: SessionStats | null,
): ChatSessionStatsView {
  const transcript = buildTranscriptSessionStatsView(state.sessionId, messages);
  const statsContext = stats?.contextUsage ?? null;
  const contextUsage = statsContext
    ? {
        percent: statsContext.percent ?? null,
        contextWindow: statsContext.contextWindow ?? state.contextUsage?.contextWindow ?? 0,
        tokens: statsContext.tokens ?? state.contextUsage?.tokens ?? null,
      }
    : toContextUsageView(state.contextUsage);
  return {
    ...transcript,
    ...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
    ...(state.sessionName === undefined ? {} : { sessionName: state.sessionName }),
    totalMessages: stats?.messageCount ?? transcript.totalMessages,
    tokens: {
      ...transcript.tokens,
      total: stats?.tokenCount ?? transcript.tokens.total,
    },
    contextUsage,
  };
}

/** Runtime ContextUsage → SessionInfoBar contextUsage (null-safe). */
export function toContextUsageView(
  usage: ContextUsage | null | undefined,
): { percent: number | null; contextWindow: number; tokens: number | null } | null {
  if (!usage) return null;
  return {
    percent: usage.percent ?? null,
    contextWindow: usage.contextWindow ?? 0,
    tokens: usage.tokens ?? null,
  };
}

/** Runtime QueuedMessages (turn objects) → composer queued view (text rows). */
export function toQueuedMessagesView(
  queued: QueuedMessages | undefined,
): QueuedMessagesView | null {
  if (!queued) return null;
  const steering = queued.steering.map((turn) => turn.message);
  const followUp = queued.followUp.map((turn) => turn.message);
  if (steering.length === 0 && followUp.length === 0) return null;
  return { steering, followUp };
}

/** Composer AttachedImage list → protocol prompt images (base64, no prefix). */
const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function toImageAttachments(
  images: readonly AttachedImage[] | undefined,
): readonly ImageAttachment[] | undefined {
  if (!images || images.length === 0) return undefined;
  // The Protocol accepts a fixed image media-type set; anything else (e.g. an
  // exotic image/* the runtime would reject) is dropped rather than coerced.
  const supported = images.filter((image) => SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType));
  if (supported.length === 0) return undefined;
  return supported.map((image) => ({
    type: "image" as const,
    data: image.data,
    mimeType: image.mimeType as ImageAttachment["mimeType"],
  }));
}

/**
 * Protocol branch tree (GET /v1/sessions/:id/tree) → the narrow structural
 * node BranchNavigator consumes. `kind` maps onto the source `entry.type` and
 * the preview `label` is forwarded verbatim; `skippedEntryIds` become the
 * source's `compressedEntryIds` chain.
 */
export function toBranchNavigatorTree(
  roots: readonly ProtocolSessionTreeNode[],
): SessionTreeNode[] {
  return roots.map((node) => ({
    entry: { type: node.kind, id: node.entryId },
    label: node.label,
    ...(node.skippedEntryIds === undefined || node.skippedEntryIds.length === 0
      ? {}
      : { compressedEntryIds: [...node.skippedEntryIds] }),
    children: toBranchNavigatorTree(node.children),
  }));
}

/**
 * Live step label for the composer's streaming-actions row — a direct port of
 * the source ChatWindow `currentStepLabel` derivation: compaction first, then
 * the live tail's last process step, then the streaming phase label.
 */
export function buildStepLabel(options: {
  messages: readonly AgentMessage[];
  entryIds: readonly string[];
  streamingMessage: AgentMessage | null;
  running: boolean;
  isCompacting: boolean;
  phase: string | null;
  toolResults: Map<string, ToolResultMessage>;
  t: (key: string) => string;
}): string | null {
  const { messages, entryIds, streamingMessage, running, isCompacting, phase, toolResults, t } = options;
  if (isCompacting) return t("desktop.compacting");
  if (!running) return null;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") { lastUserIdx = i; break; }
  }

  const processIndices: number[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (hasDisplayableProcessMessage(messages[i]!)) processIndices.push(i);
  }
  let processBlocks: ProcessContentBlock[] = collectProcessContentBlocks(
    messages as AgentMessage[],
    [...entryIds],
    processIndices,
    toolResults,
  );

  let hasStreamingAnswer = false;
  const streaming = streamingMessage as (AgentMessage & { role: string }) | null;
  if (streaming?.role === "assistant") {
    const streamingAssistant = streaming as Extract<AgentMessage, { role: "assistant" }>;
    const streamingContent = splitAssistantContentBlocks(streamingAssistant, {
      messageIndex: messages.length,
      toolResults,
      isStreaming: true,
    });
    processBlocks = processBlocks.concat(streamingContent.processBlocks);
    hasStreamingAnswer = splitFinalAssistantBlocks(streamingAssistant, { isStreaming: true }).answerBlocks.length > 0;
  }

  const steps = buildProcessSteps(processBlocks, t, true);
  if (steps.length === 0) return phaseLabel(phase, t);
  if (hasStreamingAnswer) return t("desktop.sessionStatusOutput");
  return steps[steps.length - 1]!.label ?? null;
}

/** Source ChatWindow `phaseLabel` — streaming phase → human label. */
export function phaseLabel(phase: string | null | undefined, t: (key: string) => string): string | null {
  switch (phase) {
    case "running_tools":
      return t("desktop.runningTool");
    case "waiting_model":
      return t("desktop.waitingForModel");
    case "running_command":
    case "bash":
      return t("desktop.runningCommand");
    default:
      return null;
  }
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message).length > 0;
  }
  return message.role === "custom";
}
