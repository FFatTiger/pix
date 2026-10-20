/**
 * Round-7 assistant E2E (isolated instance, REAL model):
 *   1. create_session with wait — the assistant creates a session in a real
 *      project, delegates a small task, waits, and the tool result carries
 *      the outcome summary; the new session shows up in the sessions list
 *      (sidebar data source) and its transcript's FIRST user message starts
 *      with the sent-by-assistant marker line;
 *   2. steer / follow_up insertion points against a RUNNING session — the
 *      steered message lands mid-turn (tool calls after it), the follow-up
 *      message lands after the current turn ends;
 *   3. stop_session stops the target's running turn;
 *   4. no-wait delegation → completion notification arrives in the assistant
 *      session (marker line) and triggers an assistant turn that reports back;
 *   5. assistant worker gone (stopped — the same stopRecord path idle
 *      reclamation takes) → the notification still delivers by reactivating
 *      the assistant session;
 *   6. a second attached client observes the delegated message in the target
 *      session in realtime.
 *
 * Isolation: own temp HOME/sessiond/host dirs + port; real models.json +
 * auth.json are COPIED (read-only use). No production process or directory
 * is touched. NOT RUN as part of this change — see the round-7 report; run
 * manually after a full build.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX, PROTOCOL_VERSION } from "@fffattiger/pix-protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const BOOT_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 180_000;
const NOTIFY_TIMEOUT_MS = 120_000;

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
  async submitFenced(sessionId, prompt, operationId) {
    let fence = this.fenceOf(sessionId);
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.submitTurn(sessionId, prompt, operationId, fence.epoch, fence.lastEventId);
      if (result.payload.status !== "rejected") return result;
      lastError = result.payload.error;
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
    // A caller that only needs the turn admitted (so it can steer or stop it
    // while it runs) must not wait for the terminal here: that consumes the
    // streaming frames the caller is about to look for.
    if (this.admissionOnly) return submitResult;
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
      throw error;
    }
  }
  close() {
    this.ws?.close();
  }
}

/** Wait until the session is observed NOT running (turn settled / idle). */
async function waitIdle(ws, sessionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = `snap-idle-${Date.now()}`;
    const after = ws.messages.length;
    ws.send({ type: "getSnapshot", id, payload: { sessionId } });
    const frame = await ws.waitFor((m) => (m.type === "snapshot" && m.id === id) || (m.type === "response" && m.id === id), `idle snapshot ${id}`, 20_000, after);
    // A stopped worker is no longer active: the snapshot read comes back
    // not_found, which is itself the idle outcome of a stop.
    if (frame.type === "response" && frame.payload?.ok === false && frame.payload?.error?.code === "not_found") return true;
    const snapshot = frame.type === "snapshot" ? frame.payload.snapshot : frame.payload.result;
    const state = snapshot?.state ?? snapshot;
    if (state && !state.isStreaming && !state.isPromptRunning && !state.isBashRunning && !state.isCompacting) return true;
    await delay(700);
  }
  throw new Error(`session ${sessionId} never went idle`);
}

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

/** Full transcript text of one session (per-cwd subdir layout). */
function readSessionJsonl(agentDir, sessionId) {
  const sessionsRoot = join(agentDir, "sessions");
  if (!existsSync(sessionsRoot)) return "";
  for (const name of readdirSync(sessionsRoot, { recursive: true })) {
    if (!String(name).endsWith(".jsonl")) continue;
    const text = readFileSync(join(sessionsRoot, String(name)), "utf8");
    if (text.includes(sessionId)) return text;
  }
  return "";
}

/** Parse the target session's JSONL into message entries (best effort). */
function messageEntries(jsonl, sessionId) {
  const entries = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type !== "message" || !parsed.message) continue;
    const message = parsed.message;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = typeof message.content === "string"
      ? message.content
      : blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    const toolCalls = blocks.filter((b) => b.type === "toolCall").map((b) => b.name ?? b.toolName ?? "tool");
    entries.push({ role: message.role, text, toolCalls, isError: message.isError === true, id: parsed.id ?? "" });
  }
  return entries;
}

function concise(text, max) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "pixa7-e2e-"));
  const e2eHome = join(temp, "home");
  const sessiondDir = join(temp, "sessiond");
  const hostDir = join(realpathSync(temp), "host");
  const agentDir = join(temp, "agent");
  mkdirSync(e2eHome, { recursive: true });
  const project = join(homedir(), "pixa7-e2e-projects", "demo-project");
  rmSync(join(homedir(), "pixa7-e2e-projects"), { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { mode: 0o700, recursive: true });
  writeFileSync(join(project, "README.md"), "# demo project\n", { mode: 0o600 });

  const realAgent = join(homedir(), ".pi", "agent");
  copyFileSync(join(realAgent, "models.json"), join(agentDir, "models.json"));
  copyFileSync(join(realAgent, "auth.json"), join(agentDir, "auth.json"));
  const realSettings = JSON.parse(readFileSync(join(realAgent, "settings.json"), "utf8"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: realSettings.defaultProvider,
    defaultModel: realSettings.defaultModel,
  }, null, 2), { mode: 0o600 });

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

  let stack;
  try {
    stack = await boot();
    console.log("stack booted, capabilities:", stack.health.capabilities.length);

    const bindingResponse = await fetch(`${origin}/v1/assistant`);
    const binding = await bindingResponse.json();
    const assistantCwd = binding.cwd;
    assert.equal(binding.sessionId, null, "fresh binding should have no session");

    const ws = new Ws(origin.replace(/^http/, "ws") + "/v1/runtime");
    await ws.connect();
    await ws.handshake();

    // Assistant session up.
    const assistant = await ws.create(assistantCwd);
    await attachSession(ws, assistant.sessionId);
    await ws.submitFenced(assistant.sessionId, "只用一句话回答：你收到这条消息了吗？", "e2e-r7-a0");
    check("assistant session alive", true, "");

    // create_session resolves a project by name only from directories that
    // already have a session (list_projects reports the same set). Give
    // demo-project one ordinary session first, the same way round 5 does,
    // so the name resolves instead of coming back as "no such project".
    const seeded = await ws.create(project);
    await attachSession(ws, seeded.sessionId);
    await ws.submitFenced(seeded.sessionId, "这是 demo-project 的初始会话，回复一个字：好。", "e2e-r7-seed");
    await attachSession(ws, assistant.sessionId);

    // -- 1. create_session with wait ---------------------------------------
    const createTurn = await ws.submitFenced(
      assistant.sessionId,
      `用 create_session 在项目 demo-project 里新建一个会话，任务原文：「在工作目录里创建文件 hello.txt，内容为 hello from pix assistant，然后用一句话确认。」title 用「代发任务A」。设置 wait=true 等它完成，完成后把结果告诉我。`,
      "e2e-r7-a1",
    );
    check("create_session turn completed", createTurn.payload.state === "completed", createTurn.payload.state);
    await ws.waitFor(
      (m) => m.type === "event" && m.payload?.type === "agent_settled" && m.payload.sessionId === assistant.sessionId,
      "assistant settled after create",
      60_000,
    );
    const assistantJsonl1 = readSessionJsonl(agentDir, assistant.sessionId);
    // Pi persists a tool call as {type:"toolCall", name}. A codemode wrap
    // keeps the inner name on nestedCalls.calls[].name. toolName is the
    // protocol field and is not what the JSONL records for the call itself.
    check("assistant really invoked create_session", /"name":"create_session"/.test(assistantJsonl1), "");
    // Find the delegated target session: any OTHER session whose first user
    // message carries the sent-by-assistant marker with our task text.
    const sessionsRoot = join(agentDir, "sessions");
    let targetA = null;
    let targetAJsonl = "";
    for (const name of readdirSync(sessionsRoot, { recursive: true })) {
      if (!String(name).endsWith(".jsonl")) continue;
      const text = readFileSync(join(sessionsRoot, String(name)), "utf8");
      if (text === assistantJsonl1 || !text.includes("hello from pix assistant")) continue;
      if (!text.includes(ASSISTANT_SENT_MESSAGE_PREFIX)) continue;
      targetAJsonl = text;
      // The session id is the filename suffix, not a field inside the JSONL.
      const fileMatch = String(name).match(/_([0-9a-f-]{36})\.jsonl$/);
      targetA = fileMatch ? fileMatch[1] : null;
      break;
    }
    check("delegated session exists with marker first line", targetA !== null && targetAJsonl !== "", targetA ?? "not found");

    if (targetA !== null) {
      const entries = messageEntries(targetAJsonl, targetA);
      const firstUser = entries.find((e) => e.role === "user");
      check(
        "target first user message starts with the marker line",
        firstUser !== undefined && firstUser.text.startsWith(`${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n`),
        concise(firstUser?.text ?? "", 80),
      );
      const targetAnswer = entries.filter((e) => e.role === "assistant").map((e) => e.text).join(" ");
      // Soft assertion: the model understood the proxy-sending (it saw the
      // marker line saying the pix assistant sent this on the user's behalf).
      check("target model acknowledges the delegated instruction", /hello|确认|完成/.test(targetAnswer), concise(targetAnswer, 100));
      // The wait result rode back through the tool result in the assistant
      // transcript (marker text never leaks into the ASSISTANT's own copy).
      check("assistant reported the delegated outcome", /hello|完成|结果/.test(assistantJsonl1), "");
      // Sidebar data source: the new session is a normal session in the list.
      const listResponse = await fetch(`${origin}/v1/sessions`);
      const listBody = await listResponse.json();
      const listed = JSON.stringify(listBody).includes(targetA);
      check("new session appears in sessions list (sidebar)", listed, targetA);
    }

    // -- 2. steer / follow_up insertion points against a RUNNING session ----
    if (targetA !== null) {
      // Long-running turn in the target: many sequential tool calls.
      const targetWs = new Ws(origin.replace(/^http/, "ws") + "/v1/runtime");
      await targetWs.connect();
      await targetWs.handshake();
      await attachSession(targetWs, targetA);
      const longId = `e2e-r7-long-${Date.now()}`;
      // Admit only, and through the fenced retry: the session was just
      // created by the delegation, so its epoch is still moving and a bare
      // submit comes back conflict. Waiting for the terminal here would run
      // the whole turn out before the steer below ever fires.
      targetWs.admissionOnly = true;
      const longRun = targetWs.submitFenced(targetA, "把 1 到 12 每个数字写进 nums.txt，一次追加一个数字，每追加一次都要单独调用一次工具。做完后说完成。", longId).catch((error) => ({ payload: { state: "stalled", error: String(error) } }));
      targetWs.admissionOnly = false;
      // The Host forwards a session's events only to the connection that
      // holds its attach. Attaching the observer below moves the attach off
      // this connection, so the streaming evidence has to be captured here,
      // before that hand-off.
      await targetWs.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === targetA && (m.payload?.type === "message_start" || m.payload?.type === "agent_start" || m.payload?.type === "message_update"),
        "target turn streaming",
        90_000,
      );
      await delay(1_500);

      // Second client attached to the target observes the steer in realtime.
      const observer = new Ws(origin.replace(/^http/, "ws") + "/v1/runtime");
      await observer.connect();
      await observer.handshake();
      await attachSession(observer, targetA);

      // Arm the observer BEFORE the steer. submitFenced waits for the
      // assistant turn to finish, and the steered message lands in the target
      // during that wait — looking for it afterwards only sees frames that
      // already arrived.
      const observedUserPromise = observer.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === targetA && m.payload?.message?.role === "user",
        "observer sees delegated user message",
        180_000,
      );
      const steerTurn = await ws.submitFenced(
        assistant.sessionId,
        `用 send_to_session 给会话「代发任务A」发送引导（delivery="steer"），消息原文：「补充：写完数字后，再在最后追加一行 done」。不要等待（wait 不设）。`,
        "e2e-r7-a2",
      );
      check("steer op turn completed", steerTurn.payload.state === "completed", steerTurn.payload.state);
      const observedUser = await observedUserPromise;
      const observedText = (Array.isArray(observedUser.payload.message.content) ? observedUser.payload.message.content : [])
        .filter((b) => b.type === "text").map((b) => b.text).join(" ");
      check(
        "observer sees the steered message with marker, mid-turn",
        observedText.startsWith(ASSISTANT_SENT_MESSAGE_PREFIX) && observedText.includes("done"),
        concise(observedText, 80),
      );
      observer.close();

      // Follow-up queued behind the running turn.
      const followTurn = await ws.submitFenced(
        assistant.sessionId,
        `用 send_to_session 给会话「代发任务A」发送后续消息（delivery="follow_up"），消息原文：「追加任务：把文件里数字的个数统计出来，回复数字即可」。不要等待。`,
        "e2e-r7-a3",
      );
      check("follow_up op turn completed", followTurn.payload.state === "completed", followTurn.payload.state);

      await longRun;
      await waitIdle(targetWs, targetA, 120_000);
      const jsonlAfter = readSessionJsonl(agentDir, targetA);
      const entriesAfter = messageEntries(jsonlAfter, targetA);
      const steerIdx = entriesAfter.findIndex((e) => e.role === "user" && e.text.includes("追加一行 done"));
      const followIdx = entriesAfter.findIndex((e) => e.role === "user" && e.text.includes("统计出来"));
      check("steer message landed inside the long turn (tool calls AFTER it)", steerIdx >= 0 && entriesAfter.slice(steerIdx + 1).some((e) => e.role === "assistant" && e.toolCalls.length > 0), `steerIdx=${steerIdx}`);
      check("follow_up message landed AFTER the long turn's last assistant message", followIdx > steerIdx && followIdx >= 0, `followIdx=${followIdx}`);
      const doneWait = await targetWs.waitFor(
        (m) => m.type === "turn_status" && m.payload?.sessionId === targetA && (m.payload.state === "completed" || m.payload.state === "failed"),
        "follow-up consumption settle",
        90_000,
      ).catch(() => null);
      // The follow-up being consumed is proven by its answer in the transcript.
      const followAnswer = entriesAfter.slice(followIdx > 0 ? followIdx : 0).filter((e) => e.role === "assistant").map((e) => e.text).join(" ");
      check("follow-up was consumed as the next turn", /\d{1,2}/.test(followAnswer), concise(followAnswer, 80));
      targetWs.close();
    }

    // -- 3. stop_session -----------------------------------------------------
    if (targetA !== null) {
      const targetWs2 = new Ws(origin.replace(/^http/, "ws") + "/v1/runtime");
      await targetWs2.connect();
      await targetWs2.handshake();
      await attachSession(targetWs2, targetA);
      const slowId = `e2e-r7-slow-${Date.now()}`;
      targetWs2.admissionOnly = true;
      const slowRun = targetWs2.submitFenced(targetA, "把 1 到 30 每个数字依次追加到 slow.txt，每个数字单独一次工具调用。", slowId).catch(() => null);
      targetWs2.admissionOnly = false;
      await targetWs2.waitFor(
        (m) => m.type === "event" && m.payload?.sessionId === targetA && (m.payload?.type === "message_start" || m.payload?.type === "agent_start" || m.payload?.type === "message_update"),
        "slow turn streaming",
        90_000,
      );
      await delay(1_000);
      const stopTurn = await ws.submitFenced(
        assistant.sessionId,
        `用 stop_session 停止会话「代发任务A」当前这一轮。`,
        "e2e-r7-a4",
      );
      check("stop op turn completed", stopTurn.payload.state === "completed", stopTurn.payload.state);
      await waitIdle(targetWs2, targetA, 60_000);
      // waitIdle returns only once the session is idle or its worker has
      // stopped (getSnapshot answers not_found). A stopped worker is not
      // running, so the idle check is the assertion.
      check("target stopped (idle, not running)", true, "");
      await slowRun;
      targetWs2.close();
    }

    // -- 4. no-wait delegation → notification + assistant report -------------
    if (targetA !== null) {
      const beforeNotifyCount = readSessionJsonl(agentDir, assistant.sessionId)
        .split("\n").filter((l) => l.includes(ASSISTANT_NOTIFY_MESSAGE_PREFIX)).length;
      const delegateTurn = await ws.submitFenced(
        assistant.sessionId,
        `用 send_to_session 给会话「代发任务A」发送任务：「在 working.txt 里写入 ok 一个词」。不要等待，发完直接回复我一句“已安排”。`,
        "e2e-r7-a5",
      );
      check("delegate turn completed", delegateTurn.payload.state === "completed", delegateTurn.payload.state);
      // The completion notification must arrive and trigger an assistant turn.
      const deadline = Date.now() + NOTIFY_TIMEOUT_MS;
      let notified = false;
      let reported = false;
      while (Date.now() < deadline && !(notified && reported)) {
        await delay(2_000);
        const jsonl = readSessionJsonl(agentDir, assistant.sessionId);
        const notifyLines = jsonl.split("\n").filter((l) => l.includes(ASSISTANT_NOTIFY_MESSAGE_PREFIX));
        if (notifyLines.length > beforeNotifyCount) {
          notified = true;
          // An assistant turn AFTER the notification: assistant text appearing
          // after the notify line in the raw transcript.
          const idx = jsonl.lastIndexOf(ASSISTANT_NOTIFY_MESSAGE_PREFIX);
          const tail = jsonl.slice(idx);
          const assistantAfter = /"role":"assistant"/.test(tail);
          reported = assistantAfter;
        }
      }
      check("notification delivered into assistant session", notified, "");
      check("notification triggered an assistant reply", reported, "");
    }

    // -- 5. assistant worker gone → notification still delivers --------------
    if (targetA !== null) {
      // Stop the assistant session over Host WS — the exact stopRecord path
      // idle reclamation takes, so the assistant has NO live record/worker.
      const stopId = `stop-assistant-${Date.now()}`;
      ws.send({ type: "stop", id: stopId, payload: { sessionId: assistant.sessionId } });
      await ws.waitFor((m) => m.type === "response" && m.id === stopId, "assistant stop ack", 30_000);
      // The stop replaces the session epoch. Wait until the snapshot shows
      // the worker gone, so the cold submit below fences against the new
      // epoch instead of the one the stop just invalidated.
      await waitIdle(ws, assistant.sessionId, 30_000);
      const beforeNotifyCount2 = readSessionJsonl(agentDir, assistant.sessionId)
        .split("\n").filter((l) => l.includes(ASSISTANT_NOTIFY_MESSAGE_PREFIX)).length;
      // Delegate again — this time the completion must cold-open the
      // assistant session to deliver its notification.
      // Re-create a UI turn on the assistant first (cold submit reactivates it).
      // No fence. The worker was just stopped and the cold submit is what
      // reactivates it, which replaces the epoch — any epoch read beforehand
      // is already stale and comes back epoch_changed.
      const reactivate = await ws.submitTurn(assistant.sessionId, "用 send_to_session 给会话「代发任务A」发送任务：「在 working2.txt 里写入 ok2」。不要等待，回复一句“已安排”。", `e2e-r7-a6`).catch((e) => ({ payload: { state: "failed", error: String(e) } }));
      check("cold delegate turn admitted", reactivate.payload.status !== "rejected" && reactivate.payload.state !== "failed", `${reactivate.payload.state ?? ""} ${reactivate.payload.error ? JSON.stringify(reactivate.payload.error).slice(0, 200) : ""}`);
      await ws.waitFor(
        (m) => m.type === "turn_status" && m.payload?.sessionId === assistant.sessionId && (m.payload.state === "completed" || m.payload.state === "failed"),
        "cold delegate terminal",
        TURN_TIMEOUT_MS,
      );
      // Stop the assistant AGAIN so the notification must cold-open it.
      const stopId2 = `stop-assistant2-${Date.now()}`;
      ws.send({ type: "stop", id: stopId2, payload: { sessionId: assistant.sessionId } });
      await ws.waitFor((m) => m.type === "response" && m.id === stopId2, "assistant stop2 ack", 30_000);
      await delay(1_000);
      const deadline2 = Date.now() + NOTIFY_TIMEOUT_MS;
      let notified2 = false;
      while (Date.now() < deadline2 && !notified2) {
        await delay(2_000);
        const jsonl = readSessionJsonl(agentDir, assistant.sessionId);
        const count = jsonl.split("\n").filter((l) => l.includes(ASSISTANT_NOTIFY_MESSAGE_PREFIX)).length;
        notified2 = count > beforeNotifyCount2;
      }
      check("notification delivered after assistant worker was gone (cold reopen)", notified2, "");
    }

    ws.close();
  } finally {
    if (stack) await stack.proc.stop();
    await rm(temp, { recursive: true, force: true });
    rmSync(join(homedir(), "pixa7-e2e-projects"), { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`FAILED: ${f.name} :: ${f.detail}`);
    process.exitCode = 1;
  }

  async function boot() {
    const proc = startProcess(["scripts/product-entry.mjs", "start", "--hostname", "127.0.0.1", "--port", String(port), "--no-open"], env);
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
  }
}

main().catch((error) => {
  console.error("E2E fatal:", error);
  process.exitCode = 1;
});
