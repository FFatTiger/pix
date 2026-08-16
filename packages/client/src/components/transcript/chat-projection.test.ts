import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage } from "@fffattiger/pix-protocol";
import {
  buildChatTranscriptRows,
  type ChatTranscriptRow,
} from "./chat-projection";

function user(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
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

describe("chat-projection — user → process → final", () => {
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
    // No final answer → the tool-call assistant becomes a process row (never a
    // fake answer row) and the trailing toolResult renders after it.
    expect(kinds(rows)).toEqual(["message", "process", "message"]);
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
  it("merges committed process messages with the streaming partial into one live tail", () => {
    const rows = build(
      [
        user("hello"),
        assistant([{ type: "thinking", thinking: "plan" }]),
      ],
      {
        running: true,
        streamingMessage: assistant([{ type: "text", text: "partial" }], { role: "assistant" }),
      },
    );
    expect(kinds(rows)).toEqual(["message", "process", "message"]);
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
