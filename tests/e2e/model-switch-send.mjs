/**
 * Model-switch send E2E — REAL Chrome over the built Client against the real
 * SDK stack (sessiond + SDK worker + loopback controlled provider).
 *
 * The production defect class under test (v0.3.7 iPhone PWA): the user picks
 * a model in the picker and sends within ~1s; the picker's set_model command
 * (and the auto title generation it can race) appends journal events —
 * including the adapter's `runtime_state_changed` re-affirmation — which used
 * to advance the submit fence, so sessiond rejected the racing submit with
 * `conflict/not_delivered` and the composer showed 「消息未发送，草稿已保留」
 * even though the message was never delivered.
 *
 * Scenarios (both REQUIRED):
 *  A. type → open picker → switch to the OTHER model → send IMMEDIATELY
 *     (<1s, no waits between the pick and the send): the turn is admitted,
 *     exactly one provider request, no send-failure alert, draft cleared,
 *     exactly one user bubble, reply settles.
 *  B. same flow but re-selecting the CURRENT model (reselect path): same
 *     assertions.
 *
 * Provider-request oracle: requestHasUserHash (see idle-send.mjs) — the
 * Worker's request appends trailing context after the user prompt, so "the
 * turn carried this prompt" is matched by any user message equal to it.
 *
 * Run: node tests/e2e/model-switch-send.mjs
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, requestHasUserHash } from "./helpers/controlled-provider.mjs";
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
const PROVIDER_ID = "pix-e2e-stub";
const MODEL_A = "pix-e2e-alpha";
const NAME_A = "Pix E2E Alpha";
const MODEL_B = "pix-e2e-beta";
const NAME_B = "Pix E2E Beta";
const TERMINAL_MARKER = "TERMINAL-MARKER-DONE";

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

async function waitTurnTerminal(tab, replyNonce, label, timeoutMs = SEND_TIMEOUT_MS) {
  await tab.waitFor(`(() => {
    const answers = [...document.querySelectorAll(".chat-assistant-message")].filter(node => {
      const text = node.textContent ?? "";
      return text.includes(${JSON.stringify(replyNonce)}) && text.includes(${JSON.stringify(TERMINAL_MARKER)});
    });
    return answers.length === 1 && !answers[0].classList.contains("is-streaming")
      && !answers[0].querySelector(".markdown-body.is-streaming");
  })()`, { timeoutMs, label: `${label}: matching assistant settled` });
  await waitForIdleComposer(tab, `${label}: terminal`);
}

async function dumpUi(tab) {
  return await tab.evaluate(`(${PAGE.dumpDom})()`).catch(() => null);
}

/**
 * The production race, verbatim: type the prompt FIRST, then open the picker,
 * pick a model, and click send with NO awaits between pick and send — the
 * set_model command is still in flight when the submit races it.
 */
async function pickModelThenSendImmediately(tab, { prompt, needles, label }) {
  await waitForIdleComposer(tab, label);
  const value = await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(prompt)})`);
  assert.equal(value, prompt, `${label}: composer must hold the typed text`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: send enabled` });
  assert.equal(await tab.evaluate(`(${PAGE.clickModelSelector})()`), true, `${label}: model selector click must land`);
  const picked = await tab.waitFor(`(${PAGE.clickModelRowByLabels})(${JSON.stringify(needles)})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: model row picked` });
  assert.equal(picked, true, `${label}: model row click must land`);
  // IMMEDIATE send — zero delay after the pick.
  assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, `${label}: send click must land`);
}

async function assertExactlyOneDelivery(tab, provider, { prompt, replyNonce, label }) {
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  for (;;) {
    if (requestsFor(provider, prompt).length > 0) break;
    const dump = await dumpUi(tab);
    if (dump?.alert) throw new Error(`${label}: send surfaced a client error: alert=${JSON.stringify(dump.alert)}`);
    if (Date.now() > deadline) throw new Error(`${label}: no provider request within ${SEND_TIMEOUT_MS}ms dump=${JSON.stringify(dump)}`);
    await delay(100);
  }
  await waitTurnTerminal(tab, replyNonce, label);
  assert.equal(requestsFor(provider, prompt).length, 1, `${label}: exactly one provider request`);
  const dump = await dumpUi(tab);
  assert.equal(dump.alert, null, `${label}: no send-failure alert at terminal: ${JSON.stringify(dump)}`);
  assert.equal(dump.textareaValue, "", `${label}: draft must be cleared after the accepted send: ${JSON.stringify(dump)}`);
  const bubbles = await tab.waitFor(`(() => {
    const matches = [...document.querySelectorAll(".chat-user-message")]
      .filter(node => (node.textContent ?? "").includes(${JSON.stringify(prompt)}));
    return matches.length;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: user bubble present` });
  assert.equal(bubbles, 1, `${label}: exactly one user bubble`);
}

async function openSeededSessionTab(chrome, origin, dirs, label) {
  const history = seedSessionHistoryForTests({
    cwd: dirs.projectCwd,
    turns: 2,
    model: { provider: PROVIDER_ID, modelId: MODEL_A },
    label,
  });
  const tab = await chrome.openTab();
  const url = `${origin}/?session=${encodeURIComponent(history.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;
  await tab.navigate(url);
  await tab.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: history transcript` });
  await waitForIdleComposer(tab, label);
  return { tab, sessionId: history.sessionId };
}

/** A. Switch to the OTHER model and send immediately. */
async function scenarioSwitchModelAndSend(chrome, provider, origin, dirs) {
  const { tab } = await openSeededSessionTab(chrome, origin, dirs, "switch-other");

  // Control turn on the default model so the session is live-attached.
  const reply1 = nonce("a-r1");
  const prompt1 = `switch-a-t1 ${nonce("a-p1")}`;
  planTurn(provider, reply1);
  await waitForIdleComposer(tab, "A:turn1");
  await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(prompt1)})`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: "A:turn1: send enabled" });
  await tab.evaluate(`(${PAGE.clickSend})()`);
  await waitTurnTerminal(tab, reply1, "A:turn1");

  // THE race: pick model B, send immediately.
  const reply2 = nonce("a-r2");
  const prompt2 = `switch-a-t2 ${nonce("a-p2")}`;
  planTurn(provider, reply2);
  await pickModelThenSendImmediately(tab, { prompt: prompt2, needles: [MODEL_B, NAME_B], label: "A:turn2" });
  await assertExactlyOneDelivery(tab, provider, { prompt: prompt2, replyNonce: reply2, label: "A:turn2" });
  await tab.close();
}

/** B. Re-select the CURRENT model and send immediately. */
async function scenarioReselectModelAndSend(chrome, provider, origin, dirs) {
  const { tab } = await openSeededSessionTab(chrome, origin, dirs, "reselect-same");

  const reply1 = nonce("b-r1");
  const prompt1 = `switch-b-t1 ${nonce("b-p1")}`;
  planTurn(provider, reply1);
  await waitForIdleComposer(tab, "B:turn1");
  await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(prompt1)})`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: "B:turn1: send enabled" });
  await tab.evaluate(`(${PAGE.clickSend})()`);
  await waitTurnTerminal(tab, reply1, "B:turn1");

  const reply2 = nonce("b-r2");
  const prompt2 = `switch-b-t2 ${nonce("b-p2")}`;
  planTurn(provider, reply2);
  await pickModelThenSendImmediately(tab, { prompt: prompt2, needles: [MODEL_A, NAME_A], label: "B:turn2" });
  await assertExactlyOneDelivery(tab, provider, { prompt: prompt2, replyNonce: reply2, label: "B:turn2" });
  await tab.close();
}

async function main() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFactory = process.env.PIX_AGENT_WORKER_FACTORY;
  let dirs = null;
  let provider = null;
  let stack = null;
  let chrome = null;
  const results = [];
  const cleanupFailures = [];
  const deadlineTimer = setTimeout(() => {
    log(`SUITE-DEADLINE exceeded ${SUITE_DEADLINE_MS}ms — tearing down`);
    process.exit(1);
  }, SUITE_DEADLINE_MS);
  let exitCode = 0;
  try {
    dirs = await makeIsolatedDirs("px-switch");
    provider = await startControlledProvider();
    await writeStubProviderConfig(dirs.agentDir, provider.port, PROVIDER_ID, MODEL_A, {
      defaultName: NAME_A,
      extraModels: [{ id: MODEL_B, name: NAME_B }],
    });
    process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

    stack = await bootLifecycleStack({ sessiondDir: dirs.sessiondDir, projectCwd: dirs.projectCwd, hostDir: dirs.hostDir, clientDist: CLIENT_DIST });
    chrome = await launchChromeCdp();
    log(`boot host=${stack.origin} daemon=${stack.daemon.instanceId.slice(0, 12)}`);

    for (const scenario of [
      { name: "A-switch-other-model-send", run: () => scenarioSwitchModelAndSend(chrome, provider, stack.origin, dirs) },
      { name: "B-reselect-same-model-send", run: () => scenarioReselectModelAndSend(chrome, provider, stack.origin, dirs) },
    ]) {
      try {
        await scenario.run();
        results.push({ scenario: scenario.name, ok: true });
      } catch (error) {
        exitCode = 1;
        results.push({ scenario: scenario.name, ok: false, error: String(error?.message ?? error).slice(0, 900) });
        log(`FAIL ${scenario.name}`, error?.stack ?? error);
        provider.release();
      }
    }
    if (exitCode === 0) log("PASS — model-switch send (other-model switch + same-model reselect)");
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
