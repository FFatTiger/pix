/**
 * Bounded composer staging owner (4A.3.2a) — pure store tests.
 */
import { describe, expect, it } from "vitest";
import {
  SessionStagingStore,
  isProvisionalStagingKey,
  isStagingKey,
  provisionalStagingKey,
  sessionStagingKey,
} from "./session-staging-store";

const MODEL_A = { provider: "openai", modelId: "gpt-4o" };
const MODEL_B = { provider: "anthropic", modelId: "claude" };

describe("SessionStagingStore — bounds / validation / A-B independence", () => {
  it("bounds records at max with NO silent eviction: a new key at capacity is session_busy retryable:true", () => {
    const store = new SessionStagingStore({ maxRecords: 2 });
    expect(store.stage("session:A", MODEL_A, "medium")).toEqual({ ok: true });
    expect(store.stage("session:B", MODEL_B, "low")).toEqual({ ok: true });
    // Capacity reached; existing keys still update.
    expect(store.stage("session:A", MODEL_A, "high")).toEqual({ ok: true });
    // A NEW key at capacity fails structured, never silently evicts.
    const result = store.stage("session:C", MODEL_A, "medium");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: "session_busy", retryable: true });
    }
    expect(store.count).toBe(2);
    expect(store.get("session:A")).not.toBeNull();
    expect(store.get("session:C")).toBeNull();
    // In-place updates never fail even at capacity.
    expect(store.stage("session:A", null, null)).toEqual({ ok: true });
    expect(store.count).toBe(1);
  });

  it("exports typed session/provisional constructors and rejects invalid keys", () => {
    expect(sessionStagingKey("A")).toBe("session:A");
    expect(provisionalStagingKey("home")).toBe("new:home");
    expect(isStagingKey(sessionStagingKey("A"))).toBe(true);
    expect(isProvisionalStagingKey(provisionalStagingKey("tx-1"))).toBe(true);
    expect(isProvisionalStagingKey(sessionStagingKey("A"))).toBe(false);
    expect(isStagingKey("session:")).toBe(false);
    expect(isStagingKey("new:")).toBe(false);
    expect(isStagingKey("other:A")).toBe(false);
  });

  it("strictly validates keys, model and thinking; rejects invalid_input", () => {
    const store = new SessionStagingStore();
    // invalid keys
    expect(store.stage("" as never, MODEL_A)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(store.stage("session:" as never, MODEL_A)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // invalid model (empty/blank provider or modelId)
    expect(store.stage("session:A", { provider: "", modelId: "x" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(store.stage("session:A", { provider: "p", modelId: "  " })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // invalid thinking level
    expect(store.stage("session:A", MODEL_A, "turbo" as never)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(store.count).toBe(0);
  });

  it("keeps A and B staging independent (per-exact-key)", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "medium");
    store.stage("session:B", MODEL_B, "low");
    expect(store.get("session:A")).toEqual({ key: "session:A", revision: expect.any(Number), model: MODEL_A, thinking: "medium" });
    expect(store.get("session:B")).toEqual({ key: "session:B", revision: expect.any(Number), model: MODEL_B, thinking: "low" });
    // Updating A never touches B.
    store.stage("session:A", null, "high");
    expect(store.get("session:A")?.thinking).toBe("high");
    expect(store.get("session:A")?.model).toBeNull();
    expect(store.get("session:B")).toEqual({ key: "session:B", revision: expect.any(Number), model: MODEL_B, thinking: "low" });
  });

  it("stage preserves the other field when only one is provided; empty records are removed", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A);
    expect(store.get("session:A")).toEqual({ key: "session:A", revision: expect.any(Number), model: MODEL_A, thinking: null });
    store.stage("session:A", undefined, "medium");
    expect(store.get("session:A")).toEqual({ key: "session:A", revision: expect.any(Number), model: MODEL_A, thinking: "medium" });
    // Explicit null clears a field; both null removes the record.
    store.stage("session:A", null, null);
    expect(store.get("session:A")).toBeNull();
  });
});

describe("SessionStagingStore — clear semantics (accepted clears, matching-field-only, failure preserves)", () => {
  it("clear removes the exact record (accepted send clears)", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "medium");
    store.clear("session:A");
    expect(store.get("session:A")).toBeNull();
    // Clearing an absent key is a no-op.
    store.clear("session:A");
    expect(store.count).toBe(0);
  });

  it("clearModel / clearThinking clear the matching field only; empty records are removed", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "medium");
    store.clearModel("session:A");
    expect(store.get("session:A")).toEqual({ key: "session:A", revision: expect.any(Number), model: null, thinking: "medium" });
    store.clearThinking("session:A");
    expect(store.get("session:A")).toBeNull();
    // Model-only record: clearModel removes entirely.
    store.stage("session:B", MODEL_B, null);
    store.clearModel("session:B");
    expect(store.get("session:B")).toBeNull();
    // Thinking-only record: clearThinking removes entirely.
    store.stage("session:C", null, "high");
    store.clearThinking("session:C");
    expect(store.get("session:C")).toBeNull();
  });

  it("definite/activation failure and uncertain delivery PRESERVE (caller simply never clears)", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "medium");
    // Simulated failure path: no clear is issued.
    expect(store.get("session:A")).toEqual({ key: "session:A", revision: expect.any(Number), model: MODEL_A, thinking: "medium" });
    expect(store.count).toBe(1);
  });
});

describe("SessionStagingStore — promote (provisional → exact, synchronous, fail closed)", () => {
  it("promotes a provisional new: record to its exact session: key and removes the source", () => {
    const store = new SessionStagingStore();
    store.stage("new:tx-1", MODEL_A, "high");
    const result = store.promote("new:tx-1", "s1");
    expect(result).toEqual({ ok: true });
    expect(store.get("new:tx-1")).toBeNull();
    expect(store.get("session:s1")).toEqual({ key: "session:s1", revision: expect.any(Number), model: MODEL_A, thinking: "high" });
  });

  it("fails closed on collision (target already has staging) and RETAINS the source", () => {
    const store = new SessionStagingStore();
    store.stage("new:tx-1", MODEL_A, "high");
    store.stage("session:s1", MODEL_B, "low");
    const result = store.promote("new:tx-1", "s1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
    expect(store.get("new:tx-1")).toEqual({ key: "new:tx-1", revision: expect.any(Number), model: MODEL_A, thinking: "high" });
    expect(store.get("session:s1")).toEqual({ key: "session:s1", revision: expect.any(Number), model: MODEL_B, thinking: "low" });
  });

  it("rejects missing / non-provisional sources and invalid target ids, retaining records", () => {
    const store = new SessionStagingStore();
    expect(store.promote("new:missing", "s1")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(store.promote("session:A" as never, "s1")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    store.stage("new:tx-2", MODEL_B, "medium");
    expect(store.promote("new:tx-2", "")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(store.get("new:tx-2")).toEqual({ key: "new:tx-2", revision: expect.any(Number), model: MODEL_B, thinking: "medium" });
  });
});

describe("SessionStagingStore — snapshots / dispose", () => {
  it("publishes immutable snapshots that are reference-stable between mutations", () => {
    const store = new SessionStagingStore();
    const snap0 = store.getSnapshot();
    const again = store.getSnapshot();
    expect(again).toBe(snap0);
    store.stage("session:A", MODEL_A, "medium");
    const snap1 = store.getSnapshot();
    expect(snap1).not.toBe(snap0);
    expect(snap1.records).toHaveLength(1);
    const again2 = store.getSnapshot();
    expect(again2).toBe(snap1);
    // Mutations always produce new snapshot objects (immutable).
    store.stage("session:A", MODEL_A, "high");
    expect(store.getSnapshot()).not.toBe(snap1);
  });

  it("subscribes/unsubscribes and notifies only on mutation", () => {
    const store = new SessionStagingStore();
    let calls = 0;
    const unsub = store.subscribe(() => { calls += 1; });
    expect(calls).toBe(0);
    store.stage("session:A", MODEL_A, "medium");
    expect(calls).toBe(1);
    unsub();
    store.stage("session:A", null, null);
    expect(calls).toBe(1);
  });

  it("dispose clears every record exactly once (provider unmount)", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "medium");
    store.stage("new:tx-1", MODEL_B, "low");
    store.dispose();
    expect(store.count).toBe(0);
    expect(store.getSnapshot().records).toEqual([]);
    // Post-dispose ops fail closed.
    expect(store.stage("session:A", MODEL_A)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(store.promote("new:tx-1", "s1")).toMatchObject({ ok: false, error: { code: "unavailable" } });
    // Post-dispose accepted-submission clears are inert (no admission state exists).
    store.clearMatching("session:A", 1);
    store.dispose(); // idempotent
    expect(store.count).toBe(0);
  });
});

describe("SessionStagingStore — clearMatching (accepted submission: identity-fenced clear)", () => {
  it("clears the exact record while its revision still matches the captured submission", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "high");
    const revision = store.get("session:A")!.revision;
    store.clearMatching("session:A", revision);
    expect(store.get("session:A")).toBeNull();
    expect(store.count).toBe(0);
    // Idempotent: a repeated settle of the same submission is a no-op.
    store.clearMatching("session:A", revision);
    expect(store.count).toBe(0);
  });

  it("a NEWER generation is never cleared — distinct value or a re-selected SAME value (A→B→A)", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A); // generation 1 — submitted.
    const submitted = store.get("session:A")!.revision;
    store.stage("session:A", MODEL_B); // newer selection B.
    store.stage("session:A", MODEL_A); // SAME VALUE as the submission, NEW generation.
    const reselected = store.get("session:A")!.revision;
    expect(reselected).not.toBe(submitted);
    // The old acknowledgement cannot clear the newer generation...
    store.clearMatching("session:A", submitted);
    expect(store.get("session:A")!.revision).toBe(reselected);
    expect(store.get("session:A")!.model).toEqual(MODEL_A);
    // ...and it leaves no state behind that a later clear could resurrect.
    store.clear("session:A");
    store.clearMatching("session:A", submitted);
    expect(store.get("session:A")).toBeNull();
    expect(store.getSnapshot().records).toEqual([]);
  });

  it("a null captured revision (nothing staged at send) and absent records are no-ops", () => {
    const store = new SessionStagingStore();
    store.clearMatching("session:A", null);
    expect(store.count).toBe(0);
    store.stage("session:B", MODEL_B, "low");
    store.clearMatching("session:A", store.get("session:B")!.revision);
    expect(store.get("session:B")).toEqual({ key: "session:B", revision: expect.any(Number), model: MODEL_B, thinking: "low" });
  });

  it("a settle for one key never clears another session's staging (wrong session cannot settle)", () => {
    const store = new SessionStagingStore();
    store.stage("session:A", MODEL_A, "high");
    store.stage("session:B", MODEL_B, "low");
    store.clearMatching("session:A", store.get("session:A")!.revision);
    expect(store.get("session:A")).toBeNull();
    expect(store.get("session:B")).toEqual({ key: "session:B", revision: expect.any(Number), model: MODEL_B, thinking: "low" });
  });

  it("clearMatching never exceeds the record bound: no admission state is created", () => {
    const store = new SessionStagingStore({ maxRecords: 1 });
    store.stage("session:A", MODEL_A);
    store.clearMatching("session:A", store.get("session:A")!.revision);
    expect(store.count).toBe(0);
    expect(store.getSnapshot().records).toEqual([]);
  });

  it("promote mints a fresh revision so a post-promote submission fences the moved identity", () => {
    const store = new SessionStagingStore();
    store.stage("new:tx-1", MODEL_A, "high");
    const provisionalRevision = store.get("new:tx-1")!.revision;
    expect(store.promote("new:tx-1", "s1")).toEqual({ ok: true });
    const promotedRevision = store.get("session:s1")!.revision;
    expect(promotedRevision).not.toBe(provisionalRevision);
    // The stale provisional identity cannot clear the promoted record.
    store.clearMatching("session:s1", provisionalRevision);
    expect(store.get("session:s1")!.revision).toBe(promotedRevision);
    store.clearMatching("session:s1", promotedRevision);
    expect(store.get("session:s1")).toBeNull();
  });
});
