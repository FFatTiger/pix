/**
 * MANUAL repro harness (not an assertion suite): "switch model → send within
 * <1s" against a LIVE dev instance (default http://127.0.0.1:30144).
 *
 * Production symptom (v0.3.7 iPhone PWA): user picks a model in the picker,
 * sends ~1.3s later; the session JSONL shows model_change + the user message
 * + an assistant reply, yet the composer shows 「消息未发送，草稿已保留」 with
 * the draft retained.
 *
 * Usage: node tests/e2e/manual/sendfail-repro.mjs [--origin http://127.0.0.1:30144] [--keep] [--mobile]
 * Gate password is read from ~/.pi/pix.json (auth.password) and NEVER printed;
 * a gate-less origin (local unauthenticated boot) skips the login step.
 * --mobile runs an iPhone-class viewport with touch emulation.
 * Creates test sessions on the target instance and deletes them at the end
 * (unless --keep).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchChromeCdp, PAGE } from "../helpers/chrome-cdp.mjs";

const args = process.argv.slice(2);
const originArg = args[args.indexOf("--origin") + 1];
const ORIGIN = args.includes("--origin") && originArg ? originArg : "http://127.0.0.1:30144";
const KEEP = args.includes("--keep");
const MOBILE = args.includes("--mobile");

function gatePassword() {
  const config = JSON.parse(readFileSync(join(homedir(), ".pi", "pix.json"), "utf8"));
  const password = config?.auth?.password;
  if (typeof password !== "string" || password.length === 0) throw new Error("no gate password in ~/.pi/pix.json");
  return password;
}

function nonce(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Full-fidelity frame tap: records every WS frame (deltas compressed). */
const FULL_TAP = `(() => {
  if (window.__sendfixTap) return true;
  const Original = window.WebSocket;
  const frames = [];
  function shrink(value, depth) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return value.length > 160 ? value.slice(0, 160) + "…" + value.length : value;
    if (typeof value !== "object") return value;
    if (depth > 4) return "[…]";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => shrink(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "text" || key === "thinking") { out[key] = typeof item === "string" ? \`str(\${item.length})\` : item; continue; }
      out[key] = shrink(item, depth + 1);
    }
    return out;
  }
  function record(direction, raw) {
    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch { return; }
    if (parsed?.type === "event" && parsed?.payload?.type === "message_delta") return;
    if (parsed?.type === "event" && parsed?.payload?.type === "stream_delta") return;
    frames.push({ t: Date.now(), dir: direction, frame: shrink(parsed, 0) });
  }
  class Tapped extends Original {
    constructor(url, protocols) {
      super(url, protocols);
      this.addEventListener("message", (event) => record("in", event.data));
      const origSend = this.send.bind(this);
      this.send = (data) => { record("out", data); return origSend(data); };
    }
  }
  window.WebSocket = Tapped;
  window.__sendfixTap = {
    frames,
    since(index) { return frames.slice(index); },
  };
  return true;
})()`;

const DUMP = `(() => {
  const alert = document.querySelector("[role=alert]");
  const textarea = document.querySelector(".chat-input-textarea");
  const modelBtn = document.querySelector(".chat-input-toolbar-model button");
  return {
    url: location.href,
    alert: alert ? alert.textContent : null,
    draft: textarea ? textarea.value : null,
    modelLabel: modelBtn ? (modelBtn.textContent ?? "").trim().slice(0, 40) : null,
    userBubbles: [...document.querySelectorAll(".chat-user-message")].map((n) => (n.textContent ?? "").slice(0, 60)),
    assistantLast: (() => { const nodes = document.querySelectorAll(".chat-assistant-message"); return nodes.length ? (nodes[nodes.length - 1].textContent ?? "").slice(0, 80) : null; })(),
    sendBtn: Boolean(document.querySelector("button.chat-input-send:not(.is-stop)")),
    stopBtn: Boolean(document.querySelector("button.chat-input-send.is-stop")),
  };
})()`;

async function login(tab, password) {
  await tab.navigate(ORIGIN);
  // Gate-less local boot: no login form ever appears; wait for the app.
  const hasForm = await tab.waitFor(`Boolean(document.querySelector("input[name=password]"))`, { timeoutMs: 3_000, label: "login form" }).then(() => true, () => false);
  if (!hasForm) {
    await tab.waitFor(`Boolean(document.querySelector(".chat-input-textarea"))`, { timeoutMs: 30000, label: "app composer" });
    return;
  }
  await tab.evaluate(`(() => {
    const input = document.querySelector("input[name=password]");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(password)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`, { label: "type password" });
  await tab.evaluate(`document.querySelector("form button[type=submit], button.login-submit")?.click(); true`, { label: "submit login" });
  await tab.waitFor(`Boolean(document.querySelector(".chat-input-textarea"))`, { timeoutMs: 30000, label: "app composer" });
}

function printFrames(frames) {
  for (const entry of frames) {
    const frame = entry.frame ?? {};
    const payload = frame.payload ?? {};
    const bits = [`t=${entry.t}`, frame.type];
    if (payload.type) bits.push(`p=${payload.type}`);
    if (payload.command?.type) bits.push(`cmd=${payload.command.type}`);
    if (frame.id) bits.push(`id=${String(frame.id).slice(0, 10)}`);
    if (payload.operationId) bits.push(`op=${String(payload.operationId).slice(0, 12)}`);
    if (payload.error) bits.push(`error=${JSON.stringify(payload.error).slice(0, 260)}`);
    if (payload.status) bits.push(`status=${typeof payload.status === "string" ? payload.status : JSON.stringify(payload.status).slice(0, 160)}`);
    if (payload.epoch) bits.push(`epoch=${String(payload.epoch).slice(0, 8)}`);
    if (payload.expectedEpoch) bits.push(`fence=${String(payload.expectedEpoch).slice(0, 8)}/${payload.expectedRevision}`);
    if (payload.eventId !== undefined) bits.push(`ev=${payload.eventId}`);
    if (payload.revision !== undefined) bits.push(`rev=${payload.revision}`);
    if (payload.command?.model) bits.push(`setModel=${payload.command.provider}/${payload.command.model}`);
    if (payload.activationOverrides) bits.push(`ovr=${JSON.stringify(payload.activationOverrides)}`);
    if (payload.prompt) bits.push(`prompt=${String(payload.prompt).slice(0, 24)}`);
    console.log(`  ${entry.dir === "out" ? ">" : "<"} ${bits.join(" ")}`);
  }
}

async function scenario(tab, { label, needles }) {
  const probe = nonce("probe");
  console.log(`\n=== ${label} (probe=${probe}) ===`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: 20000, label: `${label}: idle composer` });
  await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(probe)})`);
  await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: 20000, label: `${label}: send enabled` });
  await tab.evaluate(`(${PAGE.clickModelSelector})()`, { label: `${label}: open picker` });
  const rows = await tab.waitFor(
    `(() => { const rows = ${PAGE.modelDropdownRows}; return rows && rows.rowCount > 1 ? rows : null; })()`,
    { timeoutMs: 15000, label: `${label}: dropdown rows` },
  );
  const before = await tab.evaluate(DUMP, { label: `${label}: pre-send dump` });
  console.log(`pre-send: model=${before.modelLabel} rows0=${rows.rowTexts[0]}`);
  const framesBefore = await tab.evaluate(`window.__sendfixTap.frames.length`, { label: "tap count" });
  await tab.waitFor(`(${PAGE.clickModelRowByLabels})(${JSON.stringify(needles)})`, { timeoutMs: 10000, label: `${label}: pick model` });
  // Send IMMEDIATELY after the pick (no awaits between pick and send).
  await tab.evaluate(`(${PAGE.clickSend})()`, { label: `${label}: send` });
  const startedAt = Date.now();
  let outcome = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const dump = await tab.evaluate(DUMP, { label: `${label}: poll` });
    const probeBubble = dump.userBubbles.filter((text) => text.includes(probe)).length;
    const replied = probeBubble > 0 && !dump.stopBtn;
    if (dump.alert && dump.alert.length > 0) { outcome = { kind: "ALERT", dump, probeBubble, at: Date.now() - startedAt }; break; }
    if (replied) { outcome = { kind: "REPLIED", dump, probeBubble, at: Date.now() - startedAt }; break; }
    if (i === 89) outcome = { kind: "TIMEOUT", dump, probeBubble, at: Date.now() - startedAt };
  }
  console.log(`outcome: ${outcome.kind} after ${outcome.at}ms probeBubbles=${outcome.probeBubble}`);
  console.log(`post: alert=${JSON.stringify(outcome.dump.alert)} draft=${JSON.stringify(outcome.dump.draft)} model=${outcome.dump.modelLabel}`);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const late = await tab.evaluate(DUMP, { label: `${label}: late dump` });
  console.log(`late(+4s): alert=${JSON.stringify(late.alert)} draft=${JSON.stringify(late.draft)} probeBubbles=${late.userBubbles.filter((t) => t.includes(probe)).length} model=${late.modelLabel}`);
  const frames = await tab.evaluate(`window.__sendfixTap.since(${Math.max(0, framesBefore - 6)})`, { label: `${label}: frames` });
  console.log(`frames since pick-6 (${frames.length}):`);
  printFrames(frames);
  return { probe, outcome };
}

async function main() {
  const password = gatePassword();
  const chrome = await launchChromeCdp({ headless: true });
  let created = [];
  let tab = null;
  try {
    tab = await chrome.openTab("about:blank");
    if (MOBILE) await tab.setViewport(390, 844, 3, true);
    await tab.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    await tab.cdp("Page.addScriptToEvaluateOnNewDocument", { source: FULL_TAP });
    await login(tab, password);
    console.log("logged in; app ready");

    // Seed: create the session via a cwd-scoped first send (works both on the
    // dev instance with project history and on a fresh gate-less instance);
    // wait for the reply so the session is live-attached (the incident's
    // precondition).
    await tab.navigate(`${ORIGIN}/?cwd=${encodeURIComponent("/Users/proxy")}`);
    await tab.waitFor(`Boolean(document.querySelector(".chat-input-textarea"))`, { timeoutMs: 20000, label: "seed: composer" });
    const seedProbe = nonce("seed");
    await tab.evaluate(`(${PAGE.setComposerText})(${JSON.stringify(seedProbe)})`);
    await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.sendButtonDisabled})`, { timeoutMs: 20000, label: "seed: send enabled" });
    await tab.evaluate(`(${PAGE.clickSend})()`, { label: "seed: send" });
    await tab.waitFor(`(() => {
      const answers = [...document.querySelectorAll(".chat-assistant-message")];
      return answers.length >= 1 && !document.querySelector("button.chat-input-send.is-stop");
    })()`, { timeoutMs: 90000, label: "seed: first reply" }).catch(async (error) => {
      const dump = await tab.evaluate(DUMP, { label: "seed fail dump" }).catch(() => null);
      const frames = await tab.evaluate(`window.__sendfixTap.frames`, { label: "seed fail frames" }).catch(() => []);
      console.log(`SEED FAILED dump=${JSON.stringify(dump)}`);
      printFrames(frames.slice(-40));
      throw error;
    });
    const seedUrl = await tab.evaluate(`location.href`, { label: "seed url" });
    console.log(`seed session url: ${seedUrl}`);
    const scriptStart = Date.now() - 120_000;
    const mine = await tab.evaluate(`(async () => {
      const res = await fetch("/v1/sessions");
      const data = await res.json();
      const sessions = data.sessions ?? data;
      return sessions.filter((s) => {
        const ts = Date.parse(s.updatedAt ?? s.lastActivityAt ?? s.createdAt ?? "");
        return Number.isFinite(ts) && ts > ${scriptStart} && s.cwd === "/Users/proxy";
      }).map((s) => s.sessionId ?? s.id);
    })()`, { label: "find created sessions" }).catch(() => []);
    created.push(...(Array.isArray(mine) ? mine : []));
    console.log(`created sessions to clean later: ${created.length}`);

    const rows = await (async () => {
      await tab.evaluate(`(${PAGE.clickModelSelector})()`, { label: "rows probe open" });
      const r = await tab.waitFor(`(() => { const rows = ${PAGE.modelDropdownRows}; return rows && rows.rowCount > 1 ? rows : null; })()`, { timeoutMs: 15000, label: "rows probe" });
      await tab.evaluate(`document.querySelector(".chat-input-toolbar-model button")?.click(); true`, { label: "rows probe close" });
      return r;
    })();
    console.log(`row texts: ${rows.rowTexts.slice(0, 8).join(" | ").slice(0, 500)}`);

    // Scenario 1: normal session, pick row #2 (different), immediate send.
    await scenario(tab, { label: "normal/different-model", needles: [rows.rowTexts[1]] });

    // Scenario 2: normal session, re-select the CURRENT model, immediate send.
    await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: 20000, label: "s2: idle" });
    const currentName = await tab.evaluate(`${PAGE.modelSelectorName}`, { label: "s2 current" });
    await scenario(tab, { label: "normal/same-model", needles: [currentName] });

    // Scenario 3: hide the page for a few seconds, come back and send
    // IMMEDIATELY (wake-from-hidden freshness probe path).
    await tab.waitFor(`(${PAGE.sendButtonPresent}) && !(${PAGE.inputStreaming})`, { timeoutMs: 20000, label: "s4: idle" });
    await tab.setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await tab.setHidden(false);
    await scenario(tab, { label: "normal/hidden-return-send", needles: [rows.rowTexts[1]] });

    // Scenario 4: Pixie assistant conversation, immediate send after model pick.
    const chipClicked = await tab.evaluate(`(() => { const chip = document.querySelector("[data-testid=assistant-entry-chip-selected], [data-testid=assistant-entry-tab] button"); if (!chip) return false; chip.click(); return true; })()`, { label: "assistant chip" });
    console.log(`\nassistant chip clicked: ${chipClicked}`);
    if (chipClicked) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await scenario(tab, { label: "pixie/model-pick-send", needles: [rows.rowTexts[1]] });
    }
  } finally {
    if (!KEEP && tab) {
      try {
        const results = await tab.evaluate(`(async () => {
          const results = [];
          for (const id of ${JSON.stringify(created)}) {
            try { const res = await fetch("/v1/sessions/" + id, { method: "DELETE" }); results.push(String(id).slice(0, 8) + ":" + res.status); }
            catch { results.push(String(id).slice(0, 8) + ":ERR"); }
          }
          return results;
        })()`, { label: "delete sessions" }).catch(() => []);
        const list = Array.isArray(results) ? results : [String(results)];
        console.log(`cleanup: ${list.join(", ")}`);
      } catch (error) {
        console.log(`cleanup skipped: ${String(error?.message ?? error)}`);
      }
    }
    await chrome.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
