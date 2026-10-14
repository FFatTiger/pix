/**
 * Silent pre-wire self-heal E2E — REAL Chrome (phone viewport) over the built
 * Client against the real SDK stack, with a killing reverse proxy.
 *
 * The defect class: a send fails BEFORE it reaches the server (half-open
 * socket, no close delivered). The client must force one reconnect + re-attach
 * and resend the SAME operationId once. The user sees no error and the stub
 * provider receives that prompt exactly once.
 *
 * Scenarios (phone 390x844, mobile + touch):
 *  P. normal project session
 *  A. Pixie assistant session (cwd = <home>/.pi/pix/assistant, residency ON)
 *
 * Both scenarios: one healthy send, page hidden, killWebSockets(), wait
 * past one heartbeat, page visible, second distinct prompt. The hidden wait
 * makes the client treat the socket as unproven, so it reconnects BEFORE
 * writing: exactly one submit_turn for the second prompt, and that frame is
 * on the new socket (after the recovery handshake). One provider request,
 * no alert. Two different operationIds is a failure.
 *
 * Run: node tests/e2e/idle-send-self-heal.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, requestHasUserHash } from "./helpers/controlled-provider.mjs";
import { launchChromeCdp, PAGE } from "./helpers/chrome-cdp.mjs";
import {
  bootLifecycleStack,
  delay,
  log,
  makeIsolatedDirs,
  teardownLifecycleStack,
  writeStubProviderConfig,
} from "./helpers/lifecycle-stack.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");
const SUITE_DEADLINE_MS = 6 * 60_000;
const STEP_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 60_000;
const HEAL_WAIT_MS = 3_000;
const PHONE = { width: 390, height: 844, mobile: true };
const PROVIDER_ID = "pix-e2e-stub";
const MODEL_A = "pix-e2e-alpha";
const NAME_A = "Pix E2E Alpha";
const TERMINAL_MARKER = "TERMINAL-MARKER-DONE";
const FORBIDDEN_ALERTS = [
  "消息未发送，草稿已保留。",
  "网络连接中断，正在重连。",
  "Connection lost — reconnecting.",
  "not sent, draft kept",
];

function assertBundleHasSelfHeal() {
  const assets = join(CLIENT_DIST, "assets");
  assert.equal(existsSync(assets), true, `client dist missing: ${CLIENT_DIST}`);
  const hit = readdirSync(assets).filter((name) => name.endsWith(".js") && !name.endsWith(".map"))
    .some((name) => {
      const text = readFileSync(join(assets, name), "utf8");
      return text.includes("submit turn recovery") || text.includes("send_failure");
    });
  assert.equal(hit, true, "served client bundle must contain submit turn recovery / send_failure — rebuild @fffattiger/pix-client");
}

async function startKillingProxy(targetOrigin) {
  const target = new URL(targetOrigin);
  const targetPort = Number(target.port);
  const livePairs = new Set();
  const acceptedSockets = new Set();
  let upgradeCount = 0;
  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: target.hostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", () => { res.destroy(); });
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    acceptedSockets.add(socket);
    socket.once("close", () => acceptedSockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    upgradeCount += 1;
    const upstream = net.connect(targetPort, target.hostname);
    const pair = { upstream, socket, dead: false };
    upstream.on("connect", () => {
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
    killWebSockets() {
      for (const pair of livePairs) {
        pair.dead = true;
        // Half-open AND write-dead: the browser still sees OPEN (no close),
        // but the next send throws. A proxy that keeps swallowing writes
        // never trips the client's pre-wire self-heal.
        pair.socket.removeAllListeners("data");
        pair.socket.unpipe();
        pair.socket.write = () => {
          throw new Error("half-open upstream");
        };
        pair.upstream.destroy();
        // The browser's send() does not throw on a half-open socket. Ending
        // our side makes the next client ping fail its pong deadline, which
        // is what proves the transport dead after a backgrounded page wakes.
        pair.socket.end();
      }
    },
    close: () => new Promise((resolvePromise) => {
      for (const pair of [...livePairs]) {
        pair.dead = true;
        pair.socket.destroy();
        pair.upstream.destroy();
      }
      livePairs.clear();
      for (const socket of [...acceptedSockets]) socket.destroy();
      acceptedSockets.clear();
      server.close(() => resolvePromise());
    }),
  };
}

function nonce(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestsFor(provider, prompt) {
  return provider.requests.filter((record) => requestHasUserHash(record, prompt));
}

function planTurn(provider, replyNonce) {
  provider.reset();
  provider.plan({ chunks: [`${replyNonce} `, `${TERMINAL_MARKER}.`] });
}

async function phoneViewport(tab) {
  await tab.setViewport(PHONE.width, PHONE.height, 3, PHONE.mobile);
  await tab.evaluate(`(${PAGE_TOUCH})()`);
}

const PAGE_TOUCH = `(function enableTouch() {
  try {
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5, configurable: true });
  } catch { /* already defined */ }
  return navigator.maxTouchPoints;
})`;

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
  if (process.env.HEAL_DEBUG === "1") {
    await delay(2_000);
    const debug = await tab.evaluate(`(${PAGE.dumpDom})()`).catch((error) => String(error));
    log("DEBUG", `${label} ${JSON.stringify(debug).slice(0, 800)}`);
  }
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

async function waitTurnTerminal(tab, replyNonce, label) {
  try {
    await tab.waitFor(`(() => {
      const answers = [...document.querySelectorAll(".chat-assistant-message")].filter(node => {
        const text = node.textContent ?? "";
        return text.includes(${JSON.stringify(replyNonce)}) && text.includes(${JSON.stringify(TERMINAL_MARKER)});
      });
      return answers.length === 1 && !answers[0].classList.contains("is-streaming")
        && !answers[0].querySelector(".markdown-body.is-streaming");
    })()`, { timeoutMs: SEND_TIMEOUT_MS, label: `${label}: matching assistant settled` });
  } catch (error) {
    const dump = await tab.evaluate(`(${PAGE.dumpDom})()`).catch(() => null);
    const tap = await tab.evaluate(PAGE.runtimeTap).catch(() => null);
    throw new Error(`${String(error?.message ?? error)} dump=${JSON.stringify(dump)} tap=${JSON.stringify(tap).slice(0, 1200)}`);
  }
  await waitForIdleComposer(tab, `${label}: terminal`);
}

async function requireLivenessNegotiated(tab, label) {
  const features = await tab.waitFor(`(() => {
    const frames = window.__pixRuntimeTap?.frames ?? [];
    const ack = frames.find(frame => frame.direction === "in" && frame.type === "handshake_ack"
      && Array.isArray(frame.acceptedFeatures) && frame.acceptedFeatures.includes("runtime.liveness.v1"));
    return ack ? ack.acceptedFeatures : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: runtime.liveness.v1 negotiated` });
  assert.ok(features.includes("runtime.liveness.v1"), `${label}: Host must accept runtime.liveness.v1`);
}

function submitFramesFor(operationId) {
  return `(window.__pixRuntimeTap?.frames ?? [])
    .filter(frame => frame.direction === "out" && frame.type === "submit_turn" && frame.operationId === ${JSON.stringify(operationId)})
    .length`;
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

async function openProjectTab(chrome, proxy, dirs) {
  const history = seedSessionHistoryForTests({
    cwd: dirs.projectCwd,
    turns: 2,
    model: { provider: PROVIDER_ID, modelId: MODEL_A },
    label: "self-heal-project",
  });
  const tab = await chrome.openTab();
  await phoneViewport(tab);
  const url = `${proxy.origin}/?session=${encodeURIComponent(history.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;
  await tab.navigate(url);
  await phoneViewport(tab);
  await tab.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: "project: history transcript" });
  await waitForIdleComposer(tab, "project");
  await requireLivenessNegotiated(tab, "project");
  return tab;
}

/**
 * Pixie: the page creates the assistant session the same way AppShell does.
 * With no assistant session yet, the composer is the draft at
 * `/?draft=assistant` (the assistant view itself only exists once a session
 * id is known). The first send creates with the assistant cwd.
 */
async function openAssistantTab(chrome, proxy, stack) {
  const binding = await fetch(`${stack.origin}/v1/assistant`);
  assert.equal(binding.ok, true, `GET /v1/assistant must be mounted (got ${binding.status})`);
  const info = await binding.json();
  assert.ok(typeof info.cwd === "string" && info.cwd.endsWith("/.pi/pix/assistant"), `assistant cwd: ${JSON.stringify(info)}`);
  const tab = await chrome.openTab();
  await phoneViewport(tab);
  await tab.navigate(`${proxy.origin}/?draft=assistant`);
  await phoneViewport(tab);
  await tab.waitFor(`location.search.includes("assistant")`, { timeoutMs: STEP_TIMEOUT_MS, label: "pixie: assistant url" });
  await waitForIdleComposer(tab, "pixie");
  await requireLivenessNegotiated(tab, "pixie");
  return { tab, cwd: info.cwd };
}

function submitLayout(op) {
  return `(() => {
    const frames = window.__pixRuntimeTap?.frames ?? [];
    const submits = [];
    let handshakesBefore = 0;
    let seenHandshake = false;
    for (const frame of frames) {
      if (frame.direction === "out" && frame.type === "handshake") {
        if (submits.length === 0) handshakesBefore += 1;
        seenHandshake = true;
      }
      if (frame.direction === "out" && frame.type === "submit_turn" && frame.operationId === ${JSON.stringify(op)}) {
        submits.push(seenHandshake);
        seenHandshake = false;
      }
    }
    const lastHandshake = frames.reduce((index, frame, at) =>
      frame.direction === "out" && frame.type === "handshake" ? at : index, -1);
    const submitIndexes = frames
      .map((frame, at) => frame.direction === "out" && frame.type === "submit_turn" && frame.operationId === ${JSON.stringify(op)} ? at : -1)
      .filter((at) => at >= 0);
    return { count: submits.length, handshakesBeforeFirst: handshakesBefore, lastHandshake, submitIndexes };
  })()`;
}

async function assertDeliveredOnce(tab, provider, prompt, op, name) {
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  let alertSeen = null;
  for (;;) {
    const count = requestsFor(provider, prompt).length;
    const dump = await tab.evaluate(`(${PAGE.dumpDom})()`).catch(() => null);
    alertSeen = dump?.alert ?? alertSeen;
    if (alertSeen && FORBIDDEN_ALERTS.some((copy) => String(alertSeen).includes(copy))) {
      throw new Error(`${name}: forbidden alert=${JSON.stringify(alertSeen)}`);
    }
    if (count > 1) throw new Error(`${name}: provider received the prompt ${count} times`);
    if (count === 1) break;
    if (Date.now() > deadline) {
      const detail = await tab.evaluate(`(() => (window.__pixRuntimeTap?.frames ?? [])
        .filter(frame => frame.type === "submit_turn" || frame.type === "submit_turn_result")
        .map(frame => ({ direction: frame.direction, type: frame.type, operationId: frame.operationId, envelopeId: frame.envelopeId, prompt: frame.promptHash, status: frame.status, errorCode: frame.errorCode })))()`).catch(() => null);
      throw new Error(`${name}: no provider request alert=${JSON.stringify(alertSeen)} submits=${JSON.stringify(detail)}`);
    }
    await delay(100);
  }
  assert.equal(requestsFor(provider, prompt).length, 1, `${name}: exactly one provider request`);
  return alertSeen;
}

async function runScenario({ name, chrome, stack, provider, proxy, open, only }) {
  if (only && name !== only) return null;
  const opened = await open();
  const tab = opened.tab ?? opened;
  const reply1 = nonce(`${name}-r1`);
  const prompt1 = `${name}-t1 ${nonce(`${name}-p1`)}`;
  planTurn(provider, reply1);
  const op1 = await typeAndSend(tab, prompt1, `${name}:turn1`);
  const deadline1 = Date.now() + SEND_TIMEOUT_MS;
  while (requestsFor(provider, prompt1).length < 1 && Date.now() < deadline1) await delay(50);
  assert.equal(requestsFor(provider, prompt1).length, 1, `${name}:turn1: exactly one provider request`);
  await waitTurnTerminal(tab, reply1, `${name}:turn1`);
  const upgradesAfterTurn1 = proxy.upgradeCount;
  if (opened.cwd) {
    const latest = await stack.rpc.call("sessions.findLatest", { cwd: opened.cwd });
    assert.equal(latest.sessionId === null, false, `${name}: first send must create an assistant session`);
    assert.equal(latest.cwd, opened.cwd, `${name}: assistant session cwd`);
    assert.equal(String(latest.cwd).endsWith("/.pi/pix/assistant"), true, `${name}: cwd must be the assistant workspace`);
  }

  await tab.setHidden(true);
  proxy.killWebSockets();
  // Past one client heartbeat (30s). A hidden page cannot prove the socket,
  // so the next send reconnects before writing instead of trusting the
  // last inbound frame.
  await delay(Math.max(HEAL_WAIT_MS, 31_000));
  await tab.setHidden(false);

  const reply2 = nonce(`${name}-r2`);
  const prompt2 = `${name}-t2 ${nonce(`${name}-p2`)}`;
  planTurn(provider, reply2);
  const op2 = await typeAndSend(tab, prompt2, `${name}:turn2`);
  await assertDeliveredOnce(tab, provider, prompt2, op2, `${name}:turn2`);
  await waitTurnTerminal(tab, reply2, `${name}:turn2`);
  const providerCount = requestsFor(provider, prompt2).length;
  assert.equal(providerCount, 1, `${name}:turn2: exactly one provider request`);
  const frameCount = await tab.evaluate(submitFramesFor(op2));
  const distinct = await tab.evaluate(`(() => {
    const ids = (window.__pixRuntimeTap?.frames ?? [])
      .filter(frame => frame.direction === "out" && frame.type === "submit_turn")
      .map(frame => frame.operationId)
      .filter(id => id && id !== ${JSON.stringify(op1)});
    return [...new Set(ids)];
  })()`);
  const layout = await tab.evaluate(submitLayout(op2));
  assert.deepEqual(distinct, [op2], `${name}:turn2: one operationId (got ${JSON.stringify(distinct)}, frames=${frameCount})`);
  assert.equal(frameCount, 1, `${name}:turn2: wake reconnects before writing, so exactly one submit (frames=${frameCount})`);
  assert.equal(layout.submitIndexes.length, 1, `${name}:turn2: one submit index`);
  assert.ok(layout.submitIndexes[0] > layout.lastHandshake && layout.handshakesBeforeFirst >= 2,
    `${name}:turn2: the single submit must be on the new socket: ${JSON.stringify(layout)}`);
  const finalDump = await tab.evaluate(`(${PAGE.dumpDom})()`);
  assert.equal(finalDump.alert, null, `${name}: alert must be empty once the reply arrives: ${JSON.stringify(finalDump.alert)}`);
  assert.ok(proxy.upgradeCount > upgradesAfterTurn1, `${name}: recovery opened a fresh WebSocket`);
  const evidence = {
    scenario: name,
    turn1: { operationId: op1, providerRequests: requestsFor(provider, prompt1).length },
    turn2: {
      operationId: op2,
      submitFrames: frameCount,
      distinctOperationIds: distinct,
      providerRequests: providerCount,
      alert: finalDump.alert,
    },
  };
  log("EVIDENCE", JSON.stringify(evidence));
  await tab.close();
  return evidence;
}

async function main() {
  assertBundleHasSelfHeal();
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
    dirs = await makeIsolatedDirs("px-heal");
    provider = await startControlledProvider();
    await writeStubProviderConfig(dirs.agentDir, provider.port, PROVIDER_ID, MODEL_A, { defaultName: NAME_A });
    process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

    stack = await bootLifecycleStack({
      sessiondDir: dirs.sessiondDir,
      projectCwd: dirs.projectCwd,
      hostDir: dirs.hostDir,
      clientDist: CLIENT_DIST,
      assistantResidency: true,
    });
    assert.ok(stack.assistantCwd?.endsWith("/.pi/pix/assistant"), `assistant cwd not mounted: ${stack.assistantCwd}`);
    proxy = await startKillingProxy(stack.origin);
    chrome = await launchChromeCdp();
    log(`boot host=${stack.origin} proxy=${proxy.origin} assistant=${stack.assistantCwd} daemon=${stack.daemon.instanceId.slice(0, 12)}`);

    const scenarios = [
      {
        name: "project",
        open: () => openProjectTab(chrome, proxy, dirs),
      },
      {
        name: "pixie",
        open: () => openAssistantTab(chrome, proxy, stack),
      },
    ];
    for (const scenario of scenarios) {
      try {
        const evidence = await runScenario({
          name: scenario.name,
          chrome,
          stack,
          provider,
          proxy,
          open: scenario.open,
          only: process.env.HEAL_ONLY,
        });
        if (evidence === null) continue;
        results.push({ scenario: scenario.name, ok: true, evidence });
        await stopAllSessions(stack, scenario.name);
      } catch (error) {
        exitCode = 1;
        results.push({ scenario: scenario.name, ok: false, error: String(error?.message ?? error).slice(0, 1200) });
        log(`FAIL ${scenario.name}`, error?.stack ?? error);
        provider.release();
        await stopAllSessions(stack, scenario.name).catch(() => {});
      }
    }
    if (exitCode === 0) log("PASS — silent pre-wire self-heal (project + pixie)");
    else log(`REGRESSION — ${results.filter((entry) => !entry.ok).map((entry) => entry.scenario).join(", ")}`);
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
