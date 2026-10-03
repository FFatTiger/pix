/**
 * Real-stack side-chat acceptance test.
 *
 * Run after the repository build is ready:
 *   node tests/e2e/side-chat.mjs
 *
 * The runtime path is production sessiond -> production SDK Worker -> Hono ->
 * browser Client. Model traffic stays on the controlled loopback provider.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import {
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
} from "@fffattiger/pix-protocol";
import {
  hashPrompt,
  markExactPrompt,
  startControlledProvider,
} from "./helpers/controlled-provider.mjs";
import { launchChromeCdp, PAGE } from "./helpers/chrome-cdp.mjs";
import {
  COMMAND_TIMEOUT_MS,
  LIFECYCLE_FEATURES,
  RuntimeWsClient,
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
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STEP_TIMEOUT_MS = 20_000;
const COLD_SEND_TIMEOUT_MS = 60_000;
const SIDE_PARTIAL = "SIDE-HELD-PARTIAL";
const MAIN_PARTIAL = "MAIN-HELD-PARTIAL";
const MAIN_DONE = "MAIN-TERMINAL";
const SIDE_DONE = "SIDE-FIRST-TERMINAL";

function marker(label) {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitUntil(predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${String(lastError.message ?? lastError)}` : ""}`);
}

async function waitForProviderRequest(provider, prompt, label) {
  const hash = hashPrompt(prompt);
  return waitUntil(
    () => provider.requests.find((request) => request.promptHash === hash || request.userHashes.includes(hash)),
    `${label} provider request`,
    COLD_SEND_TIMEOUT_MS,
  );
}

async function waitForProviderGate(provider, label) {
  await waitUntil(() => provider.gated, `${label} provider gate`);
}

async function snapshotWhen(stack, sessionId, predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
  return waitUntil(async () => {
    const snapshot = await stack.rpc.call("runtime.getSnapshot", { sessionId });
    return predicate(snapshot) ? snapshot : null;
  }, label, timeoutMs);
}

async function readJson(response, label) {
  const text = await response.text();
  assert.equal(response.ok, true, `${label} failed (${response.status}): ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

async function sessionDetail(stack, sessionId) {
  return readJson(await fetch(`${stack.origin}/v1/sessions/${encodeURIComponent(sessionId)}`), "session detail");
}

async function sessionContext(stack, sessionId) {
  return readJson(await fetch(`${stack.origin}/v1/sessions/${encodeURIComponent(sessionId)}/context`), "session context");
}

async function activate(control, sessionId) {
  const id = `activate-${sessionId.slice(0, 8)}`;
  const afterIndex = control.messages.length;
  control.send({ type: "activate", id, payload: { sessionId } });
  const response = await control.waitFor(
    (message) => message.type === "response" && message.id === id,
    { label: id, timeoutMs: COLD_SEND_TIMEOUT_MS, afterIndex },
  );
  assert.equal(response.payload.ok, true, `explicit activate failed: ${JSON.stringify(response.payload)}`);
  return response.payload.result;
}

async function command(control, sessionId, input, label) {
  const commandId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `cmd-${commandId}`;
  const afterIndex = control.messages.length;
  control.send({
    type: "command",
    id,
    payload: {
      sessionId,
      epoch: control.epoch,
      command: { ...input, commandId },
    },
  });
  const response = await control.waitFor(
    (message) => message.type === "response" && message.id === id,
    { label: `command ${input.type}`, timeoutMs: COMMAND_TIMEOUT_MS, afterIndex },
  );
  assert.equal(response.payload.ok, true, `${input.type} envelope failed: ${JSON.stringify(response.payload)}`);
  assert.equal(response.payload.result.commandId, commandId, `${input.type} command correlation mismatch`);
  return response.payload.result.result;
}

async function interrupt(control, sessionId, interruptType, label) {
  const commandId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `int-${commandId}`;
  const afterIndex = control.messages.length;
  control.send({
    type: "interrupt",
    id,
    payload: { sessionId, commandId, epoch: control.epoch, interrupt: interruptType },
  });
  const response = await control.waitFor(
    (message) => message.type === "interrupt_result" && message.id === id,
    { label: `interrupt ${interruptType.type}`, timeoutMs: COMMAND_TIMEOUT_MS, afterIndex },
  );
  assert.equal(response.payload.commandId, commandId, `${interruptType.type} correlation mismatch`);
  assert.equal(response.payload.interruptType, interruptType.type);
  return response.payload.result;
}

async function setEnglishProfile(chrome, origin) {
  await chrome.navigate(origin);
  await chrome.evaluate(`localStorage.setItem("pi-locale", "en"); true`);
}

async function requireObserveFeature(chrome, label) {
  const tap = await chrome.waitFor(`(() => {
    const value = window.__pixRuntimeTap?.summary();
    return value?.acceptedObserve ? value : null;
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label}: observe-existing accepted` });
  assert.equal(tap.requestedObserve, true, `${label}: Client must request observe-existing`);
  assert.equal(tap.acceptedObserve, true, `${label}: Host must accept observe-existing`);
}

async function setMainComposer(chrome, text) {
  await chrome.waitFor(PAGE.sendButtonPresent, { timeoutMs: STEP_TIMEOUT_MS, label: "main send button" });
  assert.equal(await chrome.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(text)})`), text);
  await chrome.waitFor(`!(${PAGE.sendButtonDisabled})`, { timeoutMs: STEP_TIMEOUT_MS, label: "main send enabled" });
  assert.equal(await chrome.evaluate(`(${PAGE.clickSend})()`), true, "main send click must land");
}

async function openRightPane(chrome) {
  const open = await chrome.evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="right-pane-toggle"]');
    if (!toggle) return false;
    if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
    return true;
  })()`);
  assert.equal(open, true, "right-pane toggle must exist");
  await chrome.waitFor(`document.querySelector('.right-panel-container')?.classList.contains('right-panel-open')`, {
    timeoutMs: STEP_TIMEOUT_MS,
    label: "right pane open",
  });
}

async function closeRightPane(chrome) {
  const closed = await chrome.evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="right-pane-toggle"]');
    if (!toggle) return false;
    if (toggle.getAttribute('aria-pressed') === 'true') toggle.click();
    return true;
  })()`);
  assert.equal(closed, true, "right-pane toggle must exist");
  await chrome.waitFor(`document.querySelector('.right-panel-container')?.classList.contains('right-panel-closed')`, {
    timeoutMs: STEP_TIMEOUT_MS,
    label: "right pane closed",
  });
}

async function sideButtonState(chrome) {
  return chrome.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.right-pane-selector button'))
      .find((node) => (node.textContent ?? '').trim() === 'Side chat');
    return button ? { disabled: button.disabled, pressed: button.getAttribute('aria-pressed') } : null;
  })()`);
}

async function selectSideChat(chrome) {
  const selected = await chrome.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.right-pane-selector button'))
      .find((node) => (node.textContent ?? '').trim() === 'Side chat');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(selected, true, "enabled Side chat selector must be clickable");
  await chrome.waitFor(`Boolean(document.querySelector('[data-testid="side-chat-panel"]'))`, {
    timeoutMs: STEP_TIMEOUT_MS,
    label: "side-chat panel",
  });
}

async function openSideChat(chrome) {
  await openRightPane(chrome);
  await selectSideChat(chrome);
}

async function sendSideMessage(chrome, text) {
  const value = await chrome.evaluate(`(() => {
    const textarea = document.querySelector('.side-chat-composer textarea');
    if (!textarea || textarea.disabled) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea.value;
  })()`);
  assert.equal(value, text, "side-chat composer must hold typed text");
  await chrome.waitFor(`(() => {
    const button = document.querySelector('.side-chat-composer button[aria-label="Send to side chat"]');
    return Boolean(button && !button.disabled);
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: "side send enabled" });
  assert.equal(await chrome.evaluate(`(() => {
    const button = document.querySelector('.side-chat-composer button[aria-label="Send to side chat"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`), true, "side send click must land");
}

async function clickSideAction(chrome, ariaLabel) {
  await chrome.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="${ariaLabel}"]`)});
    return Boolean(button && !button.disabled);
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${ariaLabel} enabled` });
  const clicked = await chrome.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="${ariaLabel}"]`)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `${ariaLabel} must be clickable`);
}

async function setSideMode(chrome, label, expectedMode, stack, sessionId) {
  await chrome.waitFor(`(() => {
    const button = Array.from(document.querySelectorAll('.side-chat-modes button'))
      .find((node) => (node.textContent ?? '').trim() === ${JSON.stringify(label)});
    return Boolean(button && !button.disabled);
  })()`, { timeoutMs: STEP_TIMEOUT_MS, label: `${label} mode enabled` });
  const clicked = await chrome.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.side-chat-modes button'))
      .find((node) => (node.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `${label} mode must be clickable`);
  await snapshotWhen(
    stack,
    sessionId,
    (snapshot) => snapshot.state.sideChat?.mode === expectedMode,
    `side mode ${expectedMode}`,
  );
}

function assertExactlyOneRequest(provider, prompt, label) {
  markExactPrompt(provider, prompt);
  const hash = hashPrompt(prompt);
  const matches = provider.requests.filter((request) => request.promptHash === hash);
  assert.equal(matches.length, 1, `${label}: originating prompt hash must reach provider once: ${JSON.stringify(provider.report())}`);
  assert.equal(matches[0].exactPrompt, true, `${label}: final user prompt hash must match exactly`);
  return matches[0];
}

function assertRequestContainsPrompt(record, prompt, label) {
  assert.ok(record.userHashes.includes(hashPrompt(prompt)), `${label}: request context must contain exact prompt hash`);
}

function assertNoSideTextInParent(context, texts, label) {
  const serialized = JSON.stringify(context.context.entries);
  for (const text of texts) assert.equal(serialized.includes(text), false, `${label}: parent context contains side-chat text`);
}

async function assertMainOwnership(chrome, label) {
  const state = await chrome.evaluate(`(() => {
    const input = document.querySelector('.chat-input-textarea');
    const transcript = document.querySelector('.transcript-scroll');
    const panel = document.querySelector('[data-testid="side-chat-panel"]');
    return {
      mainInput: Boolean(input),
      transcript: Boolean(transcript),
      inputInsideSide: Boolean(input && panel?.contains(input)),
      transcriptInsideSide: Boolean(transcript && panel?.contains(transcript)),
      sideOwnsScroll: Boolean(panel?.querySelector('[data-testid="side-chat-scroll"]')),
    };
  })()`);
  assert.deepEqual(state, {
    mainInput: true,
    transcript: true,
    inputInsideSide: false,
    transcriptInsideSide: false,
    sideOwnsScroll: true,
  }, `${label}: main composer/transcript ownership changed`);
}

async function assertResponsivePanel(chrome, expectedMaxWidth, label) {
  const geometry = await chrome.evaluate(`(() => {
    const selectors = [
      '[data-testid="side-chat-panel"]',
      '.side-chat-context',
      '.side-chat-toolbar',
      '.side-chat-composer',
      '.side-chat-icon-button',
    ];
    const rects = selectors.map((selector) => {
      const node = document.querySelector(selector);
      if (!node) return { selector, missing: true };
      const rect = node.getBoundingClientRect();
      return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      rects,
    };
  })()`);
  assert.ok(geometry.innerWidth <= expectedMaxWidth, `${label}: viewport is ${geometry.innerWidth}px, expected <= ${expectedMaxWidth}px`);
  assert.ok(geometry.scrollWidth <= geometry.innerWidth, `${label}: horizontal overflow ${geometry.scrollWidth} > ${geometry.innerWidth}`);
  for (const rect of geometry.rects) {
    assert.equal(rect.missing, undefined, `${label}: missing ${rect.selector}`);
    assert.ok(rect.left >= -1 && rect.right <= geometry.innerWidth + 1, `${label}: ${rect.selector} outside viewport: ${JSON.stringify(rect)}`);
    assert.ok(rect.top >= -1 && rect.bottom <= geometry.innerHeight + 1, `${label}: ${rect.selector} outside viewport: ${JSON.stringify(rect)}`);
  }
  return geometry;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closeChrome(chrome) {
  if (!chrome) return [];
  const failures = [];
  try {
    await Promise.race([
      chrome.close(),
      delay(8_000).then(() => { throw new Error(`chrome.close timeout pid=${chrome.pid}`); }),
    ]);
  } catch (error) {
    failures.push(String(error.message ?? error));
  }
  if (chrome.pid && pidAlive(chrome.pid)) {
    try { process.kill(chrome.pid, "SIGKILL"); } catch { /* already exited */ }
  }
  if (chrome.pid && pidAlive(chrome.pid)) failures.push(`owned Chrome pid still alive: ${chrome.pid}`);
  return failures;
}

async function main() {
  if (!existsSync(CLIENT_DIST)) throw new Error(`client dist missing: ${CLIENT_DIST}`);
  if (!existsSync(CHROME_PATH)) throw new Error(`Chrome missing: ${CHROME_PATH}`);

  const suiteDeadline = Date.now() + SUITE_DEADLINE_MS;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFactory = process.env.PIX_AGENT_WORKER_FACTORY;
  delete process.env.PIX_AGENT_WORKER_FACTORY;

  const dirs = await makeIsolatedDirs("px-side-chat");
  const provider = await startControlledProvider();
  const stub = await writeStubProviderConfig(dirs.agentDir, provider.port);
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

  let stack;
  let desktop;
  let mobile;
  let control;
  let exitCode = 0;
  const cleanupFailures = [];
  const sideTexts = [];

  try {
    const parent = seedSessionHistoryForTests({
      cwd: dirs.projectCwd,
      turns: 3,
      model: { provider: stub.providerId, modelId: stub.modelId },
      label: "side-chat-parent",
    });
    const other = seedSessionHistoryForTests({
      cwd: dirs.projectCwd,
      turns: 2,
      model: { provider: stub.providerId, modelId: stub.modelId },
      label: "side-chat-other",
    });
    stack = await bootLifecycleStack({
      sessiondDir: dirs.sessiondDir,
      projectCwd: dirs.projectCwd,
      hostDir: dirs.hostDir,
      clientDist: CLIENT_DIST,
    });
    assert.ok(Date.now() < suiteDeadline, "suite deadline exceeded after boot");

    const parentUrl = `${stack.origin}/?session=${encodeURIComponent(parent.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;
    const otherUrl = `${stack.origin}/?session=${encodeURIComponent(other.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`;
    const detail = await sessionDetail(stack, parent.sessionId);
    const sessionFile = detail.session.sessionFile;
    assert.ok(typeof sessionFile === "string" && sessionFile.length > 0, "parent session file must be discoverable");

    desktop = await launchChromeCdp();
    await setEnglishProfile(desktop, stack.origin);
    await desktop.navigate(parentUrl);
    await desktop.waitFor(`document.querySelectorAll('.chat-user-message').length >= 1`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "seeded parent history",
    });
    await requireObserveFeature(desktop, "history boot");
    assert.deepEqual((await stack.rpc.call("runtime.listRunning", {})).sessions, [], "opening history must create zero workers");

    await openRightPane(desktop);
    assert.deepEqual(await sideButtonState(desktop), { disabled: true, pressed: "false" }, "side chat must be unavailable before exact live capability");
    assert.equal(await desktop.evaluate(`Boolean(document.querySelector('[data-testid="side-chat-panel"]'))`), false);
    await closeRightPane(desktop);

    control = new RuntimeWsClient(stack.wsUrl);
    await control.connect();
    await control.handshake(LIFECYCLE_FEATURES);
    control.requireAcceptedFeatures([RUNTIME_EXPLICIT_ACTIVATE_FEATURE, RUNTIME_OBSERVE_EXISTING_FEATURE]);
    const activated = await activate(control, parent.sessionId);
    const attached = await control.attach(parent.sessionId, undefined, { existingOnly: true });
    assert.equal(attached.type, "snapshot", "explicitly activated parent must attach existing-only");
    assert.equal(attached.payload.epoch, activated.epoch, "activation/attach epoch mismatch");
    assert.equal(attached.payload.snapshot.capabilities.capabilities.includes("runtime.side_chat"), true, "live capability must advertise runtime.side_chat");
    const activeAfterAttach = await stack.rpc.call("runtime.listRunning", {});
    assert.equal(activeAfterAttach.sessions.length, 1, "activation must create exactly one parent Worker");
    assert.equal(activeAfterAttach.sessions[0].sessionId, parent.sessionId);

    const mainPrompt = `main-${marker("held")}`;
    const sidePrompt1 = `side-${marker("parallel")}`;
    const sideReply1 = `${SIDE_DONE}-${marker("reply")}`;
    sideTexts.push(sidePrompt1, sideReply1);
    provider.plan(
      { chunks: [MAIN_PARTIAL, MAIN_DONE], gateAfterChunks: 1 },
      { matchPromptHash: hashPrompt(sidePrompt1), chunks: [sideReply1] },
    );

    await setMainComposer(desktop, mainPrompt);
    const mainRecord = await waitForProviderRequest(provider, mainPrompt, "main held");
    await waitForProviderGate(provider, "main held");
    await desktop.waitFor(PAGE.inputStreaming, { timeoutMs: COLD_SEND_TIMEOUT_MS, label: "main running overlay" });
    await requireObserveFeature(desktop, "main live");
    await openRightPane(desktop);
    assert.deepEqual(await sideButtonState(desktop), { disabled: false, pressed: "false" }, "side chat must unlock only for exact live capability");
    await selectSideChat(desktop);
    await snapshotWhen(stack, parent.sessionId, (snapshot) => snapshot.state.sideChat?.status === "idle", "side-chat start");
    const started = await stack.rpc.call("runtime.getSnapshot", { sessionId: parent.sessionId });
    const conversation1 = started.state.sideChat.conversationId;
    assert.ok(conversation1, "side_chat_start must create a conversationId");
    await assertMainOwnership(desktop, "side start");

    await sendSideMessage(desktop, sidePrompt1);
    const sideRecord1 = await waitForProviderRequest(provider, sidePrompt1, "parallel side");
    await desktop.waitFor(`document.querySelector('[data-testid="side-chat-panel"]')?.textContent.includes(${JSON.stringify(sideReply1)})`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "parallel side terminal in browser",
    });
    const parallelSnapshot = await snapshotWhen(
      stack,
      parent.sessionId,
      (snapshot) => snapshot.state.sideChat?.status === "idle" && snapshot.state.sideChat.messages.some((message) => message.text.includes(sideReply1)),
      "parallel side terminal snapshot",
    );
    assert.equal(parallelSnapshot.state.isPromptRunning, true, "main turn must remain held while side turn completes");
    assert.equal(provider.gated, true, "ungated side request must not overwrite the main provider gate");
    assert.ok(mainRecord.userHashes.includes(hashPrompt(mainPrompt)), "main provider context must contain the exact prompt hash");
    assert.equal(sideRecord1.promptHash, hashPrompt(sidePrompt1));
    assert.ok(sideRecord1.messageCount >= mainRecord.messageCount, `side context must include captured parent context: main=${mainRecord.messageCount} side=${sideRecord1.messageCount}`);
    assert.equal((await stack.rpc.call("runtime.listRunning", {})).sessions.length, 1, "side engine must not create a Pix child session");
    assertRequestContainsPrompt(mainRecord, mainPrompt, "held main");
    assertExactlyOneRequest(provider, sidePrompt1, "parallel side");
    assertNoSideTextInParent(await sessionContext(stack, parent.sessionId), sideTexts, "parallel side");
    assert.equal(await desktop.evaluate(`Array.from(document.querySelectorAll('.chat-user-message,.chat-assistant-message')).some((node) => node.textContent.includes(${JSON.stringify(sidePrompt1)}) || node.textContent.includes(${JSON.stringify(sideReply1)}))`), false, "main transcript must exclude side chat");

    await setSideMode(desktop, "Edit", "edit", stack, parent.sessionId);
    await setSideMode(desktop, "Discussion", "read_only", stack, parent.sessionId);
    await desktop.screenshot(join(tmpdir(), "pix-side-chat-desktop.png"));

    provider.release();
    await desktop.waitFor(`(() => {
      const nodes = document.querySelectorAll('.chat-assistant-message');
      return nodes.length > 0 && nodes[nodes.length - 1].textContent.includes(${JSON.stringify(MAIN_DONE)});
    })()`, { timeoutMs: STEP_TIMEOUT_MS, label: "main terminal in browser" });
    await snapshotWhen(stack, parent.sessionId, (snapshot) => snapshot.state.isPromptRunning === false, "main idle after release");
    assertRequestContainsPrompt(mainRecord, mainPrompt, "released main");

    const sidePrompt2 = `side-${marker("held")}`;
    const sideReply2 = `${SIDE_PARTIAL}-${marker("reply")}`;
    const mainPrompt2 = `main-${marker("abort-isolation")}`;
    sideTexts.push(sidePrompt2, sideReply2);
    provider.plan(
      { matchPromptHash: hashPrompt(sidePrompt2), chunks: [sideReply2, "SIDE-SHOULD-NOT-COMMIT"], gateAfterChunks: 1 },
      {
        chunks: Array.from({ length: 300 }, (_, index) => `MAIN2-${index}-`),
        chunkDelayMs: 100,
      },
    );
    await sendSideMessage(desktop, sidePrompt2);
    await waitForProviderRequest(provider, sidePrompt2, "held side");
    await waitForProviderGate(provider, "held side");
    await desktop.waitFor(`document.querySelector('.side-chat-message.is-streaming')?.textContent.includes(${JSON.stringify(sideReply2)})`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "side partial stream",
    });
    const heldSide = await snapshotWhen(
      stack,
      parent.sessionId,
      (snapshot) => snapshot.state.sideChat?.status === "running" && snapshot.state.sideChat.stream.text.includes(sideReply2),
      "held side authoritative snapshot",
    );
    assert.equal(heldSide.state.isPromptRunning, false, "side activity must not become parent prompt activity");
    const heldRunId = heldSide.state.sideChat.runId;

    // Keep a real parent turn active while the side provider owns the single
    // deterministic gate. The long ungated chunk plan is aborted by protocol
    // identity below; no elapsed-time assertion depends on its duration.
    await setMainComposer(desktop, mainPrompt2);
    const mainRecord2 = await waitForProviderRequest(provider, mainPrompt2, "abort-isolation main");
    await snapshotWhen(
      stack,
      parent.sessionId,
      (snapshot) => snapshot.state.isPromptRunning === true && snapshot.state.sideChat?.status === "running",
      "simultaneous parent and side activity",
    );
    assert.equal(provider.gated, true, "ungated parent stream must not overwrite the held side gate");

    await closeRightPane(desktop);
    assert.equal(await desktop.evaluate(`Boolean(document.querySelector('[data-testid="side-chat-panel"]'))`), false, "closing pane must unmount its surface");
    await openSideChat(desktop);
    await desktop.waitFor(`document.querySelector('[data-testid="side-chat-panel"]')?.textContent.includes(${JSON.stringify(sideReply2)})`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "side partial after pane reopen",
    });
    assert.equal((await stack.rpc.call("runtime.getSnapshot", { sessionId: parent.sessionId })).state.sideChat.conversationId, conversation1, "pane reopen must preserve conversation identity");

    await desktop.reload();
    await requireObserveFeature(desktop, "reload during side stream");
    const afterReload = await stack.rpc.call("runtime.getSnapshot", { sessionId: parent.sessionId });
    assert.equal(afterReload.state.sideChat.conversationId, conversation1, "reload must preserve side conversation in the same Worker");
    assert.equal(afterReload.state.sideChat.runId, heldRunId, "reload must preserve active side run");
    assert.ok(afterReload.state.sideChat.stream.text.includes(sideReply2), "reload snapshot must preserve partial side text");
    await openSideChat(desktop);
    await desktop.waitFor(`document.querySelector('[data-testid="side-chat-panel"]')?.textContent.includes(${JSON.stringify(sideReply2)})`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "side partial after reload",
    });
    await assertMainOwnership(desktop, "reload");

    mobile = await launchChromeCdp({ extraArgs: ["--window-size=390,844", "--force-device-scale-factor=1"] });
    await mobile.setViewport(390, 844, 1, true);
    await setEnglishProfile(mobile, stack.origin);
    await mobile.navigate(parentUrl);
    await requireObserveFeature(mobile, "mobile side stream");
    await openSideChat(mobile);
    await mobile.waitFor(`document.querySelector('[data-testid="side-chat-panel"]')?.textContent.includes(${JSON.stringify(sideReply2)})`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "mobile side partial",
    });
    const mobileGeometry = await assertResponsivePanel(mobile, 390, "mobile");
    log("mobile geometry", JSON.stringify({ width: mobileGeometry.innerWidth, height: mobileGeometry.innerHeight, scrollWidth: mobileGeometry.scrollWidth }));
    await mobile.waitFor(`document.documentElement.classList.contains('pi-booted') && getComputedStyle(document.body, '::before').content === 'none'`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "mobile startup splash dismissed",
    });
    await mobile.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, { awaitPromise: true });
    await mobile.screenshot(join(tmpdir(), "pix-side-chat-mobile.png"));
    cleanupFailures.push(...await closeChrome(mobile));
    mobile = undefined;

    await desktop.navigate(otherUrl);
    await desktop.waitFor(`document.querySelectorAll('.chat-user-message').length >= 1`, { timeoutMs: STEP_TIMEOUT_MS, label: "other parent history" });
    await requireObserveFeature(desktop, "other parent history");
    assert.equal(await desktop.evaluate(`Boolean(document.querySelector('[data-testid="side-chat-panel"]'))`), false, "other parent must not expose hidden side panel");
    const runningOnOther = await stack.rpc.call("runtime.listRunning", {});
    assert.equal(runningOnOther.sessions.length, 1, "other history must not activate another Worker");
    assert.equal(runningOnOther.sessions[0].sessionId, parent.sessionId, "only original parent Worker may remain live");

    await desktop.navigate(parentUrl);
    await requireObserveFeature(desktop, "return to held side parent");
    await openSideChat(desktop);
    await desktop.waitFor(`document.querySelector('[data-testid="side-chat-panel"]')?.textContent.includes(${JSON.stringify(sideReply2)})`, {
      timeoutMs: STEP_TIMEOUT_MS,
      label: "held side after other-parent round trip",
    });

    const parentAbort = await interrupt(control, parent.sessionId, { type: "abort" }, "parent-abort-during-side");
    assert.equal(parentAbort.ok, true, `active parent abort failed: ${JSON.stringify(parentAbort)}`);
    assert.equal(parentAbort.type, "abort", "parent abort must use the parent interrupt identity");
    const afterParentAbort = await snapshotWhen(
      stack,
      parent.sessionId,
      (snapshot) => snapshot.state.isPromptRunning === false && snapshot.state.sideChat?.status === "running",
      "parent abort terminal with side still held",
      COMMAND_TIMEOUT_MS,
    );
    assert.equal(afterParentAbort.state.sideChat.runId, heldRunId, "parent abort must not replace the side run");
    assertRequestContainsPrompt(mainRecord2, mainPrompt2, "aborted isolation main");
    const bytesBeforeSideControl = await readFile(sessionFile);

    await clickSideAction(desktop, "Stop side chat");
    const abortedSide = await snapshotWhen(
      stack,
      parent.sessionId,
      (snapshot) => snapshot.state.sideChat?.status === "idle",
      "exact side abort terminal",
      COMMAND_TIMEOUT_MS,
    );
    assert.equal(abortedSide.state.isPromptRunning, false, "side abort must not start or alter parent activity");
    provider.release();
    assertExactlyOneRequest(provider, sidePrompt2, "aborted held side");

    await clickSideAction(desktop, "Refork from current conversation");
    const reforked = await snapshotWhen(
      stack,
      parent.sessionId,
      (snapshot) => snapshot.state.sideChat !== null
        && snapshot.state.sideChat !== undefined
        && snapshot.state.sideChat.conversationId !== conversation1,
      "refork conversation identity",
    );
    const conversation2 = reforked.state.sideChat.conversationId;
    assert.equal(reforked.state.sideChat.messages.length, 0, "refork must clear old side messages");
    assert.equal(reforked.state.sideChat.stream.text, "", "refork must clear old side stream");
    assert.equal(await desktop.evaluate(`document.querySelector('[data-testid="side-chat-panel"]')?.textContent.includes(${JSON.stringify(sideReply1)})`), false, "refork UI must clear old output");
    const runningAfterRefork = await stack.rpc.call("runtime.listRunning", {});
    assert.equal(runningAfterRefork.sessions.length, 1, "refork must reuse the same parent Worker");
    assert.equal(runningAfterRefork.sessions[0].sessionId, parent.sessionId);

    const staleSend = await command(control, parent.sessionId, {
      type: "side_chat_send",
      conversationId: conversation1,
      message: "stale conversation probe",
    }, "stale-side-send");
    assert.equal(staleSend.ok, false, "prior conversation must reject side_chat_send");
    assert.equal(staleSend.error.code, "not_found", "prior conversation rejection must be not_found");

    const staleOverlap = await command(control, parent.sessionId, {
      type: "side_chat_overlap_response",
      conversationId: conversation2,
      requestId: "missing-overlap-request",
      proceed: false,
    }, "stale-side-overlap");
    assert.equal(staleOverlap.ok, false, "unknown overlap response must fail");
    assert.equal(staleOverlap.error.code, "not_found", "unknown overlap response must be not_found");
    await setSideMode(desktop, "Edit", "edit", stack, parent.sessionId);
    await setSideMode(desktop, "Discussion", "read_only", stack, parent.sessionId);

    const bytesAfterSide = await readFile(sessionFile);
    assert.deepEqual(bytesAfterSide, bytesBeforeSideControl, "side-chat abort/reset/mode commands must not append parent JSONL");
    const finalContext = await sessionContext(stack, parent.sessionId);
    assertNoSideTextInParent(finalContext, sideTexts, "final parent history");
    assert.equal(JSON.stringify(finalContext.context.entries).includes(mainPrompt), true, "completed main prompt must remain in parent history");
    assertExactlyOneRequest(provider, sidePrompt1, "final parallel side");
    assertExactlyOneRequest(provider, sidePrompt2, "final held side");
    assert.ok(Date.now() < suiteDeadline, "suite deadline exceeded");

    log("PASS side chat real-stack acceptance", JSON.stringify({
      workerSession: parent.sessionId.slice(0, 8),
      conversationChanged: conversation1 !== conversation2,
      providerRequests: provider.requests.length,
      requestContextCounts: provider.requests.map((request) => request.messageCount),
      servedJs: stack.identity.servedJsHash.slice(0, 16),
    }));
  } catch (error) {
    exitCode = 1;
    log("FAIL side chat", error?.stack ?? error);
    log("provider report", JSON.stringify(provider.report(), null, 2));
    const artifactDir = process.env.PIX_E2E_ARTIFACT_DIR ?? tmpdir();
    if (desktop) {
      try { await desktop.screenshot(join(artifactDir, `pix-side-chat-fail-${process.pid}.png`)); } catch { /* best-effort evidence */ }
    }
  } finally {
    provider.release();
    control?.close();
    cleanupFailures.push(...await closeChrome(mobile));
    cleanupFailures.push(...await closeChrome(desktop));
    const torn = await teardownLifecycleStack(stack, dirs);
    cleanupFailures.push(...torn.failures);
    const providerClosed = await Promise.race([
      provider.close().then(() => true),
      delay(3_000).then(() => false),
    ]).catch(() => false);
    if (!providerClosed) cleanupFailures.push("provider.close timed out");
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousFactory === undefined) delete process.env.PIX_AGENT_WORKER_FACTORY;
    else process.env.PIX_AGENT_WORKER_FACTORY = previousFactory;
    if (cleanupFailures.length > 0) {
      log("CLEANUP-FAIL", JSON.stringify(cleanupFailures));
      exitCode = 1;
    }
  }
  return exitCode;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    log("FAIL before harness ownership", error?.stack ?? error);
    process.exitCode = 1;
  },
);
