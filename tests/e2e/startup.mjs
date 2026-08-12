import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const STEP_TIMEOUT_MS = 12_000;

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function freePort() {
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

function startProcess(args, env, stdio = ["ignore", "pipe", "pipe"]) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForExit(child, timeoutMs = STOP_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process ${child.pid ?? "?"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runProcess(args, env, timeoutMs = STOP_TIMEOUT_MS) {
  const running = startProcess(args, env);
  const result = await waitForExit(running.child, timeoutMs);
  const output = running.output();
  return { ...result, ...output };
}

async function waitForHealthy(origin, running) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      const output = running.output();
      throw new Error(
        `Host exited before readiness (code=${running.child.exitCode}, signal=${running.child.signalCode})\n` +
          `${output.stdout}\n${output.stderr}`,
      );
    }
    try {
      const response = await fetch(`${origin}/v1/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const output = running.output();
  throw new Error(
    `Host did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}\n` +
      `${output.stdout}\n${output.stderr}`,
  );
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} should return 200`);
  return await response.json();
}

// X1 honest-capability regression: open a real WS /v1/runtime handshake and
// resolve with the handshake_ack payload (bounded + robustly closed).
async function runtimeAck(origin, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const url = origin.replace(/^http/, "ws") + "/v1/runtime";
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`runtime WS handshake timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "handshake",
          payload: { protocolVersion: 1, client: { shell: "web", platform: "mac" }, features: [] },
        }),
      );
    });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "handshake_ack") {
        finish(resolve, msg.payload);
      } else if (msg.type === "handshake_reject") {
        finish(reject, new Error(`handshake rejected: ${JSON.stringify(msg.payload)}`));
      }
    });
    ws.on("error", (error) => finish(reject, error));
  });
}

// Wait until health/capabilities/bootstrap all project [] after sessiond goes
// down while the Host keeps running.
async function waitForEmptyCapabilities(origin, running) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(
        `Host exited while waiting for empty capabilities\n${running.output().stdout}\n${running.output().stderr}`,
      );
    }
    try {
      const [health, caps, bootstrap] = await Promise.all([
        fetchJson(`${origin}/v1/health`),
        fetchJson(`${origin}/v1/capabilities`),
        fetchJson(`${origin}/v1/bootstrap`),
      ]);
      const allEmpty =
        health.sessiond === "down" &&
        Array.isArray(health.capabilities) && health.capabilities.length === 0 &&
        Array.isArray(caps.capabilities) && caps.capabilities.length === 0 &&
        Array.isArray(bootstrap.capabilities) && bootstrap.capabilities.length === 0;
      if (allEmpty) return;
      last = { health, caps, bootstrap };
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`Host did not project [] capabilities after sessiond down: ${JSON.stringify(last)}`);
}

async function stopHost(running) {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill("SIGTERM");
  }
  const result = await waitForExit(running.child);
  assert.equal(result.code, 0, `Host should exit 0 after SIGTERM (signal=${result.signal})`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLock(lockFile) {
  return JSON.parse(await readFile(lockFile, "utf8"));
}

async function main() {
  const clientIndex = join(ROOT, "packages", "client", "dist", "index.html");
  const cliDist = join(ROOT, "packages", "cli", "dist", "index.js");
  if (!existsSync(clientIndex) || !existsSync(cliDist)) {
    throw new Error("pix startup E2E requires built artifacts; run `npm run build` first");
  }

  const temp = await mkdtemp(join(tmpdir(), "pix-startup-e2e-"));
  const runtimeDir = join(temp, "sessiond");
  const lockFile = join(runtimeDir, "sessiond.lock");
  const socketFile = join(runtimeDir, "sessiond.sock");
  const env = {
    ...process.env,
    PIX_SESSIOND_DIR: runtimeDir,
    PIX_CLIENT_DIST: join(ROOT, "packages", "client", "dist"),
  };
  let firstHost;
  let secondHost;
  let sessiondPid;

  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;

    // Exercise the exact root product dispatcher used by `npm run start`.
    firstHost = startProcess([
      "scripts/product-entry.mjs",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env);

    const health = await waitForHealthy(origin, firstHost);
    assert.deepEqual(health, {
      ok: true,
      service: "pix-host",
      sessiond: "up",
      // X1: agent is honest when sessiond is healthy (R2 production factory).
      capabilities: ["agent"],
    });

    const capabilities = await fetchJson(`${origin}/v1/capabilities`);
    assert.deepEqual(capabilities, { ok: true, sessiond: "up", capabilities: ["agent"] });

    const bootstrap = await fetchJson(`${origin}/v1/bootstrap`);
    assert.equal(bootstrap.ok, true);
    assert.equal(bootstrap.service, "pix-host");
    assert.equal(bootstrap.protocolVersion, 1);
    assert.equal(bootstrap.sessiond, "up");
    assert.deepEqual(bootstrap.capabilities, ["agent"]);

    const indexResponse = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
    assert.equal(indexResponse.status, 200);
    const html = await indexResponse.text();
    assert.match(html, /<title>pix<\/title>/i);
    const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
    assert(asset, "Vite index should reference a JavaScript asset");
    const assetResponse = await fetch(`${origin}${asset}`);
    assert.equal(assetResponse.status, 200);

    const firstLock = await readLock(lockFile);
    sessiondPid = firstLock.pid;
    assert.equal(typeof sessiondPid, "number");
    assert.equal(pidAlive(sessiondPid), true);

    const statusBefore = await runProcess(["scripts/product-entry.mjs", "cli", "status"], env);
    assert.equal(statusBefore.code, 0, statusBefore.stderr);
    assert.match(statusBefore.stdout, /sessiond: running \(healthy\)/);
    assert.match(statusBefore.stdout, new RegExp(`pid: ${sessiondPid}\\b`));

    await stopHost(firstHost);
    firstHost = undefined;
    assert.equal(pidAlive(sessiondPid), true, "sessiond must survive Host exit");
    assert.equal((await readLock(lockFile)).pid, sessiondPid);

    // Restart only the Host through the dedicated production bin. It must reuse
    // the same session authority rather than spawning another daemon.
    secondHost = startProcess([
      "packages/cli/bin/pix-host.mjs",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env);
    const restartedHealth = await waitForHealthy(origin, secondHost);
    assert.equal(restartedHealth.sessiond, "up");
    assert.deepEqual(restartedHealth.capabilities, ["agent"]);
    assert.equal((await readLock(lockFile)).pid, sessiondPid, "Host restart must reuse sessiond PID");

    // X1 honest-capability regression: the WS /v1/runtime handshake must agree
    // with the HTTP projection. sessiond up → a real WS handshake acks ["agent"].
    const upAck = await runtimeAck(origin);
    assert.deepEqual(upAck.host.capabilities, ["agent"]);

    // Stop sessiond WHILE the Host keeps running (the Host only tears down on a
    // signal). The Host stays alive and must now honestly project [] over HTTP.
    const down = await runProcess(["scripts/product-entry.mjs", "cli", "down", "--all"], env);
    assert.equal(down.code, 0, `${down.stdout}\n${down.stderr}`);
    assert.match(down.stdout, new RegExp(`terminated \\(pid ${sessiondPid}\\)`));

    await waitForEmptyCapabilities(origin, secondHost);

    // A NEW WS handshake, with sessiond down, must honestly ack [] — never ["agent"].
    const downAck = await runtimeAck(origin);
    assert.deepEqual(downAck.host.capabilities, []);

    // Now stop the Host; sessiond is already down.
    await stopHost(secondHost);
    secondHost = undefined;

    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && (existsSync(lockFile) || pidAlive(sessiondPid))) {
      await delay(50);
    }
    assert.equal(existsSync(lockFile), false, "down --all must remove the lock");
    if (process.platform !== "win32") {
      assert.equal(existsSync(socketFile), false, "down --all must remove the Unix socket");
    }
    assert.equal(pidAlive(sessiondPid), false, "down --all must stop sessiond");

    const finalStatus = await runProcess(["scripts/product-entry.mjs", "cli", "status"], env);
    assert.equal(finalStatus.code, 0, finalStatus.stderr);
    assert.match(finalStatus.stdout, /sessiond: not running/);

    console.log(JSON.stringify({
      ok: true,
      port,
      sessiondPid,
      hostRestartReusedSessiond: true,
      wsAckUp: upAck.host.capabilities,
      wsAckDown: downAck.host.capabilities,
      asset,
    }));
  } finally {
    for (const running of [firstHost, secondHost]) {
      if (running?.child && running.child.exitCode === null && running.child.signalCode === null) {
        running.child.kill("SIGTERM");
        await waitForExit(running.child, 2_000).catch(() => {
          running.child.kill("SIGKILL");
        });
      }
    }
    if (sessiondPid && pidAlive(sessiondPid)) {
      process.kill(sessiondPid, "SIGTERM");
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && pidAlive(sessiondPid)) await delay(50);
      if (pidAlive(sessiondPid)) process.kill(sessiondPid, "SIGKILL");
    }
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[pix:e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
