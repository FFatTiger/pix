/**
 * Runtime → chat view adapters (pure, read-only).
 *
 * Maps the pix exact-runtime/protocol projections onto the narrow shapes the
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
  ThinkingLevel,
} from "@fffattiger/pix-protocol";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";
import type { SessionTreeNode as ProtocolSessionTreeNode } from "@/lib/session-tree";
import type { AttachedImage } from "./ChatInput";
import type { QueuedMessages as QueuedMessagesView } from "@/lib/chat-view-model";
import type { SessionTreeNode } from "@/lib/chat-view-model";

/**
 * Narrow session-stats shape consumed by the ported SessionInfoBar (source
 * `SessionStatsInfo`). pix fills it from the authoritative RuntimeSnapshot;
 * fields the runtime does not carry stay at their empty values so the bar
 * renders only real data.
 */
/** Context derived from persisted tokens and a catalog window is an estimate. */
export interface ContextUsageView {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
  estimated?: boolean;
}

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
  contextUsage: ContextUsageView | null;
}

/** Accumulate persisted transcript totals; current context has its own source. */
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

/**
 * Build the live stats view from the authoritative runtime snapshot state.
 *
 * `stats` is the optional Protocol {@link SessionStats} (runtime
 * `get_session_stats`) and is mapped HONESTLY: `tokenCount` lands in
 * `tokens.total` and `messageCount` in `totalMessages` only; pix has no
 * input/output/cache/cost split, so those stay 0 (never fabricated).
 *
 * Context usage comes EXCLUSIVELY from the snapshot state's coherent
 * projection (context-usage consistency): the authoritative reducer owns it
 * via the atomic `runtime_state_changed` context payload and the worker
 * snapshot, and it honestly carries `null` for unknown. A `get_session_stats`
 * read must NEVER override it — that read is a one-shot file-backed snapshot
 * from response time and can be STALER than the event-driven projection
 * (the old stats-first precedence showed a dead 80% over a fresh 26%), and it
 * must never fabricate a window next to a null projection.
 */
export function buildSessionStatsView(
  state: RuntimeState,
  messages: readonly AgentMessage[],
  stats?: SessionStats | null,
): ChatSessionStatsView {
  const transcript = buildTranscriptSessionStatsView(state.sessionId, messages);
  const stateContext = state.contextUsage;
  const contextUsage = stateContext
    ? {
        percent: stateContext.percent ?? null,
        contextWindow: stateContext.contextWindow ?? 0,
        tokens: stateContext.tokens ?? null,
      }
    : null;
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

/** Minimal typed model-catalog entry the history assembler depends on. */
export interface ContextCatalogModel {
  readonly provider: string;
  readonly id: string;
  /** Exact catalog window; absent when the catalog entry carries none. */
  readonly contextWindow?: number | undefined;
}

/**
 * THE single pure history context-usage assembler (context-usage consistency).
 *
 * The numerator comes from the SAME zero-Worker `/sessions/:id/context` read
 * that resolved the displayed persisted model (`SessionContext.contextTokens`,
 * computed by the adapter's shared estimator on the full raw selected branch);
 * the denominator is the EXACT displayed model's catalog window — including a
 * STAGED pending model choice, so the shown percentage always belongs to the
 * model shown next to it (never the old model's percentage).
 *
 * Fail-closed rules (no fallbacks):
 *  - `contextTokens` omitted (older same-major producer) or `null` (honest
 *    unknown, e.g. post-compaction) → unknown;
 *  - no displayed model, or the model is not in the catalog BY EXACT
 *    provider+id, or the entry has no positive window → unknown;
 *  - never the catalog default/first model, another provider's window, or a
 *    hardcoded fallback denominator.
 *
 * Live sessions never use this function — they consume the runtime projection
 * (`toContextUsageView`) exclusively.
 */
export function assembleHistoryContextUsage(options: {
  readonly contextTokens: number | null | undefined;
  readonly model: { readonly provider: string; readonly modelId: string } | null | undefined;
  readonly catalog: readonly ContextCatalogModel[] | undefined;
}): ContextUsageView | null {
  const { contextTokens, model, catalog } = options;
  if (contextTokens === null || contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens < 0) return null;
  if (model === null || model === undefined || catalog === undefined) return null;
  const entry = catalog.find(
    (candidate) => candidate.provider === model.provider && candidate.id === model.modelId,
  );
  const contextWindow = entry?.contextWindow;
  if (entry === undefined || typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return {
    percent: (contextTokens / contextWindow) * 100,
    contextWindow,
    tokens: contextTokens,
    estimated: true,
  };
}

/**
 * Resolve the live thinking selector without confusing the runtime's effective
 * level with an explicit user pin. Pi always materializes a concrete effective
 * level (for example an `auto` default may clamp to `high` for the model), while
 * pix's `thinkingLevelPinned:false` can represent automatic/default behavior.
 * That pin bit is adapter-memory-only across a cold reopen, however, so it is
 * trusted as `auto` only together with the exact controller's Browser-local
 * identity-only-create fact. Existing/cold-open and older mixed-build sessions
 * keep exposing their concrete effective level rather than guessing `auto`.
 */
export function toLiveThinkingLevelOption(
  state: Pick<RuntimeState, "thinkingLevel" | "thinkingLevelPinned"> | null | undefined,
  stagedThinking: ThinkingLevel | null,
  createdWithAutoThinking: boolean,
): ThinkingLevelOption | undefined {
  if (stagedThinking !== null) return stagedThinking;
  if (createdWithAutoThinking && state?.thinkingLevelPinned === false) return "auto";
  return state?.thinkingLevel as ThinkingLevelOption | undefined;
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
