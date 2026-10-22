import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

async function setup() {
  const driver = await new ScriptedSdkDriverFactory(new ScriptedSdkStore()).create({ cwd: "/workspace" }, {});
  const adapter = new CanonicalAgentRuntimeAdapter(driver);
  await adapter.ready();
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { driver, adapter, events };
}

const userText = (event: RuntimeEvent): string | undefined =>
  event.type === "message_start" && event.message.role === "user" && typeof event.message.content === "string" ? event.message.content : undefined;

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error("timed out");
  }
}

describe("Stop with a queued message", () => {
  it("stops first, then sends the queued steer as the next turn", async () => {
    const { adapter, events } = await setup();
    try {
      const running = await adapter.submitTurn({ prompt: "long task no-write" });
      assert.equal(running.admission.ok, true);
      await until(() => events.some((event) => event.type === "message_update"));
      assert.equal((await adapter.execute({ type: "steer", message: "after stop" })).ok, true);

      assert.equal((await adapter.execute({ type: "abort" })).ok, true);
      await until(() => JSON.stringify(events).includes('Done processing \\"after stop\\"'));

      // The steer opened its own turn after the stopped one ended — never
      // written into the dying turn.
      const steerAt = events.findIndex((event) => userText(event) === "after stop");
      assert.equal(events.slice(0, steerAt).filter((event) => event.type === "agent_start").length, 2);
      assert.ok(events.slice(0, steerAt).some((event) => event.type === "agent_end"));
      const state = await adapter.execute({ type: "get_state" });
      assert.ok(state.ok && state.type === "get_state");
      assert.deepEqual(state.state.queuedMessages, { steering: [], followUp: [] });
    } finally {
      await adapter.close("user");
    }
  });

  it("a next turn that cannot start puts the messages back in the queue", async () => {
    const { driver, adapter, events } = await setup();
    try {
      await adapter.submitTurn({ prompt: "long task no-write" });
      await until(() => events.some((event) => event.type === "message_update"));
      assert.equal((await adapter.execute({ type: "steer", message: "kept" })).ok, true);
      const requeued: string[] = [];
      const steer = driver.steer.bind(driver);
      driver.steer = async (message, images) => { requeued.push(message); return steer(message, images); };
      adapter.submitTurn = async () => ({
        admission: { ok: false, error: { code: "busy", message: "busy", retryable: true } },
        completion: Promise.resolve({ ok: false, error: { code: "busy", message: "busy", retryable: true } }),
      }) as never;

      assert.equal((await adapter.execute({ type: "abort" })).ok, true);
      assert.deepEqual(requeued, ["kept"]);
    } finally {
      await adapter.close("user");
    }
  });
});

describe("stop outcome in the snapshot", () => {
  it("a stopped run is reported by the snapshot, and the next run clears it", async () => {
    const { adapter, events } = await setup();
    try {
      await adapter.submitTurn({ prompt: "long task no-write" });
      await until(() => events.some((event) => event.type === "message_update"));
      await adapter.execute({ type: "abort" });
      await until(() => events.some((event) => event.type === "agent_settled"));
      assert.equal((await adapter.getSnapshot()).state.lastTurnAborted, true);
      const next = await adapter.submitTurn({ prompt: "again no-write" });
      await next.completion;
      assert.equal((await adapter.getSnapshot()).state.lastTurnAborted, false);
    } finally {
      await adapter.close("user");
    }
  });
});

describe("image-only send", () => {
  it("starts a turn with an image and no text", async () => {
    const { adapter, events } = await setup();
    try {
      const handle = await adapter.submitTurn({ prompt: "", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
      assert.equal(handle.admission.ok, true);
      assert.equal((await handle.completion).ok, true);
      assert.ok(events.some((event) => event.type === "message_start" && event.message.role === "user"));
      const blank = await adapter.submitTurn({ prompt: " " });
      assert.equal(blank.admission.ok, false);
    } finally {
      await adapter.close("user");
    }
  });
});
