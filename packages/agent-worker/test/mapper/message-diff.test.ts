import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffSameRole } from "../../src/mapper/message-diff.js";
import type { AssistantContentBlock, StreamingAgentMessage } from "@fffattiger/pix-runtime-core";

function assistant(blocks: readonly AssistantContentBlock[]): StreamingAgentMessage {
  return { role: "assistant", content: blocks };
}
describe("message-diff (frozen diff boundaries)", () => {
  it("prefix text growth yields exactly one suffix delta", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "Hello" }]),
      assistant([{ type: "text", text: "Hello world" }]),
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "assistant", delta: { type: "text", text: " world" } }] });
  });

  it("byte-identical cumulative yields zero deltas (duplicate)", () => {
    const message = assistant([{ type: "text", text: "Hello" }]);
    const result = diffSameRole(message, message);
    assert.deepEqual(result, { kind: "deltas", deltas: [] });
  });

  it("non-prefix text rewrite restarts", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "Hello" }]),
      assistant([{ type: "text", text: "Goodbye" }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("text shrinkage restarts (never emits a negative delta)", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "Hello world" }]),
      assistant([{ type: "text", text: "Hello" }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("thinking prefix growth yields a thinking suffix delta", () => {
    const result = diffSameRole(
      assistant([{ type: "thinking", thinking: "plan" }]),
      assistant([{ type: "thinking", thinking: "planning" }]),
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "assistant", delta: { type: "thinking", thinking: "ning" } }] });
  });

  it("thinking rewrite restarts", () => {
    const result = diffSameRole(
      assistant([{ type: "thinking", thinking: "plan" }]),
      assistant([{ type: "thinking", thinking: "other" }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("unchanged toolCall yields no delta", () => {
    const toolCall = { type: "toolCall" as const, toolCallId: "t1", toolName: "bash", input: { a: 1 } };
    const result = diffSameRole(assistant([toolCall]), assistant([toolCall]));
    assert.deepEqual(result, { kind: "deltas", deltas: [] });
  });

  it("toolCall input mutation restarts", () => {
    const result = diffSameRole(
      assistant([{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: { a: 1 } }]),
      assistant([{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: { a: 2 } }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("toolCallId change restarts", () => {
    const result = diffSameRole(
      assistant([{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: {} }]),
      assistant([{ type: "toolCall", toolCallId: "t2", toolName: "bash", input: {} }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("image rewrite restarts", () => {
    const image = (data: string) => ({ type: "image" as const, source: { type: "base64" as const, data, media_type: "image/png" as const } });
    const result = diffSameRole(
      assistant([{ type: "text", text: "see:" }, image("AAAA")]),
      assistant([{ type: "text", text: "see:" }, image("BBBB")]),
    );
    assert.equal(result.kind, "restart");
  });

  it("new trailing text block produces a delta", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "Hello" }]),
      assistant([{ type: "text", text: "Hello" }, { type: "text", text: " world" }]),
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "assistant", delta: { type: "text", text: " world" } }] });
  });

  it("new trailing toolCall block produces a toolCall delta", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "Hi" }]),
      assistant([{ type: "text", text: "Hi" }, { type: "toolCall", toolCallId: "t9", toolName: "ls", input: {} }]),
    );
    assert.deepEqual(result, {
      kind: "deltas",
      deltas: [{ role: "assistant", delta: { type: "toolCall", toolCallId: "t9", toolName: "ls", input: {} } }],
    });
  });

  it("new trailing image block restarts (image has no incremental delta)", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "Hi" }]),
      assistant([{ type: "text", text: "Hi" }, { type: "image", source: { type: "url", url: "https://example.com/a.png" } }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("fewer blocks restarts (content shrinkage)", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "A" }, { type: "text", text: "B" }]),
      assistant([{ type: "text", text: "A" }]),
    );
    assert.equal(result.kind, "restart");
  });

  it("role mismatch restarts (caller opens a new stream)", () => {
    const result = diffSameRole(
      assistant([{ type: "text", text: "A" }]),
      { role: "user", content: "B" },
    );
    assert.equal(result.kind, "restart");
  });

  it("toolResult text prefix growth yields a toolResult suffix delta", () => {
    const result = diffSameRole(
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "out" }] },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "output" }] },
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "toolResult", toolCallId: "t1", delta: { type: "text", text: "put" } }] });
  });

  it("toolResult toolCallId change restarts", () => {
    const result = diffSameRole(
      { role: "toolResult", toolCallId: "t1", content: [] },
      { role: "toolResult", toolCallId: "t2", content: [] },
    );
    assert.equal(result.kind, "restart");
  });

  it("toolResult brand-new image block yields an image delta", () => {
    const result = diffSameRole(
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "see" }] },
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "see" }, { type: "image", source: { type: "url", url: "https://example.com/b.png" } }],
      },
    );
    assert.equal(result.kind, "deltas");
    if (result.kind !== "deltas") return;
    assert.equal(result.deltas.length, 1);
    const delta = result.deltas[0]!;
    assert.equal(delta.role, "toolResult");
    assert.equal(delta.delta.type, "image");
  });

  it("toolResult image rewrite restarts", () => {
    const image = (data: string) => ({ type: "image" as const, source: { type: "base64" as const, data, media_type: "image/png" as const } });
    const result = diffSameRole(
      { role: "toolResult", toolCallId: "t1", content: [image("AAAA")] },
      { role: "toolResult", toolCallId: "t1", content: [image("BBBB")] },
    );
    assert.equal(result.kind, "restart");
  });

  it("custom string prefix growth yields a custom suffix delta", () => {
    const result = diffSameRole(
      { role: "custom", customType: "status", content: "step 1" },
      { role: "custom", customType: "status", content: "step 1/2" },
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "custom", customType: "status", delta: { type: "text", text: "/2" } }] });
  });

  it("custom customType change restarts", () => {
    const result = diffSameRole(
      { role: "custom", customType: "status", content: "a" },
      { role: "custom", customType: "widget", content: "a" },
    );
    assert.equal(result.kind, "restart");
  });

  it("custom non-string rewrite restarts", () => {
    const result = diffSameRole(
      { role: "custom", customType: "status", content: "a" },
      { role: "custom", customType: "status", content: "b" },
    );
    assert.equal(result.kind, "restart");
  });

  it("bashExecution output prefix growth yields an output delta", () => {
    const result = diffSameRole(
      { role: "bashExecution", command: "ls", output: "a" },
      { role: "bashExecution", command: "ls", output: "ab" },
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "bashExecution", delta: { type: "output", output: "b" } }] });
  });

  it("bashExecution status change yields a status delta", () => {
    const result = diffSameRole(
      { role: "bashExecution", command: "ls", output: "a" },
      { role: "bashExecution", command: "ls", output: "a", exitCode: 0 },
    );
    assert.deepEqual(result, { kind: "deltas", deltas: [{ role: "bashExecution", delta: { type: "status", exitCode: 0 } }] });
  });

  it("bashExecution command change restarts", () => {
    const result = diffSameRole(
      { role: "bashExecution", command: "ls", output: "a" },
      { role: "bashExecution", command: "pwd", output: "a" },
    );
    assert.equal(result.kind, "restart");
  });

  it("bashExecution output rewrite restarts", () => {
    const result = diffSameRole(
      { role: "bashExecution", command: "ls", output: "abc" },
      { role: "bashExecution", command: "ls", output: "ax" },
    );
    assert.equal(result.kind, "restart");
  });

  it("user role any mutation restarts (no user update delta exists)", () => {
    const result = diffSameRole({ role: "user", content: "a" }, { role: "user", content: "ab" });
    assert.equal(result.kind, "restart");
  });
});
