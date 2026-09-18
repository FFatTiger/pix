/**
 * LC-00 layer 3 E2E — REAL Chrome over the built Client against the real SDK
 * stack (sessiond + SDK worker + loopback controlled provider).
 *
 * Strict by default: held partial transcript, A→B→A resume, and refresh resume
 * are required. Optional `--diagnostic-baseline` still reports the same cases
 * but cannot masquerade as a strict PASS (nonzero unless every required case
 * succeeded). No legacy activating-attach fallback: observe-existing must be
 * requested and accepted before behavior assertions.
 *
 * Run: node tests/e2e/lifecycle-browser.mjs
 *      node tests/e2e/lifecycle-browser.mjs --diagnostic-baseline
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, markExactPrompt, hashPrompt } from "./helpers/controlled-provider.mjs";
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
const COLD_SEND_TIMEOUT_MS = 60_000;
const DIAGNOSTIC_BASELINE = process.argv.includes("--diagnostic-baseline");
const HELD_CHUNK = "HELD-PARTIAL-MARKER";
const TERMINAL_CHUNK = "TERMINAL-MARKER-DONE";

function uniqueMarker(kind) {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function redactDump(dump) {
  if (!dump || typeof dump !== "object") return dump;
  const clip = (value) => (typeof value === "string" ? value.replace(/[A-Za-z0-9+/=_-]{12,}/g, "…") : value);
  return {
    url: typeof dump.url === "string" ? dump.url.replace(/session=[^&]+/g, "session=…") : dump.url,
    overlay: dump.overlay,
    runningDot: dump.runningDot,
    sendBtn: dump.sendBtn,
    sendDisabled: dump.sendDisabled,
    stopBtn: dump.stopBtn,
    textareaDisabled: dump.textareaDisabled,
    selectedRow: dump.selectedRow
      ? { running: dump.selectedRow.running, workspace: dump.selectedRow.workspace, textLen: (dump.selectedRow.text ?? "").length }
      : null,
    userCount: dump.userCount,
    assistantCount: dump.assistantCount,
    assistantStreaming: dump.assistantStreaming,
    markdownStreaming: dump.markdownStreaming,
    lastAssistantLen: typeof dump.lastAssistant === "string" ? dump.lastAssistant.length : 0,
    lastMarkdownLen: typeof dump.lastMarkdown === "string" ? dump.lastMarkdown.length : 0,
    alert: clip(dump.alert),
  };
}

async function waitForProviderCount(provider, expected, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (provider.requests.length < expected && Date.now() < deadline) await delay(50);
  assert.equal(provider.requests.length, expected, `${label}: expected ${expected} provider requests, got ${provider.requests.length}: ${JSON.stringify(provider.report())}`);
}

async function waitForProviderGate(provider, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!provider.gated && Date.now() < deadline) await delay(50);
  assert.equal(provider.gated, true, `${label}: provider must be paused: ${JSON.stringify(provider.report())}`);
}

function gatedPlan(chunks, prompt) {
  assert.ok(typeof prompt === "string" && prompt.length > 0, "gatedPlan requires the exact user prompt hash");
  return { chunks, gateAfterChunks: 1, matchPromptHash: hashPrompt(prompt) };
}

function ungatedPlan(chunks, prompt) {
  if (prompt) return { chunks, matchPromptHash: hashPrompt(prompt) };
  return { chunks };
}

function promptRequestCount(provider, prompt) {
  const hash = hashPrompt(prompt);
  return provider.requests.filter((record) => record.promptHash === hash).length;
}

function otherRequestCount(provider, ...prompts) {
  const hashes = new Set(prompts.map((prompt) => hashPrompt(prompt)));
  return provider.requests.filter((record) => !hashes.has(record.promptHash)).length;
}

function assertExactPromptOnce(provider, prompt, label) {
  markExactPrompt(provider, prompt);
  const count = promptRequestCount(provider, prompt);
  assert.equal(count, 1, `${label}: exact prompt hash must appear once (got ${count}, other=${otherRequestCount(provider, prompt)}): ${JSON.stringify(provider.report())}`);
}

async function waitForIdleComposer(chrome, timeoutMs, label) {
  await chrome.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs, label: `${label}: idle send button` });
}

async function typeAndSend(chrome, text) {
  await waitForIdleComposer(chrome, STEP_TIMEOUT_MS, "pre-send");
  await chrome.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(text)})`).then((value) =>
    assert.equal(value, text, "composer must hold the typed text"));
  await chrome.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: "send button enabled after composer text" });
  assert.equal(await chrome.evaluate(`(${PAGE.clickSend})()`), true, "send click must land");
}

async function requireObserveFeature(chrome, label) {
  const tap = await chrome.waitFor(`(() => {
    const tap = window.__pixRuntimeTap && window.__pixRuntimeTap.summary();
    return tap && tap.acceptedObserve ? tap : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: observe-existing accepted` });
  assert.equal(tap.requestedObserve, true, `${label}: Client must request runtime.observe-existing.v1: ${JSON.stringify(tap)}`);
  assert.equal(tap.acceptedObserve, true, `${label}: Host must accept runtime.observe-existing.v1 (no legacy fallback): ${JSON.stringify(tap)}`);
  return tap;
}

function streamingHasMarkerExpr(marker) {
  return `(() => {
    const streaming = document.querySelector(".chat-assistant-message.is-streaming, .markdown-body.is-streaming");
    const text = streaming?.textContent ?? "";
    return streaming && text.includes(${JSON.stringify(marker)}) ? text : null;
  })()`;
}

async function assertHeldStreaming(chrome, provider, marker, label) {
  await waitForProviderGate(provider, STEP_TIMEOUT_MS, label);
  let text;
  try {
    text = await chrome.waitFor(streamingHasMarkerExpr(marker), { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: current streaming node shows ${marker}` });
  } catch (error) {
    const dump = await chrome.evaluate(`(${PAGE.dumpDom})()`).catch((cause) => ({ evaluateError: String(cause?.message ?? cause).slice(0, 200) }));
    const tap = await chrome.evaluate(PAGE.runtimeTap).catch(() => null);
    throw new Error(`${label}: held streaming marker missing while provider gated=${provider.gated} dump=${JSON.stringify(redactDump(dump))} tap=${JSON.stringify(tap)} original=${String(error?.message ?? error).slice(0, 200)}`);
  }
  const dump = await chrome.evaluate(`(${PAGE.dumpDom})()`);
  assert.equal(dump.assistantStreaming || dump.markdownStreaming, true, `${label}: selected session must show .is-streaming: ${JSON.stringify(redactDump(dump))}`);
  assert.equal(typeof dump.lastAssistant === "string" && dump.lastAssistant.includes(TERMINAL_CHUNK), false, `${label}: must not show accepted terminal while held`);
  const tap = await chrome.evaluate(PAGE.runtimeTap);
  const snapshotPartialChars = tap?.shapes?.find((shape) => shape.type === "snapshot" && shape.partial?.charCount > 0)?.partial?.charCount ?? 0;
  assert.ok(
    (tap?.textDeltas ?? 0) >= 1 || snapshotPartialChars > 0,
    `${label}: inbound WS must carry text-delta frames or a snapshot partial during hold: ${JSON.stringify(tap)}`,
  );
  return { text, dump: redactDump(dump), tap };
}

async function clickSession(chrome, sessionId, label) {
  const clicked = await chrome.waitFor(`(${PAGE.clickSessionByTestId})(${JSON.stringify(sessionId)}) || null`, {
    timeoutMs: STEP_TIMEOUT_MS,
    label: `${label}: session row ${sessionId.slice(0, 8)}`,
  });
  assert.equal(clicked, true, `${label}: session-select-${sessionId} must be clickable`);
}

async function logBrowserEvidence(chrome, provider, dirs, label) {
  let dump = null;
  let tap = null;
  try {
    dump = await chrome.evaluate(`(${PAGE.dumpDom})()`);
  } catch (error) {
    dump = { evaluateError: String(error?.message ?? error).slice(0, 200) };
  }
  try {
    tap = await chrome.evaluate(PAGE.runtimeTap);
  } catch {
    tap = null;
  }
  let diag = null;
  try {
    diag = await chrome.evaluate(PAGE.pixDiag);
  } catch {
    diag = null;
  }
  const payload = {
    label,
    dump: redactDump(dump),
    tap,
    diag,
    provider: provider.report(),
  };
  log(`${label}-evidence`, JSON.stringify(payload));
  const evidenceDir = join(ROOT, "tests", "e2e", ".artifacts");
  try {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `browser-${label}.json`), JSON.stringify(payload, null, 2));
  } catch {
    /* evidence write is best-effort */
  }
  try {
    await chrome.screenshot(join(evidenceDir, `browser-${label}.png`));
  } catch {
    /* screenshot is evidence, not a test requirement */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closeOwnedChrome(chrome) {
  if (!chrome) return { ok: true, error: null };
  let closed = false;
  let error = null;
  try {
    closed = await Promise.race([
      chrome.close().then(() => true),
      delay(8_000).then(() => false),
    ]);
    if (!closed) error = `chrome.close timed out pid=${chrome.pid}`;
  } catch (cause) {
    error = `chrome.close rejected pid=${chrome.pid}: ${String(cause?.message ?? cause).slice(0, 200)}`;
  }
  const pid = chrome.pid;
  if (pid && pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (pid && pidAlive(pid)) error = `${error ? `${error}; ` : ""}owned chrome pid ${pid} still alive`;
  return { ok: error === null, error };
}

function createChromeSlot() {
  let current = null;
  const ownedPids = [];
  return {
    get() {
      return current;
    },
    pids() {
      return [...ownedPids];
    },
    /** Register immediately. Returns the previous client so the caller can close it after the new owner is live. */
    adopt(next) {
      if (next?.pid && Number.isInteger(next.pid)) ownedPids.push(next.pid);
      const previous = current;
      current = next;
      return previous;
    },
    async closeAll() {
      const previous = current;
      current = null;
      const failures = [];
      if (previous) {
        const closed = await closeOwnedChrome(previous);
        if (!closed.ok && closed.error) failures.push(closed.error);
      }
      const leftover = ownedPids.filter((pid) => pidAlive(pid));
      for (const pid of leftover) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      const still = ownedPids.filter((pid) => pidAlive(pid));
      if (still.length > 0) failures.push(`owned chrome pids still alive: ${still.join(",")}`);
      return { failures, leftover: still, ownedPids: [...ownedPids] };
    },
  };
}

async function runChromeRelaunchOwnershipProbe() {
  const slot = createChromeSlot();
  let exitCode = 0;
  const recorded = [];
  try {
    const first = await launchChromeCdp();
    slot.adopt(first);
    const previous = first;
    const firstClosed = await closeOwnedChrome(previous);
    if (!firstClosed.ok) {
      recorded.push(firstClosed.error);
      throw new Error(`unexpected first chrome cleanup failure: ${firstClosed.error}`);
    }
    const second = await launchChromeCdp();
    slot.adopt(second);
    const rejectClosed = await closeOwnedChrome({
      pid: second.pid,
      close: async () => { throw new Error("forced chrome.close reject"); },
    });
    if (rejectClosed.ok) recorded.push("forced chrome.close reject was reported ok");
    else log("forced chrome.close reject recorded", rejectClosed.error);
    throw new Error("injected failure after chrome relaunch");
  } catch (error) {
    if (String(error?.message ?? error) !== "injected failure after chrome relaunch") {
      exitCode = 1;
      log("FAIL", error?.stack ?? error);
    }
  } finally {
    const closed = await slot.closeAll();
    if (closed.leftover.length > 0 || closed.failures.length > 0) {
      log("CLEANUP-FAIL", JSON.stringify({ recorded, leftover: closed.leftover, ownedPids: closed.ownedPids, failures: closed.failures }));
      exitCode = 1;
    } else {
      log("PASS chrome relaunch ownership probe", JSON.stringify({ ownedPids: closed.ownedPids, leftover: [], recorded }));
    }
  }
  return exitCode;
}

async function runCorpus(chromeSlot, stack, provider, dirs, corpus, { includeResume }) {
  let chrome = chromeSlot.get();
  assert.ok(chrome, `${corpus.label}: chrome slot must already own a client`);
  const { history, sessionUrl, cwd } = corpus;
  const counts = { failures: [] };
  const requestsBeforeLoad = provider.requests.length;
  await chrome.navigate(sessionUrl);
  await chrome.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: history transcript` });
  await chrome.waitFor(PAGE.sendButtonPresent, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: idle send button present` });
  const observeTap = await requireObserveFeature(chrome, `${corpus.label}: boot`);
  log(`${corpus.label}: observe-existing requested=${observeTap.requestedObserve} accepted=${observeTap.acceptedObserve}`);
  assert.equal(provider.requests.length, requestsBeforeLoad, `${corpus.label}: loading history must issue zero provider requests`);
  const runningBeforeSend = await stack.rpc.call("runtime.listRunning", {});
  assert.deepEqual(runningBeforeSend.sessions, [], `${corpus.label}: opening history must create zero workers`);
  const bootDump = await chrome.evaluate(`(${PAGE.dumpDom})()`);
  assert.equal(bootDump.alert, null, `${corpus.label}: history-only/workspace alert must be absent: ${JSON.stringify(redactDump(bootDump))}`);

  const held1 = uniqueMarker(`${corpus.label}-held1`);
  const prompt1 = `browser-${corpus.label} send-1 ${held1}`;
  provider.reset();
  provider.plan(gatedPlan([`${held1} ${HELD_CHUNK} `, `${TERMINAL_CHUNK}.`], prompt1));
  await typeAndSend(chrome, prompt1);
  const clickAt = Date.now();
  await chrome.waitFor(PAGE.inputStreaming, { timeoutMs: COLD_SEND_TIMEOUT_MS, label: `${corpus.label}: composer streaming overlay while turn runs` });
  await chrome.waitFor(PAGE.runningDot, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: workspace running dot while turn runs` });
  await chrome.waitFor(`!(${PAGE.sendButtonPresent})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: send button swapped out while turn runs` });
  await chrome.waitFor(`window.__pixRuntimeTap && window.__pixRuntimeTap.summary().submitResults >= 1`, { timeoutMs: COLD_SEND_TIMEOUT_MS, label: `${corpus.label}: submit_turn_result on Client WS` });
  const deadline1 = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, prompt1) < 1 && Date.now() < deadline1) await delay(50);
  assertExactPromptOnce(provider, prompt1, `${corpus.label} send-1`);
  const first = provider.requests.find((record) => record.promptHash === hashPrompt(prompt1));
  log(`${corpus.label}: provider request at +${first.receivedAt - clickAt}ms bytes=${first.requestBytes} messages=${first.messageCount} other=${otherRequestCount(provider, prompt1)}`);
  await chrome.waitFor(`(() => { const t = ${PAGE.lastUserBubbleText}; return t && t.includes(${JSON.stringify(prompt1)}) ? t : null; })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: user bubble with exact prompt` });
  await assertHeldStreaming(chrome, provider, held1, `${corpus.label}: live-partial`);
  assertExactPromptOnce(provider, prompt1, `${corpus.label} send-1 held`);

  provider.release();
  await chrome.waitFor(`(() => {
    const assistant = ${PAGE.lastAssistantText} ?? "";
    return assistant.includes(${JSON.stringify(TERMINAL_CHUNK)}) ? assistant : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: assistant terminal text` });
  await chrome.waitFor(`!(${PAGE.assistantStreaming})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: streaming cleared at terminal` });
  await waitForIdleComposer(chrome, STEP_TIMEOUT_MS, `${corpus.label} send-1 terminal`);
  assertExactPromptOnce(provider, prompt1, `${corpus.label} send-1 terminal`);
  log(`${corpus.label}: send-1 otherRequests=${otherRequestCount(provider, prompt1)}`);

  const prompt2 = `browser-${corpus.label} send-2 ${uniqueMarker("s2")}`;
  provider.plan(ungatedPlan([`ok-${corpus.label}-2 `, `${TERMINAL_CHUNK}.`], prompt2));
  await typeAndSend(chrome, prompt2);
  const deadline2 = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, prompt2) < 1 && Date.now() < deadline2) await delay(50);
  assertExactPromptOnce(provider, prompt2, `${corpus.label} send-2`);
  await chrome.waitFor(`(() => { const t = ${PAGE.lastUserBubbleText}; return t && t.includes(${JSON.stringify(prompt2)}) ? t : null; })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: second user bubble` });
  await waitForIdleComposer(chrome, STEP_TIMEOUT_MS, `${corpus.label} send-2 terminal`);
  assertExactPromptOnce(provider, prompt1, `${corpus.label} after send-2 prompt1`);
  assertExactPromptOnce(provider, prompt2, `${corpus.label} send-2 terminal`);
  log(`${corpus.label}: core send/terminal PASS other=${otherRequestCount(provider, prompt1, prompt2)}`);

  if (!includeResume) {
    return counts;
  }

  const heldNav = uniqueMarker(`${corpus.label}-nav`);
  const promptNav = `browser-${corpus.label} nav ${heldNav}`;
  provider.plan(gatedPlan([`${heldNav} ${HELD_CHUNK} `, `${TERMINAL_CHUNK}.`], promptNav));
  await typeAndSend(chrome, promptNav);
  const navDeadline = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, promptNav) < 1 && Date.now() < navDeadline) await delay(50);
  assertExactPromptOnce(provider, promptNav, `${corpus.label} nav send`);
  await waitForProviderGate(provider, STEP_TIMEOUT_MS, `${corpus.label}: nav gated`);
  await assertHeldStreaming(chrome, provider, heldNav, `${corpus.label}: nav pre-switch`);
  await clickSession(chrome, corpus.otherId, `${corpus.label}: A→B`);
  await delay(400);
  await clickSession(chrome, history.sessionId, `${corpus.label}: B→A`);
  await requireObserveFeature(chrome, `${corpus.label}: after A→B→A`);
  const afterNavRunning = await stack.rpc.call("runtime.listRunning", {});
  assert.equal(afterNavRunning.sessions.length, 1, `${corpus.label}: A→B→A must keep exactly one worker`);
  assert.equal(afterNavRunning.sessions[0]?.sessionId, history.sessionId, `${corpus.label}: A→B→A must keep the original worker`);
  assertExactPromptOnce(provider, promptNav, `${corpus.label} A→B→A`);
  await assertHeldStreaming(chrome, provider, heldNav, `${corpus.label}: nav resume`);
  provider.release();
  await chrome.waitFor(`(() => {
    const assistant = ${PAGE.lastAssistantText} ?? "";
    return assistant.includes(${JSON.stringify(TERMINAL_CHUNK)}) ? assistant : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: nav terminal text` });
  await waitForIdleComposer(chrome, STEP_TIMEOUT_MS, `${corpus.label} nav terminal`);
  assertExactPromptOnce(provider, promptNav, `${corpus.label} nav terminal`);

  const heldRefresh = uniqueMarker(`${corpus.label}-refresh`);
  const promptRefresh = `browser-${corpus.label} refresh ${heldRefresh}`;
  provider.plan(gatedPlan([`${heldRefresh} ${HELD_CHUNK} `, `${TERMINAL_CHUNK}.`], promptRefresh));
  await typeAndSend(chrome, promptRefresh);
  const refreshDeadline = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, promptRefresh) < 1 && Date.now() < refreshDeadline) await delay(50);
  assertExactPromptOnce(provider, promptRefresh, `${corpus.label} refresh send`);
  await assertHeldStreaming(chrome, provider, heldRefresh, `${corpus.label}: refresh pre`);
  await chrome.reload();
  await chrome.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: refresh transcript restored` });
  await requireObserveFeature(chrome, `${corpus.label}: after refresh`);
  const afterRefreshRunning = await stack.rpc.call("runtime.listRunning", {});
  assert.equal(afterRefreshRunning.sessions.length, 1, `${corpus.label}: refresh must keep exactly one worker`);
  assert.equal(afterRefreshRunning.sessions[0]?.sessionId, history.sessionId, `${corpus.label}: refresh must keep the original worker`);
  assertExactPromptOnce(provider, promptRefresh, `${corpus.label} refresh`);
  await assertHeldStreaming(chrome, provider, heldRefresh, `${corpus.label}: refresh resume`);
  provider.release();
  await chrome.waitFor(`(() => {
    const assistant = ${PAGE.lastAssistantText} ?? "";
    return assistant.includes(${JSON.stringify(TERMINAL_CHUNK)}) ? assistant : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: refresh terminal text` });
  await waitForIdleComposer(chrome, STEP_TIMEOUT_MS, `${corpus.label} refresh terminal`);
  assertExactPromptOnce(provider, promptRefresh, `${corpus.label} refresh terminal`);

  const heldDetach = uniqueMarker(`${corpus.label}-detach`);
  const promptDetach = `browser-${corpus.label} detach ${heldDetach}`;
  provider.plan(gatedPlan([`${heldDetach} ${HELD_CHUNK} `, `${TERMINAL_CHUNK}.`], promptDetach));
  await typeAndSend(chrome, promptDetach);
  const detachDeadline = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, promptDetach) < 1 && Date.now() < detachDeadline) await delay(50);
  assertExactPromptOnce(provider, promptDetach, `${corpus.label} detach send`);
  await assertHeldStreaming(chrome, provider, heldDetach, `${corpus.label}: detach pre`);
  const previous = chrome;
  const previousClosed = await closeOwnedChrome(previous);
  chrome = await launchChromeCdp();
  chromeSlot.adopt(chrome);
  if (!previousClosed.ok) throw new Error(`${corpus.label}: previous chrome cleanup failed: ${previousClosed.error}`);
  await delay(500);
  assertExactPromptOnce(provider, promptDetach, `${corpus.label} browser close`);
  const running = await stack.rpc.call("runtime.listRunning", {});
  assert.ok(running.sessions.some((s) => s.sessionId === history.sessionId), `${corpus.label}: browser close must not stop the worker`);
  await chrome.navigate(sessionUrl);
  await requireObserveFeature(chrome, `${corpus.label}: after reopen`);
  await assertHeldStreaming(chrome, provider, heldDetach, `${corpus.label}: reopen resume`);
  assertExactPromptOnce(provider, promptDetach, `${corpus.label} reopen`);
  provider.release();
  await chrome.waitFor(`!(${PAGE.assistantStreaming})`, { timeoutMs: STEP_TIMEOUT_MS, label: `${corpus.label}: detach terminal` });
  assertExactPromptOnce(provider, promptDetach, `${corpus.label} re-attach`);

  await stack.rpc.call("runtime.stop", { sessionId: history.sessionId, reason: "user" });
  let stopped = false;
  for (let i = 0; i < 100; i++) {
    const list = await stack.rpc.call("runtime.listRunning", {});
    if (!list.sessions.some((s) => s.sessionId === history.sessionId)) {
      stopped = true;
      break;
    }
    await delay(50);
  }
  assert.equal(stopped, true, `${corpus.label}: explicit runtime.stop must recycle the worker`);
  return { ...counts, cwd };
}

async function runNewSessionFirstSend(chrome, stack, provider, dirs, projectCwd) {
  await chrome.navigate(`${stack.origin}/?cwd=${encodeURIComponent(projectCwd)}`);
  await chrome.waitFor(`(${PAGE.sendButtonPresent}) || document.querySelector('[data-testid="home-stack"], [data-testid="transcript-home"]')`, { timeoutMs: STEP_TIMEOUT_MS, label: "new-home: composer or home stack" });
  await requireObserveFeature(chrome, "new-home: boot");
  const held = uniqueMarker("newhome-held");
  const prompt = `browser-newhome ${held}`;
  provider.plan(gatedPlan([`${held} ${HELD_CHUNK} `, `${TERMINAL_CHUNK}.`], prompt));
  await typeAndSend(chrome, prompt);
  const homeDeadline = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, prompt) < 1 && Date.now() < homeDeadline) await delay(50);
  assertExactPromptOnce(provider, prompt, "new-home send");
  await assertHeldStreaming(chrome, provider, held, "new-home: live-partial");
  const running = await stack.rpc.call("runtime.listRunning", {});
  assert.equal(running.sessions.length, 1, `new-home: first send must activate exactly one worker: ${JSON.stringify(running.sessions.map((s) => s.sessionId?.slice?.(0, 8)))}`);
  provider.release();
  await chrome.waitFor(`(() => {
    const assistant = ${PAGE.lastAssistantText} ?? "";
    return assistant.includes(${JSON.stringify(TERMINAL_CHUNK)}) ? assistant : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: "new-home: terminal text" });
  await chrome.waitFor(`!(${PAGE.assistantStreaming})`, { timeoutMs: STEP_TIMEOUT_MS, label: "new-home: streaming cleared" });
  try {
    await waitForIdleComposer(chrome, COLD_SEND_TIMEOUT_MS, "new-home terminal");
  } catch (error) {
    const uiBeforeRpc = {
      at: Date.now(),
      dump: redactDump(await chrome.evaluate(`(${PAGE.dumpDom})()`).catch((cause) => ({ evaluateError: String(cause?.message ?? cause).slice(0, 200) }))),
      tap: await chrome.evaluate(PAGE.runtimeTap).catch(() => null),
      diag: await chrome.evaluate(PAGE.pixDiag).catch(() => null),
    };
    log("new-home-idle UI/WS before RPC", JSON.stringify({ dump: uiBeforeRpc.dump, diag: uiBeforeRpc.diag, terminals: uiBeforeRpc.tap?.terminals ?? null }));
    let authorityAfter = null;
    try {
      const listRunning = await stack.rpc.call("runtime.listRunning", {});
      const sessionId = running.sessions[0]?.sessionId;
      const snap = sessionId ? await stack.rpc.call("runtime.getSnapshot", { sessionId }) : null;
      const uiAfterRpc = {
        at: Date.now(),
        dump: redactDump(await chrome.evaluate(`(${PAGE.dumpDom})()`).catch((cause) => ({ evaluateError: String(cause?.message ?? cause).slice(0, 200) }))),
        diag: await chrome.evaluate(PAGE.pixDiag).catch(() => null),
      };
      authorityAfter = {
        listRunningCount: listRunning?.sessions?.length ?? null,
        listRunningBusy: Array.isArray(listRunning?.sessions) ? listRunning.sessions.map((s) => ({ id: s.sessionId?.slice?.(0, 8), busy: s.busy ?? s.isBusy ?? null })) : null,
        snapshot: snap ? {
          isStreaming: snap.state?.isStreaming ?? snap.snapshot?.state?.isStreaming ?? null,
          isPromptRunning: snap.state?.isPromptRunning ?? snap.snapshot?.state?.isPromptRunning ?? null,
          streamingActive: snap.streaming?.active ?? snap.snapshot?.streaming?.active ?? null,
          streamingPhase: snap.streaming?.phase ?? snap.snapshot?.streaming?.phase ?? null,
        } : null,
        uiChangedAfterRpc: JSON.stringify(uiBeforeRpc.diag) !== JSON.stringify(uiAfterRpc.diag) || JSON.stringify(uiBeforeRpc.dump) !== JSON.stringify(uiAfterRpc.dump),
        uiAfterRpc,
      };
      log("new-home-idle authority after RPC", JSON.stringify(authorityAfter));
    } catch (probeError) {
      log("new-home-idle authority probe failed", String(probeError?.message ?? probeError).slice(0, 300));
    }
    await logBrowserEvidence(chrome, provider, dirs, "new-home-idle");
    throw new Error(`new-home idle composer not restored after terminal: uiBeforeRpc=${JSON.stringify({ dump: uiBeforeRpc.dump, diag: uiBeforeRpc.diag, terminals: uiBeforeRpc.tap?.terminals ?? null })} authorityAfter=${JSON.stringify(authorityAfter)} original=${String(error?.message ?? error).slice(0, 200)}`);
  }
  assertExactPromptOnce(provider, prompt, "new-home terminal");
  const prompt2Nonce = uniqueMarker("newhome-s2");
  const prompt2 = `browser-newhome send-2 ${prompt2Nonce}`;
  provider.plan(ungatedPlan([`ok-newhome-2 ${prompt2Nonce} `, `${TERMINAL_CHUNK}.`], prompt2));
  await typeAndSend(chrome, prompt2);
  const secondDeadline = Date.now() + COLD_SEND_TIMEOUT_MS;
  while (promptRequestCount(provider, prompt2) < 1 && Date.now() < secondDeadline) await delay(50);
  assertExactPromptOnce(provider, prompt2, "new-home send-2");
  await chrome.waitFor(`(() => { const t = ${PAGE.lastUserBubbleText}; return t && t.includes(${JSON.stringify(prompt2)}) ? t : null; })()`, { timeoutMs: STEP_TIMEOUT_MS, label: "new-home send-2: last user is prompt2" });
  await chrome.waitFor(`(() => {
    const assistant = ${PAGE.lastAssistantText} ?? "";
    return assistant.includes(${JSON.stringify(prompt2Nonce)}) && assistant.includes(${JSON.stringify(TERMINAL_CHUNK)}) ? assistant : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: "new-home send-2: unique reply + terminal text" });
  await chrome.waitFor(`!(${PAGE.assistantStreaming})`, { timeoutMs: STEP_TIMEOUT_MS, label: "new-home send-2: streaming cleared" });
  await waitForIdleComposer(chrome, COLD_SEND_TIMEOUT_MS, "new-home send-2 terminal");
  assertExactPromptOnce(provider, prompt, "new-home after send-2 prompt1");
  assertExactPromptOnce(provider, prompt2, "new-home send-2 terminal");
  const runningAfterSecond = await stack.rpc.call("runtime.listRunning", {});
  assert.equal(runningAfterSecond.sessions.length, 1, `new-home: second send must preserve exactly one worker: ${JSON.stringify(runningAfterSecond.sessions.map((s) => s.sessionId?.slice?.(0, 8)))}`);
  assert.equal(runningAfterSecond.sessions[0]?.sessionId, running.sessions[0].sessionId, "new-home: second send must keep the same worker session");
  await stack.rpc.call("runtime.stop", { sessionId: running.sessions[0].sessionId, reason: "user" }).catch(() => {});
  let stopped = false;
  for (let i = 0; i < 100; i++) {
    const list = await stack.rpc.call("runtime.listRunning", {});
    if (!list.sessions.some((s) => s.sessionId === running.sessions[0].sessionId)) {
      stopped = true;
      break;
    }
    await delay(50);
  }
  assert.equal(stopped, true, "new-home: explicit runtime.stop must recycle the worker");
}

async function main() {
  if (process.argv.includes("--probe-chrome-relaunch-cleanup")) {
    return runChromeRelaunchOwnershipProbe();
  }
  if (!existsSync(CLIENT_DIST)) {
    log(`FAIL client dist missing: ${CLIENT_DIST} (run: npm run build --workspace @fffattiger/pix-client)`);
    return 1;
  }
  if (!existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) {
    log("FAIL installed Chrome not found at /Applications/Google Chrome.app");
    return 1;
  }

  const suiteDeadline = Date.now() + SUITE_DEADLINE_MS;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFactory = process.env.PIX_AGENT_WORKER_FACTORY;
  delete process.env.PIX_AGENT_WORKER_FACTORY;
  const dirs = await makeIsolatedDirs("px-lbr");
  const provider = await startControlledProvider();
  const stub = await writeStubProviderConfig(dirs.agentDir, provider.port);
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

  let stack;
  const chromeSlot = createChromeSlot();
  let exitCode = 0;
  let cleanupFailures = [];
  try {
    assert.ok(Date.now() < suiteDeadline, "suite deadline exceeded before boot");
    const short = seedSessionHistoryForTests({
      cwd: dirs.projectCwd,
      turns: 3,
      model: { provider: stub.providerId, modelId: stub.modelId },
      label: "lifecycle-browser",
    });
    const other = seedSessionHistoryForTests({
      cwd: dirs.projectCwd,
      turns: 2,
      model: { provider: stub.providerId, modelId: stub.modelId },
      label: "lifecycle-other",
    });
    const diagnoseFirstHeld = process.argv.includes("--diagnose-first-held");
    const diagnoseNewHomeIdle = process.argv.includes("--diagnose-newhome-idle");
    const long = diagnoseFirstHeld || diagnoseNewHomeIdle ? null : seedSessionHistoryForTests({
      cwd: dirs.projectCwd,
      turns: 80,
      toolDense: true,
      model: { provider: stub.providerId, modelId: stub.modelId },
      label: "lifecycle-browser-long",
    });
    log(`seeded short=${short.sessionId.slice(0, 8)}… other=${other.sessionId.slice(0, 8)}… long=${long ? long.sessionId.slice(0, 8) : "skipped"}… jsonl=${short.jsonlBytes}/${long?.jsonlBytes ?? 0}B messages=${short.messageCount}/${long?.messageCount ?? 0}`);

    stack = await bootLifecycleStack({ sessiondDir: dirs.sessiondDir, projectCwd: dirs.projectCwd, hostDir: dirs.hostDir, clientDist: CLIENT_DIST });
    log(`served identity ${JSON.stringify({
      source: stack.identity.sourceCommit,
      asset: stack.identity.assetPath,
      servedJs: stack.identity.servedJsHash,
      bytes: stack.identity.bytes,
    })}`);
    chromeSlot.adopt(await launchChromeCdp());
    const sessionUrl = `${stack.origin}/?session=${encodeURIComponent(short.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;

    await runCorpus(chromeSlot, stack, provider, dirs, {
      label: "short",
      history: short,
      otherId: other.sessionId,
      sessionUrl,
      cwd: dirs.projectCwd,
    }, { includeResume: !diagnoseFirstHeld && !diagnoseNewHomeIdle });
    if (diagnoseFirstHeld) {
      log("DIAGNOSTIC-ONLY short first-held complete; skipped A→B→A/refresh/reopen/new-home/long — not a strict PASS");
      exitCode = 2;
    } else if (diagnoseNewHomeIdle) {
      log("DIAGNOSTIC-ONLY short core then new-home idle capture; skipped A→B→A/refresh/reopen/long — not a strict PASS");
      await stack.rpc.call("runtime.stop", { sessionId: short.sessionId, reason: "user" }).catch(() => {});
      for (let i = 0; i < 100; i++) {
        const list = await stack.rpc.call("runtime.listRunning", {});
        if (!list.sessions.some((s) => s.sessionId === short.sessionId)) break;
        await delay(50);
      }
      await runNewSessionFirstSend(chromeSlot.get(), stack, provider, dirs, dirs.projectCwd);
      exitCode = 2;
    } else {
      log("STRICT short held-stream + A→B→A + refresh + reopen PASS");
      await runNewSessionFirstSend(chromeSlot.get(), stack, provider, dirs, dirs.projectCwd);
      log("STRICT new-home first send PASS");
      await stack.rpc.call("runtime.stop", { sessionId: long.sessionId, reason: "user" }).catch(() => {});
      await runCorpus(chromeSlot, stack, provider, dirs, {
        label: "long-tools",
        history: long,
        otherId: other.sessionId,
        sessionUrl: `${stack.origin}/?session=${encodeURIComponent(long.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`,
        cwd: dirs.projectCwd,
      }, { includeResume: true });
      log("STRICT long/tool-rich held-stream PASS");
      log(`PASS — strict browser; diagnosticBaseline=${DIAGNOSTIC_BASELINE} served=${stack.identity.servedJsHash.slice(0, 16)} source=${stack.identity.sourceCommit.slice(0, 12)}`);
    }
  } catch (error) {
    exitCode = 1;
    log("FAIL", error?.stack ?? error);
    log("provider-report", JSON.stringify(provider.report(), null, 2));
    try {
      if (chromeSlot.get()) await logBrowserEvidence(chromeSlot.get(), provider, dirs, "fail");
    } catch {
      /* best-effort evidence */
    }
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousFactory === undefined) delete process.env.PIX_AGENT_WORKER_FACTORY;
    else process.env.PIX_AGENT_WORKER_FACTORY = previousFactory;
    provider.release();
    const chromeClosed = await chromeSlot.closeAll();
    cleanupFailures.push(...chromeClosed.failures);
    const torn = await teardownLifecycleStack(stack, dirs);
    cleanupFailures.push(...torn.failures);
    const leftoverWorkers = (torn.workerPids ?? []).filter((pid) => pidAlive(pid));
    if (leftoverWorkers.length > 0) cleanupFailures.push(`owned workers still alive: ${leftoverWorkers.join(",")}`);
    const providerClosed = await Promise.race([provider.close().then(() => true), delay(3_000).then(() => false)]);
    if (!providerClosed) cleanupFailures.push("provider.close timed out");
    if (cleanupFailures.length > 0) {
      log("CLEANUP-FAIL", JSON.stringify(cleanupFailures));
      exitCode = 1;
    }
  }
  return exitCode;
}

main().then((code) => {
  process.exit(code === 0 ? 0 : 1);
});
