/**
 * Round-5 assistant E2E (isolated instance, REAL model):
 *   1. assistant session role prompt — the real worker's effective system
 *      prompt after a real turn: assistant preamble replaces Pi's default,
 *      `assistant` segment appended, tools/rules/docs preserved;
 *   2. list_projects — really invoked by the model, authoritative running
 *      counts, seeded project surfaced;
 *   3. ordinary project session — default preamble untouched, no assistant
 *      segment (prompt isolation);
 *   4. reload — sessiond+host restarted on the same dirs, the same assistant
 *      session keeps its role prompt after the next turn.
 *
 * Isolation: own temp HOME/sessiond/host dirs + port; the real models.json +
 * auth.json are COPIED (read-only use) so a real provider answers. No
 * production process or directory is touched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@fffattiger/pix-protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const BOOT_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 120_000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function startProcess(args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => { stdout += c; });
  child.stderr?.on("data", (c) => { stderr += c; });
  return {
    child,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
        child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
      });
    },
  };
}

class Ws {
  constructor(url) {
    this.url = url;
    this.messages = [];
    this.waiters = new Set();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (data) => {
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      this.messages.push(parsed);
      for (const w of [...this.waiters]) {
        if (w.pred(parsed)) {
          this.waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(parsed);
        }
      }
    });
    this.ws.on("close", (code, reason) => {
      for (const w of [...this.waiters]) {
        this.waiters.delete(w);
        w.reject(new Error(`ws closed (${code}: ${String(reason)})`));
      }
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
      this.ws.once("open", () => { clearTimeout(timer); resolvePromise(); });
      this.ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
  send(message) {
    assert.ok(this.ws && this.ws.readyState === WebSocket.OPEN, "ws not open");
    this.ws.send(JSON.stringify(message));
  }
  waitFor(pred, label, timeoutMs = 20_000, afterIndex = 0) {
    const hit = this.messages.slice(afterIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      const entry = { pred, resolve: resolvePromise, reject, timer };
      this.waiters.add(entry);
    });
  }
  async handshake() {
    this.send({
      type: "handshake",
      id: `hs-${Date.now()}`,
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        client: { shell: "web", platform: "mac" },
        features: ["runtime.running-watch.v1", "runtime.read-rpc.v1", "runtime.submit-turn.v1", "runtime.observe-existing.v1", "runtime.explicit-activate.v1"],
      },
    });
    const ack = await this.waitFor((m) => m.type === "handshake_ack", "handshake_ack");
    return ack;
  }
  async create(cwd) {
    const id = `create-${Date.now()}`;
    this.send({ type: "create", id, payload: { createRequestId: id, cwd, projectRoot: cwd } });
    const res = await this.waitFor((m) => m.type === "response" && m.id === id, `create ${id}`, 30_000);
    assert.equal(res.payload.ok, true, JSON.stringify(res.payload));
    return res.payload.result;
  }

  /** Newest epoch/lastEventId observed for a session (snapshot + event frames). */
  fenceOf(sessionId) {
    let epoch;
    let lastEventId;
    for (const m of this.messages) {
      const p = m.payload ?? {};
      const snapshot = p.snapshot ?? {};
      const sid = p.sessionId ?? snapshot.sessionId;
      if (sid !== sessionId) continue;
      if (typeof p.epoch === "string") epoch = p.epoch;
      if (typeof snapshot.epoch === "string") epoch = snapshot.epoch;
      if (typeof p.lastEventId === "number") lastEventId = p.lastEventId;
      if (typeof snapshot.lastEventId === "number") lastEventId = snapshot.lastEventId;
      if (typeof p.eventId === "number") lastEventId = p.eventId;
    }
    return { epoch, lastEventId };
  }

  /** Fenced submit with same-operationId retry on fence conflicts. */
  async submitFenced(sessionId, prompt, operationId) {
    let fence = this.fenceOf(sessionId);
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.submitTurn(sessionId, prompt, operationId, fence.epoch, fence.lastEventId);
      if (result.payload.status !== "rejected") return result;
      lastError = result.payload.error;
      // The rejection carries the record's CURRENT fence values — adopt them
      // and retry the SAME operationId (idempotent admission).
      fence = { epoch: result.payload.epoch, lastEventId: result.payload.revision };
      if (lastError?.code !== "conflict" && lastError?.code !== "epoch_changed") break;
      await delay(250);
    }
    throw new Error(`submit ${operationId} rejected: ${JSON.stringify(lastError)}`);
  }
  async submitTurn(sessionId, prompt, operationId, expectedEpoch, expectedRevision) {
    const id = `submit-${operationId}`;
    const after = this.messages.length;
    this.send({
      type: "submit_turn",
      id,
      payload: {
        sessionId,
        prompt,
        operationId,
        ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    });
    const submitResult = await this.waitFor((m) => m.type === "submit_turn_result" && m.id === id, `submit_turn_result ${operationId}`, 30_000, after);
    if (submitResult.payload.status === "rejected") return submitResult;
    try {
      return await this.waitFor(
        (m) => m.type === "turn_status" && m.payload?.sessionId === sessionId && m.payload?.operationId === operationId && (m.payload.state === "completed" || m.payload.state === "failed"),
        `turn terminal ${operationId}`,
        TURN_TIMEOUT_MS,
        after,
      );
    } catch (error) {
      const tail = this.messages.slice(-25).map((m) => `${m.type}:${m.payload?.type ?? m.payload?.state ?? ""}`).join(", ");
      console.error(`TURN ${operationId} STALL. last frames: ${tail}`);
      const errorFrames = this.messages.filter((m) => m.type === "event" && /error/i.test(String(m.payload?.type))).slice(-5);
      console.error("error-ish frames:", JSON.stringify(errorFrames).slice(0, 1_500));
      throw error;
    }
  }
  close() {
    this.ws?.close();
  }
}

/** Assistant text across message_end events, scoped to one session. */
function assistantText(ws, sessionId) {
  const texts = [];
  for (const m of ws.messages) {
    if (m.type !== "event" || m.payload?.type !== "message_end") continue;
    if (sessionId !== undefined && m.payload.sessionId !== sessionId) continue;
    const message = m.payload.message;
    if (message?.role !== "assistant") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    if (text.trim() !== "") texts.push(text);
  }
  return texts.join("\n");
}

/** Authoritative current state: ask the Host for a fresh snapshot (the
    runtime_state_changed events are re-read signals, not state carriers). */
async function currentState(ws, sessionId) {
  const id = `snap-${sessionId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const after = ws.messages.length;
  ws.send({ type: "getSnapshot", id, payload: { sessionId } });
  const frame = await ws.waitFor((m) => (m.type === "snapshot" && m.id === id) || (m.type === "response" && m.id === id), `getSnapshot ${id}`, 30_000, after);
  if (frame.type === "response") {
    assert.equal(frame.payload.ok, true, `getSnapshot failed: ${JSON.stringify(frame.payload).slice(0, 300)}`);
    return frame.payload.result?.state ?? frame.payload.result ?? null;
  }
  return frame.payload.snapshot?.state ?? null;
}

/** Observe a session on this connection so its events flow (observe-existing). */
async function attachSession(ws, sessionId) {
  const id = `attach-${sessionId.slice(0, 8)}-${Date.now()}`;
  ws.send({ type: "attach", id, payload: { sessionId } });
  await ws.waitFor((m) => (m.type === "snapshot" && m.id === id) || (m.type === "response" && m.id === id), `attach ${id}`, 40_000);
}

async function waitHealthy(origin) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/v1/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.sessiond === "up") return body;
        lastError = new Error(`sessiond ${body.sessiond}`);
      } else {
        lastError = new Error(`health ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`host never healthy: ${lastError}`);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "pixa5-e2e-"));
  const e2eHome = join(temp, "home");
  const sessiondDir = join(temp, "sessiond");
  // realpath only the host dir (macOS /var symlink): ensurePixHostDir refuses
  // intermediate path-text symlinks, while sessiond stays on the short /var
  // form so the AF_UNIX socket path fits 104 bytes.
  const hostDir = join(realpathSync(temp), "host");
  const agentDir = join(temp, "agent");
  // The demo project must live OUTSIDE tmpdir: the catalog's browse-kind
  // policy classifies /var/folders (and /tmp) workspaces as session_only
  // scratch, and list_projects intentionally reports only regular projects.
  mkdirSync(e2eHome, { recursive: true });
  const project = join(homedir(), "pixa5-e2e-projects", "demo-project");
  rmSync(join(homedir(), "pixa5-e2e-projects"), { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { mode: 0o700, recursive: true });
  writeFileSync(join(project, "README.md"), "# demo project\n", { mode: 0o600 });

  // Real model seam (read-only copy): provider catalog + credentials + the
  // default model selection only — nothing else from the operator agent dir.
  const realAgent = join(homedir(), ".pi", "agent");
  copyFileSync(join(realAgent, "models.json"), join(agentDir, "models.json"));
  copyFileSync(join(realAgent, "auth.json"), join(agentDir, "auth.json"));
  const realSettings = JSON.parse(readFileSync(join(realAgent, "settings.json"), "utf8"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: realSettings.defaultProvider,
    defaultModel: realSettings.defaultModel,
  }, null, 2), { mode: 0o600 });

  // realpath HOME: the Host resolves the assistant workspace through realpath
  // (macOS /var → /private/var); the worker derives the same workspace from
  // os.homedir() (string equality, no symlink resolution), so both sides must
  // agree. A symlinked production HOME would need the same alignment.
  const env = {
    ...process.env,
    HOME: realpathSync(e2eHome),
    PIX_SESSIOND_DIR: sessiondDir,
    PIX_HOST_DIR: hostDir,
    PI_CODING_AGENT_DIR: agentDir,
    PIX_ALLOWED_ROOTS: [realpathSync(e2eHome), project].join(":"),
    PIX_CLIENT_DIST: join(ROOT, "packages", "client", "dist"),
  };
  delete env.PIX_PASSWORD;
  delete env.PIX_GATE_DISABLED;
  delete env.PIX_GATE_CONFIG;
  // The harness talks to Host APIs directly (fetch + WS) with no login step;
  // an unconfigured local gate would answer 503 to every one of them.
  env.PIX_AUTH_DISABLED = "true";

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  };

  const boot = async () => {
    const proc = startProcess(["scripts/product-entry.mjs", "start", "--foreground", "--hostname", "127.0.0.1", "--port", String(port), "--no-open"], env);
    let health;
    try {
      health = await waitHealthy(origin);
    } catch (error) {
      const out = proc.output();
      console.error("BOOT FAILED. stdout tail:", out.stdout.slice(-2_000));
      console.error("BOOT FAILED. stderr tail:", out.stderr.slice(-2_000));
      await proc.stop();
      throw error;
    }
    return { proc, health };
  };

  let stack;
  try {
    stack = await boot();
    console.log("stack booted, capabilities:", stack.health.capabilities.length);

    // -- 1. assistant binding ------------------------------------------------
    const bindingResponse = await fetch(`${origin}/v1/assistant`);
    assert.equal(bindingResponse.status, 200);
    const binding = await bindingResponse.json();
    const assistantCwd = binding.cwd;
    assert.ok(realpathSync(assistantCwd).startsWith(realpathSync(e2eHome)), `assistant cwd isolated: ${assistantCwd}`);
    assert.equal(binding.sessionId, null, `fresh binding should have no session yet: ${JSON.stringify(binding)}`);
    console.log("assistant binding:", JSON.stringify(binding));

    const ws = new Ws(origin.replace(/^http/, "ws") + "/v1/runtime");
    await ws.connect();
    await ws.handshake();

    // -- 2. assistant first turn: identity + role prompt ----------------------
    const assistant = await ws.create(assistantCwd);
    await attachSession(ws, assistant.sessionId);
    const turn1 = await ws.submitFenced(assistant.sessionId, "你是谁、你的工作目录是做什么的？一两句话。", "e2e-a1");
    check("assistant turn1 terminal state", turn1.payload.state === "completed", turn1.payload.state);
    const answer1 = assistantText(ws, assistant.sessionId);
    check("assistant answers in its role (中文随身助手/草稿区)", /助手|草稿/.test(answer1) && !/expert coding assistant/i.test(answer1), concise(answer1, 120));

    const prompt1 = (await currentState(ws, assistant.sessionId))?.systemPrompt ?? "";
    check("system prompt (published state): assistant preamble durable", prompt1.includes("你是 Pixie，用户在 Pix 里的随身助手"), concise(prompt1, 60));
    check("system prompt: no Pi default preamble", !prompt1.includes("expert coding assistant"), "");
    check("system prompt: {workspace}/{home} substituted", !prompt1.includes("{workspace}") && !prompt1.includes("{home}"), "");
    // The published state carries the LAST EFFECTIVE turn prompt (not the
    // between-turn base): segments included.
    check("system prompt (published state): segments included", prompt1.includes("<assistant>") && prompt1.includes("<tools>") && prompt1.includes("list_projects"), concise(prompt1, 80));
    // Request-time full fidelity: the turn's system message in the transcript
    // carries the replaced preamble, the preserved tools/rules/docs segments,
    // and the trailing assistant segment (the forced-prompt projection itself
    // is not persisted — its sections are).
    const jsonl = readAssistantJsonl(agentDir, assistant.sessionId);
    check("transcript system message: replaced preamble", jsonl.includes("你是 Pixie，用户在 Pix 里的随身助手"), "");
    check("transcript system message: assistant segment", jsonl.includes("<assistant>") && jsonl.includes("长期对话"), "");
    check("transcript system message: tools/rules/docs preserved", jsonl.includes("<tools>") && jsonl.includes("list_projects") && jsonl.includes("<rules>") && jsonl.includes("<docs>"), "");

    // -- 3. ordinary session first: prompt isolation + real project history ----
    const ordinary = await ws.create(project);
    await attachSession(ws, ordinary.sessionId);
    await ws.submitFenced(ordinary.sessionId, "在 README.md 里写下三步部署说明，简短即可。", "e2e-o1");
    const ordinaryPrompt = (await currentState(ws, ordinary.sessionId))?.systemPrompt ?? "";
    check("ordinary session keeps Pi default preamble", ordinaryPrompt.includes("expert coding assistant"), concise(ordinaryPrompt, 60));
    check("ordinary session has NO assistant preamble/segment", !ordinaryPrompt.includes("随身助手") && !ordinaryPrompt.includes("<assistant>"), "");
    check("ordinary session has no assistant tools", !ordinaryPrompt.includes("search_sessions"), "");

    // -- 4. list_projects + cross-project coverage over that real history ----
    const turn2 = await ws.submitFenced(assistant.sessionId, "先用 list_projects 看一下有哪些项目，然后告诉我最近各项目有啥进展。", "e2e-a2");
    check("assistant turn2 terminal state", turn2.payload.state === "completed", turn2.payload.state);
    await ws.waitFor((m) => m.type === "event" && m.payload?.type === "agent_settled" && m.payload.sessionId === assistant.sessionId, "agent_settled a2", 30_000);
    // The authoritative record of the turn is the session transcript: the
    // list_projects invocation, its bounded project row, and the final answer
    // covering all projects by default (the assistant was never told which
    // project — coverage comes from its tools, not the prompt).
    const assistantJsonl = readAssistantJsonl(agentDir, assistant.sessionId);
    // Pi persists a tool call as {type:"toolCall", name}; toolName is the protocol field and is absent from the session JSONL.
    check("list_projects really invoked with the project row", /"name":"list_projects"/.test(assistantJsonl) && assistantJsonl.includes("demo-project｜/Users/proxy/pixa5-e2e-projects/demo-project"), "");
    check("cross-project answer covers the real project session", assistantJsonl.includes("demo-project") && assistantJsonl.includes("部署"), "answer read from the transcript");

    // -- 5. reload: same dirs, same conversation, role prompt survives ---------
    await stack.proc.stop();
    await delay(1_000);
    const stack2 = await boot();
    try {
      const ws2 = new Ws(origin.replace(/^http/, "ws") + "/v1/runtime");
      await ws2.connect();
      await ws2.handshake();
      const attachId = `attach-${Date.now()}`;
      ws2.send({ type: "attach", id: attachId, payload: { sessionId: assistant.sessionId } });
      await ws2.waitFor((m) => (m.type === "snapshot" && m.id === attachId) || (m.type === "response" && m.id === attachId), "attach after reload", 40_000);
      await ws2.submitFenced(assistant.sessionId, "再确认一下：你是谁，工作目录是做什么的？一句话。", "e2e-a3");
      const prompt3 = (await currentState(ws2, assistant.sessionId))?.systemPrompt ?? "";
      check("after reload the role prompt persists", prompt3.includes("你是 Pixie，用户在 Pix 里的随身助手") && !prompt3.includes("expert coding assistant"), concise(prompt3, 60));
      ws2.close();
    } finally {
      await stack2.proc.stop();
    }
  } finally {
    if (stack) await stack.proc.stop();
    await rm(temp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`FAILED: ${f.name} :: ${f.detail}`);
    process.exitCode = 1;
  }
}

/** Full transcript text of one session (per-cwd subdir layout). */
function readAssistantJsonl(agentDir, sessionId) {
  const sessionsRoot = join(agentDir, "sessions");
  for (const name of readdirSync(sessionsRoot, { recursive: true })) {
    if (!String(name).endsWith(".jsonl")) continue;
    const text = readFileSync(join(sessionsRoot, String(name)), "utf8");
    if (text.includes(sessionId)) return text;
  }
  return "";
}

function concise(text, max) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

main().catch((error) => {
  console.error("E2E fatal:", error);
  process.exitCode = 1;
});
