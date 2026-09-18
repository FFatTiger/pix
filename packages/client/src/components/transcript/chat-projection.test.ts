import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage } from "@fffattiger/pix-protocol";
import {
  buildChatTranscriptRows,
  estimateChatRowHeight,
  type ChatTranscriptRow,
} from "./chat-projection";

function user(content: string, overrides: Record<string, unknown> = {}): AgentMessage {
  return { role: "user", content, ...overrides } as AgentMessage;
}

function assistant(blocks: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AgentMessage {
  return { role: "assistant", content: blocks, model: "m", provider: "p", ...overrides } as AgentMessage;
}

function toolResult(toolCallId: string, content: string, overrides: Record<string, unknown> = {}): AgentMessage {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: content }], ...overrides } as AgentMessage;
}

function custom(customType: string, content: string): AgentMessage {
  return { role: "custom", customType, content, display: true } as AgentMessage;
}

function build(messages: AgentMessage[], input: Partial<Parameters<typeof buildChatTranscriptRows>[0]> = {}) {
  return buildChatTranscriptRows({
    messages,
    entryIds: messages.map((_, i) => `e${i}`),
    streamingMessage: null,
    running: false,
    cwd: "/x",
    ...input,
  });
}

function kinds(rows: ChatTranscriptRow[]): string[] {
  return rows.map((row) => row.kind);
}

describe("chat-projection — virtual row estimates", () => {
  const origin = { phase: "process", placement: "inline", sourceMessageIndex: 1 } as const;
  const manyBlocks = Array.from({ length: 30 }, (_, index) => ({
    id: `thinking-${index}`,
    origin,
    type: "thinking" as const,
    thinking: `step ${index}`,
  }));

  it("estimates settled process groups at their collapsed height regardless of block count", () => {
    expect(estimateChatRowHeight({
      kind: "process",
      key: "settled",
      blocks: manyBlocks,
      isStreaming: false,
    })).toBe(60);
  });

  it("keeps block-scaled estimates for the expanded streaming process group", () => {
    expect(estimateChatRowHeight({
      kind: "process",
      key: "streaming",
      blocks: manyBlocks,
      isStreaming: true,
    })).toBe(96 + Math.ceil(manyBlocks.length / 3) * 34);
  });
});

describe("chat-projection — row identity stability", () => {
  it("keeps the live and settled process key stable so completion can auto-collapse the same component", () => {
    const messages = [
      user("question"),
      assistant([{ type: "thinking", thinking: "work" }, { type: "text", text: "answer" }]),
    ];
    const live = build(messages, { running: true });
    const settled = build(messages, { running: false });
    expect(live.find((row) => row.kind === "process")?.key).toBe("process-group-turn-0");
    expect(settled.find((row) => row.kind === "process")?.key).toBe("process-group-turn-0");
  });

  it("keeps process identity stable when a live user entry id is not persisted yet", () => {
    const messages = [
      user("question"),
      assistant([{ type: "thinking", thinking: "work" }, { type: "text", text: "answer" }]),
    ];
    const live = buildChatTranscriptRows({ messages, entryIds: ["", ""], streamingMessage: null, running: true });
    const settled = build(messages, { running: false });
    expect(live.find((row) => row.kind === "process")?.key).toBe("process-group-turn-0");
    expect(settled.find((row) => row.kind === "process")?.key).toBe("process-group-turn-0");
  });

  it("keeps a leaderless live process mounted through settle and anchors the live process before its partial answer", () => {
    const live = buildChatTranscriptRows({
      messages: [assistant([{ type: "thinking", thinking: "work" }])],
      entryIds: [""],
      streamingMessage: assistant([{ type: "thinking", thinking: "more" }, { type: "text", text: "partial" }]),
      running: true,
    });
    const settled = build([assistant([{ type: "thinking", thinking: "work" }, { type: "text", text: "partial" }])]);
    const liveProcess = live.find((row) => row.kind === "process");
    expect(liveProcess?.key).toBe("leaderless-process-idx0");
    expect(settled.find((row) => row.kind === "process")?.key).toBe("leaderless-process-idx0");
  });
});

describe("chat-projection — user → process → final", () => {
  it("projects authoritative turn time bounds onto the process row", () => {
    const rows = build([
      user("hello", { timestamp: 1_000 }),
      assistant([{ type: "thinking", thinking: "think" }], { timestamp: 20_000 }),
      assistant([{ type: "text", text: "done" }], { timestamp: 66_000 }),
    ]);
    expect(rows.find((row) => row.kind === "process")).toMatchObject({
      kind: "process",
      startedAt: 1_000,
      completedAt: 66_000,
      isStreaming: false,
    });
  });

  it("groups a user turn into user row, process group and final answer row", () => {
    const rows = build([
      user("hello"),
      assistant([{ type: "thinking", thinking: "think" }, { type: "toolCall", toolCallId: "tc1", toolName: "read", input: { path: "/x/a.ts" } }]),
      assistant([{ type: "text", text: "Answer here" }]),
    ]);
    expect(kinds(rows)).toEqual(["message", "process", "message"]);
    expect(rows[0]!.kind === "message" && rows[0]!.message.role).toBe("user");
    expect(rows[1]!.kind === "process" && rows[1]!.blocks.map((b) => b.type)).toEqual(["thinking", "toolCall"]);
    const final = rows[2]!;
    expect(final.kind).toBe("message");
    if (final.kind === "message") {
      expect(final.message.role).toBe("assistant");
      const text = (final.message as AssistantMessage).content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      expect(text).toBe("Answer here");
      expect(final.writtenFiles).toEqual([]);
    }
  });

  it("groups a process-only assistant (no final answer) into a process row and never fabricates an answer", () => {
    const rows = build([
      user("hello"),
      assistant([{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }]),
      toolResult("tc1", "ok"),
    ]);
    // No final answer and NO text in the final assistant → the tool-call
    // assistant becomes a process row (never a fabricated answer row). The
    // trailing toolResult renders inline under its toolCall, so it never
    // occupies a standalone (formerly empty) row.
    expect(kinds(rows)).toEqual(["message", "process"]);
  });

  it("attaches the turn's written files to the final answer row", () => {
    const rows = build([
      user("write it"),
      assistant([{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { file_path: "/x/a.ts", content: "line1\nline2\n" } }]),
      toolResult("w1", "ok"),
      assistant([{ type: "text", text: "done" }]),
    ]);
    const final = rows.find((row): row is Extract<ChatTranscriptRow, { kind: "message" }> =>
      row.kind === "message" && row.message.role === "assistant");
    expect(final).toBeDefined();
    expect(final!.writtenFiles).toEqual([{ filePath: "/x/a.ts", additions: 2 }]);
  });
});

describe("chat-projection — live merge", () => {
  it("keeps a running turn live across segment-flush gaps (stopReason toolUse, no partial)", () => {
    // Mid-turn the SDK flushes each finished segment as its own assistant
    // entry (stopReason "toolUse") and the streaming partial is briefly
    // null. The turn is still running — it must stay live, or the group
    // collapses and re-expands on every flush.
    const messages = [
      user("go", { timestamp: 1_000 }),
      assistant(
        [{ type: "thinking", thinking: "plan" }, { type: "text", text: "interim note" }],
        { stopReason: "toolUse", timestamp: 2_000 },
      ),
    ];
    const rows = build(messages, { running: true, streamingMessage: null });
    expect(kinds(rows)).toEqual(["message", "process"]);
    expect(rows[1]).toMatchObject({ kind: "process", isStreaming: true });
    if (rows[1]!.kind === "process") {
      // The flushed interim text/thinking stay visible inside the live group.
      expect(rows[1]!.blocks.length).toBeGreaterThan(0);
    }
  });

  it("keeps a running turn live across stop segments and idle phase gaps", () => {
    // `stop` and runtime phase describe individual model/tool segments, not
    // the whole prompt. While the red Stop control is active (`running` true),
    // neither signal may collapse the response group.
    const messages = [
      user("go", { timestamp: 1_000 }),
      assistant(
        [{ type: "thinking", thinking: "wrap" }, { type: "text", text: "interim answer" }],
        { stopReason: "stop", timestamp: 2_000 },
      ),
    ];
    const rows = build(messages, { running: true, streamingMessage: null });
    expect(rows[1]).toMatchObject({ kind: "process", isStreaming: true });

    const settledRows = build(messages, { running: false, streamingMessage: null });
    expect(settledRows[1]).toMatchObject({ kind: "process", isStreaming: false });
  });

  it("keeps the previous turn settled while the next turn's user partial is streaming", () => {
    // Submit immediately streams the new user message; its entry has not
    // landed in `messages` yet, so `lastUserIdx` still points at the previous
    // (terminal) turn — which must not flash back into the live path.
    const messages = [
      user("question"),
      assistant([{ type: "text", text: "final answer" }], { stopReason: "stop" }),
    ];
    const rows = build(messages, {
      running: true,
      streamingMessage: { role: "user", content: "next prompt" } as AgentMessage,
    });
    // Text-only settled turn: user row + settled answer row, no live process
    // tail and nothing flagged streaming.
    expect(kinds(rows)).toEqual(["message", "message"]);
    for (const row of rows) {
      if (row.kind === "message") expect(row.isStreaming).toBeUndefined();
    }
  });

  it("renders a post-answer custom notification inside the process group, not as a legacy standalone row", () => {
    // Subagent notifications can land after the turn's final answer. Both the
    // live tail and the settled projection must collect them into the SAME
    // process group — a settled-only standalone card made the row bounce
    // between styles on every live↔settled transition.
    const messages = [
      user("go", { timestamp: 1_000 }),
      assistant([{ type: "thinking", thinking: "work" }, { type: "text", text: "done" }], { stopReason: "stop", timestamp: 2_000 }),
      custom("subagent_notification", "child finished"),
    ];
    const settled = build(messages, { running: false });
    const live = build(messages, { running: true, streamingMessage: null });
    const settledProcess = settled.find((row) => row.kind === "process");
    const liveProcess = live.find((row) => row.kind === "process");
    expect(settledProcess).toBeTruthy();
    expect(liveProcess).toBeTruthy();
    if (settledProcess?.kind === "process" && liveProcess?.kind === "process") {
      expect(settledProcess.blocks.some((block) => block.type === "custom")).toBe(true);
      expect(liveProcess.blocks.some((block) => block.type === "custom")).toBe(true);
      // No standalone custom message row in either projection.
      expect(settled.some((row) => row.kind === "message" && row.message.role === "custom")).toBe(false);
      expect(live.some((row) => row.kind === "message" && row.message.role === "custom")).toBe(false);
    }
  });

  it("shows a working process placeholder immediately after send, before any assistant tokens", () => {
    const rows = build([user("hello")], { running: true, streamingMessage: null });
    expect(kinds(rows)).toEqual(["message", "process"]);
    expect(rows[1]).toMatchObject({ kind: "process", isStreaming: true, blocks: [] });
  });

  it("merges committed process messages with the streaming partial into one live tail", () => {
    const rows = build(
      [
        user("hello", { timestamp: 1_000 }),
        assistant([{ type: "thinking", thinking: "plan" }], { timestamp: 2_000 }),
      ],
      {
        running: true,
        streamingMessage: assistant([{ type: "text", text: "partial" }], { role: "assistant", timestamp: 3_000 }),
      },
    );
    expect(kinds(rows)).toEqual(["message", "process", "message"]);
    expect(rows[1]).toMatchObject({
      kind: "process",
      isStreaming: true,
      isAnswerStreaming: true,
      startedAt: 1_000,
    });
    expect(rows[1] && "completedAt" in rows[1]).toBe(false);
    const liveAnswer = rows[2]!;
    expect(liveAnswer.kind).toBe("message");
    if (liveAnswer.kind === "message") {
      expect(liveAnswer.isStreaming).toBe(true);
      expect(liveAnswer.message.role).toBe("assistant");
    }
  });

  it("collapses a pure streaming process tail (no answer blocks yet) into one live process row", () => {
    const rows = build([user("go")], {
      running: true,
      streamingMessage: assistant([{ type: "thinking", thinking: "first" }, { type: "toolCall", toolCallId: "tc", toolName: "bash", input: {} }], { role: "assistant" }),
    });
    // Only process blocks in the streaming partial → no live answer row yet.
    expect(kinds(rows)).toEqual(["message", "process"]);
  });
});

describe("chat-projection — compaction boundary + written files", () => {
  it("treats a retained compaction entry as a turn boundary so the next agent response still uses the process path", () => {
    const rows = build([
      custom("compaction", "context summary"),
      assistant([{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }]),
      assistant([{ type: "text", text: "compacted summary" }]),
    ]);
    // custom compaction row, then a process group for the first assistant
    // response after compaction, then the final answer — never a bare message.
    expect(kinds(rows)).toEqual(["message", "process", "message"]);
    expect(rows[0]!.kind === "message" && (rows[0]!.message as { customType?: string }).customType).toBe("compaction");
  });

  it("does not drop messages after a compaction entry followed by a user turn", () => {
    const rows = build([
      custom("compaction", "ctx"),
      user("continue"),
      assistant([{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }]),
      assistant([{ type: "text", text: "resumed" }]),
    ]);
    expect(kinds(rows)).toEqual(["message", "message", "process", "message"]);
  });
});

describe("chat-projection — leaderless live tail", () => {
  it("keeps a committed leaderless fragment live while the streaming partial is temporarily absent", () => {
    const rows = build([
      assistant([{ type: "thinking", thinking: "plan" }], { timestamp: 2_000 }),
    ], {
      running: true,
      streamingMessage: null,
    });

    expect(kinds(rows)).toEqual(["process"]);
    expect(rows[0]).toMatchObject({
      kind: "process",
      key: "leaderless-process-idx0",
      isStreaming: true,
      startedAt: 2_000,
    });
    expect(rows[0] && "completedAt" in rows[0]).toBe(false);
  });

  it("shows a live leaderless process placeholder before either committed or partial content exists", () => {
    const rows = build([], { running: true, streamingMessage: null });
    expect(rows).toEqual([{
      kind: "process",
      key: "leaderless-process-idx0",
      blocks: [],
      isStreaming: true,
    }]);
  });

  it("groups a pagination-truncated fragment into ONE process group (not bare rows)", () => {
    // The oldest loaded page starts mid-turn: no user message, just the tail of
    // an assistant turn (thinking + tool + result + final text). It must render
    // as a single ProcessGroup row (timeline/tabs), never legacy bare rows.
    const rows = build([
      assistant([{ type: "thinking", thinking: "plan" }]),
      assistant([{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: {} }]),
      toolResult("tc1", "ok"),
      assistant([{ type: "text", text: "truncated tail" }]),
    ]);
    expect(kinds(rows)).toEqual(["process", "message"]);
    const process = rows[0]!;
    expect(process.kind).toBe("process");
    if (process.kind === "process") {
      expect(process.blocks.map((b) => b.type)).toEqual(["thinking", "toolCall"]);
    }
    const answer = rows[1]!;
    expect(answer.kind).toBe("message");
    if (answer.kind === "message") expect(answer.message.role).toBe("assistant");
  });

  it("never drops a streaming assistant turn when no user message is in the projection", () => {
    const rows = build([], {
      running: true,
      streamingMessage: assistant([{ type: "text", text: "standalone" }], { role: "assistant" }),
    });
    expect(kinds(rows)).toEqual(["message"]);
    expect(rows[0]!.kind === "message" && rows[0]!.message.role).toBe("assistant");
  });

  it("renders a leaderless streaming process block as its own live process group", () => {
    const rows = build([], {
      running: true,
      streamingMessage: assistant([{ type: "thinking", thinking: "plan" }, { type: "toolCall", toolCallId: "tc", toolName: "bash", input: {} }], { role: "assistant" }),
    });
    expect(kinds(rows)).toEqual(["process"]);
    expect(rows[0]!.kind === "process" && rows[0]!.isStreaming).toBe(true);
  });

  it("keeps committed leaderless process history when a new streaming partial arrives", () => {
    const committed = [
      assistant([{ type: "thinking", thinking: "old plan" }, { type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }]),
      toolResult("tc1", "ok"),
      assistant([{ type: "text", text: "intermediate reasoning" }]),
      custom("progress", "event"),
      assistant([{ type: "toolCall", toolCallId: "tc2", toolName: "bash", input: {} }]),
    ];
    const rows = build(committed, {
      running: true,
      streamingMessage: assistant([
        { type: "thinking", thinking: "current plan" },
        { type: "toolCall", toolCallId: "tc3", toolName: "edit", input: {} },
      ]),
    });
    expect(kinds(rows)).toEqual(["process"]);
    const process = rows[0]!;
    expect(process.kind).toBe("process");
    if (process.kind === "process") {
      expect(process.isStreaming).toBe(true);
      expect(process.blocks.map((block) => block.type)).toEqual([
        "thinking", "toolCall", "text", "custom", "toolCall", "thinking", "toolCall",
      ]);
      expect(process.blocks.filter((block) => block.type === "toolCall")).toHaveLength(3);
    }
  });
});

describe("chat-projection — row/branch order", () => {
  it("preserves turn order across multiple user messages", () => {
    const rows = build([
      user("a"),
      assistant([{ type: "text", text: "A1" }]),
      user("b"),
      assistant([{ type: "text", text: "B1" }]),
    ]);
    const texts = rows
      .filter((row): row is Extract<ChatTranscriptRow, { kind: "message" }> => row.kind === "message")
      .map((row) => {
        if (row.message.role === "user") return String(row.message.content);
        return (row.message as AssistantMessage).content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");
      });
    expect(texts).toEqual(["a", "A1", "b", "B1"]);
  });

  it("keeps the row order stable when a turn has multiple parallel assistant messages", () => {
    const rows = build([
      user("fork"),
      assistant([{ type: "text", text: "branch one" }]),
      assistant([{ type: "toolCall", toolCallId: "tc", toolName: "read", input: {} }]),
      assistant([{ type: "text", text: "final" }]),
    ]);
    // The earlier assistant text is process content (source grouping); the last
    // assistant message with an answer is the final answer row.
    expect(kinds(rows)).toEqual(["message", "process", "message"]);
    const process = rows[1]!;
    expect(process.kind).toBe("process");
    if (process.kind === "process") {
      expect(process.blocks.map((b) => (b.type === "text" ? b.text : b.type))).toEqual(["branch one", "toolCall"]);
    }
    const final = rows[2]!;
    expect(final.kind).toBe("message");
    if (final.kind === "message") {
      const text = (final.message as AssistantMessage).content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      expect(text).toBe("final");
    }
  });
});
