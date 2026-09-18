import { describe, expect, it } from "vitest";
import type { AgentMessage, RuntimeState, SessionStats } from "@fffattiger/pix-protocol";
import type { SessionTreeNode as ProtocolSessionTreeNode } from "@/lib/session-tree";
import {
  assembleHistoryContextUsage,
  buildSessionStatsView,
  buildTranscriptSessionStatsView,
  toBranchNavigatorTree,
  toContextUsageView,
  toImageAttachments,
  toLiveThinkingLevelOption,
  toQueuedMessagesView,
} from "./chat-runtime-view";
import type { AttachedImage } from "./ChatInput";

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    sessionId: "s1",
    isStreaming: false,
    isPromptRunning: false,
    isBashRunning: false,
    isCompacting: false,
    model: null,
    messageCount: 0,
    ...overrides,
  } as RuntimeState;
}

function messages(overrides: Partial<AgentMessage>[] = []): AgentMessage[] {
  return [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "answer" }], model: "m", provider: "p" },
    { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "out" }] },
    ...overrides,
  ] as AgentMessage[];
}

describe("toLiveThinkingLevelOption — auto vs effective runtime level", () => {
  it("keeps auto selected when an unpinned runtime default clamps to high", () => {
    expect(toLiveThinkingLevelOption(
      state({ thinkingLevel: "high", thinkingLevelPinned: false }),
      null,
      true,
    )).toBe("auto");
  });

  it("shows an explicit pin and lets staged intent win", () => {
    expect(toLiveThinkingLevelOption(
      state({ thinkingLevel: "high", thinkingLevelPinned: true }),
      null,
      true,
    )).toBe("high");
    expect(toLiveThinkingLevelOption(
      state({ thinkingLevel: "high", thinkingLevelPinned: false }),
      "low",
      true,
    )).toBe("low");
  });

  it("does not guess auto for a cold-open unpinned session or an older snapshot", () => {
    expect(toLiveThinkingLevelOption(
      state({ thinkingLevel: "high", thinkingLevelPinned: false }),
      null,
      false,
    )).toBe("high");
    expect(toLiveThinkingLevelOption(state({ thinkingLevel: "medium" }), null, true)).toBe("medium");
  });
});

describe("buildTranscriptSessionStatsView — detached history stats", () => {
  it("aggregates real persisted assistant usage without activating a worker", () => {
    const view = buildTranscriptSessionStatsView("history-1", [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "m",
        provider: "p",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 5,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
      },
    ]);
    expect(view.sessionId).toBe("history-1");
    expect(view.tokens).toEqual({ input: 100, output: 20, cacheRead: 50, cacheWrite: 5, total: 175 });
    expect(view.cost).toBe(0.33);
    expect(view.contextUsage).toBeNull();
  });
});

describe("buildSessionStatsView — real stats mapping", () => {
  it("derives message counts from the live projection when no stats are available and never fakes tokens", () => {
    const view = buildSessionStatsView(state(), messages());
    expect(view.sessionId).toBe("s1");
    expect(view.userMessages).toBe(1);
    expect(view.assistantMessages).toBe(1);
    expect(view.toolResults).toBe(1);
    expect(view.toolCalls).toBe(0);
    expect(view.totalMessages).toBe(3);
    // No stats → total stays 0; input/output/cache/cost are NEVER fabricated.
    expect(view.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    expect(view.cost).toBe(0);
    expect(view.contextUsage).toBeNull();
  });

  it("honestly maps stats.tokenCount → tokens.total and stats.messageCount → totalMessages", () => {
    const stats: SessionStats = { messageCount: 42, tokenCount: 12345 };
    const view = buildSessionStatsView(state(), messages(), stats);
    expect(view.tokens.total).toBe(12345);
    // Input/output/cache/cost have no protocol source — they stay 0 (no faking).
    expect(view.tokens.input).toBe(0);
    expect(view.tokens.output).toBe(0);
    expect(view.tokens.cacheRead).toBe(0);
    expect(view.tokens.cacheWrite).toBe(0);
    expect(view.cost).toBe(0);
    expect(view.totalMessages).toBe(42);
  });

  // Context-usage consistency: the runtime projection (state.contextUsage) is
  // the ONLY live context authority. A one-shot get_session_stats read is
  // file-backed at RESPONSE time and can be STALER than the event-driven
  // projection — it must never override a fresh value, and a stats context
  // must never fabricate a window next to a null (unknown) projection. Fresh
  // usage now arrives via the atomic runtime_state_changed context payload
  // (covered by the Protocol reducer tests), not via stats precedence.
  it("keeps the fresh snapshot contextUsage over a stale stats read (26% wins over 80%)", () => {
    const stats: SessionStats = {
      messageCount: 1,
      contextUsage: { percent: 79.6358, contextWindow: 1_050_000, tokens: 836_176 },
    };
    const st = state({ contextUsage: { percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711 } });
    const view = buildSessionStatsView(st, [], stats);
    expect(view.contextUsage).toEqual({ percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711 });
  });

  it("never fabricates context from a stats read when the projection is unknown (null)", () => {
    const stats: SessionStats = {
      messageCount: 1,
      contextUsage: { percent: 55, contextWindow: 200_000, tokens: 110_000 },
    };
    const view = buildSessionStatsView(state({ contextUsage: null }), [], stats);
    expect(view.contextUsage).toBeNull();
  });

  it("falls back to snapshot state contextUsage when stats carry none", () => {
    const stats: SessionStats = { messageCount: 1, tokenCount: 5 };
    const st = state({ contextUsage: { percent: 33, contextWindow: 9_000, tokens: 3_000 } });
    const view = buildSessionStatsView(st, [], stats);
    expect(view.contextUsage).toEqual({ percent: 33, contextWindow: 9_000, tokens: 3_000 });
  });

  it("keeps stats counts/totals honest while context stays projection-owned", () => {
    const stats: SessionStats = { messageCount: 8, tokenCount: 52_452, contextUsage: { percent: 1.7809, contextWindow: 1_000_000, tokens: 17_809 } };
    const st = state({ contextUsage: null });
    const view = buildSessionStatsView(st, [], stats);
    expect(view.totalMessages).toBe(8);
    expect(view.tokens.total).toBe(52_452);
    expect(view.tokens.input).toBe(0);
    expect(view.contextUsage).toBeNull();
  });

  it("counts toolCall blocks from assistant message content", () => {
    const msgs = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", toolCallId: "a", toolName: "read", input: {} },
          { type: "toolCall", toolCallId: "b", toolName: "write", input: {} },
        ],
        model: "m",
        provider: "p",
      },
    ] as unknown as AgentMessage[];
    const view = buildSessionStatsView(state(), msgs);
    expect(view.toolCalls).toBe(2);
  });
});

describe("toContextUsageView", () => {
  it("returns null for null/undefined usage", () => {
    expect(toContextUsageView(null)).toBeNull();
    expect(toContextUsageView(undefined)).toBeNull();
  });

  it("maps a real usage object with default fill-ins", () => {
    expect(toContextUsageView({ percent: 12, contextWindow: 100, tokens: 12 }))
      .toEqual({ percent: 12, contextWindow: 100, tokens: 12 });
    expect(toContextUsageView({ percent: 0 }))
      .toEqual({ percent: 0, contextWindow: 0, tokens: null });
  });
});

describe("assembleHistoryContextUsage — the single history context authority", () => {
  const catalog = [
    { provider: "acme-gpt", id: "gpt-6-astra", contextWindow: 1_050_000 },
    { provider: "deepseek-official", id: "deepseek-v4-flash", contextWindow: 1_000_000 },
  ];

  it("combines the history numerator with the EXACT persisted model's catalog window", () => {
    const view = assembleHistoryContextUsage({
      contextTokens: 263_711,
      model: { provider: "deepseek-official", modelId: "deepseek-v4-flash" },
      catalog,
    });
    expect(view).toEqual({ percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711, estimated: true });
  });

  it("a staged pending model recomputes against ITS window — never the old model's percentage", () => {
    const persisted = assembleHistoryContextUsage({
      contextTokens: 263_711,
      model: { provider: "deepseek-official", modelId: "deepseek-v4-flash" },
      catalog,
    });
    const staged = assembleHistoryContextUsage({
      contextTokens: 263_711,
      model: { provider: "acme-gpt", modelId: "gpt-6-astra" },
      catalog,
    });
    expect(persisted?.percent).toBeCloseTo(26.3711, 3);
    expect(staged?.percent).toBeCloseTo((263_711 / 1_050_000) * 100, 6);
    expect(staged?.contextWindow).toBe(1_050_000);
    expect(staged?.estimated).toBe(true);
  });

  it("null (post-compaction unknown) and undefined (older producer) stay unknown", () => {
    for (const contextTokens of [null, undefined]) {
      expect(assembleHistoryContextUsage({
        contextTokens,
        model: { provider: "acme-gpt", modelId: "gpt-6-astra" },
        catalog,
      })).toBeNull();
    }
  });

  it("missing model, missing catalog, provider/id mismatch, or windowless entry stay unknown", () => {
    const model = { provider: "deepseek-official", modelId: "deepseek-v4-flash" };
    expect(assembleHistoryContextUsage({ contextTokens: 10, model: null, catalog })).toBeNull();
    expect(assembleHistoryContextUsage({ contextTokens: 10, model: undefined, catalog })).toBeNull();
    expect(assembleHistoryContextUsage({ contextTokens: 10, model, catalog: undefined })).toBeNull();
    // Same id under ANOTHER provider is a different model — no cross-provider fallback.
    expect(assembleHistoryContextUsage({
      contextTokens: 10,
      model: { provider: "other", modelId: "deepseek-v4-flash" },
      catalog,
    })).toBeNull();
    // Catalog entry without a usable window → unknown, never a hardcoded window.
    expect(assembleHistoryContextUsage({
      contextTokens: 10,
      model,
      catalog: [{ provider: "deepseek-official", id: "deepseek-v4-flash" }],
    })).toBeNull();
    expect(assembleHistoryContextUsage({
      contextTokens: 10,
      model,
      catalog: [{ provider: "deepseek-official", id: "deepseek-v4-flash", contextWindow: 0 }],
    })).toBeNull();
  });

  it("a known-empty branch (0 tokens) still reports 0% with the exact window", () => {
    const view = assembleHistoryContextUsage({
      contextTokens: 0,
      model: { provider: "acme-gpt", modelId: "gpt-6-astra" },
      catalog,
    });
    expect(view).toEqual({ percent: 0, contextWindow: 1_050_000, tokens: 0, estimated: true });
  });
});

describe("toQueuedMessagesView", () => {
  it("maps runtime queued turns to the composer text view", () => {
    const queued = {
      steering: [{ message: "s1" }, { message: "s2" }],
      followUp: [{ message: "f1" }],
    };
    expect(toQueuedMessagesView(queued)).toEqual({ steering: ["s1", "s2"], followUp: ["f1"] });
  });

  it("returns null when empty or absent", () => {
    expect(toQueuedMessagesView(undefined)).toBeNull();
    expect(toQueuedMessagesView({ steering: [], followUp: [] })).toBeNull();
  });
});

describe("toImageAttachments", () => {
  const image = (mimeType: string): AttachedImage => ({ data: "AAAA", mimeType, previewUrl: "blob:x" });

  it("maps supported images to protocol attachments", () => {
    const out = toImageAttachments([image("image/png"), image("image/jpeg")]);
    expect(out?.map((a) => a.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(out?.[0]?.data).toBe("AAAA");
  });

  it("drops unsupported media types and returns undefined when nothing remains", () => {
    expect(toImageAttachments([image("image/avif")])).toBeUndefined();
    expect(toImageAttachments([image("image/png"), image("image/avif")])?.length).toBe(1);
    expect(toImageAttachments(undefined)).toBeUndefined();
    expect(toImageAttachments([])).toBeUndefined();
  });
});

describe("toBranchNavigatorTree", () => {
  it("maps protocol kind/label/skipped ids onto the BranchNavigator view nodes", () => {
    const roots: ProtocolSessionTreeNode[] = [
      {
        entryId: "e1",
        kind: "user",
        label: "first question",
        truncated: false,
        children: [
          {
            entryId: "e2",
            kind: "assistant",
            label: "first answer",
            truncated: true,
            children: [],
            skippedEntryIds: ["e0"],
          },
        ],
      },
    ];
    const tree = toBranchNavigatorTree(roots);
    expect(tree[0]!.entry).toEqual({ type: "user", id: "e1" });
    expect(tree[0]!.label).toBe("first question");
    expect(tree[0]!.children[0]!.entry.type).toBe("assistant");
    expect(tree[0]!.children[0]!.label).toBe("first answer");
    expect(tree[0]!.children[0]!.compressedEntryIds).toEqual(["e0"]);
  });

  it("omits compressedEntryIds when the protocol node has no skipped ids", () => {
    const tree = toBranchNavigatorTree([
      { entryId: "e1", kind: "system", label: "boot", truncated: false, children: [] },
    ]);
    expect(tree[0]).not.toHaveProperty("compressedEntryIds");
    expect(tree[0]!.entry.type).toBe("system");
  });
});
