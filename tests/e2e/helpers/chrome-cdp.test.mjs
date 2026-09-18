// Deterministic fake-CDP regressions for the E2E Chrome driver's transport
// seams (tests/e2e/helpers/chrome-cdp.mjs).
//
// Covers the two fail-closed contracts the browser suites depend on, without
// spawning Chrome:
//   1. createCdpChannel — every command settles exactly once: a command whose
//      response never arrives rejects within its budget, a LATE response for
//      that already-settled id is dropped (at-most-once), and the channel keeps
//      serving later commands; a socket close rejects every pending command.
//   2. closeCdpTarget — a target is reported closed only when closure is
//      PROVEN (absent from Target.getTargets); errors that cannot be proven
//      throw, and an acknowledged close that never takes effect throws.
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { createCdpChannel, closeCdpTarget } from "./chrome-cdp.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(10);
  }
}

/** A real loopback ws pair standing in for the DevTools browser socket. */
async function fakeCdpPair() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const serverSockets = [];
  server.on("connection", (socket) => serverSockets.push(socket));
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  await waitFor(() => serverSockets.length === 1, "server side socket");
  const bounded = (ms, start) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    start(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return {
    server,
    client,
    peer: serverSockets[0],
    /** Bounded teardown: never waits forever on an already-closed socket. */
    async close() {
      await bounded(1_000, (done) => {
        if (client.readyState === WebSocket.CLOSED) return done();
        client.once("close", done);
        try {
          client.close();
        } catch {
          done();
        }
      });
      await bounded(1_000, (done) => server.close(() => done()));
    },
  };
}

test("createCdpChannel: unanswered command rejects within its budget, late response is dropped, later commands still settle", { timeout: 10_000 }, async () => {
  const pair = await fakeCdpPair();
  try {
    const channel = createCdpChannel(pair.client, { commandTimeoutMs: 40 });
    const received = [];
    pair.peer.on("message", (data, isBinary) => {
      if (isBinary) return;
      received.push(JSON.parse(String(data)));
    });

    const started = Date.now();
    await assert.rejects(channel.send("Target.noReply"), /timed out after 40ms/);
    assert.ok(Date.now() - started >= 35, "rejection must come from the command budget, not earlier");
    assert.equal(channel.pendingCount, 0, "timed-out entry must be removed");

    assert.equal(received.length, 1);
    const staleId = received[0].id;
    // LATE response for the already-settled id: must be ignored, not settled.
    pair.peer.send(JSON.stringify({ id: staleId, result: { late: true } }));
    await delay(70);
    assert.equal(channel.pendingCount, 0, "late response must not resurrect a pending entry");

    // At-most-once for the SAME promise, and a fresh command still resolves
    // with its OWN result (id routing must not cross).
    const next = channel.send("Runtime.evaluate");
    await waitFor(() => received.length >= 2, "second command on the wire");
    assert.notEqual(received[1].id, staleId);
    pair.peer.send(JSON.stringify({ id: staleId, error: { code: -32000, message: "stale" } }));
    pair.peer.send(JSON.stringify({ id: received[1].id, result: { result: { value: 7 } } }));
    assert.deepEqual(await next, { result: { value: 7 } });
    assert.equal(channel.pendingCount, 0);
  } finally {
    await pair.close();
  }
});

test("createCdpChannel: socket close rejects every pending command", { timeout: 10_000 }, async () => {
  const pair = await fakeCdpPair();
  try {
    const channel = createCdpChannel(pair.client, { commandTimeoutMs: 5_000 });
    const first = channel.send("Page.navigate");
    const second = channel.send("Runtime.evaluate");
    assert.equal(channel.pendingCount, 2);
    await new Promise((resolve) => {
      pair.client.once("close", resolve);
      pair.peer.close();
    });
    await assert.rejects(first, /closed with commands in flight/);
    await assert.rejects(second, /closed with commands in flight/);
    assert.equal(channel.pendingCount, 0);
    // Post-close sends settle immediately instead of hanging forever.
    await assert.rejects(channel.send("Anything.else"), /refused: websocket is not open/);
  } finally {
    await pair.close();
  }
});

/** Fake CDP `send` for Target.getTargets / Target.closeTarget.
 *  `listed` is consumed one entry per Target.getTargets call (the last entry
 *  repeats), so a test can script "listed now, gone on the next check". */
function fakeTargetSend({ listed = [], closeTargetError }) {
  const calls = [];
  const queue = [...listed];
  const send = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "Target.getTargets") {
      const isListed = queue.length > 1 ? queue.shift() : queue[0];
      return { targetInfos: isListed ? [{ targetId: "t1" }] : [] };
    }
    if (method === "Target.closeTarget") {
      if (closeTargetError) throw new Error(closeTargetError);
      return { success: true };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { send, calls };
}

test("closeCdpTarget: already-absent target is an idempotent success with no close command", async () => {
  const { send, calls } = fakeTargetSend({ listed: [false] });
  assert.deepEqual(await closeCdpTarget(send, "t1", { confirmTimeoutMs: 50 }), { alreadyClosed: true });
  assert.deepEqual(calls.map((call) => call.method), ["Target.getTargets"]);
});

test("closeCdpTarget: acknowledged close confirmed absent resolves", async () => {
  // listed on the pre-check, still listed on the first confirmation poll,
  // gone from the next poll on.
  const { send, calls } = fakeTargetSend({ listed: [true, true, false] });
  assert.deepEqual(await closeCdpTarget(send, "t1", { confirmTimeoutMs: 2_000, pollMs: 5 }), { closed: true });
  const methods = calls.map((call) => call.method);
  assert.deepEqual(methods.slice(0, 2), ["Target.getTargets", "Target.closeTarget"]);
  assert.equal(methods[methods.length - 1], "Target.getTargets", "closure must be proven by a final listing");
  assert.ok(methods.length >= 3);
});

test("closeCdpTarget: closeTarget error with the target still listed throws", async () => {
  const { send, calls } = fakeTargetSend({ listed: [true], closeTargetError: "boom" });
  await assert.rejects(closeCdpTarget(send, "t1", { confirmTimeoutMs: 50 }), /Target.closeTarget failed for t1: boom/);
  assert.equal(calls.filter((call) => call.method === "Target.closeTarget").length, 1, "exactly one close attempt, no retry loop");
});

test("closeCdpTarget: error is acceptable only when absence is independently proven", async () => {
  // listed on the pre-check (so a close is attempted), provably absent by the
  // time the error is verified.
  const { send, calls } = fakeTargetSend({ listed: [true, false], closeTargetError: "boom" });
  assert.deepEqual(await closeCdpTarget(send, "t1", { confirmTimeoutMs: 50 }), { closed: true });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["Target.getTargets", "Target.closeTarget", "Target.getTargets"],
  );
});

test("closeCdpTarget: acknowledged close that never takes effect throws within the confirm budget", async () => {
  const { send } = fakeTargetSend({ listed: [true] });
  const started = Date.now();
  await assert.rejects(
    closeCdpTarget(send, "t1", { confirmTimeoutMs: 60, pollMs: 5 }),
    /still listed 60ms after Target.closeTarget acknowledged/,
  );
  assert.ok(Date.now() - started >= 55, "must poll for the full confirm budget before failing");
});
