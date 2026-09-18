import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextUsageFromSession } from "../src/internal/sdk-runtime.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Deterministic fixtures for the FILE-BACKED context usage estimate.
//
// Regression: the Pi SDK's `session.getContextUsage()` estimates from the
// agent's in-memory transcript, which a long-lived worker can desync from the
// session file — the estimate then stays 0 forever while stats keep growing.
// `contextUsageFromSession` sources the SAME arithmetic from the session
// manager (the on-disk branch actually sent to the LLM) instead. These tests
// pin the arithmetic and the fail-closed "unknown" semantics.
// ---------------------------------------------------------------------------

interface FakeMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface FakeEntry {
  type: string;
  message?: FakeMessage;
  timestamp?: string;
  summary?: string;
}

function fakeSession(options: {
  model?: { provider: string; id: string; contextWindow?: number } | null;
  branch: FakeEntry[];
  messages: FakeMessage[];
}): AgentSession {
  return {
    model: options.model ?? null,
    sessionManager: {
      getBranch: () => options.branch,
      buildSessionContext: () => ({ messages: options.messages, thinkingLevel: "off", model: null }),
      getLeafId: () => null,
      getEntries: () => options.branch,
      getCwd: () => "/workspace",
    },
  } as unknown as AgentSession;
}

const MODEL = { provider: "test", id: "m", contextWindow: 10_000 };

describe("contextUsageFromSession (file-backed context estimate)", () => {
  it("estimates from the manager messages (last valid assistant usage + trailing), not the in-memory list", () => {
    const messages: FakeMessage[] = [
      { role: "user", content: "abcd" }, // 4 chars → 1 token
      {
        role: "assistant",
        content: [{ type: "text", text: "eight chars!" }],
        stopReason: "end_turn",
        usage: { totalTokens: 1000, input: 1000, output: 0 },
      },
      { role: "toolResult", content: [{ type: "text", text: "1234" }] }, // 4 chars → 1
    ];
    const session = fakeSession({
      model: MODEL,
      branch: messages.map((message) => ({ type: "message", message })),
      messages,
    });
    const usage = contextUsageFromSession(session);
    assert.ok(usage);
    assert.equal(usage.percent === null ? null : Math.round(usage.percent * 100) / 100, (1001 / 10_000) * 100);
    assert.equal(usage.tokens, 1001);
    assert.equal(usage.contextWindow, 10_000);
  });

  it("empty session really is 0% (never hidden as unknown)", () => {
    const session = fakeSession({ model: MODEL, branch: [], messages: [] });
    const usage = contextUsageFromSession(session);
    assert.ok(usage);
    assert.equal(usage.percent, 0);
    assert.equal(usage.tokens, 0);
  });

  it("omits context usage entirely when the model has no usable context window", () => {
    const session = fakeSession({
      model: { provider: "test", id: "m" },
      branch: [],
      messages: [],
    });
    assert.equal(contextUsageFromSession(session), undefined);
    // No model at all → also omitted (fail closed, never a made-up window).
    assert.equal(contextUsageFromSession(fakeSession({ model: null, branch: [], messages: [] })), undefined);
  });

  it("post-compaction with NO valid assistant usage after → unknown (percent null, tokens null)", () => {
    const branch: FakeEntry[] = [
      { type: "message", message: { role: "user", content: "before" } },
      { type: "compaction", timestamp: "2026-01-01T00:00:00.000Z", summary: "summary" },
      { type: "message", message: { role: "assistant", stopReason: "aborted", content: [], usage: { totalTokens: 999_999 } } },
      { type: "message", message: { role: "assistant", stopReason: "error", content: [], usage: { totalTokens: 999_999 } } },
    ];
    // Even though stale pre/late usage exists, the true size is unknown until a
    // post-compaction response lands.
    const session = fakeSession({
      model: MODEL,
      branch,
      messages: branch.filter((e) => e.message).map((e) => e.message as FakeMessage),
    });
    const usage = contextUsageFromSession(session);
    assert.ok(usage);
    assert.equal(usage.percent, null);
    assert.equal(usage.tokens, null);
  });

  it("post-compaction WITH a valid assistant usage after → estimate from that usage", () => {
    const branch: FakeEntry[] = [
      { type: "compaction", timestamp: "2026-01-01T00:00:00.000Z", summary: "summary" },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "end_turn",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 200, output: 300, cacheRead: 500, cacheWrite: 0 },
        },
      },
    ];
    const session = fakeSession({
      model: MODEL,
      branch,
      messages: branch.filter((e) => e.message).map((e) => e.message as FakeMessage),
    });
    const usage = contextUsageFromSession(session);
    assert.ok(usage);
    // No totalTokens → sum of components (SDK calculateContextTokens fallback).
    assert.equal(usage.tokens, 1000);
    assert.ok(usage.percent !== null && usage.percent > 0);
  });

  it("falls back to the estimateTokens sum when no assistant usage exists at all", () => {
    const messages: FakeMessage[] = [
      { role: "user", content: "0123456789" }, // 10 chars → 3 tokens (ceil 2.5)
      { role: "user", content: "abcd" }, // 4 chars → 1
    ];
    const session = fakeSession({
      model: MODEL,
      branch: messages.map((message) => ({ type: "message", message })),
      messages,
    });
    const usage = contextUsageFromSession(session);
    assert.ok(usage);
    assert.ok(usage.tokens !== null && usage.tokens >= 4);
    assert.equal(usage.percent === null ? null : usage.percent >= 0, true);
  });
});
