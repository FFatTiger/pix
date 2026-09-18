import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  RuntimeSnapshotSchema,
  RuntimeStateChangedContextSchema,
  RuntimeStateChangedEventDataSchema,
  SessionContextSchema,
  reduceRuntimeEventData,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Context-usage consistency (Protocol v2 additive seam):
//  - SessionContext carries the adapter-estimated `contextTokens` numerator
//    (null = post-compaction unknown, omitted = older same-major producer);
//  - `runtime_state_changed` MAY carry the atomic {model, leafId,
//    contextUsage} payload; the shared reducer applies all three fields
//    together, `null` clears, and a payload-less event stays signal-only.
// ---------------------------------------------------------------------------

const idleState = {
  sessionId: "s-1",
  isStreaming: false,
  isPromptRunning: false,
  isBashRunning: false,
  isCompacting: false,
  model: null,
  messageCount: 0,
};

function baseSnapshot(overrides = {}) {
  return {
    sessionId: "s-1",
    cwd: "/project",
    projectRoot: "/project",
    state: { ...idleState, ...overrides },
    capabilities: { capabilities: [], version: 0 },
  };
}

const OLD_WORKER_USAGE = { percent: 79.6358, contextWindow: 1_050_000, tokens: 836_176 };
const FRESH_DISK_USAGE = { percent: 26.3711, contextWindow: 1_000_000, tokens: 263_711 };

describe("SessionContext contextTokens wire contract", () => {
  it("accepts a known numerator, a known-empty zero, a null unknown, and an omitted older-producer field", () => {
    const base = {
      sessionId: "s-1",
      entries: [],
      pageInfo: { hasMore: false },
    };
    assert.equal(SessionContextSchema.safeParse({ ...base, contextTokens: 263_711 }).success, true);
    assert.equal(SessionContextSchema.safeParse({ ...base, contextTokens: 0 }).success, true);
    assert.equal(SessionContextSchema.safeParse({ ...base, contextTokens: null }).success, true);
    assert.equal(SessionContextSchema.safeParse(base).success, true);
  });

  it("rejects malformed numerators fail-closed (negative, fractional, string)", () => {
    const base = { sessionId: "s-1", entries: [], pageInfo: { hasMore: false } };
    assert.equal(SessionContextSchema.safeParse({ ...base, contextTokens: -1 }).success, false);
    assert.equal(SessionContextSchema.safeParse({ ...base, contextTokens: 1.5 }).success, false);
    assert.equal(SessionContextSchema.safeParse({ ...base, contextTokens: "263711" }).success, false);
  });
});

describe("runtime_state_changed context payload wire contract", () => {
  it("stays signal-only compatible and accepts the atomic payload", () => {
    assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
      type: "runtime_state_changed",
      sessionId: "s-1",
    }).success, true);
    assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: {
        model: { provider: "deepseek-official", id: "deepseek-v4-flash" },
        leafId: "entry-9",
        contextUsage: FRESH_DISK_USAGE,
      },
    }).success, true);
  });

  it("accepts null model/leaf/usage (honest unknown) and rejects malformed payloads", () => {
    assert.equal(RuntimeStateChangedContextSchema.safeParse({
      model: null,
      leafId: null,
      contextUsage: null,
    }).success, true);
    // Missing field (Protocol v3 required-field floor will make this a
    // producer error): malformed context fails closed today via strictness.
    assert.equal(RuntimeStateChangedContextSchema.safeParse({
      model: null,
      leafId: null,
    }).success, false);
    assert.equal(RuntimeStateChangedEventDataSchema.safeParse({
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: { model: null, leafId: "x", contextUsage: { percent: "26" } },
    }).success, false);
  });
});

describe("reduceRuntimeEventData — atomic context payload application", () => {
  it("applies model, leafId and contextUsage together from one payload", () => {
    const before = baseSnapshot({
      model: { provider: "acme-gpt", id: "gpt-6-astra" },
      leafId: "entry-1",
      contextUsage: OLD_WORKER_USAGE,
    });
    const after = reduceRuntimeEventData(before, {
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: {
        model: { provider: "deepseek-official", id: "deepseek-v4-flash" },
        leafId: "entry-7",
        contextUsage: FRESH_DISK_USAGE,
      },
    });
    assert.deepEqual(after.state.model, { provider: "deepseek-official", id: "deepseek-v4-flash" });
    assert.equal(after.state.leafId, "entry-7");
    assert.deepEqual(after.state.contextUsage, FRESH_DISK_USAGE);
    // Input snapshot untouched (pure reducer).
    assert.deepEqual(before.state.contextUsage, OLD_WORKER_USAGE);
  });

  it("isolates the reduced state from subsequent event mutation", () => {
    const event = {
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: {
        model: { provider: "p", id: "m" },
        leafId: "entry-7",
        contextUsage: { ...FRESH_DISK_USAGE },
      },
    };
    const after = reduceRuntimeEventData(baseSnapshot(), event);
    event.context.model.id = "changed";
    event.context.contextUsage.tokens = 999;
    assert.equal(after.state.model.id, "m");
    assert.equal(after.state.contextUsage.tokens, FRESH_DISK_USAGE.tokens);
    after.state.model.provider = "local";
    after.state.contextUsage.percent = 0;
    assert.equal(event.context.model.provider, "p");
    assert.equal(event.context.contextUsage.percent, FRESH_DISK_USAGE.percent);
  });

  it("null usage clears a stale percentage (post-compaction unknown) and null leaf clears the pointer", () => {
    const before = baseSnapshot({
      leafId: "entry-7",
      contextUsage: OLD_WORKER_USAGE,
    });
    const after = reduceRuntimeEventData(before, {
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: { model: null, leafId: null, contextUsage: null },
    });
    assert.equal(after.state.contextUsage, null);
    assert.equal("leafId" in after.state, false);
    assert.equal(after.state.model, null);
  });

  it("a payload-less event stays signal-only: no projection mutation", () => {
    const before = baseSnapshot({
      leafId: "entry-7",
      contextUsage: FRESH_DISK_USAGE,
      model: { provider: "p", id: "m" },
    });
    const after = reduceRuntimeEventData(before, {
      type: "runtime_state_changed",
      sessionId: "s-1",
    });
    assert.deepEqual(after, before);
  });

  it("a fresh payload after a committed message_end converges usage with the advanced leaf", () => {
    let snapshot = baseSnapshot({ contextUsage: null });
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "message_start",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    });
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "message_end",
      sessionId: "s-1",
      streamId: "stream-1",
      messageId: "msg-1",
      message: { role: "assistant", content: [{ type: "text", text: "xy" }], model: "m", provider: "p" },
      entryId: "entry-2",
    });
    // message_end advances leaf/count but NOT usage (frozen-value bug guard)…
    assert.equal(snapshot.state.leafId, "entry-2");
    assert.equal(snapshot.state.messageCount, 1);
    assert.equal(snapshot.state.contextUsage, null);
    // …the committed payload published right after it is what updates usage.
    snapshot = reduceRuntimeEventData(snapshot, {
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: {
        model: { provider: "p", id: "m" },
        leafId: "entry-2",
        contextUsage: FRESH_DISK_USAGE,
      },
    });
    assert.deepEqual(snapshot.state.contextUsage, FRESH_DISK_USAGE);
  });

  it("rejects a cross-session payload fail-closed (caller owns cursor gating)", () => {
    const before = baseSnapshot();
    assert.throws(() => reduceRuntimeEventData(before, {
      type: "runtime_state_changed",
      sessionId: "OTHER",
      context: { model: null, leafId: null, contextUsage: null },
    }), /mismatch/);
  });

  it("the reduced snapshot stays schema-valid (no extra keys leak onto the wire)", () => {
    const after = reduceRuntimeEventData(baseSnapshot({ leafId: "entry-1", contextUsage: OLD_WORKER_USAGE }), {
      type: "runtime_state_changed",
      sessionId: "s-1",
      context: { model: null, leafId: null, contextUsage: null },
    });
    assert.equal(RuntimeSnapshotSchema.safeParse(after).success, true);
  });
});

describe("protocol version fence", () => {
  it("stays on Protocol v2 (additive seam, no major bump)", () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });
});
