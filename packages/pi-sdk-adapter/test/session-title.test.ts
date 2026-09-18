import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendTitleRequestToTrailingUser,
  parseGeneratedSessionTitle,
  sanitizeTitleMessages,
} from "../src/internal/session-title.js";

/**
 * Deterministic unit tests for the PURE helpers of real session-title
 * generation (port of the legacy web app's session-title module). No model
 * calls, no Agent construction — only the message/string transformations that
 * the shadow-agent title run depends on.
 */

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

const USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(content: UserMessage["content"]): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" | "error" = "stop",
  errorMessage?: string,
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: USAGE,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 2,
  };
}

function toolResult(toolCallId: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "grep",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 3,
  };
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function toolCallBlock(
  id: string,
  name = "grep",
): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
  return { type: "toolCall", id, name, arguments: {} };
}

describe("parseGeneratedSessionTitle", () => {
  it("extracts a title from a fenced JSON response", () => {
    assert.equal(parseGeneratedSessionTitle('```json\n{"title": "Fix login bug"}\n```'), "Fix login bug");
  });

  it("extracts a title from a bare JSON object", () => {
    assert.equal(parseGeneratedSessionTitle('{"title": "Refactor auth flow"}'), "Refactor auth flow");
  });

  it("strips wrapping quotes", () => {
    assert.equal(parseGeneratedSessionTitle('"Refactor auth flow"'), "Refactor auth flow");
    assert.equal(parseGeneratedSessionTitle("'Refactor auth flow'"), "Refactor auth flow");
    assert.equal(parseGeneratedSessionTitle("`Refactor auth flow`"), "Refactor auth flow");
    assert.equal(parseGeneratedSessionTitle("\u201cRefactor auth flow\u201d"), "Refactor auth flow");
    assert.equal(parseGeneratedSessionTitle("\u300c重构登录流程\u300d"), "重构登录流程");
  });

  it("strips label prefixes", () => {
    assert.equal(parseGeneratedSessionTitle("Title: Refactor auth flow"), "Refactor auth flow");
    assert.equal(parseGeneratedSessionTitle("session title: Refactor auth flow"), "Refactor auth flow");
    assert.equal(parseGeneratedSessionTitle("标题：重构登录流程"), "重构登录流程");
  });

  it("keeps only the first line of a multiline response", () => {
    assert.equal(parseGeneratedSessionTitle("Refactor the auth flow\nto use refresh tokens"), "Refactor the auth flow");
  });

  it("truncates to 80 characters", () => {
    const long = "x".repeat(100);
    assert.equal(parseGeneratedSessionTitle(long).length, 80);
    assert.equal(parseGeneratedSessionTitle(long), "x".repeat(80));
  });

  it("throws when no usable title is present", () => {
    assert.throws(() => parseGeneratedSessionTitle("..."), /The model did not return a usable session title/);
    assert.throws(() => parseGeneratedSessionTitle("```\n```"), /The model did not return a usable session title/);
    assert.throws(() => parseGeneratedSessionTitle("\uD83D\uDE42"), /The model did not return a usable session title/);
  });
});

describe("sanitizeTitleMessages", () => {
  it("drops orphan tool results that no assistant tool call requested", () => {
    const messages: AgentMessage[] = [
      user("hi"),
      assistant([textBlock("plain answer")]),
      toolResult("call_orphan"),
    ];
    const sanitized = sanitizeTitleMessages(messages);
    assert.deepEqual(
      sanitized.map((message) => message.role),
      ["user", "assistant"],
    );
  });

  it("removes orphan assistant tool calls that have no following tool result", () => {
    const messages: AgentMessage[] = [
      user("hi"),
      assistant([textBlock("I will search"), toolCallBlock("call_orphan")], "toolUse"),
    ];
    const sanitized = sanitizeTitleMessages(messages);
    assert.equal(sanitized.length, 2);
    const firstAssistant = sanitized[1]! as AssistantMessage;
    assert.deepEqual(
      firstAssistant.content.map((block) => (block as { type: string }).type),
      ["text"],
    );
  });

  it("keeps assistant tool calls paired with a matching following tool result", () => {
    const messages: AgentMessage[] = [
      user("hi"),
      assistant([textBlock("searching"), toolCallBlock("call_1")], "toolUse"),
      toolResult("call_1"),
      assistant([textBlock("done")]),
    ];
    const sanitized = sanitizeTitleMessages(messages);
    assert.deepEqual(
      sanitized.map((message) => message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    const firstAssistant = sanitized[1]! as AssistantMessage;
    assert.deepEqual(
      firstAssistant.content.map((block) => (block as { type: string }).type),
      ["text", "toolCall"],
    );
    assert.equal(sanitized.length, 4, "paired tool call + result must be preserved");
  });
});

describe("appendTitleRequestToTrailingUser", () => {
  it("folds the title request into a trailing string-content user message", () => {
    const messages: AgentMessage[] = [user("Hello there")];
    const folded = appendTitleRequestToTrailingUser(messages);
    const last = folded[folded.length - 1]!;
    assert.equal(last.role, "user");
    if (last.role !== "user") return;
    assert.equal(typeof last.content, "string");
    if (typeof last.content !== "string") return;
    assert.ok(last.content.startsWith("Hello there\n\n"), "original text must be preserved");
    assert.ok(last.content.includes("Create a concise title for this session"));
    assert.ok(last.content.includes("Do not call any tools."));
    assert.ok(last.content.includes("Return only the title as plain text"));
  });

  it("folds the title request into a trailing block-content user message", () => {
    const messages: AgentMessage[] = [user([textBlock("Hello there")])];
    const folded = appendTitleRequestToTrailingUser(messages);
    const last = folded[folded.length - 1]!;
    assert.equal(last.role, "user");
    if (last.role !== "user") return;
    assert.equal(typeof last.content, "object", "block content must stay an array");
    if (typeof last.content === "string") return;
    assert.equal(last.content.length, 2, "one original block plus the folded title prompt");
    const second = last.content[1];
    assert.ok(second !== undefined && second.type === "text", "second block must be the folded title prompt");
    if (second !== undefined && second.type === "text") {
      assert.ok(second.text.startsWith("Create a concise title for this session"));
      assert.ok(second.text.includes("Do not call any tools."));
    }
  });

  it("no-ops when the trailing message is not a user message", () => {
    const assistantTail: AgentMessage[] = [assistant([textBlock("response")])];
    assert.equal(appendTitleRequestToTrailingUser(assistantTail), assistantTail);

    const toolResultTail: AgentMessage[] = [user("hi"), toolResult("call_1")];
    assert.equal(appendTitleRequestToTrailingUser(toolResultTail), toolResultTail);
  });
});
