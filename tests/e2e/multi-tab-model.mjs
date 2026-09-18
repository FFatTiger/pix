/**
 * Multi-tab / multi-session model-submit acceptance (LC layer 3, real Chrome).
 *
 * Two REAL Chrome targets in ONE isolated profile drive the REAL stack
 * (isolated agentDir → sessiond → SDK worker → loopback controlled provider).
 * Each tab owns its own RuntimeProvider/WS (per-target runtime tap proves an
 * independent handshake per tab).
 *
 * Contract under test (model-submit regression, "composer shows A then sends B"):
 *
 *  S1 same session, two tabs:
 *   - tab2 makes the session live with one turn, then tab1 is opened while the
 *     session is idle → detached, branch-resolved display of history model A;
 *   - tab2 (live) mutates the model to B (immediate runtime.model.set); tab1
 *     stays detached and must still SHOW A while the worker now holds B (the
 *     exact "composer shows A" divergence);
 *   - tab1 sends: the controlled provider's ACTUAL request.model must equal the
 *     model tab1 displayed immediately before the send, exactly one request;
 *   - exactly ONE worker identity for the whole scenario (same sessiond worker
 *     process), and closing a tab must not stop the worker nor the other tab.
 *
 *  S2 different sessions, two tabs, distinct models:
 *   - tabA (session A, persisted model A) and tabB (session B, persisted model B);
 *   - A's reply is held at the provider gate while B reaches terminal;
 *   - each prompt hash must map to its own model, one request each, and the two
 *     sessions must hold two DISTINCT worker identities.
 *
 * Privacy: only model ids, prompt hashes, session-id prefixes, worker PIDs and
 * counts are ever logged. No raw prompts, replies, cookies or profile paths.
 *
 * Run: npm run test:e2e:multi-tab   (or: node tests/e2e/multi-tab-model.mjs)
 * Prerequisites: npm ci && npm run build (client dist), installed Google Chrome.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, markExactPrompt, hashPrompt } from "./helpers/controlled-provider.mjs";
import { launchChromeCdp, PAGE, CHROME_PATH } from "./helpers/chrome-cdp.mjs";
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
const suiteAbort = new AbortController();
const submittedOperations = new WeakMap();

const PROVIDER_ID = "pix-e2e-stub";
const MODEL_A = "pix-e2e-alpha";
const MODEL_B = "pix-e2e-beta";
const NAME_A = "Pix E2E Alpha";
const NAME_B = "Pix E2E Beta";
const NAME_TO_ID = new Map([
  [NAME_A, MODEL_A],
  [NAME_B, MODEL_B],
]);
const TERMINAL_MARKER = "TERMINAL-MARKER-DONE";

function nonce(tag) {
  return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Safe prompt identifier: hash prefix only, never the content. */
function promptTag(prompt) {
  return hashPrompt(prompt).slice(0, 12);
}

function requestsFor(provider, prompt) {
  const hash = hashPrompt(prompt);
  return provider.requests.filter((record) => record.promptHash === hash);
}

/** Bounded condition wait over an async predicate (no fixed sleeps). */
async function waitForCondition(predicate, { timeoutMs = STEP_TIMEOUT_MS, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    suiteAbort.signal.throwIfAborted();
    const value = await predicate();
    suiteAbort.signal.throwIfAborted();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(50);
  }
}

/** Structural tab state only — no transcript/draft content ever leaves the page. */
async function tabState(tab) {
  const dump = await tab.evaluate(`(${PAGE.dumpDom})()`).catch(() => null);
  if (!dump || typeof dump !== "object") return { available: false };
  return {
    available: true,
    overlay: Boolean(dump.overlay),
    runningDot: Boolean(dump.runningDot),
    sendBtn: Boolean(dump.sendBtn),
    sendDisabled: dump.sendDisabled ?? null,
    stopBtn: Boolean(dump.stopBtn),
    textareaChars: typeof dump.textareaValue === "string" ? dump.textareaValue.length : null,
    userCount: dump.userCount ?? 0,
    assistantCount: dump.assistantCount ?? 0,
    assistantStreaming: Boolean(dump.assistantStreaming || dump.markdownStreaming),
    alert: typeof dump.alert === "string" ? dump.alert.slice(0, 200) : null,
  };
}

async function tabTapSummary(tab) {
  return await tab.evaluate(PAGE.runtimeTap).catch(() => null);
}

/** Structural-only probe of why the model selector is/isn't rendered. */
async function diagnoseModelSelector(tab, sessionId) {
  const source = [
    "(async function diagnoseModelSelector(sessionId) {",
    "  const probe = {",
    "    toolbarModelPresent: Boolean(document.querySelector('.chat-input-toolbar-model')),",
    "    toolbarButtons: document.querySelectorAll('.chat-input-toolbar-controls button').length,",
    "    composerPresent: Boolean(document.querySelector('.chat-input-textarea')),",
    "  };",
    "  try {",
    "    const response = await fetch('/v1/models', { credentials: 'same-origin' });",
    "    const body = await response.json();",
    "    probe.modelsStatus = response.status;",
    "    probe.modelIds = Array.isArray(body.models) ? body.models.map((model) => model.provider + '/' + model.id) : null;",
    "  } catch (error) { probe.modelsStatus = 'error:' + String(error).slice(0, 80); }",
    "  try {",
    "    const response = await fetch('/v1/sessions/' + encodeURIComponent(sessionId), { credentials: 'same-origin' });",
    "    const body = await response.json();",
    "    probe.sessionStatus = response.status;",
    "    probe.workspaceAccess = (body && body.session && body.session.workspaceAccess) || null;",
    "  } catch (error) { probe.sessionStatus = 'error:' + String(error).slice(0, 80); }",
    "  return probe;",
    "})(" + JSON.stringify(sessionId === null ? "" : String(sessionId)) + ")",
  ].join("\n");
  return await tab.evaluate(source, { awaitPromise: true }).catch((cause) => ({ probeError: String(cause?.message ?? cause).slice(0, 160) }));
}

async function requireObserveFeature(tab, label) {
  const tap = await tab.waitFor(`(() => {
    const tap = window.__pixRuntimeTap && window.__pixRuntimeTap.summary();
    return tap && tap.acceptedObserve ? tap : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: observe-existing accepted` });
  assert.equal(tap.requestedObserve, true, `${label}: Client must request runtime.observe-existing.v1`);
  assert.equal(tap.acceptedObserve, true, `${label}: Host must accept runtime.observe-existing.v1`);
  return tap;
}

async function waitForIdleComposer(tab, label) {
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: idle composer` });
}

async function typeAndSend(tab, text, label) {
  await waitForIdleComposer(tab, label);
  suiteAbort.signal.throwIfAborted();
  const value = await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(text)})`);
  assert.equal(value, text, `${label}: composer must hold the typed text`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: send enabled` });
  const priorOperations = await tab.evaluate(`(window.__pixRuntimeTap?.frames ?? [])
    .filter(frame => frame.direction === "out" && frame.type === "submit_turn")
    .map(frame => frame.operationId)`);
  suiteAbort.signal.throwIfAborted();
  assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, `${label}: send click must land`);
  const operationIds = await tab.waitFor(`(() => {
    const previous = new Set(${JSON.stringify(priorOperations)});
    const ids = [...new Set((window.__pixRuntimeTap?.frames ?? [])
      .filter(frame => frame.direction === "out" && frame.type === "submit_turn" && !previous.has(frame.operationId))
      .map(frame => frame.operationId))];
    return ids.length ? ids : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: exact submit identity` });
  assert.equal(operationIds.length, 1, `${label}: one new submit operation`);
  assert.equal(typeof operationIds[0], "string");
  submittedOperations.set(tab, operationIds[0]);
}

async function waitTurnTerminal(tab, replyNonce, label) {
  const operationId = submittedOperations.get(tab);
  assert.equal(typeof operationId, "string", `${label}: submitted operation must be known`);
  try {
    await tab.waitFor(`(window.__pixRuntimeTap?.frames ?? []).some(frame =>
      frame.direction === "in" && frame.type === "turn_status"
      && frame.operationId === ${JSON.stringify(operationId)} && frame.turnState === "completed")`,
    { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: exact operation completed` });
    await tab.waitFor(`(() => {
      const answers = [...document.querySelectorAll(".chat-assistant-message")].filter(node => {
        const text = node.textContent ?? "";
        return text.includes(${JSON.stringify(replyNonce)}) && text.includes(${JSON.stringify(TERMINAL_MARKER)});
      });
      return answers.length === 1 && !answers[0].classList.contains("is-streaming")
        && !answers[0].querySelector(".markdown-body.is-streaming");
    })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: matching assistant settled` });
  } catch (error) {
    // Timeout evidence is structural and protocol-sanitized: no prompt,
    // transcript, or reply content leaves the browser.
    throw new Error(`${error.message} state=${JSON.stringify(await tabState(tab))} runtime=${JSON.stringify(await tabTapSummary(tab))}`);
  }
  await waitForIdleComposer(tab, `${label}: terminal`);
}

/** Bounded wait for the composer's displayed model, matched by catalog display
 *  name OR model id (the selector falls back to the id when no display name is
 *  projected). The observed label is included in the failure message. */
async function waitForModelName(tab, modelId, displayName, label, sessionId = null) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    suiteAbort.signal.throwIfAborted();
    const name = await visibleModelName(tab);
    if (name === displayName || name === modelId || (typeof name === "string" && name.includes(modelId))) return name;
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: composer must display ${displayName}/${modelId} (observed=${JSON.stringify(name)}) `
          + `state=${JSON.stringify(await tabState(tab))} `
          + `selectorProbe=${JSON.stringify(await diagnoseModelSelector(tab, sessionId))}`,
      );
    }
    await delay(50);
  }
}

/** Type into the OPEN dropdown's search box (React-controlled input). */
async function setModelSearch(tab, text, label) {
  const applied = await tab.evaluate(`(function setModelSearch(text) {
    const panel = document.querySelector(".chat-input-model-dropdown");
    if (!panel) return { ok: false, reason: "dropdown-missing" };
    const input = panel.querySelector("input");
    if (!input) return { ok: false, reason: "search-input-missing" };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, value: input.value };
  })(${JSON.stringify(text)})`);
  assert.equal(applied?.ok, true, `${label}: model search must accept text: ${JSON.stringify(applied)}`);
}

/** Open the model dropdown, filter to any of `needles` (display name and model
 *  id), click its row. Bounded UI waits with structural-only diagnostics. */
async function selectModel(tab, needles, label) {
  suiteAbort.signal.throwIfAborted();
  const list = [...needles];
  assert.equal(await tab.evaluate(`(${PAGE.clickModelSelector})()`), true, `${label}: model selector button must exist`);
  await tab.waitFor(`Boolean(document.querySelector(".chat-input-model-dropdown"))`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: model dropdown open` });
  await setModelSearch(tab, list[0], label);
  suiteAbort.signal.throwIfAborted();
  try {
    await tab.waitFor(`(${PAGE.clickModelRowByLabels})(${JSON.stringify(list)})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: model row for ${list[0]} clickable` });
  } catch (error) {
    const rows = await tab.evaluate(PAGE.modelDropdownRows).catch(() => null);
    throw new Error(`${String(error?.message ?? error)} dropdown=${JSON.stringify(rows)}`);
  }
  await tab.waitFor(`!Boolean(document.querySelector(".chat-input-model-dropdown"))`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: model dropdown closed` });
}

async function visibleModelName(tab) {
  return await tab.evaluate(`(${PAGE.modelSelectorName})`);
}

/** Worker-authority live model for a running session (null when not running). */
async function authorityModel(stack, sessionId) {
  const running = await stack.rpc.call("runtime.listRunning", {});
  if (!running.sessions.some((session) => session.sessionId === sessionId)) return null;
  const snapshot = await stack.rpc.call("runtime.getSnapshot", { sessionId });
  return snapshot?.state?.model?.id ?? null;
}

async function runningIds(stack) {
  const running = await stack.rpc.call("runtime.listRunning", {});
  return running.sessions.map((session) => session.sessionId);
}

async function workerPids(stack) {
  return [...stack.daemon.diagnostics.workerPids()];
}

async function openSessionTab(chrome, stack, dirs, sessionId, label) {
  suiteAbort.signal.throwIfAborted();
  const tab = await chrome.openTab();
  suiteAbort.signal.throwIfAborted();
  const url = `${stack.origin}/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;
  await tab.navigate(url);
  await tab.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: history transcript` });
  await tab.waitFor(PAGE.sendButtonPresent, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: composer present` });
  await requireObserveFeature(tab, label);
  return tab;
}

/**
 * Send from one tab and wait for the provider request carrying that exact
 * prompt. Fails fast (bounded) when the Client surfaces a send error instead of
 * a model request, with structural-only diagnostics.
 */
async function sendAndAwaitRequest(tab, provider, prompt, label) {
  await typeAndSend(tab, prompt, label);
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  for (;;) {
    suiteAbort.signal.throwIfAborted();
    const records = requestsFor(provider, prompt);
    if (records.length > 0) return records;
    const state = await tabState(tab);
    if (state.alert) {
      throw new Error(
        `${label}: send surfaced a client error before any provider request (prompt=${promptTag(prompt)}): `
        + `alert=${JSON.stringify(state.alert)} state=${JSON.stringify(state)} tap=${JSON.stringify(await tabTapSummary(tab))}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: no provider request for prompt=${promptTag(prompt)} within ${SEND_TIMEOUT_MS}ms: `
        + `state=${JSON.stringify(state)} tap=${JSON.stringify(await tabTapSummary(tab))} provider=${JSON.stringify(provider.report())}`,
      );
    }
    await delay(50);
  }
}

/**
 * Prompt-hash ledger — the ONLY "exactly one request" oracle.
 *
 * `sendAndAwaitRequest` returns a snapshot captured the moment the request
 * arrived, which is BEFORE the turn reaches terminal: a late duplicate can land
 * afterwards and `provider.reset()` would destroy the evidence. The ledger
 * therefore keeps every expected prompt hash + expected model (hashes only,
 * never content) and `verifyRequestLedger` re-reads `provider.requests` fresh,
 * so counts/models stay checkable after terminal and at suite end. The suite
 * never resets the recorder after the first expected request exists.
 */
const requestLedger = [];

function expectRequest(prompt, expectedModel, label) {
  const hash = hashPrompt(prompt);
  if (requestLedger.some((entry) => entry.hash === hash)) return;
  requestLedger.push({ hash, expectedModel, label });
}

/** Zero provider requests for any hash the suite did not expect. */
function assertNoUnexpectedRequests(provider, label) {
  const knownHashes = new Set(requestLedger.map((entry) => entry.hash));
  const unexpected = provider.requests.filter((record) => !knownHashes.has(record.promptHash)).length;
  assert.equal(unexpected, 0, `${label}: ${unexpected} unexpected provider request(s): ${JSON.stringify(provider.report())}`);
}

/** Fresh, full re-verification: exactly one request per expected prompt hash
 *  with the expected model, and zero requests for any other hash. */
function verifyRequestLedger(provider, label) {
  const problems = [];
  for (const entry of requestLedger) {
    const matches = provider.requests.filter((record) => record.promptHash === entry.hash);
    if (matches.length !== 1) {
      problems.push(`${entry.label}[${entry.hash.slice(0, 12)}]: expected exactly 1 provider request, got ${matches.length}`);
      continue;
    }
    if (matches[0].model !== entry.expectedModel) {
      problems.push(`${entry.label}[${entry.hash.slice(0, 12)}]: request.model ${String(matches[0].model)} != ${entry.expectedModel}`);
    }
  }
  const knownHashes = new Set(requestLedger.map((entry) => entry.hash));
  const unexpected = provider.requests.filter((record) => !knownHashes.has(record.promptHash)).length;
  if (unexpected > 0) problems.push(`${unexpected} unexpected provider request(s)`);
  assert.equal(problems.length, 0, `${label}: ${problems.join("; ")} :: ${JSON.stringify(provider.report())}`);
}

/** Register the expectation and verify THIS turn against a FRESH read of the
 *  recorder (never the snapshot returned by `sendAndAwaitRequest`), plus the
 *  no-unexpected-requests invariant. Full-history re-verification (which also
 *  catches late duplicates of earlier turns) is `verifyRequestLedger`, run
 *  after each terminal and once more at suite end. */
function assertSingleRequest(provider, prompt, expectedModel, label) {
  const matches = provider.requests.filter((record) => record.promptHash === hashPrompt(prompt));
  assert.equal(matches.length, 1, `${label}: exactly one provider request for prompt=${promptTag(prompt)} (got ${matches.length})`);
  assert.equal(
    matches[0].model,
    expectedModel,
    `${label}: provider request.model must be ${expectedModel} for prompt=${promptTag(prompt)} (got ${String(matches[0].model)})`,
  );
  assertNoUnexpectedRequests(provider, label);
}

async function stopAllSessions(stack, label) {
  const ids = await runningIds(stack);
  for (const sessionId of ids) {
    await stack.rpc.call("runtime.stop", { sessionId, reason: "user" }).catch(() => {});
  }
  await waitForCondition(async () => (await runningIds(stack)).length === 0, { timeoutMs: 15_000, label: `${label}: workers stopped` }).catch(() => {});
}

// ---------------------------------------------------------------------------
// S1 — same session, two tabs, tab2 mutates the model, tab1 sends its visible
// ---------------------------------------------------------------------------

async function scenarioSameSessionTwoTabs(chrome, stack, provider, dirs) {
  const history = seedSessionHistoryForTests({
    cwd: dirs.projectCwd,
    turns: 2,
    model: { provider: PROVIDER_ID, modelId: MODEL_A },
    label: "mtab-same",
  });
  const sessionId = history.sessionId;
  log(`S1 seed session=${sessionId.slice(0, 18)}… persistedModel=${MODEL_A}`);

  // tab2 opens first and drives the worker live from history.
  const tab2 = await openSessionTab(chrome, stack, dirs, sessionId, "S1:tab2");
  assert.deepEqual(await runningIds(stack), [], "S1: opening history in tab2 must create zero workers");

  const reply1 = nonce("r1");
  const prompt1 = `mtab-s1-tab2-t1 ${nonce("p1")}`;
  provider.plan({ chunks: [`${reply1} `, `${TERMINAL_MARKER}.`], matchPromptHash: hashPrompt(prompt1) });
  expectRequest(prompt1, MODEL_A, "S1:tab2-turn1");
  await sendAndAwaitRequest(tab2, provider, prompt1, "S1:tab2-turn1");
  markExactPrompt(provider, prompt1);
  assertSingleRequest(provider, prompt1, MODEL_A, "S1:tab2-turn1 (worker reopen must restore the persisted history model)");
  await waitTurnTerminal(tab2, reply1, "S1:tab2-turn1");
  verifyRequestLedger(provider, "S1:tab2-turn1 terminal");

  const workersAfterTurn1 = await workerPids(stack);
  assert.equal(workersAfterTurn1.length, 1, "S1: exactly one worker identity after tab2's turn");
  assert.equal(await authorityModel(stack, sessionId), MODEL_A, "S1: live worker model must be the restored history model");

  // tab1 is opened while the session is IDLE (no busy turn to auto-observe) →
  // detached, branch-resolved display of the history model A, and no worker
  // mutation has happened yet, so the read is the model the user sees.
  const tab1 = await openSessionTab(chrome, stack, dirs, sessionId, "S1:tab1");
  await waitForModelName(tab1, MODEL_A, NAME_A, "S1: tab1 selector shows the history model A", sessionId);

  // tab2 (live) mutates the model to B — an immediate runtime.model.set. tab1
  // stays detached with its already-resolved branch read: it must still SHOW A
  // while the worker now holds B (the exact "composer shows A" divergence).
  await selectModel(tab2, [NAME_B, MODEL_B], "S1:tab2-select-B");
  await waitForCondition(async () => (await authorityModel(stack, sessionId)) === MODEL_B, { label: "S1: authority model becomes B" });
  await waitForModelName(tab2, MODEL_B, NAME_B, "S1: tab2 selector shows B", sessionId);
  await waitForModelName(tab1, MODEL_A, NAME_A, "S1: tab1 still shows A after tab2's mutation", sessionId);
  const visiblePreSend = await visibleModelName(tab1);
  const expectedModelId = NAME_TO_ID.get(visiblePreSend) ?? null;
  assert.equal(expectedModelId, MODEL_A, `S1: tab1's visible pre-send model must resolve to ${MODEL_A} (got ${String(visiblePreSend)})`);

  // The divergence precondition, asserted immediately before the send.
  assert.equal(await authorityModel(stack, sessionId), MODEL_B, "S1: precondition — the live worker must still hold model B when tab1 sends");
  assert.equal((await workerPids(stack)).length, 1, "S1: precondition — exactly one worker identity");

  const reply2 = nonce("r2");
  const prompt2 = `mtab-s1-tab1-t2 ${nonce("p2")}`;
  provider.plan({ chunks: [`${reply2} `, `${TERMINAL_MARKER}.`], matchPromptHash: hashPrompt(prompt2) });
  expectRequest(prompt2, expectedModelId, "S1:tab1-send");
  await sendAndAwaitRequest(tab1, provider, prompt2, "S1:tab1-send");
  markExactPrompt(provider, prompt2);
  assertSingleRequest(provider, prompt2, expectedModelId, "S1:tab1-send (request.model must match tab1's visible pre-send model)");
  await waitTurnTerminal(tab1, reply2, "S1:tab1-send");
  verifyRequestLedger(provider, "S1:tab1-send terminal");

  assert.deepEqual(await workerPids(stack), workersAfterTurn1, "S1: the worker identity must be unchanged after tab1's send");
  assert.equal((await runningIds(stack)).join(","), sessionId, "S1: still exactly the one session worker");

  // Closing a tab must not stop the worker nor the surviving tab.
  await tab2.close();
  await waitForCondition(async () => (await runningIds(stack)).includes(sessionId), { timeoutMs: STEP_TIMEOUT_MS, label: "S1: worker survives tab2 close" });
  assert.deepEqual(await workerPids(stack), workersAfterTurn1, "S1: worker identity unchanged after tab2 close");

  await waitForModelName(tab1, MODEL_A, NAME_A, "S1: tab1 selector back to A after its send", sessionId);

  // The surviving tab must still be able to drive the SAME worker end to end.
  const reply3 = nonce("r3");
  const prompt3 = `mtab-s1-tab1-t3 ${nonce("p3")}`;
  provider.plan({ chunks: [`${reply3} `, `${TERMINAL_MARKER}.`], matchPromptHash: hashPrompt(prompt3) });
  expectRequest(prompt3, MODEL_A, "S1:tab1-after-tab2-close");
  await sendAndAwaitRequest(tab1, provider, prompt3, "S1:tab1-after-tab2-close");
  markExactPrompt(provider, prompt3);
  assertSingleRequest(provider, prompt3, MODEL_A, "S1:tab1-after-tab2-close");
  await waitTurnTerminal(tab1, reply3, "S1:tab1-after-tab2-close");
  verifyRequestLedger(provider, "S1 final");
  assert.deepEqual(await workerPids(stack), workersAfterTurn1, "S1: still exactly one worker identity at the end");

  await tab1.close();
  log("PASS S1 same-session two-tabs", JSON.stringify({
    session: sessionId.slice(0, 18),
    workerPids: workersAfterTurn1,
    visiblePreSend: expectedModelId,
    providerModels: [MODEL_A, expectedModelId, MODEL_A],
    survivedTabClose: true,
  }));
}

// ---------------------------------------------------------------------------
// S2 — different sessions, distinct models, gated A vs terminal B
// ---------------------------------------------------------------------------

async function scenarioDistinctSessions(chrome, stack, provider, dirs) {
  const historyA = seedSessionHistoryForTests({
    cwd: dirs.projectCwd,
    turns: 2,
    model: { provider: PROVIDER_ID, modelId: MODEL_A },
    label: "mtab-distinct-a",
  });
  const historyB = seedSessionHistoryForTests({
    cwd: dirs.projectCwd,
    turns: 2,
    model: { provider: PROVIDER_ID, modelId: MODEL_B },
    label: "mtab-distinct-b",
  });
  assert.notEqual(historyA.sessionId, historyB.sessionId, "S2: the two scenarios must seed two distinct sessions");
  log(`S2 seed sessionA=${historyA.sessionId.slice(0, 24)}… model=${MODEL_A} sessionB=${historyB.sessionId.slice(0, 24)}… model=${MODEL_B}`);

  const tabA = await openSessionTab(chrome, stack, dirs, historyA.sessionId, "S2:tabA");
  const tabB = await openSessionTab(chrome, stack, dirs, historyB.sessionId, "S2:tabB");
  await waitForModelName(tabA, MODEL_A, NAME_A, "S2: tabA selector shows its own persisted model", historyA.sessionId);
  await waitForModelName(tabB, MODEL_B, NAME_B, "S2: tabB selector shows its own persisted model", historyB.sessionId);
  assert.deepEqual(await runningIds(stack), [], "S2: opening both histories must create zero workers");

  const replyA = nonce("ra");
  const replyB = nonce("rb");
  const promptA = `mtab-s2-a ${nonce("pa")}`;
  const promptB = `mtab-s2-b ${nonce("pb")}`;
  provider.plan({ chunks: [`${replyA} held `, `${TERMINAL_MARKER}.`], gateAfterChunks: 1, matchPromptHash: hashPrompt(promptA) });
  provider.plan({ chunks: [`${replyB} `, `${TERMINAL_MARKER}.`], matchPromptHash: hashPrompt(promptB) });
  expectRequest(promptA, MODEL_A, "S2:A-send");
  expectRequest(promptB, MODEL_B, "S2:B-send");

  // A first: its reply is held at the provider gate.
  await sendAndAwaitRequest(tabA, provider, promptA, "S2:A-send");
  await waitForCondition(() => provider.gated === true, { label: "S2: A held at the provider gate" });

  // B runs to terminal while A is still held.
  await sendAndAwaitRequest(tabB, provider, promptB, "S2:B-send");
  await waitTurnTerminal(tabB, replyB, "S2:B-terminal-while-A-held");
  assert.equal(provider.gated, true, "S2: A must still be held when B reaches terminal");

  markExactPrompt(provider, promptA);
  markExactPrompt(provider, promptB);
  assertSingleRequest(provider, promptA, MODEL_A, "S2:A-send (prompt hash must map to session A's model)");
  assertSingleRequest(provider, promptB, MODEL_B, "S2:B-send (prompt hash must map to session B's model)");
  verifyRequestLedger(provider, "S2 both-turns terminal");

  const pids = await workerPids(stack);
  assert.equal(pids.length, 2, `S2: two distinct worker identities (got ${pids.length}: ${pids.join(",")})`);
  assert.deepEqual(
    [...(await runningIds(stack))].sort(),
    [historyA.sessionId, historyB.sessionId].sort(),
    "S2: both sessions must hold their own worker",
  );

  provider.release();
  await waitTurnTerminal(tabA, replyA, "S2:A-terminal-after-release");
  verifyRequestLedger(provider, "S2 final");
  assert.deepEqual(await workerPids(stack), pids, "S2: worker identities unchanged after A terminal");

  await tabA.close();
  await tabB.close();
  log("PASS S2 distinct-sessions two-tabs", JSON.stringify({
    sessionA: historyA.sessionId.slice(0, 18),
    sessionB: historyB.sessionId.slice(0, 18),
    workerPids: pids,
    promptToModel: [
      { prompt: promptTag(promptA), model: requestsFor(provider, promptA)[0]?.model ?? null },
      { prompt: promptTag(promptB), model: requestsFor(provider, promptB)[0]?.model ?? null },
    ],
  }));
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(CLIENT_DIST)) {
    log(`FAIL client dist missing: ${CLIENT_DIST} (run: npm run build --workspace @fffattiger/pix-client)`);
    return 1;
  }
  if (!existsSync(CHROME_PATH)) {
    log(`FAIL installed Chrome not found at ${CHROME_PATH}`);
    return 1;
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFactory = process.env.PIX_AGENT_WORKER_FACTORY;
  delete process.env.PIX_AGENT_WORKER_FACTORY;

  // Every owned resource is declared BEFORE the try so a partial boot (dirs
  // created, provider listening, chrome spawned, stack half-up) is still torn
  // down by the same finally.
  let dirs = null;
  let provider = null;
  let stack = null;
  let chrome = null;
  const results = [];
  const cleanupFailures = [];
  const deadlineTimer = setTimeout(() => {
    suiteAbort.abort(new Error(`suite deadline exceeded ${SUITE_DEADLINE_MS}ms`));
  }, SUITE_DEADLINE_MS);
  let exitCode = 0;
  try {
    dirs = await makeIsolatedDirs("px-mtab");
    suiteAbort.signal.throwIfAborted();
    provider = await startControlledProvider();
    suiteAbort.signal.throwIfAborted();
    await writeStubProviderConfig(dirs.agentDir, provider.port, PROVIDER_ID, MODEL_A, {
      defaultName: NAME_A,
      extraModels: [{ id: MODEL_B, name: NAME_B }],
    });
    suiteAbort.signal.throwIfAborted();
    process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

    const runScenarios = async () => {
      stack = await bootLifecycleStack({ sessiondDir: dirs.sessiondDir, projectCwd: dirs.projectCwd, hostDir: dirs.hostDir, clientDist: CLIENT_DIST });
      suiteAbort.signal.throwIfAborted();
      chrome = await launchChromeCdp();
      suiteAbort.signal.throwIfAborted();
      log(`boot origin=${stack.origin} tabs=${chrome.tabIds().length} daemon=${stack.daemon.instanceId.slice(0, 12)}`);

      for (const scenario of [
        { name: "S1-same-session-two-tabs", run: scenarioSameSessionTwoTabs },
        { name: "S2-distinct-sessions-two-tabs", run: scenarioDistinctSessions },
      ]) {
        suiteAbort.signal.throwIfAborted();
        try {
          await scenario.run(chrome, stack, provider, dirs);
          suiteAbort.signal.throwIfAborted();
        } catch (error) {
          suiteAbort.signal.throwIfAborted();
          exitCode = 1;
          results.push({ scenario: scenario.name, ok: false, error: String(error?.message ?? error).slice(0, 900) });
          log(`FAIL ${scenario.name}`, error?.stack ?? error);
          log(`${scenario.name}-provider`, JSON.stringify(provider.report()));
          // Keep the next scenario independent of a half-finished turn/worker.
          // The recorder is NEVER reset here: accumulated requests are the
          // evidence for the reported failure and for the suite-final re-check.
          provider.release();
          await stopAllSessions(stack, scenario.name);
          continue;
        }
        results.push({ scenario: scenario.name, ok: true });
        await stopAllSessions(stack, scenario.name);
      }
    };
    // Cooperative deadline: join the scenario body before teardown. Every
    // outstanding CDP/RPC/boot operation has its own bounded wait; cancellation
    // is checked at condition waits and resource/scenario boundaries. A late
    // resource is assigned to its owned slot before cancellation can unwind.
    // Never race an uncancelled body against cleanup.
    await runScenarios();
    suiteAbort.signal.throwIfAborted();

    // Suite-final re-verification of EVERY expected prompt hash against a
    // fresh recorder read — catches duplicates that land after a scenario's
    // own terminal check. Reported as its own summary row so it can never mask
    // (or be masked by) a scenario result.
    if (requestLedger.length > 0) {
      try {
        verifyRequestLedger(provider, "suite final");
      } catch (error) {
        exitCode = 1;
        const message = String(error?.message ?? error).slice(0, 900);
        results.push({ scenario: "suite-final-request-ledger", ok: false, error: message });
        log("FAIL suite-final request ledger", message);
      }
    }

    if (exitCode === 0) log("PASS — multi-tab model-submit acceptance (same-session + distinct-sessions)");
    else log(`REGRESSION-RECORDED — ${results.filter((entry) => !entry.ok).map((entry) => entry.scenario).join(", ")}`);
  } catch (error) {
    exitCode = 1;
    log("FAIL harness", error?.stack ?? error);
    if (provider) log("provider-report", JSON.stringify(provider.report(), null, 2));
  } finally {
    clearTimeout(deadlineTimer);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousFactory === undefined) delete process.env.PIX_AGENT_WORKER_FACTORY;
    else process.env.PIX_AGENT_WORKER_FACTORY = previousFactory;
    if (provider) provider.release();
    if (chrome) {
      const chromeClosed = await Promise.race([chrome.close().then(() => true), delay(8_000).then(() => false)]).catch(() => false);
      if (!chromeClosed) cleanupFailures.push("chrome.close timed out");
    }
    const torn = await teardownLifecycleStack(stack, dirs);
    cleanupFailures.push(...torn.failures);
    const providerClosed = provider
      ? await Promise.race([provider.close().then(() => true), delay(3_000).then(() => false)])
      : true;
    if (!providerClosed) cleanupFailures.push("provider.close timed out");
    if (cleanupFailures.length > 0) {
      log("CLEANUP-FAIL", JSON.stringify(cleanupFailures));
      exitCode = 1;
    }
  }
  log("summary", JSON.stringify(results));
  return exitCode;
}

main().then(
  (code) => {
    process.exit(code === 0 ? 0 : 1);
  },
  (error) => {
    // A top-level rejection must still be a nonzero, reported exit.
    log("FAIL unhandled", error?.stack ?? error);
    process.exit(1);
  },
);
