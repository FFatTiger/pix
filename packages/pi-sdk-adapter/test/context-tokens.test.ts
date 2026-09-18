import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import { contextUsageFromSession } from "../src/internal/sdk-runtime.js";
import { estimateSdkBranchContextTokens } from "../src/internal/context-tokens.js";

// ---------------------------------------------------------------------------
// Context-usage consistency (adapter seam).
//
// The ONE shared estimator must make the LIVE driver's usage and the
// ZERO-WORKER history read (`readSessionContext.contextTokens`) agree about
// the same JSONL branch, regardless of paging/deferral, and keep the honest
// post-compaction "unknown". These tests pin that parity with REAL temp JSONL
// sessions (deterministic, never a real user session).
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function usage(totalTokens: number) {
  return {
    input: Math.max(0, totalTokens - 10),
    output: Math.min(10, totalTokens),
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

interface Fixture {
  root: string;
  sessionDir: string;
  cwd: string;
  manager: SessionManager;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pix-context-tokens-"));
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { root, sessionDir, cwd, manager: SessionManager.create(cwd, sessionDir) };
}

/** Wrap a real manager + a fixed model into the AgentSession estimator seam. */
function fakeLiveSession(
  manager: SessionManager,
  model: { provider: string; id: string; contextWindow: number } | null,
): AgentSession {
  return {
    model,
    sessionManager: manager,
  } as unknown as AgentSession;
}

describe("shared context-token estimator (live ↔ history parity)", () => {
  it("the live driver numerator and the history contextTokens are IDENTICAL on the same branch", async () => {
    const f = await setup();
    try {
      const manager = f.manager;
      manager.appendMessage({ role: "user", content: "hello world", timestamp: NOW });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "anthropic",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        usage: usage(200_000),
        stopReason: "stop",
        timestamp: NOW + 1,
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "search",
        content: [{ type: "text", text: "a tool result with some length" }],
        isError: false,
        timestamp: NOW + 2,
      });

      const sessionId = manager.getSessionId();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const context = await store.readSessionContext(sessionId);
      assert.notEqual(context.contextTokens, undefined);
      assert.notEqual(context.contextTokens, null);

      const live = contextUsageFromSession(fakeLiveSession(manager, {
        provider: "deepseek-official",
        id: "deepseek-v4-flash",
        contextWindow: 1_000_000,
      }));
      assert.ok(live);
      assert.ok(live.tokens !== null);
      assert.equal(context.contextTokens, live.tokens, "live numerator must equal the history numerator");
      assert.equal(live.contextWindow, 1_000_000);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("the latest persisted model + its usage estimate is what history reports (26% branch), never a background worker's", async () => {
    const f = await setup();
    try {
      const manager = f.manager;
      // Fork from a non-tip entry so both old and new branches remain leaves.
      manager.appendModelChange("acme-gpt", "gpt-6-astra");
      const branchPoint = manager.appendMessage({ role: "user", content: "old branch", timestamp: NOW });
      const assistantA = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        api: "anthropic",
        provider: "acme-gpt",
        model: "gpt-6-astra",
        usage: usage(836_176),
        stopReason: "stop",
        timestamp: NOW + 1,
      });
      manager.branch(branchPoint);
      manager.appendModelChange("deepseek-official", "deepseek-v4-flash");
      manager.appendMessage({ role: "user", content: "new branch", timestamp: NOW + 2 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "new answer" }],
        api: "anthropic",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        usage: usage(263_711),
        stopReason: "stop",
        timestamp: NOW + 3,
      });

      const sessionId = manager.getSessionId();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const context = await store.readSessionContext(sessionId);
      // The SELECTED (latest persisted) branch estimate is the 263_711 usage —
      // the old branch's 836_176 belongs to a different leaf and must never
      // win just because a same-id worker holds it in memory.
      assert.equal(context.contextTokens, 263_711);
      assert.equal(context.settings?.model?.provider, "deepseek-official");
      assert.equal(context.settings?.model?.modelId, "deepseek-v4-flash");
      const old = await store.readSessionContext(sessionId, { leafId: assistantA });
      assert.equal(old.contextTokens, 836_176);
      assert.equal(old.settings?.model?.modelId, "gpt-6-astra");
      const parents = new Set(manager.getEntries().map((entry) => entry.parentId));
      assert.equal(manager.getEntries().filter((entry) => !parents.has(entry.id)).length, 2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("a selected OLD leaf gets its OWN model + token estimate", async () => {
    const f = await setup();
    try {
      const manager = f.manager;
      manager.appendMessage({ role: "user", content: "old branch", timestamp: NOW });
      const assistantA = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        api: "anthropic",
        provider: "acme-gpt",
        model: "gpt-6-astra",
        usage: usage(836_176),
        stopReason: "stop",
        timestamp: NOW + 1,
      });
      manager.appendModelChange("deepseek-official", "deepseek-v4-flash");
      manager.appendMessage({ role: "user", content: "new branch", timestamp: NOW + 2 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "new answer" }],
        api: "anthropic",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        usage: usage(263_711),
        stopReason: "stop",
        timestamp: NOW + 3,
      });

      const sessionId = manager.getSessionId();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const selected = await store.readSessionContext(sessionId, { leafId: assistantA });
      assert.equal(selected.contextTokens, 836_176);
      assert.equal(selected.settings?.model?.provider, "acme-gpt");
      assert.equal(selected.settings?.model?.modelId, "gpt-6-astra");

      // Invalid / non-member leaf fails closed BEFORE any SDK projection.
      await assert.rejects(
        () => store.readSessionContext(sessionId, { leafId: "not-an-entry" }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("raw deferral (thinking/media) and explicit paging NEVER change contextTokens", async () => {
    const f = await setup();
    try {
      const manager = f.manager;
      manager.appendMessage({ role: "user", content: "hello", timestamp: NOW });
      manager.appendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "long reasoning ".repeat(200) },
          { type: "text", text: "answer" },
        ],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(1_000),
        stopReason: "stop",
        timestamp: NOW + 1,
      });
      manager.appendMessage({ role: "user", content: "more", timestamp: NOW + 2 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(2_000),
        stopReason: "stop",
        timestamp: NOW + 3,
      });

      manager.appendMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "trailing reasoning ".repeat(2000) }],
        api: "anthropic", provider: "p", model: "m",
        usage: usage(0), stopReason: "stop", timestamp: NOW + 4,
      });
      manager.appendMessage({
        role: "toolResult", toolCallId: "image-tail", toolName: "read",
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "trailing tool result" }],
        isError: false, timestamp: NOW + 5,
      });
      const sessionId = manager.getSessionId();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const complete = await store.readSessionContext(sessionId);
      const deferred = await store.readSessionContext(sessionId, { deferThinking: true, deferMedia: true });
      const paged = await store.readSessionContext(sessionId, { limit: 1, deferThinking: true, deferMedia: true });
      assert.ok(complete.contextTokens !== undefined && complete.contextTokens !== null && complete.contextTokens > 10_000,
        "trailing thinking and image estimates must contribute beyond the last positive usage");
      assert.equal(deferred.contextTokens, complete.contextTokens);
      assert.equal(paged.contextTokens, complete.contextTokens);
      const imageTail = deferred.entries.at(-1)?.message;
      assert.equal(imageTail?.role, "toolResult");
      if (imageTail?.role === "toolResult") assert.equal(imageTail.content.some((block) => block.type === "image"), false);
      assert.equal(paged.entries.length, 1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("post-compaction stays UNKNOWN (null) until a valid post-compaction usage — error/aborted/zero usages do not resurrect", async () => {
    const f = await setup();
    try {
      const manager = f.manager;
      const user = manager.appendMessage({ role: "user", content: "before compaction", timestamp: NOW });
      const assistant = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "pre-compaction answer" }],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(500_000),
        stopReason: "stop",
        timestamp: NOW + 1,
      });
      const compaction = manager.appendCompaction("summary", assistant, 500_000, undefined, false, usage(1));
      assert.ok(compaction);
      // Post-compaction: aborted assistant (usage present but invalid).
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "aborted" }],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(999_999),
        stopReason: "aborted",
        timestamp: NOW + 2,
      });
      // Error assistant with ZERO usage.
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "errored" }],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(0),
        stopReason: "error",
        timestamp: NOW + 3,
      });

      const sessionId = manager.getSessionId();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const unknown = await store.readSessionContext(sessionId);
      assert.equal(unknown.contextTokens, null, "no pre-compaction resurrection, no fake 0%");

      // Live driver on the same session must agree (null percent, window kept).
      const live = contextUsageFromSession(fakeLiveSession(manager, {
        provider: "p",
        id: "m",
        contextWindow: 1_000_000,
      }));
      assert.ok(live);
      assert.equal(live.percent, null);
      assert.equal(live.tokens, null);
      assert.equal(live.contextWindow, 1_000_000);

      // A VALID post-compaction usage flips both to a real estimate.
      manager.appendMessage({ role: "user", content: "after compaction", timestamp: NOW + 4 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "post-compaction answer" }],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(120_000),
        stopReason: "stop",
        timestamp: NOW + 5,
      });
      const recovered = await store.readSessionContext(sessionId);
      assert.equal(recovered.contextTokens, 120_000);
      assert.equal(user.length > 0, true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("window change with the SAME leaf never keeps the stale denominator (numerator cached, window fresh)", async () => {
    const f = await setup();
    try {
      const manager = f.manager;
      manager.appendMessage({ role: "user", content: "hi", timestamp: NOW });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "anthropic",
        provider: "p",
        model: "m",
        usage: usage(500_000),
        stopReason: "stop",
        timestamp: NOW + 1,
      });

      const narrow = contextUsageFromSession(fakeLiveSession(manager, {
        provider: "p", id: "m", contextWindow: 1_000_000,
      }));
      const wide = contextUsageFromSession(fakeLiveSession(manager, {
        provider: "p", id: "m", contextWindow: 2_000_000,
      }));
      assert.ok(narrow && wide);
      assert.equal(narrow.tokens, 500_000);
      assert.equal(wide.tokens, 500_000, "same branch → same numerator");
      assert.equal(narrow.percent, 50);
      assert.equal(wide.percent, 25, "window/percent track the CURRENT model, not the cached result");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("empty branch is a KNOWN zero (never hidden as unknown)", () => {
    // NOTE: the Pi SDK never persists an assistant-less session to disk (its
    // no-assistant flush guard), so a zero-token HISTORY read cannot occur for
    // a real file — zero is still a KNOWN value, pinned here at the estimator
    // seam and on the live driver (in-memory manager) that CAN hold it.
    assert.equal(estimateSdkBranchContextTokens([], []), 0);
    const f = { manager: SessionManager.inMemory("/workspace") };
    const live = contextUsageFromSession(fakeLiveSession(f.manager, {
      provider: "p", id: "m", contextWindow: 1_000,
    }));
    assert.ok(live);
    assert.equal(live.percent, 0);
    assert.equal(live.tokens, 0);
  });

  it("the estimator is a pure shared owner: identical inputs → identical output regardless of caller", () => {
    const messages = [
      { role: "user", content: "abcd" },
      {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        stopReason: "stop",
        usage: { totalTokens: 7_777, input: 7_000, output: 777 },
      },
      { role: "user", content: "trailing question" },
    ];
    const branch = messages.map((message) => ({ type: "message", message }));
    const first = estimateSdkBranchContextTokens(branch as never, messages as never);
    const second = estimateSdkBranchContextTokens(branch as never, messages as never);
    assert.equal(first, second);
    assert.ok(first !== null && first > 7_777, "trailing estimate is added to the usage numerator");
  });
});
