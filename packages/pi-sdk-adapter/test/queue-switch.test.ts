import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";
import { PRODUCTION_AGENT_CAPABILITIES, PiSdkAgentRuntimeFactory } from "../src/agent/index.js";
import { attachQueueImages, planQueuedDeliverySwitch } from "../src/internal/sdk-runtime.js";

async function withAgentDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pix-queue-switch-"));
  try {
    await mkdir(join(root, "workspace"), { recursive: true });
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("queued-delivery switch (real SDK session, no network)", () => {
  it("moves one queued entry between the queues, emits exactly ONE queue_update, and fences stale addresses", async () => {
    await withAgentDir(async (root) => {
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd: join(root, "workspace"),
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "Queue Switch",
      });
      try {
        const events: RuntimeEvent[] = [];
        port.subscribe((event) => events.push(event));
        const queueUpdates = () => events.filter((event): event is Extract<RuntimeEvent, { type: "queue_update" }> => event.type === "queue_update");

        assert.equal((await port.execute({ type: "steer", message: "s1" })).ok, true);
        assert.equal((await port.execute({ type: "follow_up", message: "f1" })).ok, true);
        assert.equal((await port.execute({ type: "follow_up", message: "f2" })).ok, true);
        const before = queueUpdates().length;

        // f1 (followUp[0]) → steering: it must land at the END of the steering
        // list, after the already-queued steer (delivery order stays
        // steering-first, FIFO inside each list).
        const switched = await port.execute({ type: "switch_queued_delivery", list: "followUp", index: 0, message: "f1" });
        assert.equal(switched.ok, true, JSON.stringify(switched));

        // The switch suppressed the SDK's clear/re-queue events and emitted
        // exactly ONE settled queue_update.
        assert.equal(queueUpdates().length - before, 1, "the switch must publish exactly one queue_update");
        const state = await port.execute({ type: "get_state" });
        assert.equal(state.ok, true);
        if (state.ok && state.type === "get_state") {
          assert.deepEqual(state.state.queuedMessages?.steering.map((turn) => turn.message), ["s1", "f1"]);
          assert.deepEqual(state.state.queuedMessages?.followUp.map((turn) => turn.message), ["f2"]);
        }

        // A stale fence (the entry moved) fails closed with conflict and never
        // touches the queue.
        const stale = await port.execute({ type: "switch_queued_delivery", list: "followUp", index: 0, message: "f1" });
        assert.equal(stale.ok, false);
        if (!stale.ok) assert.equal(stale.error.code, "conflict");
        // An out-of-range index is a stale address, never a wrong-entry move.
        const outOfRange = await port.execute({ type: "switch_queued_delivery", list: "steering", index: 9, message: "s1" });
        assert.equal(outOfRange.ok, false);
        if (!outOfRange.ok) assert.equal(outOfRange.error.code, "conflict");

        // A reverse switch moves it back to the END of the follow-up list.
        const back = await port.execute({ type: "switch_queued_delivery", list: "steering", index: 1, message: "f1" });
        assert.equal(back.ok, true, JSON.stringify(back));
        const after = await port.execute({ type: "get_state" });
        if (after.ok && after.type === "get_state") {
          assert.deepEqual(after.state.queuedMessages?.steering.map((turn) => turn.message), ["s1"]);
          assert.deepEqual(after.state.queuedMessages?.followUp.map((turn) => turn.message), ["f2", "f1"]);
        }
      } finally {
        await port.close("user");
      }
    });
  });
});

describe("planQueuedDeliverySwitch (mirror vs physical reconstruction)", () => {
  const address = (list: "steering" | "followUp", index: number, message: string) => ({ list, index, message });

  it("steady state: peek head equals the steering mirror head → nothing mid-delivery", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("followUp", 0, "f1"),
      mirrorSteering: ["s1"],
      mirrorFollowUp: ["f1", "f2"],
      peeked: ["s1"],
    });
    assert.deepEqual(plan, { status: "switched", steering: ["s1", "f1"], followUp: ["f2"] });
  });

  it("moved entry lands at the END of its new list (delivery order preserved)", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("steering", 0, "s1"),
      mirrorSteering: ["s1", "s2"],
      mirrorFollowUp: ["f1"],
      peeked: ["s1"],
    });
    assert.deepEqual(plan, { status: "switched", steering: ["s2"], followUp: ["f1", "s1"] });
  });

  it("steering head mid-delivery (peek shows the next physical entry): the limbo entry is excluded, later entries shift", () => {
    // The loop drained s1 (not yet message_start): mirror [s1,s2], physical
    // steering [s2]. Switching s2 must NOT re-queue s1.
    const plan = planQueuedDeliverySwitch({
      address: address("steering", 1, "s2"),
      mirrorSteering: ["s1", "s2"],
      mirrorFollowUp: ["f1"],
      peeked: ["s2"],
    });
    assert.deepEqual(plan, { status: "switched", steering: [], followUp: ["f1", "s2"] });
  });

  it("addressing the mid-delivery steering head fails closed as in_delivery", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("steering", 0, "s1"),
      mirrorSteering: ["s1", "s2"],
      mirrorFollowUp: [],
      peeked: ["s2"],
    });
    assert.deepEqual(plan, { status: "in_delivery" });
  });

  it("steering head mid-delivery with an empty physical steering queue (peek = follow-up head)", () => {
    // s1 is mid-delivery (drained, not yet message_start): it must NOT be
    // re-queued; only the follow-up entry moves.
    const plan = planQueuedDeliverySwitch({
      address: address("followUp", 0, "f1"),
      mirrorSteering: ["s1"],
      mirrorFollowUp: ["f1"],
      peeked: ["f1"],
    });
    assert.deepEqual(plan, { status: "switched", steering: ["f1"], followUp: [] });
  });

  it("follow-up head mid-delivery (mirror steering empty, peek shows the next follow-up)", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("followUp", 1, "f2"),
      mirrorSteering: [],
      mirrorFollowUp: ["f1", "f2"],
      peeked: ["f2"],
    });
    assert.deepEqual(plan, { status: "switched", steering: ["f2"], followUp: [] });
  });

  it("addressing the mid-delivery follow-up head fails closed as in_delivery", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("followUp", 0, "f1"),
      mirrorSteering: [],
      mirrorFollowUp: ["f1", "f2"],
      peeked: ["f2"],
    });
    assert.deepEqual(plan, { status: "in_delivery" });
  });

  it("empty physical queues with a single mirror head treat it as mid-delivery", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("steering", 0, "s1"),
      mirrorSteering: ["s1"],
      mirrorFollowUp: [],
      peeked: [],
    });
    assert.deepEqual(plan, { status: "in_delivery" });
  });

  it("impossible mirror state (more than one entry unaccounted for) fails closed as unavailable", () => {
    const plan = planQueuedDeliverySwitch({
      address: address("steering", 1, "s2"),
      mirrorSteering: ["s1", "s2"],
      mirrorFollowUp: [],
      peeked: [],
    });
    assert.deepEqual(plan, { status: "unavailable" });
  });

  it("a text fence mismatch or an out-of-range index is stale, never a wrong-entry move", () => {
    assert.deepEqual(planQueuedDeliverySwitch({
      address: address("followUp", 0, "not there"),
      mirrorSteering: [],
      mirrorFollowUp: ["f1"],
      peeked: ["f1"],
    }), { status: "stale" });
    assert.deepEqual(planQueuedDeliverySwitch({
      address: address("followUp", 3, "f1"),
      mirrorSteering: [],
      mirrorFollowUp: ["f1"],
      peeked: ["f1"],
    }), { status: "stale" });
  });
});

describe("attachQueueImages (whole-queue image reconcile)", () => {
  const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" as const };

  it("a moved entry keeps the images its ORIGINAL list carried", () => {
    // s1 (with images) moved from steering to the follow-up list: matching
    // runs over the whole previous queue, not per list.
    const rebuilt = attachQueueImages(
      [{ message: "s1", images: [image] }, { message: "f1" }],
      ["f1", "s1"],
    );
    assert.deepEqual(rebuilt[1], { message: "s1", images: [image] });
    assert.deepEqual(rebuilt[0], { message: "f1" });
  });

  it("duplicate texts never steal each other's images (first occurrence wins in order)", () => {
    const rebuilt = attachQueueImages(
      [{ message: "same" }, { message: "same", images: [image] }],
      ["same", "same"],
    );
    assert.deepEqual(rebuilt[0], { message: "same" });
    assert.deepEqual(rebuilt[1], { message: "same", images: [image] });
  });

  it("an unknown text carries no images (fail-closed, never a wrong entry's images)", () => {
    const rebuilt = attachQueueImages([{ message: "a", images: [image] }], ["b"]);
    assert.deepEqual(rebuilt, [{ message: "b" }]);
  });
});
