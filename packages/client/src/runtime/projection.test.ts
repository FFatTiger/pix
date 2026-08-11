import { describe, expect, it } from "vitest";
import { reduceRuntimeEventData, applyStreamingDelta, type RuntimeSnapshot } from "@fffattiger/pix-protocol";

function base(sessionId = "s"): RuntimeSnapshot {
  return {
    sessionId,
    cwd: "/x",
    projectRoot: "/x",
    state: {
      sessionId,
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      model: null,
      messageCount: 0,
    },
    capabilities: { capabilities: ["runtime.prompt"], version: 1 },
    streaming: { active: false, phase: "idle" },
    messages: [],
  };
}

describe("reduceRuntimeEventData — purity & session guard", () => {
  it("returns a new snapshot and does not mutate the input", () => {
    const snap = base();
    const next = reduceRuntimeEventData(snap, { type: "agent_start", sessionId: "s" });
    expect(next).not.toBe(snap);
    expect(next.state.isPromptRunning).toBe(true);
    expect(snap.state.isPromptRunning).toBe(false);
  });
  it("throws on session mismatch", () => {
    expect(() => reduceRuntimeEventData(base("s"), { type: "agent_start", sessionId: "other" })).toThrow();
  });
});

describe("reduceRuntimeEventData — message stream deltas append (never merge)", () => {
  it("appends adjacent text/thinking blocks without merging", () => {
    let snap = base();
    snap = reduceRuntimeEventData(snap, { type: "message_start", sessionId: "s", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" } });
    snap = reduceRuntimeEventData(snap, { type: "message_update", sessionId: "s", streamId: "st", messageId: "m", delta: { role: "assistant", delta: { type: "text", text: "Hel" } } });
    snap = reduceRuntimeEventData(snap, { type: "message_update", sessionId: "s", streamId: "st", messageId: "m", delta: { role: "assistant", delta: { type: "text", text: "lo" } } });
    snap = reduceRuntimeEventData(snap, { type: "message_update", sessionId: "s", streamId: "st", messageId: "m", delta: { role: "assistant", delta: { type: "thinking", thinking: "hmm" } } });
    expect(snap.streaming?.partialMessage).toMatchObject({ role: "assistant" });
    expect(snap.streaming?.partialMessage?.role === "assistant" && snap.streaming.partialMessage.content).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "thinking", thinking: "hmm" },
    ]);
  });
  it("commits the message on message_end and clears the stream", () => {
    let snap = base();
    snap = reduceRuntimeEventData(snap, { type: "message_start", sessionId: "s", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" } });
    snap = reduceRuntimeEventData(snap, { type: "message_end", sessionId: "s", streamId: "st", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", provider: "p" } });
    expect(snap.streaming?.active).toBe(false);
    expect(snap.messages?.length).toBe(1);
    expect(snap.state.messageCount).toBe(1);
    expect(snap.state.isStreaming).toBe(false);
  });
});

describe("reduceRuntimeEventData — bash_update output accumulation (single accumulator)", () => {
  it("concatenates each output delta onto the cumulative output", () => {
    let snap = base();
    snap = reduceRuntimeEventData(snap, { type: "bash_update", sessionId: "s", command: "echo", output: "Hello " });
    snap = reduceRuntimeEventData(snap, { type: "bash_update", sessionId: "s", output: "World" });
    expect(snap.state.bash?.output).toBe("Hello World");
    expect(snap.state.bash?.updateCount).toBe(2);
    expect(snap.state.isBashRunning).toBe(true);
    snap = reduceRuntimeEventData(snap, { type: "bash_update", sessionId: "s", output: "!", exitCode: 0 });
    expect(snap.state.bash?.output).toBe("Hello World!");
    expect(snap.state.bash?.completed).toBe(true);
    expect(snap.state.isBashRunning).toBe(false);
  });
});

describe("reduceRuntimeEventData — queue / UI / tools / capabilities / title / writtenFiles", () => {
  it("applies queue_update pending counts", () => {
    const snap = reduceRuntimeEventData(base(), { type: "queue_update", sessionId: "s", steering: [{ message: "a" }], followUp: [{ message: "b" }] });
    expect(snap.state.pendingMessageCount).toBe(2);
  });
  it("applies extension UI requests (dedupe by id)", () => {
    const snap = reduceRuntimeEventData(base(), { type: "extension_ui_request", sessionId: "s", request: { id: "ui", method: "confirm", title: "t", message: "m" } });
    expect(snap.state.pendingExtensionUi?.length).toBe(1);
  });
  it("applies capabilities / statuses / widgets / title", () => {
    let snap = reduceRuntimeEventData(base(), { type: "runtime_capabilities_changed", sessionId: "s", capabilities: { capabilities: ["runtime.bash"], version: 2 } });
    expect(snap.capabilities.version).toBe(2);
    snap = reduceRuntimeEventData(snap, { type: "extension_statuses", sessionId: "s", statuses: [{ key: "k", text: "t" }] });
    expect(snap.state.extensionStatuses?.length).toBe(1);
    snap = reduceRuntimeEventData(snap, { type: "extension_widgets", sessionId: "s", widgets: [{ key: "k", lines: ["a"], placement: "aboveEditor" }] });
    expect(snap.state.extensionWidgets?.length).toBe(1);
    snap = reduceRuntimeEventData(snap, { type: "session_title", sessionId: "s", name: "My Session" });
    expect(snap.state.sessionName).toBe("My Session");
  });
  it("accumulates written files uniquely", () => {
    let snap = base();
    snap = reduceRuntimeEventData(snap, { type: "tool_execution_end", sessionId: "s", toolCallId: "t", writtenFiles: ["/a", "/b"] });
    snap = reduceRuntimeEventData(snap, { type: "tool_execution_end", sessionId: "s", toolCallId: "t2", writtenFiles: ["/a", "/c"] });
    expect(snap.state.writtenFiles).toEqual(["/a", "/b", "/c"]);
  });
});

describe("reduceRuntimeEventData — compaction / closed / unavailable / crashed settle streaming", () => {
  it("compaction start/end toggles isCompacting", () => {
    let snap = reduceRuntimeEventData(base(), { type: "compaction_start", sessionId: "s", reason: "auto" });
    expect(snap.state.isCompacting).toBe(true);
    expect(snap.streaming?.phase).toBe("compacting");
    snap = reduceRuntimeEventData(snap, { type: "compaction_end", sessionId: "s" });
    expect(snap.state.isCompacting).toBe(false);
  });
  it("runtime_unavailable / worker_crashed settle all running flags", () => {
    let snap = reduceRuntimeEventData(base(), { type: "agent_start", sessionId: "s" });
    snap = reduceRuntimeEventData(snap, { type: "worker_crashed", sessionId: "s" });
    expect(snap.state.isPromptRunning).toBe(false);
    expect(snap.state.isStreaming).toBe(false);
    snap = reduceRuntimeEventData(snap, { type: "agent_start", sessionId: "s" });
    snap = reduceRuntimeEventData(snap, { type: "runtime_unavailable", sessionId: "s", error: { code: "runtime_unavailable", message: "x", retryable: true } });
    expect(snap.state.isPromptRunning).toBe(false);
  });
  it("session_changed updates cwd/sessionFile/leafId", () => {
    const snap = reduceRuntimeEventData(base(), { type: "session_changed", sessionId: "s", cwd: "/y", sessionFile: "/y/s.jsonl", leafId: "l1" });
    expect(snap.cwd).toBe("/y");
    expect(snap.state.sessionFile).toBe("/y/s.jsonl");
    expect(snap.state.leafId).toBe("l1");
  });
});

describe("applyStreamingDelta", () => {
  it("accumulates custom message text", () => {
    const m1 = applyStreamingDelta({ role: "custom" }, { role: "custom", customType: "t", delta: { type: "text", text: "ab" } });
    const m2 = applyStreamingDelta(m1, { role: "custom", customType: "t", delta: { type: "text", text: "cd" } });
    expect(m2.role === "custom" && m2.content).toBe("abcd");
  });
  it("throws on role mismatch", () => {
    expect(() => applyStreamingDelta({ role: "assistant" }, { role: "custom", customType: "t", delta: { type: "text", text: "x" } })).toThrow();
  });
});
