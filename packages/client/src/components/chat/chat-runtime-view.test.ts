import { describe, expect, it } from "vitest";
import type { AgentMessage, RuntimeState, SessionStats } from "@fffattiger/pix-protocol";
import type { SessionTreeNode as ProtocolSessionTreeNode } from "@/lib/session-tree";
import {
  buildSessionStatsView,
  toBranchNavigatorTree,
  toContextUsageView,
  toImageAttachments,
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

  it("prefers stats contextUsage over the snapshot state fallback", () => {
    const stats: SessionStats = {
      messageCount: 1,
      contextUsage: { percent: 55, contextWindow: 200_000, tokens: 110_000 },
    };
    const st = state({ contextUsage: { percent: 10, contextWindow: 1_000, tokens: 100 } });
    const view = buildSessionStatsView(st, [], stats);
    expect(view.contextUsage).toEqual({ percent: 55, contextWindow: 200_000, tokens: 110_000 });
  });

  it("falls back to snapshot state contextUsage when stats carry none", () => {
    const stats: SessionStats = { messageCount: 1, tokenCount: 5 };
    const st = state({ contextUsage: { percent: 33, contextWindow: 9_000, tokens: 3_000 } });
    const view = buildSessionStatsView(st, [], stats);
    expect(view.contextUsage).toEqual({ percent: 33, contextWindow: 9_000, tokens: 3_000 });
  });

  it("fills stats contextUsage gaps from the snapshot state", () => {
    const stats: SessionStats = { messageCount: 1, contextUsage: { percent: 70 } };
    const st = state({ contextUsage: { percent: 1, contextWindow: 50_000, tokens: 20_000 } });
    const view = buildSessionStatsView(st, [], stats);
    expect(view.contextUsage).toEqual({ percent: 70, contextWindow: 50_000, tokens: 20_000 });
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
