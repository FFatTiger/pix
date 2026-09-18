/**
 * Minimal Chrome CDP driver (LC-00 layer 3 test helper).
 *
 * Drives the REAL installed Chrome (no browser framework dependency) over the
 * DevTools protocol with Node's ws: launch headless with an isolated temp
 * profile, open one target, evaluate JS, poll predicates, navigate, reload.
 * The harness lives in the repo (never an ad-hoc /tmp script).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

export const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LAUNCH_TIMEOUT_MS = 15_000;
/** Default per-command CDP budget: a lost command must settle, never hang. */
export const CDP_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Bounded CDP command channel over ONE browser WebSocket.
 *
 * Fail-closed transport contract (every command settles exactly once):
 *  - each command rejects within `commandTimeoutMs` and its pending entry is
 *    removed, so a LATE response for a timed-out id is dropped (at-most-once);
 *  - `close` / `error` on the socket reject every still-pending command;
 *  - responses for unknown ids (already settled) are ignored.
 *
 * Exported for deterministic fake-CDP regression tests
 * (tests/e2e/helpers/chrome-cdp.test.mjs); `launchChromeCdp` is its only
 * production consumer.
 *
 * @param {import("ws").WebSocket} ws
 * @param {{ commandTimeoutMs?: number }} [options]
 * @returns {{ send(method: string, params?: object, sessionId?: string): Promise<any>, readonly pendingCount: number }}
 */
export function createCdpChannel(ws, options = {}) {
  const commandTimeoutMs = options.commandTimeoutMs ?? CDP_COMMAND_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const failAll = (cause) => {
    closed = true;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(cause);
    }
  };
  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return; // already settled (timed out / socket failed): drop
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`CDP ${entry.method}: ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
  });
  ws.once("close", () => failAll(new Error("CDP websocket closed with commands in flight")));
  ws.once("error", (error) => failAll(error ?? new Error("CDP websocket error")));
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) closed = true;
  return {
    send(method, params = {}, sessionId) {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`CDP ${method} refused: websocket is not open`));
      }
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          // Remove FIRST so the eventual late response is provably dropped.
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
        pending.set(id, { resolve: resolvePromise, reject, method, timer });
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

/**
 * Close ONE target and PROVE it closed before reporting success.
 *
 * Contract:
 *  - already absent from `Target.getTargets` → idempotent success (nothing sent);
 *  - `Target.closeTarget` error is acceptable ONLY when the target is
 *    independently provably absent afterwards; otherwise it rethrows;
 *  - after an acknowledged close, the target must disappear from
 *    `Target.getTargets` within `confirmTimeoutMs`, else it throws.
 *
 * `send` is injected so fake-CDP tests can drive every branch deterministically.
 *
 * @param {(method: string, params?: object) => Promise<any>} send
 * @param {string} targetId
 * @param {{ confirmTimeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ closed?: true, alreadyClosed?: true }>}
 */
export async function closeCdpTarget(send, targetId, options = {}) {
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const listTargetIds = async () => {
    const result = await send("Target.getTargets");
    return new Set((Array.isArray(result?.targetInfos) ? result.targetInfos : []).map((info) => info?.targetId));
  };
  let listed;
  try {
    listed = await listTargetIds();
  } catch {
    listed = null; // unknown → assume still open (conservative)
  }
  if (listed && !listed.has(targetId)) return { alreadyClosed: true };

  try {
    await send("Target.closeTarget", { targetId });
  } catch (error) {
    let absent = false;
    try {
      absent = !(await listTargetIds()).has(targetId);
    } catch {
      absent = false;
    }
    if (!absent) {
      throw new Error(`Target.closeTarget failed for ${targetId}: ${String(error?.message ?? error)}`);
    }
    return { closed: true };
  }

  const deadline = Date.now() + confirmTimeoutMs;
  for (;;) {
    let ids = null;
    try {
      ids = await listTargetIds();
    } catch {
      /* retry inside the bounded window */
    }
    if (ids && !ids.has(targetId)) return { closed: true };
    if (Date.now() > deadline) {
      throw new Error(`target ${targetId} still listed ${confirmTimeoutMs}ms after Target.closeTarget acknowledged`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }
}

async function freePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

/**
 * Page-scoped client for ONE target: evaluate / waitFor / navigate / reload /
 * screenshot, plus a `close()` that closes ONLY this target (never the
 * browser). Returned by {@link launchChromeCdp}'s `openTab`.
 *
 * @typedef {{ evaluate(expression: string, options?: { awaitPromise?: boolean }): Promise<unknown>,
 *             waitFor(expression: string, options?: { timeoutMs?: number, pollMs?: number, label?: string }): Promise<unknown>,
 *             navigate(url: string): Promise<void>,
 *             reload(): Promise<void>,
 *             screenshot(path: string): Promise<void>,
 *             close(): Promise<void>, readonly targetId: string }} ChromeCdpPage
 */

/**
 * Browser owner client: the initial target's page API plus the browser
 * lifecycle (`close()` closes Chrome and removes the temp profile) and
 * `openTab()` for additional targets in the SAME isolated profile.
 *
 * @typedef {ChromeCdpPage & {
 *   readonly pid: number,
 *   openTab(url?: string): Promise<ChromeCdpPage>,
 *   tabIds(): string[],
 * }} ChromeCdpClient
 */

/**
 * @param {{ chromePath?: string, extraArgs?: string[] }} [options]
 * @returns {Promise<ChromeCdpClient>}
 */
export async function launchChromeCdp(options = {}) {
  const chromePath = options.chromePath ?? CHROME_PATH;
  const port = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "pix-e2e-chrome-profile-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--window-size=1440,900",
    "about:blank",
    ...(options.extraArgs ?? []),
  ];
  const child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "ignore"] });

  // Wait for the DevTools HTTP endpoint.
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let version;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      await rm(userDataDir, { recursive: true, force: true });
      throw new Error(`Chrome DevTools endpoint did not come up on port ${port}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const browserWsUrl = version.webSocketDebuggerUrl;
  assert.ok(browserWsUrl, "DevTools /json/version must expose webSocketDebuggerUrl");

  const ws = new WebSocket(browserWsUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP ws connect timeout")), LAUNCH_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const channel = createCdpChannel(ws);
  const send = channel.send;

  // Page-scoped client factory: one CDP session per target, with the SAME
  // runtime tap / auto-title-off bootstrap the initial target receives.
  const openTabs = new Set();

  function makePageClient(targetId, targetSession) {
    return {
      targetId,
      async evaluate(expression, evaluateOptions = {}) {
        const result = await send(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
            awaitPromise: evaluateOptions.awaitPromise ?? false,
          },
          targetSession,
        );
        if (result.exceptionDetails) {
          throw new Error(`page evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`);
        }
        return result.result?.value;
      },
      async waitFor(expression, waitOptions = {}) {
        const timeoutMs = waitOptions.timeoutMs ?? 15_000;
        const pollMs = waitOptions.pollMs ?? 100;
        const label = waitOptions.label ?? expression;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          try {
            const value = await this.evaluate(`(function(){ try { return (${expression}); } catch (error) { return { __error: String(error) }; } })()`);
            if (value && typeof value === "object" && value.__error) {
              throw new Error(`waitFor predicate threw (${label}): ${value.__error}`);
            }
            if (value) return value;
          } catch (error) {
            const text = String(error?.message ?? error);
            if (!text.includes("navigated or closed") && !text.includes("-32000")) throw error;
          }
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
          await new Promise((r) => setTimeout(r, pollMs));
        }
      },
      async navigate(url) {
        await send("Page.navigate", { url }, targetSession);
        await this.waitFor("document.readyState === 'complete' || document.readyState === 'interactive'", { timeoutMs: 20_000, label: `navigate ${url}` });
      },
      async reload() {
        await send("Page.reload", { ignoreCache: true }, targetSession);
        await this.waitFor("document.readyState === 'complete' || document.readyState === 'interactive'", { timeoutMs: 20_000, label: "reload" });
      },
      async screenshot(path) {
        const result = await send("Page.captureScreenshot", { format: "png" }, targetSession);
        await writeFile(path, Buffer.from(result.data, "base64"));
      },
      /** Close ONLY this target, PROVEN closed (see closeCdpTarget). Throws when
   *  closure cannot be established, so a still-open tab can never be reported
   *  as closed. The browser-level owner `close()` stays a separate, best-effort
   *  teardown path and can never mask this assertion. */
      async close() {
        const outcome = await closeCdpTarget(send, targetId);
        openTabs.delete(targetId);
        return outcome;
      },
    };
  }

  async function createPageTarget(url = "about:blank") {
    const created = await send("Target.createTarget", { url });
    const targetId = created.targetId;
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const targetSession = attached.sessionId;
    await send("Network.enable", {}, targetSession);
    await send("Runtime.enable", {}, targetSession);
    await send("Page.enable", {}, targetSession);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: installRuntimeTapSource() }, targetSession);
    // Isolated profile default: disable Client auto-title so a completed first
    // turn does not mint a second model request that is not the user's send.
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('pi-title-auto', 'off'); } catch (error) {}" }, targetSession);
    return makePageClient(targetId, targetSession);
  }

  const initial = await createPageTarget("about:blank");
  const client = {
    ...initial,
    pid: child.pid,
    /** Additional target in the SAME isolated profile (own CDP session + tap). */
    async openTab(url = "about:blank") {
      const tab = await createPageTarget(url);
      openTabs.add(tab.targetId);
      return tab;
    },
    tabIds() {
      return [initial.targetId, ...openTabs];
    },
    /** Browser-level close (unchanged single-target contract). */
    async close() {
      try {
        await Promise.race([
          send("Browser.close"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Browser.close timeout")), 5_000)),
        ]);
      } catch {
        /* best-effort */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await new Promise((resolveExit) => {
        const timer = setTimeout(resolveExit, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await rm(userDataDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt === 7) break;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    },
  };
  return client;
}

/**
 * Page-side helpers injected as source (kept tiny; the page owns its DOM).
 * React-controlled inputs need the native value setter before the input event.
 */
export const PAGE = {
  setComposerText: `(function setComposerText(text) {
    const textarea = document.querySelector(".chat-input-textarea");
    if (!textarea) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return textarea.value;
  })`,
  composerText: `(() => document.querySelector(".chat-input-textarea")?.value ?? null)`,
  sendButtonPresent: `Boolean(document.querySelector("button.chat-input-send"))`,
  sendButtonDisabled: `Boolean(document.querySelector("button.chat-input-send")?.disabled)`,
  clickSend: `(function clickSend() {
    const button = document.querySelector("button.chat-input-send");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })`,
  userBubbleCount: `document.querySelectorAll(".chat-user-message").length`,
  lastUserBubbleText: `(() => { const nodes = document.querySelectorAll(".chat-user-message"); return nodes.length ? nodes[nodes.length - 1].textContent : null; })()`,
  assistantMessageCount: `document.querySelectorAll(".chat-assistant-message").length`,
  lastAssistantText: `(() => { const nodes = document.querySelectorAll(".chat-assistant-message"); return nodes.length ? nodes[nodes.length - 1].textContent : null; })()`,
  assistantStreaming: `Boolean(document.querySelector(".chat-assistant-message.is-streaming") || document.querySelector(".markdown-body.is-streaming"))`,
  inputStreaming: `Boolean(document.querySelector(".chat-input-streaming-overlay"))`,
  runningDot: `Boolean(document.querySelector(".workspace-tab-running-dot"))`,
  stopButtonPresent: `Boolean(document.querySelector("button[aria-label]")) && Array.from(document.querySelectorAll("button[aria-label]")).some((button) => /stop/i.test(button.getAttribute("aria-label") ?? ""))`,
  /** Model selector (composer toolbar): the DISPLAYED model label — the value a
   *  send must capture into submit_turn.activationOverrides. Icon wrappers can
   *  render text-less spans, so the label is the joined non-empty span text. */
  modelSelectorName: `(() => {
    const button = document.querySelector(".chat-input-toolbar-model button");
    if (!button) return null;
    const label = Array.from(button.querySelectorAll("span"))
      .map((span) => (span.textContent ?? "").trim())
      .filter((text) => text.length > 0)
      .join(" ").trim();
    const fallback = (button.textContent ?? "").trim();
    const name = label.length > 0 ? label : fallback;
    return name.length > 0 ? name : null;
  })()`,
  /** Open the model dropdown (no selection). */
  clickModelSelector: `(function clickModelSelector() {
    const button = document.querySelector(".chat-input-toolbar-model button");
    if (!button) return false;
    button.click();
    return true;
  })`,
  /** Click the model row whose label contains `needle` (display name OR model
   *  id) in the OPEN dropdown. False while the filtered row has not rendered, so
   *  it can be used directly as a bounded waitFor predicate. */
  /** Click the first model row whose label matches ANY of `needles` (catalog
   *  display name and/or model id). False while the filtered row has not
   *  rendered, so it can be used directly as a bounded waitFor predicate. */
  clickModelRowByLabels: `(function clickModelRowByLabels(needles) {
    function labelOf(element) {
      const joined = Array.from(element.querySelectorAll("span"))
        .map((span) => (span.textContent ?? "").trim())
        .filter((text) => text.length > 0)
        .join(" ").trim();
      return joined.length > 0 ? joined : (element.textContent ?? "").trim();
    }
    const panel = document.querySelector(".chat-input-model-dropdown");
    if (!panel) return false;
    const rows = Array.from(panel.querySelectorAll(".model-row button"));
    const match = rows.find((row) => needles.some((needle) => labelOf(row).includes(needle)));
    if (!match) return false;
    match.click();
    return true;
  })`,
  /** Structural snapshot of the OPEN model dropdown: row count, row label
   *  texts (catalog names/ids only) and the current search value. */
  modelDropdownRows: `(() => {
    const panel = document.querySelector(".chat-input-model-dropdown");
    if (!panel) return null;
    const labelOf = (element) => Array.from(element.querySelectorAll("span"))
      .map((span) => (span.textContent ?? "").trim())
      .filter((text) => text.length > 0)
      .join(" ").trim() || (element.textContent ?? "").trim();
    const rows = Array.from(panel.querySelectorAll(".model-row button"));
    return {
      rowCount: rows.length,
      rowTexts: rows.map((row) => labelOf(row).slice(0, 60)),
      searchValue: (panel.querySelector("input")?.value ?? "").slice(0, 60),
      groupHeaders: Array.from(panel.querySelectorAll(".chat-input-menu-group-header")).map((header) => (header.textContent ?? "").trim()),
    };
  })()`,
  sessionRows: `Array.from(document.querySelectorAll("[data-session-row=true]")).map((row) => row.textContent)`,
  selectedSessionRow: `(() => { const row = document.querySelector("[data-session-row=true][data-active=true]"); return row ? { text: row.textContent, running: row.getAttribute("data-running"), workspace: row.getAttribute("data-workspace-access") } : null; })()`,
  clickSessionRow: `(function clickSessionRow(index) {
    const rows = document.querySelectorAll("[data-session-row=true]");
    const row = rows[index];
    if (!row) return false;
    row.click();
    return true;
  })`,
  clickSessionByTestId: `(function clickSessionByTestId(sessionId) {
    const button = document.querySelector('[data-testid="session-select-' + sessionId + '"]');
    if (!button) return false;
    button.click();
    return true;
  })`,
  clickNewSession: `(function clickNewSession() {
    const button = document.querySelector('[data-testid="title-new-session"], [data-testid="sidebar-new-session"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })`,
  clickNewSessionInProject: `(function clickNewSessionInProject() {
    const row = document.querySelector('[data-testid="sidebar-project-row"]');
    if (!row) return false;
    const actions = row.parentElement?.querySelectorAll('button[aria-label]');
    const plus = actions ? Array.from(actions).find((button) => /new session/i.test(button.getAttribute("aria-label") ?? "")) : null;
    if (!plus) return false;
    plus.click();
    return true;
  })`,
  dumpDom: `(function dumpDom() {
    const textarea = document.querySelector(".chat-input-textarea");
    const send = document.querySelector("button.chat-input-send");
    const selected = document.querySelector("[data-session-row=true][data-active=true]");
    const assistants = Array.from(document.querySelectorAll(".chat-assistant-message"));
    const markdown = Array.from(document.querySelectorAll(".markdown-body"));
    const alert = document.querySelector("[role=alert]");
    return {
      url: location.href,
      overlay: Boolean(document.querySelector(".chat-input-streaming-overlay")),
      runningDot: Boolean(document.querySelector(".workspace-tab-running-dot")),
      sendBtn: Boolean(send),
      sendDisabled: send?.disabled ?? null,
      stopBtn: Array.from(document.querySelectorAll("button[aria-label]")).some((button) => /stop/i.test(button.getAttribute("aria-label") ?? "")),
      textareaValue: textarea?.value ?? null,
      textareaPlaceholder: textarea?.placeholder ?? null,
      textareaDisabled: textarea?.disabled ?? null,
      selectedRow: selected ? { text: (selected.textContent ?? "").slice(0, 80), running: selected.getAttribute("data-running"), workspace: selected.getAttribute("data-workspace-access") } : null,
      userCount: document.querySelectorAll(".chat-user-message").length,
      userTexts: Array.from(document.querySelectorAll(".chat-user-message")).map((node) => (node.textContent ?? "").slice(0, 80)),
      assistantCount: assistants.length,
      assistantStreaming: assistants.some((node) => node.classList.contains("is-streaming")),
      markdownStreaming: markdown.some((node) => node.classList.contains("is-streaming")),
      lastAssistant: assistants.length ? (assistants[assistants.length - 1].textContent ?? "").slice(0, 120) : null,
      lastMarkdown: markdown.length ? (markdown[markdown.length - 1].textContent ?? "").slice(0, 120) : null,
      alert: alert?.textContent ?? null,
    };
  })`,
  runtimeTap: `window.__pixRuntimeTap ? window.__pixRuntimeTap.summary() : null`,
  pixDiag: `window.__pixDiag ?? null`,
};

export function installRuntimeTapSource() {
  return `(() => {
    if (window.__pixRuntimeTap) return true;
    const Original = window.WebSocket;
    const frames = [];
    function sanitizePartial(message) {
      if (!message || typeof message !== "object") return null;
      const content = message.content;
      let contentType = null;
      let charCount = 0;
      let blockTypes = [];
      if (typeof content === "string") {
        contentType = "string";
        charCount = content.length;
      } else if (Array.isArray(content)) {
        contentType = "array";
        blockTypes = content.map((block) => block && typeof block === "object" ? String(block.type ?? "?") : "?");
        for (const block of content) {
          if (block && typeof block === "object") {
            if (typeof block.text === "string") charCount += block.text.length;
            if (typeof block.thinking === "string") charCount += block.thinking.length;
          }
        }
      }
      return { role: message.role ?? null, contentType, charCount, blockTypes };
    }
    function record(direction, raw) {
      let parsed;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      const type = parsed?.type;
      const eventType = parsed?.payload?.type;
      const delta = parsed?.payload?.delta ?? null;
      const deltaText = delta?.delta?.text ?? delta?.text ?? null;
      const features = parsed?.payload?.acceptedFeatures ?? parsed?.payload?.features ?? null;
      const snap = parsed?.payload?.snapshot ?? (type === "snapshot" ? parsed.payload : null);
      const state = snap?.state ?? parsed?.payload?.state ?? parsed?.payload?.status?.state ?? null;
      const streaming = snap?.streaming ?? parsed?.payload?.streaming ?? null;
      const runningState = type === "running_state" ? parsed.payload : (eventType === "running_sessions_changed" ? parsed.payload : null);
      const busyIds = runningState?.busySessionIds ?? runningState?.state?.busySessionIds ?? parsed?.payload?.busySessionIds ?? null;
      const liveIds = runningState?.sessionIds ?? runningState?.state?.sessionIds ?? parsed?.payload?.sessionIds ?? null;
      frames.push({
        direction,
        type,
        eventType,
        id: parsed?.id ?? null,
        sessionIdPrefix: typeof parsed?.payload?.sessionId === "string" ? parsed.payload.sessionId.slice(0, 8) : (typeof snap?.state?.sessionId === "string" ? snap.state.sessionId.slice(0, 8) : null),
        epoch: parsed?.payload?.epoch ?? snap?.epoch ?? null,
        eventId: parsed?.payload?.eventId ?? parsed?.payload?.lastEventId ?? null,
        operationId: typeof parsed?.payload?.operationId === "string" ? parsed.payload.operationId : null,
        operationIdPrefix: typeof parsed?.payload?.operationId === "string" ? parsed.payload.operationId.slice(0, 12) : null,
        turnId: typeof parsed?.payload?.turnId === "string" ? parsed.payload.turnId : null,
        turnIdPrefix: typeof parsed?.payload?.turnId === "string" ? parsed.payload.turnId.slice(0, 12) : null,
        status: parsed?.payload?.status ?? parsed?.payload?.state ?? parsed?.payload?.status?.state ?? null,
        turnState: parsed?.payload?.state ?? parsed?.payload?.status?.state ?? null,
        promptDone: eventType === "prompt_done" ? { hasError: Boolean(parsed?.payload?.error), errorCode: parsed?.payload?.error?.code ?? null } : null,
        runningRevision: runningState?.revision ?? parsed?.payload?.revision ?? null,
        busyCount: Array.isArray(busyIds) ? busyIds.length : null,
        liveCount: Array.isArray(liveIds) ? liveIds.length : null,
        busyPrefixes: Array.isArray(busyIds) ? busyIds.map((id) => (typeof id === "string" ? id.slice(0, 8) : null)) : null,
        livePrefixes: Array.isArray(liveIds) ? liveIds.map((id) => (typeof id === "string" ? id.slice(0, 8) : null)) : null,
        hasTextDelta: typeof deltaText === "string" && deltaText.length > 0,
        textDeltaChars: typeof deltaText === "string" ? deltaText.length : 0,
        deltaRole: delta?.role ?? null,
        deltaType: delta?.delta?.type ?? delta?.type ?? null,
        attachMode: parsed?.payload?.attachMode ?? null,
        acceptedFeatures: Array.isArray(features) ? features : null,
        isStreaming: state?.isStreaming ?? null,
        isPromptRunning: state?.isPromptRunning ?? null,
        streamingActive: streaming?.active ?? null,
        streamingPhase: streaming?.phase ?? null,
        partial: sanitizePartial(streaming?.partialMessage),
      });
      if (frames.length > 400) frames.shift();
    }
    window.WebSocket = function PatchedWebSocket(url, protocols) {
      const ws = protocols === undefined ? new Original(url) : new Original(url, protocols);
      ws.addEventListener("message", (event) => record("in", event.data));
      const originalSend = ws.send.bind(ws);
      ws.send = (data) => { record("out", data); return originalSend(data); };
      return ws;
    };
    window.WebSocket.prototype = Original.prototype;
    window.WebSocket.CONNECTING = Original.CONNECTING;
    window.WebSocket.OPEN = Original.OPEN;
    window.WebSocket.CLOSING = Original.CLOSING;
    window.WebSocket.CLOSED = Original.CLOSED;
    window.__pixRuntimeTap = {
      frames,
      summary() {
        const inbound = frames.filter((frame) => frame.direction === "in");
        const outbound = frames.filter((frame) => frame.direction === "out");
        const textDeltas = inbound.filter((frame) => frame.hasTextDelta);
        const handshakeAck = inbound.find((frame) => frame.type === "handshake_ack");
        const handshakeOut = outbound.find((frame) => frame.type === "handshake");
        return {
          inbound: inbound.length,
          outbound: outbound.length,
          submitTurns: outbound.filter((frame) => frame.type === "submit_turn").length,
          submitResults: inbound.filter((frame) => frame.type === "submit_turn_result").length,
          events: inbound.filter((frame) => frame.type === "event").length,
          textDeltas: textDeltas.length,
          textDeltaChars: textDeltas.reduce((sum, frame) => sum + frame.textDeltaChars, 0),
          requestedObserve: Boolean(handshakeOut?.acceptedFeatures?.includes("runtime.observe-existing.v1")),
          acceptedObserve: Boolean(handshakeAck?.acceptedFeatures?.includes("runtime.observe-existing.v1")),
          acceptedFeatures: handshakeAck?.acceptedFeatures ?? [],
          requestedFeatures: handshakeOut?.acceptedFeatures ?? [],
          existingOnlyAttaches: outbound.filter((frame) => frame.type === "attach" && frame.attachMode === "existing_only").length,
          lastInboundTypes: inbound.slice(-12).map((frame) => frame.eventType ? (frame.type + ":" + frame.eventType) : frame.type),
          submitCorrelation: (() => {
            function digest(value) {
              if (typeof value !== "string" || value.length === 0) return null;
              let hash = 2166136261;
              for (let i = 0; i < value.length; i += 1) {
                hash ^= value.charCodeAt(i);
                hash = Math.imul(hash, 16777619);
              }
              return (hash >>> 0).toString(16).padStart(8, "0");
            }
            const submits = outbound.filter((frame) => frame.type === "submit_turn");
            const results = inbound.filter((frame) => frame.type === "submit_turn_result");
            const byOp = new Map();
            for (const frame of submits) {
              const key = frame.operationId ?? "?";
              const entry = byOp.get(key) ?? { operationId: frame.operationId ?? null, operationIdDigest: digest(frame.operationId), operationIdPrefix: frame.operationIdPrefix, sessionIdPrefix: frame.sessionIdPrefix, outbound: 0, inbound: 0, statuses: [], turnIds: [] };
              entry.outbound += 1;
              byOp.set(key, entry);
            }
            for (const frame of results) {
              const key = frame.operationId ?? "?";
              const entry = byOp.get(key) ?? { operationId: frame.operationId ?? null, operationIdDigest: digest(frame.operationId), operationIdPrefix: frame.operationIdPrefix, sessionIdPrefix: frame.sessionIdPrefix, outbound: 0, inbound: 0, statuses: [], turnIds: [] };
              entry.inbound += 1;
              if (frame.status) entry.statuses.push(frame.status);
              if (frame.turnId) entry.turnIds.push(frame.turnId);
              if (!entry.sessionIdPrefix && frame.sessionIdPrefix) entry.sessionIdPrefix = frame.sessionIdPrefix;
              if (!entry.operationId && frame.operationId) {
                entry.operationId = frame.operationId;
                entry.operationIdDigest = digest(frame.operationId);
                entry.operationIdPrefix = frame.operationIdPrefix;
              }
              byOp.set(key, entry);
            }
            return [...byOp.values()].map((entry) => {
              const uniqueTurnIds = [...new Set(entry.turnIds)];
              return {
                operationIdDigest: entry.operationIdDigest,
                operationIdPrefix: entry.operationIdPrefix,
                sessionIdPrefix: entry.sessionIdPrefix,
                outbound: entry.outbound,
                inbound: entry.inbound,
                statuses: entry.statuses,
                turnIdDigest: uniqueTurnIds.length === 1 ? digest(uniqueTurnIds[0]) : uniqueTurnIds.map(digest),
                sameOperationDuplicate: Boolean(entry.operationId)
                  && entry.outbound >= 2
                  && entry.statuses.includes("accepted")
                  && entry.statuses.includes("duplicate")
                  && uniqueTurnIds.length <= 1,
              };
            });
          })(),
          terminals: inbound.filter((frame) => frame.type === "turn_status" || frame.eventType === "prompt_done" || frame.type === "running_state" || frame.eventType === "running_sessions_changed").slice(-8).map((frame) => ({
            type: frame.eventType ? (frame.type + ":" + frame.eventType) : frame.type,
            sessionIdPrefix: frame.sessionIdPrefix,
            operationIdPrefix: frame.operationIdPrefix,
            turnIdPrefix: frame.turnIdPrefix,
            turnState: frame.turnState,
            status: frame.status,
            promptDone: frame.promptDone,
            runningRevision: frame.runningRevision,
            busyCount: frame.busyCount,
            liveCount: frame.liveCount,
            busyPrefixes: frame.busyPrefixes,
            livePrefixes: frame.livePrefixes,
          })),
          shapes: inbound.filter((frame) => frame.type === "snapshot" || frame.type === "submit_turn_result" || frame.type === "turn_status" || frame.eventType === "message_start" || frame.eventType === "message_update" || frame.eventType === "agent_start" || frame.eventType === "prompt_done" || frame.type === "running_state").slice(-12).map((frame) => ({
            type: frame.eventType ? (frame.type + ":" + frame.eventType) : frame.type,
            id: frame.id,
            sessionIdPrefix: frame.sessionIdPrefix,
            epoch: frame.epoch,
            eventId: frame.eventId,
            operationIdPrefix: frame.operationIdPrefix,
            turnIdPrefix: frame.turnIdPrefix,
            status: frame.status,
            isStreaming: frame.isStreaming,
            isPromptRunning: frame.isPromptRunning,
            streamingActive: frame.streamingActive,
            streamingPhase: frame.streamingPhase,
            hasTextDelta: frame.hasTextDelta,
            textDeltaChars: frame.textDeltaChars,
            deltaRole: frame.deltaRole,
            deltaType: frame.deltaType,
            partial: frame.partial,
            turnState: frame.turnState,
            promptDone: frame.promptDone,
            busyCount: frame.busyCount,
            liveCount: frame.liveCount,
            runningRevision: frame.runningRevision,
          })),
        };
      },
    };
    return true;
  })()`;
}
