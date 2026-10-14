/**
 * Idle-send recovery E2E — REAL Chrome over the built Client against the real
 * SDK stack (sessiond + SDK worker + loopback controlled provider), with a
 * killing reverse proxy between Chrome and the Host.
 *
 * The production defect class under test: the page idles, a proxy (or iOS
 * backgrounding) kills the runtime WebSocket WITHOUT delivering a close, and
 * the next send races into the half-open socket ("not sent, draft kept").
 *
 * Scenarios (both REQUIRED):
 *  A. silent kill → send again on a still-"attached" connection → the turn is
 *     delivered EXACTLY once: the heartbeat proves the dead transport, the
 *     client force-reconnects through the still-listening proxy, re-attaches
 *     and re-sends the SAME operationId (idempotent admission). No
 *     send-failure alert; one user bubble; one provider request.
 *  B. kill + network down (proxy refuses upgrades) → the bounded send gate
 *     surfaces the DEDICATED "reconnecting" copy (NOT the generic failure)
 *     with the draft restored; after the network returns, resending succeeds
 *     exactly once.
 *
 * Provider-request oracle: the Worker's request appends trailing context
 * after the user prompt, so "the turn carried this prompt" is matched with
 * requestHasUserHash (any user message equals the prompt verbatim), and each
 * scenario serializes one turn at a time (reset → single generic script).
 *
 * Run: node tests/e2e/idle-send.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, hashPrompt, requestHasUserHash } from "./helpers/controlled-provider.mjs";
import { launchChromeCdp, PAGE } from "./helpers/chrome-cdp.mjs";
import {
  SUITE_DEADLINE_MS,
  bootLifecycleStack,
  delay,
  log,
  makeIsolatedDirs,
  teardownLifecycleStack,
  writeStubProviderConfig,
} from "./helpers/lifecycle-stack.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");
const STEP_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 60_000;
/** Heartbeat rescue budget: tick (30s) + pong deadline (10s) + recovery+turn. */
const RESCUE_TIMEOUT_MS = 75_000;
const PROVIDER_ID = "pix-e2e-stub";
const MODEL_A = "pix-e2e-alpha";
const NAME_A = "Pix E2E Alpha";
const TERMINAL_MARKER = "TERMINAL-MARKER-DONE";
const RECONNECTING_COPIES = new Set([
  "Connection lost — reconnecting. Your draft is kept; try again shortly.",
  "网络连接中断，正在重连。草稿已保留，请稍后重试。",
]);

// ---------------------------------------------------------------------------
// Killing reverse proxy: Chrome → proxy → Host.
// ---------------------------------------------------------------------------

/**
 * HTTP/WebSocket reverse proxy whose WebSocket streams can be killed SILENTLY:
 * `killWebSockets()` destroys only the UPSTREAM socket and stops relaying, so
 * the browser's WebSocket never receives a close — a true half-open transport,
 * exactly like an idle-timeout proxy cut while the tab was hidden.
 */
async function startKillingProxy(targetOrigin) {
  const target = new URL(targetOrigin);
  const targetPort = Number(target.port);
  const livePairs = new Set();
  let upgradeCount = 0;
  let refusingUpgrades = false;
  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: target.hostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      // Preserve the ORIGINAL Host header: the Host's same-origin security
      // compares Origin against Host (what a real WS-passthrough proxy does).
      headers: { ...req.headers },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", () => { res.destroy(); });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket) => {
    upgradeCount += 1;
    if (refusingUpgrades) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(targetPort, target.hostname);
    const pair = { upstream, socket, dead: false };
    upstream.on("connect", () => {
      // Forward the ORIGINAL request verbatim (headers included — the Host's
      // same-origin Origin/Host check must see the browser's own authority).
      const headers = [`GET ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.push(`${name}: ${item}`);
      }
      upstream.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => { if (!pair.dead) upstream.write(chunk); });
    upstream.on("data", (chunk) => { if (!pair.dead) socket.write(chunk); });
    upstream.on("error", () => {
      pair.dead = true;
      livePairs.delete(pair);
      socket.destroy();
    });
    socket.on("error", () => {
      pair.dead = true;
      livePairs.delete(pair);
      upstream.destroy();
    });
    upstream.on("close", () => { livePairs.delete(pair); });
    socket.on("close", () => { livePairs.delete(pair); });
    livePairs.add(pair);
  });
  const { port } = await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise(server.address()));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    get upgradeCount() { return upgradeCount; },
    /** Silent half-open cut: upstream dies, the browser side hears nothing. */
    killWebSockets() {
      for (const pair of livePairs) {
        pair.dead = true;
        pair.socket.removeAllListeners("data");
        pair.socket.unpipe();
        pair.upstream.destroy();
      }
    },
    /** Simulate total network loss for new runtime connections (plain HTTP unaffected). */
    refuseUpgrades() { refusingUpgrades = true; },
    allowUpgrades() { refusingUpgrades = false; },
    close: () => new Promise((resolvePromise) => {
      for (const pair of livePairs) {
        pair.dead = true;
        pair.socket.destroy();
        pair.upstream.destroy();
      }
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonce(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestsFor(provider, prompt) {
  return provider.requests.filter((record) => requestHasUserHash(record, prompt));
}

/** Reset + plan one generic script: scenarios serialize one turn at a time. */
function planTurn(provider, replyNonce) {
  provider.reset();
  provider.plan({ chunks: [`${replyNonce} `, `${TERMINAL_MARKER}.`] });
}

async function waitForIdleComposer(tab, label) {
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: idle composer` });
}

async function typeAndSend(tab, text, label) {
  await waitForIdleComposer(tab, label);
  const value = await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(text)})`);
  assert.equal(value, text, `${label}: composer must hold the typed text`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: send enabled` });
  const priorOperations = await tab.evaluate(`(window.__pixRuntimeTap?.frames ?? [])
    .filter(frame => frame.direction === "out" && frame.type === "submit_turn")
    .map(frame => frame.operationId)`);
  assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, `${label}: send click must land`);
  const operationIds = await tab.waitFor(`(() => {
    const previous = new Set(${JSON.stringify(priorOperations)});
    const ids = [...new Set((window.__pixRuntimeTap?.frames ?? [])
      .filter(frame => frame.direction === "out" && frame.type === "submit_turn" && !previous.has(frame.operationId))
      .map(frame => frame.operationId))];
    return ids.length ? ids : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: exact submit identity` });
  assert.equal(operationIds.length, 1, `${label}: one new submit operation`);
  return operationIds[0];
}

/** Type + click send WITHOUT asserting the frame crossed the wire (for
 * bounded pre-wire failure scenarios: the gate may block the submit). */
async function typeAndClick(tab, text, label) {
  await waitForIdleComposer(tab, label);
  const value = await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(text)})`);
  assert.equal(value, text, `${label}: composer must hold the typed text`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: send enabled` });
  assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, `${label}: send click must land`);
}

async function waitTurnTerminal(tab, _operationId, replyNonce, label, timeoutMs = STEP_TIMEOUT_MS) {
  // Completion oracle is the USER-VISIBLE truth: exactly one settled assistant
  // message carrying the reply nonce + terminal marker, no streaming, and the
  // composer back to idle. (A wire-level turn_status predicate is deliberately
  // NOT used: the frame's projected fields are diagnostics-only here.)
  try {
    await tab.waitFor(`(() => {
      const answers = [...document.querySelectorAll(".chat-assistant-message")].filter(node => {
        const text = node.textContent ?? "";
        return text.includes(${JSON.stringify(replyNonce)}) && text.includes(${JSON.stringify(TERMINAL_MARKER)});
      });
      return answers.length === 1 && !answers[0].classList.contains("is-streaming")
        && !answers[0].querySelector(".markdown-body.is-streaming");
    })()`, { timeoutMs, label: `${label}: matching assistant settled` });
  } catch (error) {
    const dump = await tab.evaluate(`(${PAGE.dumpDom})()`).catch(() => null);
    const tap = await tab.evaluate(PAGE.runtimeTap).catch(() => null);
    throw new Error(`${String(error?.message ?? error)} dump=${JSON.stringify(dump)} tap=${JSON.stringify(tap).slice(0, 1200)}`);
  }
  await waitForIdleComposer(tab, `${label}: terminal`);
}

async function requireLivenessNegotiated(tab, label) {
  const tap = await tab.waitFor(`(() => {
    const frames = window.__pixRuntimeTap?.frames ?? [];
    const ack = frames.find(frame => frame.direction === "in" && frame.type === "handshake_ack"
      && Array.isArray(frame.acceptedFeatures) && frame.acceptedFeatures.includes("runtime.liveness.v1"));
    return ack ? ack.acceptedFeatures : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: runtime.liveness.v1 negotiated` });
  assert.ok(tap.includes("runtime.liveness.v1"), `${label}: Host must accept runtime.liveness.v1`);
}

/** Exactly-once transcript oracle: the prompt appears as exactly one user bubble. */
async function userBubbleCountFor(tab, prompt, label) {
  return await tab.waitFor(`(() => {
    const matches = [...document.querySelectorAll(".chat-user-message")]
      .filter(node => (node.textContent ?? "").includes(${JSON.stringify(prompt)}));
    return matches.length;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: user bubble present` });
}

async function runningIds(stack) {
  const running = await stack.rpc.call("runtime.listRunning", {});
  return running.sessions.map((session) => session.sessionId);
}

async function stopAllSessions(stack, label) {
  for (const sessionId of await runningIds(stack)) {
    await stack.rpc.call("runtime.stop", { sessionId, reason: "user" }).catch(() => {});
  }
  const deadline = Date.now() + 15_000;
  while ((await runningIds(stack)).length > 0 && Date.now() < deadline) await delay(50);
  assert.equal((await runningIds(stack)).length, 0, `${label}: workers stopped`);
}

async function openSeededSessionTab(chrome, proxy, dirs, label) {
  const history = seedSessionHistoryForTests({
    cwd: dirs.projectCwd,
    turns: 2,
    model: { provider: PROVIDER_ID, modelId: MODEL_A },
    label,
  });
  const tab = await chrome.openTab();
  const url = `${proxy.origin}/?session=${encodeURIComponent(history.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;
  await tab.navigate(url);
  await tab.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: history transcript` });
  await waitForIdleComposer(tab, label);
  await requireLivenessNegotiated(tab, label);
  return { tab, sessionId: history.sessionId };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** A. Silent half-open kill → the next send still lands exactly once. */
async function scenarioSilentKill(chrome, stack, provider, proxy, dirs) {
  const { tab } = await openSeededSessionTab(chrome, proxy, dirs, "idle-silent-kill");
  assert.deepEqual(await runningIds(stack), [], "A: opening history must create zero workers");

  // Control turn on the healthy connection.
  const reply1 = nonce("a-r1");
  const prompt1 = `idle-a-t1 ${nonce("a-p1")}`;
  planTurn(provider, reply1);
  const op1 = await typeAndSend(tab, prompt1, "A:turn1");
  const deadline1 = Date.now() + SEND_TIMEOUT_MS;
  while (requestsFor(provider, prompt1).length < 1 && Date.now() < deadline1) await delay(50);
  assert.equal(requestsFor(provider, prompt1).length, 1, "A:turn1: exactly one provider request");
  await waitTurnTerminal(tab, op1, reply1, "A:turn1");
  const upgradesAfterTurn1 = proxy.upgradeCount;

  // SILENT kill: the runtime WS is now half-open (no close is ever delivered).
  proxy.killWebSockets();
  await delay(200);

  // The user comes back and sends on the still-"attached" connection. The
  // submit may enter the dead socket; the heartbeat must prove death, force a
  // reconnect through the still-listening proxy, and re-send the SAME
  // operationId — sessiond admission stays idempotent (exactly one delivery).
  const reply2 = nonce("a-r2");
  const prompt2 = `idle-a-t2 ${nonce("a-p2")}`;
  planTurn(provider, reply2);
  const op2 = await typeAndSend(tab, prompt2, "A:turn2");
  const deadline2 = Date.now() + RESCUE_TIMEOUT_MS;
  for (;;) {
    if (requestsFor(provider, prompt2).length > 0) break;
    const dump = await tab.evaluate(`(${PAGE.dumpDom})()`).catch(() => null);
    if (dump?.alert) throw new Error(`A:turn2: send surfaced a client error: alert=${JSON.stringify(dump.alert)}`);
    if (Date.now() > deadline2) {
      throw new Error(`A:turn2: no provider request within ${RESCUE_TIMEOUT_MS}ms: dump=${JSON.stringify(dump)}`);
    }
    await delay(100);
  }
  await waitTurnTerminal(tab, op2, reply2, "A:turn2", RESCUE_TIMEOUT_MS);
  assert.equal(requestsFor(provider, prompt2).length, 1, "A:turn2: exactly one provider request (idempotent admission)");
  assert.equal(await userBubbleCountFor(tab, prompt2, "A:turn2"), 1, "A:turn2: exactly one user bubble");
  await tab.waitFor(`(() => {
    const pings = (window.__pixRuntimeTap?.frames ?? []).filter(frame => frame.direction === "out" && frame.type === "ping");
    return pings.length >= 1 ? pings.length : null;
  })()`, { timeoutMs: RESCUE_TIMEOUT_MS, label: "A: liveness ping crossed the wire" });
  assert.ok(proxy.upgradeCount > upgradesAfterTurn1, "A: recovery opened a fresh WebSocket through the proxy");
  const dump = await tab.evaluate(`(${PAGE.dumpDom})()`);
  assert.equal(dump.alert, null, `A: no send-failure alert at terminal: ${JSON.stringify(dump)}`);
  await tab.close();
}

/** B. Kill + network down → dedicated reconnecting copy; recovery resend works. */
async function scenarioNetworkDownCopy(chrome, stack, provider, proxy, dirs) {
  const { tab } = await openSeededSessionTab(chrome, proxy, dirs, "idle-net-down");

  // Half-open kill AND no new runtime connections (network is down). Within
  // one heartbeat window (tick + pong deadline) the client proves death and
  // starts reconnect attempts — observable here as new (refused) upgrades.
  proxy.killWebSockets();
  proxy.refuseUpgrades();
  const upgradesBeforeDetection = proxy.upgradeCount;
  const detectionDeadline = Date.now() + 90_000;
  while (proxy.upgradeCount <= upgradesBeforeDetection && Date.now() < detectionDeadline) await delay(200);
  assert.ok(proxy.upgradeCount > upgradesBeforeDetection, "B: heartbeat must detect the dead transport and attempt recovery");
  await delay(1_000);

  const prompt1 = `idle-b-t1 ${nonce("b-p1")}`;
  await typeAndClick(tab, prompt1, "B:turn1(send-fails-bounded)");
  // The send must fail BOUNDED with the DEDICATED reconnecting copy, and the
  // draft must be restored for an explicit manual retry.
  const alert = await tab.waitFor(`(() => {
    const alert = document.querySelector("[role=alert]");
    return alert && alert.textContent ? alert.textContent : null;
  })()`, { timeoutMs: 40_000, label: "B: send surfaced the reconnecting copy" });
  assert.ok(RECONNECTING_COPIES.has(alert), `B: copy must distinguish reconnecting transport loss (got=${JSON.stringify(alert)})`);
  const afterFailure = await tab.evaluate(`(${PAGE.dumpDom})()`);
  assert.equal(afterFailure.textareaValue, prompt1, "B: draft must be restored verbatim");
  assert.equal(requestsFor(provider, prompt1).length, 0, "B: no provider request while the network is down");

  // Network returns; wait for the client's backoff-bounded auto-reconnect to
  // actually complete (fresh handshake_ack observed), then resend manually.
  proxy.allowUpgrades();
  const acksBeforeRecovery = await tab.evaluate(`(window.__pixRuntimeTap?.frames ?? [])
    .filter(frame => frame.direction === "in" && frame.type === "handshake_ack").length`);
  await tab.waitFor(`(window.__pixRuntimeTap?.frames ?? [])
    .filter(frame => frame.direction === "in" && frame.type === "handshake_ack").length > ${JSON.stringify(acksBeforeRecovery)}`,
  { timeoutMs: 45_000, label: "B: runtime reconnected after network recovery" });
  const reply1 = nonce("b-r1");
  planTurn(provider, reply1);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: "B: send enabled for retry" });
  const priorOperations = await tab.evaluate(`(window.__pixRuntimeTap?.frames ?? [])
    .filter(frame => frame.direction === "out" && frame.type === "submit_turn")
    .map(frame => frame.operationId)`);
  assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, "B: retry click must land");
  const retryOp = await tab.waitFor(`(() => {
    const previous = new Set(${JSON.stringify(priorOperations)});
    const ids = [...new Set((window.__pixRuntimeTap?.frames ?? [])
      .filter(frame => frame.direction === "out" && frame.type === "submit_turn" && !previous.has(frame.operationId))
      .map(frame => frame.operationId))];
    return ids.length ? ids : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: "B: retry submit identity" });
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  while (requestsFor(provider, prompt1).length < 1 && Date.now() < deadline) await delay(50);
  assert.equal(requestsFor(provider, prompt1).length, 1, "B: retry produced exactly one provider request");
  // Cold activation: the failed first send never started a worker, so the
  // retry pays the full worker-boot + provider + streaming budget.
  await waitTurnTerminal(tab, retryOp, reply1, "B:retry", SEND_TIMEOUT_MS);
  const finalDump = await tab.evaluate(`(${PAGE.dumpDom})()`);
  assert.equal(finalDump.alert, null, `B: alert must clear at terminal: ${JSON.stringify(finalDump)}`);
  await tab.close();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFactory = process.env.PIX_AGENT_WORKER_FACTORY;
  let dirs = null;
  let provider = null;
  let stack = null;
  let proxy = null;
  let chrome = null;
  const results = [];
  const cleanupFailures = [];
  const deadlineTimer = setTimeout(() => {
    log(`SUITE-DEADLINE exceeded ${SUITE_DEADLINE_MS}ms — tearing down`);
    process.exit(1);
  }, SUITE_DEADLINE_MS);
  let exitCode = 0;
  try {
    dirs = await makeIsolatedDirs("px-idle");
    provider = await startControlledProvider();
    await writeStubProviderConfig(dirs.agentDir, provider.port, PROVIDER_ID, MODEL_A, { defaultName: NAME_A });
    process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

    stack = await bootLifecycleStack({ sessiondDir: dirs.sessiondDir, projectCwd: dirs.projectCwd, hostDir: dirs.hostDir, clientDist: CLIENT_DIST });
    proxy = await startKillingProxy(stack.origin);
    chrome = await launchChromeCdp();
    log(`boot host=${stack.origin} proxy=${proxy.origin} daemon=${stack.daemon.instanceId.slice(0, 12)}`);

    for (const scenario of [
      { name: "A-silent-half-open-kill", run: () => scenarioSilentKill(chrome, stack, provider, proxy, dirs) },
      { name: "B-network-down-copy-and-retry", run: () => scenarioNetworkDownCopy(chrome, stack, provider, proxy, dirs) },
    ]) {
      try {
        await scenario.run();
        results.push({ scenario: scenario.name, ok: true });
        await stopAllSessions(stack, scenario.name);
      } catch (error) {
        exitCode = 1;
        results.push({ scenario: scenario.name, ok: false, error: String(error?.message ?? error).slice(0, 900) });
        log(`FAIL ${scenario.name}`, error?.stack ?? error);
        provider.release();
        await stopAllSessions(stack, scenario.name).catch(() => {});
      }
    }
    if (exitCode === 0) log("PASS — idle-send recovery (silent half-open kill + network-down copy)");
    else log(`REGRESSION-RECORDED — ${results.filter((entry) => !entry.ok).map((entry) => entry.scenario).join(", ")}`);
  } catch (error) {
    exitCode = 1;
    log("FAIL harness", error?.stack ?? error);
  } finally {
    clearTimeout(deadlineTimer);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousFactory === undefined) delete process.env.PIX_AGENT_WORKER_FACTORY;
    else process.env.PIX_AGENT_WORKER_FACTORY = previousFactory;
    if (provider) provider.release();
    if (chrome) await chrome.close().catch(() => {});
    if (proxy) await proxy.close();
    if (stack || dirs) {
      const torn = await teardownLifecycleStack(stack, dirs);
      cleanupFailures.push(...torn.failures);
    }
    if (provider) await provider.close().catch(() => {});
    for (const failure of cleanupFailures) {
      exitCode = 1;
      log("CLEANUP-FAIL", failure);
    }
    log("summary", JSON.stringify(results));
  }
  return exitCode;
}

process.exit(await main());
