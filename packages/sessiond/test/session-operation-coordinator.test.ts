import assert from "node:assert/strict";
import test from "node:test";
import { SessionOperationCoordinator, type IdentityOperationKind } from "../src/internal/session-operation-coordinator.js";

const microtaskFlush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/**
 * D4 identity-lane same-kind reservation proof: pending reservations are PER-KIND
 * POSITIVE REFERENCE COUNTS, so one settled same-kind sibling can never release
 * the lane while another same-kind operation is queued/running (the old Set
 * implementation dropped the shared kind entry on the first sibling's settle,
 * removed the lane, and let a later admit bypass the still-pending sibling).
 *
 * These tests are deterministic (deferred gates, no sleep-only assertions) and
 * fail the old Set implementation.
 */
test("same-kind rename: a settled sibling cannot release the lane; C queues behind gated B and FIFO holds", async () => {
  const coordinator = new SessionOperationCoordinator();
  const order: string[] = [];
  let bStarted!: () => void;
  const bStartedPromise = new Promise<void>((resolve) => { bStarted = resolve; });
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });

  const a = coordinator.admit("s", "rename", async () => { order.push("A"); });
  const b = coordinator.admit("s", "rename", async () => { bStarted(); order.push("B"); await gateB; });
  await a;
  // B is now running and gated; its same-kind reservation must keep the lane alive.
  await bStartedPromise;
  assert.equal(coordinator.hasPendingKind("s", "rename"), true, "the sibling's rename reservation must survive A's settle");
  assert.equal(coordinator.diagnostics().lanes, 1, "the lane must be retained while the same-kind sibling is pending");
  assert.equal(coordinator.diagnostics().aliases, 1, "the alias must be retained while the same-kind sibling is pending");

  // A third same-kind rename admitted now must queue behind B (never a fresh lane).
  let cEntered = false;
  const c = coordinator.admit("s", "rename", async () => { cEntered = true; order.push("C"); });
  await microtaskFlush();
  assert.equal(cEntered, false, "C must not run before gated B settles");
  assert.equal(coordinator.diagnostics().lanes, 1, "the lane must still be the same single lane with C queued behind B");

  releaseB();
  await b;
  await c;
  assert.deepEqual(order, ["A", "B", "C"], "same-kind FIFO order must hold");
  assert.equal(coordinator.hasPendingKind("s", "rename"), false);
  assert.equal(coordinator.diagnostics().lanes, 0, "no lane may leak after every same-kind sibling settles");
  assert.equal(coordinator.diagnostics().aliases, 0, "no alias may leak after every same-kind sibling settles");
});

test("a rejected same-kind first task cannot poison or decrement its gated sibling's reservation", async () => {
  const coordinator = new SessionOperationCoordinator();
  const order: string[] = [];
  let bStarted!: () => void;
  const bStartedPromise = new Promise<void>((resolve) => { bStarted = resolve; });
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });

  const a = coordinator.admit("s", "rename", async () => { order.push("A"); throw new Error("A fails"); });
  const b = coordinator.admit("s", "rename", async () => { bStarted(); order.push("B"); await gateB; });
  await assert.rejects(a, /A fails/);
  await bStartedPromise;
  // The failed A still released exactly one reservation; B's own reservation must remain.
  assert.equal(coordinator.hasPendingKind("s", "rename"), true, "B's reservation must survive A's rejection");
  assert.equal(coordinator.diagnostics().lanes, 1, "the lane must survive A's rejection while B is pending");
  assert.equal(coordinator.diagnostics().aliases, 1);

  releaseB();
  await b;
  assert.deepEqual(order, ["A", "B"], "B must still run in FIFO after A rejected");
  assert.equal(coordinator.hasPendingKind("s", "rename"), false);
  assert.equal(coordinator.diagnostics().lanes, 0, "no lane leak after success + rejection siblings settle");
  assert.equal(coordinator.diagnostics().aliases, 0, "no alias leak after success + rejection siblings settle");
});

test("table-driven: same-kind A+B+C FIFO with a gated sibling holds for every kind (rename/activate/stop/delete)", async () => {
  const kinds: readonly IdentityOperationKind[] = ["rename", "activate", "stop", "delete"];
  for (const kind of kinds) {
    const coordinator = new SessionOperationCoordinator();
    const order: string[] = [];
    let bStarted!: () => void;
    const bStartedPromise = new Promise<void>((resolve) => { bStarted = resolve; });
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });

    const a = coordinator.admit("s", kind, async () => { order.push("A"); });
    const b = coordinator.admit("s", kind, async () => { bStarted(); order.push("B"); await gateB; });
    await a;
    await bStartedPromise;
    assert.equal(coordinator.hasPendingKind("s", kind), true, `${kind}: sibling reservation must survive A's settle`);
    assert.equal(coordinator.diagnostics().lanes, 1, `${kind}: lane must be retained`);

    let cEntered = false;
    const c = coordinator.admit("s", kind, async () => { cEntered = true; order.push("C"); });
    await microtaskFlush();
    assert.equal(cEntered, false, `${kind}: C must queue behind gated B`);
    assert.equal(coordinator.diagnostics().lanes, 1, `${kind}: lane must remain a single lane with C queued`);

    releaseB();
    await b;
    await c;
    assert.deepEqual(order, ["A", "B", "C"], `${kind}: same-kind FIFO must hold`);
    assert.equal(coordinator.hasPendingKind("s", kind), false, `${kind}: no residual reservation`);
    assert.equal(coordinator.diagnostics().lanes, 0, `${kind}: no lane leak`);
    assert.equal(coordinator.diagnostics().aliases, 0, `${kind}: no alias leak`);
  }
});

test("same-kind siblings under different ids are independent lanes (no cross-id interference)", async () => {
  const coordinator = new SessionOperationCoordinator();
  const order: string[] = [];
  let bStarted!: () => void;
  const bStartedPromise = new Promise<void>((resolve) => { bStarted = resolve; });
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });

  const a = coordinator.admit("x", "rename", async () => { order.push("Ax"); });
  const b = coordinator.admit("y", "rename", async () => { bStarted(); order.push("By"); await gateB; });
  await a;
  await bStartedPromise;
  // Different ids progress independently: a new x rename is NOT blocked by gated y.
  const c = coordinator.admit("x", "rename", async () => { order.push("Cx"); });
  await c;
  assert.deepEqual(order, ["Ax", "By", "Cx"], "different ids must progress independently (Cx ran while By was gated)");
  releaseB();
  await b;
  assert.deepEqual(order, ["Ax", "By", "Cx"], "By settles after its own gate");
  assert.equal(coordinator.diagnostics().lanes, 0);
  assert.equal(coordinator.diagnostics().aliases, 0);
});
