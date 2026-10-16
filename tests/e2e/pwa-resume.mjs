/**
 * PWA resume while a turn is RUNNING — REAL Chrome (phone viewport) over the
 * built Client against the real SDK stack, with a killing reverse proxy.
 *
 * A phone PWA that goes to the background is frozen by the OS: JS stops, the
 * socket dies, and the server keeps streaming the running turn into the
 * journal. On return:
 *  - the page must not crash while the journal backlog replays (React #185);
 *  - the session stays on screen (model, context ring, transcript) and never
 *    flips to the history error while the network is still coming back;
 *  - a message sent mid-turn right after the return is delivered;
 *  - the next ordinary send goes through.
 *
 * Scenarios: "resume" (network back at once) and "radio" (no network for the
 * first 8s after the return).
 *
 * Run: node tests/e2e/pwa-resume.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, requestHasUserHash } from "./helpers/controlled-provider.mjs";
import { launchChromeCdp, PAGE } from "./helpers/chrome-cdp.mjs";
import { bootLifecycleStack, delay, log, makeIsolatedDirs, teardownLifecycleStack, writeStubProviderConfig } from "./helpers/lifecycle-stack.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");
const FREEZE_MS = 35_000;
const SUITE_DEADLINE_MS = 10 * 60_000;
const PROVIDER_ID = "pix-e2e-stub";
const MODEL_A = "pix-e2e-alpha";
const NAME_A = "Pix E2E Alpha";
const MARK = "TERMINAL-MARKER-DONE";

async function startKillingProxy(targetOrigin) {
  const target = new URL(targetOrigin);
  const livePairs = new Set();
  let upgradeCount = 0;
  let blackoutUntil = 0;
  const server = http.createServer((req, res) => {
    const upstream = http.request({ host: target.hostname, port: Number(target.port), method: req.method, path: req.url, headers: { ...req.headers } }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  const sockets = new Set();
  // No network yet after the return: every new connection dies at once.
  server.on("connection", (socket) => {
    if (Date.now() < blackoutUntil) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    upgradeCount += 1;
    const upstream = net.connect(Number(target.port), target.hostname);
    const pair = { upstream, socket, dead: false };
    upstream.on("connect", () => {
      const headers = [`GET ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) for (const item of [value].flat()) if (item !== undefined) headers.push(`${name}: ${item}`);
      upstream.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => { if (!pair.dead) upstream.write(chunk); });
    upstream.on("data", (chunk) => { if (!pair.dead) socket.write(chunk); });
    const drop = () => { pair.dead = true; livePairs.delete(pair); socket.destroy(); upstream.destroy(); };
    upstream.on("error", drop);
    socket.on("error", drop);
    upstream.on("close", () => livePairs.delete(pair));
    socket.on("close", () => livePairs.delete(pair));
    livePairs.add(pair);
  });
  const { port } = await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => ok(server.address())); });
  return {
    origin: `http://127.0.0.1:${port}`,
    get upgradeCount() { return upgradeCount; },
    blackout(ms) { blackoutUntil = Date.now() + ms; },
    // The OS kills the socket silently: no close frame reaches the page.
    killWebSockets() {
      for (const pair of livePairs) {
        pair.dead = true;
        pair.socket.removeAllListeners("data");
        pair.upstream.destroy();
        pair.socket.end();
      }
    },
    // Keep-alive browser connections never end on their own; close them all.
    close: () => new Promise((ok) => {
      for (const pair of [...livePairs]) { pair.socket.destroy(); pair.upstream.destroy(); }
      for (const socket of [...sockets]) socket.destroy();
      server.close(() => ok());
    }),
  };
}

const OBSERVE = `(() => {
  const ring = document.querySelector(".session-info-ring");
  const assistants = document.querySelectorAll(".chat-assistant-message");
  return {
    model: ${PAGE.modelSelectorName},
    ring: ring ? (ring.querySelector(".session-info-ring-label")?.textContent ?? "empty") : null,
    alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    lastLen: assistants.length ? assistants[assistants.length - 1].textContent.length : 0,
    draft: document.querySelector(".chat-input-textarea")?.value ?? null,
    errors: (window.__pageErrors ?? []).length,
  };
})()`;

const CAPTURE_ERRORS = `(() => {
  window.__pageErrors = [];
  window.addEventListener("error", (event) => window.__pageErrors.push(String(event.error?.message ?? event.message).slice(0, 300)));
  return true;
})()`;

function delivered(provider, prompt) {
  return provider.requests.some((record) => requestHasUserHash(record, prompt));
}

async function waitDelivered(provider, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !delivered(provider, prompt)) await delay(200);
  return delivered(provider, prompt);
}

async function pressEnter(tab) {
  await tab.evaluate(`document.querySelector(".chat-input-textarea")?.focus()`);
  for (const type of ["keyDown", "keyUp"]) {
    await tab.cdp("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
}

async function runScenario({ name, blackoutMs, chrome, proxy, provider, dirs }) {
  const history = seedSessionHistoryForTests({ cwd: dirs.projectCwd, turns: 2, model: { provider: PROVIDER_ID, modelId: MODEL_A }, label: `pwa-${name}` });
  const tab = await chrome.openTab();
  try {
    await tab.setViewport(390, 844, 3, true);
    await tab.navigate(`${proxy.origin}/?session=${encodeURIComponent(history.sessionId)}&cwd=${encodeURIComponent(dirs.projectCwd)}`);
    await tab.waitFor(`document.querySelectorAll(".chat-user-message").length >= 1`, { timeoutMs: 20_000, label: `${name}: history` });
    await tab.waitFor(`(window.__pixRuntimeTap?.frames ?? []).some((f) => f.direction === "in" && f.type === "handshake_ack")`, { timeoutMs: 30_000, label: `${name}: handshake` });
    await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: 30_000, label: `${name}: idle composer` });
    await tab.evaluate(CAPTURE_ERRORS);

    // A long streaming turn (~70s) keeps the journal moving through the freeze.
    provider.reset();
    provider.plan({ chunks: [...Array.from({ length: 2400 }, (_, i) => `w${i} `), `${MARK}.`], chunkDelayMs: 30 });
    const longPrompt = `${name}-long ${Date.now()}`;
    await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(longPrompt)})`);
    assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, `${name}: start the long turn`);
    await tab.waitFor(`(window.__pixRuntimeTap?.summary?.().textDeltas ?? 0) > 20`, { timeoutMs: 60_000, label: `${name}: stream arrives` });
    await delay(3_000);

    // Background: hidden, JS frozen, socket killed by the OS.
    await tab.setHidden(true);
    await tab.cdp("Debugger.enable");
    await tab.cdp("Debugger.pause");
    proxy.killWebSockets();
    await delay(FREEZE_MS);
    if (blackoutMs > 0) proxy.blackout(blackoutMs);
    await tab.cdp("Debugger.resume");
    await tab.cdp("Debugger.disable");
    await tab.setHidden(false);

    // The user types right away while the turn is still running.
    await delay(1_500);
    const midPrompt = `${name}-mid ${Date.now()}`;
    await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(midPrompt)})`);
    await pressEnter(tab);
    const samples = [];
    for (let i = 0; i < 12; i++) {
      await delay(1_000);
      samples.push(await tab.evaluate(OBSERVE));
    }
    log(`${name}: after return`, JSON.stringify(samples.map((s) => [s.model, s.ring, s.lastLen, s.alert, s.draft, s.errors])));
    for (const [index, sample] of samples.entries()) {
      assert.equal(sample.errors, 0, `${name}: page error ${index + 1}s after the return`);
      assert.equal(sample.model, NAME_A, `${name}: model shown ${index + 1}s after the return`);
      assert.notEqual(sample.ring, null, `${name}: context ring shown ${index + 1}s after the return`);
      assert.equal(sample.alert, null, `${name}: no alert ${index + 1}s after the return (got ${sample.alert})`);
    }
    assert.equal(samples.at(-1).draft, "", `${name}: the mid-turn message left the composer`);
    assert.equal(await waitDelivered(provider, midPrompt, 120_000), true, `${name}: the mid-turn message reached the model`);

    await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: 120_000, label: `${name}: turn settled` });
    provider.reset();
    provider.plan({ chunks: ["after ", `${MARK}.`] });
    const nextPrompt = `${name}-next ${Date.now()}`;
    await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(nextPrompt)})`);
    assert.equal(await tab.evaluate(`(${PAGE.clickSend})()`), true, `${name}: next send`);
    assert.equal(await waitDelivered(provider, nextPrompt, 30_000), true, `${name}: the next send reached the model`);
    assert.equal((await tab.evaluate(OBSERVE)).errors, 0, `${name}: no page error at the end`);
    log(`PASS ${name}`);
  } finally {
    await tab.close().catch(() => {});
  }
}

async function main() {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const deadline = setTimeout(() => { log("SUITE-DEADLINE"); process.exit(1); }, SUITE_DEADLINE_MS);
  let dirs, provider, stack, proxy, chrome;
  let code = 0;
  try {
    dirs = await makeIsolatedDirs("px-pwa");
    provider = await startControlledProvider();
    await writeStubProviderConfig(dirs.agentDir, provider.port, PROVIDER_ID, MODEL_A, { defaultName: NAME_A });
    process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
    stack = await bootLifecycleStack({ sessiondDir: dirs.sessiondDir, projectCwd: dirs.projectCwd, hostDir: dirs.hostDir, clientDist: CLIENT_DIST, assistantResidency: true });
    proxy = await startKillingProxy(stack.origin);
    chrome = await launchChromeCdp();
    for (const scenario of [{ name: "resume", blackoutMs: 0 }, { name: "radio", blackoutMs: 8_000 }]) {
      if (process.env.PWA_ONLY && process.env.PWA_ONLY !== scenario.name) continue;
      try {
        await runScenario({ ...scenario, chrome, proxy, provider, dirs });
      } catch (error) {
        code = 1;
        log(`FAIL ${scenario.name}`, error?.stack ?? error);
        provider.release();
      }
      for (const session of (await stack.rpc.call("runtime.listRunning", {})).sessions) {
        await stack.rpc.call("runtime.stop", { sessionId: session.sessionId, reason: "user" }).catch(() => {});
      }
    }
  } catch (error) {
    code = 1;
    log("FAIL harness", error?.stack ?? error);
  } finally {
    clearTimeout(deadline);
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    provider?.release();
    await chrome?.close().catch(() => {});
    await proxy?.close();
    if (stack || dirs) await teardownLifecycleStack(stack, dirs);
    await provider?.close().catch(() => {});
  }
  log(code === 0 ? "PASS — PWA resume mid-turn (resume + radio)" : "REGRESSION — PWA resume mid-turn");
  return code;
}

process.exit(await main());
