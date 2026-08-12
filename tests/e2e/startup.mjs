import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const STEP_TIMEOUT_MS = 12_000;
const PROD_MAX_UPLOAD = 25 * 1024 * 1024;

// D3A-1 frozen capability surfaces. The resource layer (files/git/watch/upload)
// is mounted on the Host and stays advertised in BOTH states; `agent` (the
// runtime) and `sessions` (read-only history catalog) are added only while
// sessiond is up. `worktree` is never advertised.
const FULL_CAPS = ["agent", "sessions", "files", "files.write", "files.watch", "files.upload", "git"];
const DEGRADED_CAPS = ["files", "files.write", "files.watch", "files.upload", "git"];

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
  assert.equal(response.status, 200, `${url} should return 200 (got ${response.status})`);
  return await response.json();
}

// Open a real WS /v1/runtime handshake and resolve with the handshake_ack
// payload. Used to prove the WS capability projection agrees with HTTP.
async function runtimeAck(origin, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const url = origin.replace(/^http/, "ws") + "/v1/runtime";
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
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
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "handshake_ack") finish(resolve, msg.payload);
      else if (msg.type === "handshake_reject") finish(reject, new Error(`handshake rejected: ${JSON.stringify(msg.payload)}`));
    });
    ws.on("error", (error) => finish(reject, error));
  });
}

// Wait until all four capability surfaces (health/capabilities/bootstrap/WS)
// agree on the expected projection after a sessiond state change.
async function waitForCaps(origin, running, { sessiond, caps }) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`Host exited while waiting for capabilities\n${running.output().stdout}\n${running.output().stderr}`);
    }
    try {
      const [health, capBody, bootstrap] = await Promise.all([
        fetchJson(`${origin}/v1/health`),
        fetchJson(`${origin}/v1/capabilities`),
        fetchJson(`${origin}/v1/bootstrap`),
      ]);
      const httpAgrees =
        health.sessiond === sessiond &&
        JSON.stringify(health.capabilities) === JSON.stringify(caps) &&
        JSON.stringify(capBody.capabilities) === JSON.stringify(caps) &&
        JSON.stringify(bootstrap.capabilities) === JSON.stringify(caps) &&
        bootstrap.sessiond === sessiond;
      if (httpAgrees) {
        // The WS handshake (the fourth surface) must agree too.
        const ack = await runtimeAck(origin);
        if (JSON.stringify(ack.host.capabilities) === JSON.stringify(caps)) return ack;
        last = { ws: ack.host.capabilities };
      } else {
        last = { health, capBody, bootstrap };
      }
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`Host did not project ${JSON.stringify(caps)} (sessiond=${sessiond}): ${JSON.stringify(last)}`);
}

// Best-effort: open the SSE file-watch stream and read until the initial
// `connected` event, then abort. Proves the watch service is live.
async function readWatchConnected(origin, filePath, { timeoutMs = 3_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${origin}/v1/files/watch?path=${encodeURIComponent(filePath)}`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200, "watch should return 200");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.ok(value, "watch stream must yield an initial frame");
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: connected/, "watch must emit a connected event");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
  return JSON.parse(await (await import("node:fs/promises")).readFile(lockFile, "utf8"));
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

// Build a throwaway git project under a temp dir and return its path. Resource
// operations (read/upload/git/watch/worktree) target this, never the repo.
function makeProjectFixture() {
  const base = mkdtempSync(join(tmpdir(), "pix-proj-e2e-"));
  git(base, ["init", "-q"]);
  git(base, ["config", "user.email", "e2e@example.com"]);
  git(base, ["config", "user.name", "E2E"]);
  writeFileSync(join(base, "README.md"), "# pix e2e project\n");
  git(base, ["add", "README.md"]);
  git(base, ["commit", "-qm", "initial"]);
  // Return the REALPATH: the Host canonicalizes allowed roots via realpath, so
  // every query/assertion must use the canonical form (macOS /var ↔ /private/var).
  return realpathSync(base);
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
  const project = makeProjectFixture();
  const env = {
    ...process.env,
    PIX_SESSIOND_DIR: runtimeDir,
    PIX_CLIENT_DIST: join(ROOT, "packages", "client", "dist"),
    // D3A-1: freeze the allowed root to the throwaway project so resource
    // operations never touch the repository working tree.
    PIX_ALLOWED_ROOTS: project,
  };
  let firstHost;
  let secondHost;
  let sessiondPid;

  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const readme = join(project, "README.md");

    // ---- phase 1: start product (host + sessiond); sessiond up ------------
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
    assert.equal(health.sessiond, "up");
    assert.deepEqual(health.capabilities, FULL_CAPS, "up ⇒ full caps incl. agent + resource surface");

    // Four capability surfaces must agree while up.
    const upAck = await waitForCaps(origin, firstHost, { sessiond: "up", caps: FULL_CAPS });
    assert.equal(upAck.limits.maxUpload, PROD_MAX_UPLOAD, "WS maxUpload must mirror the 25 MiB resource limit");

    const firstLock = await readLock(lockFile);
    sessiondPid = firstLock.pid;
    assert.equal(typeof sessiondPid, "number");
    assert.equal(pidAlive(sessiondPid), true);

    // ---- roots / files / git / watch while up ----------------------------
    const roots = await fetchJson(`${origin}/v1/cwd/roots`);
    assert.deepEqual(roots.roots, [project], "roots are canonicalized to the configured project");
    assert.equal(roots.defaultCwd, project, "defaultCwd is the first configured root canonical");

    const read = await fetchJson(`${origin}/v1/files?path=${encodeURIComponent(readme)}&op=read`);
    assert.match(read.content, /pix e2e project/);

    const gitStatus = await fetchJson(`${origin}/v1/git/status?cwd=${encodeURIComponent(project)}`);
    assert.equal(gitStatus.isGitRepository, true);
    assert.equal(gitStatus.repositoryRoot, project);

    await readWatchConnected(origin, readme);

    // status CLI reflects a healthy sessiond on the captured pid.
    const statusBefore = await runProcess(["scripts/product-entry.mjs", "cli", "status"], env);
    assert.equal(statusBefore.code, 0, statusBefore.stderr);
    assert.match(statusBefore.stdout, /sessiond: running \(healthy\)/);
    assert.match(statusBefore.stdout, new RegExp(`pid: ${sessiondPid}\\b`));

    // ---- phase 2: host restart reuses sessiond; caps stay consistent ------
    await stopHost(firstHost);
    firstHost = undefined;
    assert.equal(pidAlive(sessiondPid), true, "sessiond must survive Host exit");
    assert.equal((await readLock(lockFile)).pid, sessiondPid);

    secondHost = startProcess([
      "packages/cli/bin/pix-host.mjs",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env);
    await waitForHealthy(origin, secondHost);
    await waitForCaps(origin, secondHost, { sessiond: "up", caps: FULL_CAPS });
    assert.equal((await readLock(lockFile)).pid, sessiondPid, "Host restart must reuse sessiond PID");

    // ---- phase 3: resource writes (upload) work while up ------------------
    const form = new FormData();
    form.append("files", new Blob(["uploaded by e2e\n"]), "e2e-upload.txt");
    const upload = await fetch(`${origin}/v1/files?path=${encodeURIComponent(project)}`, { method: "POST", body: form });
    assert.equal(upload.status, 201, `upload should succeed while up (got ${upload.status})`);
    const uploadBody = await upload.json();
    assert.deepEqual(uploadBody.uploaded, ["e2e-upload.txt"]);
    const uploaded = await fetchJson(`${origin}/v1/files?path=${encodeURIComponent(join(project, "e2e-upload.txt"))}&op=read`);
    assert.match(uploaded.content, /uploaded by e2e/);

    // ---- phase 4: sessiond down while Host runs --------------------------
    const down = await runProcess(["scripts/product-entry.mjs", "cli", "down", "--all"], env);
    assert.equal(down.code, 0, `${down.stdout}\n${down.stderr}`);
    assert.match(down.stdout, new RegExp(`terminated \\(pid ${sessiondPid}\\)`));

    // Four surfaces degrade to the resource-only surface (no agent, no worktree).
    const downAck = await waitForCaps(origin, secondHost, { sessiond: "down", caps: DEGRADED_CAPS });
    assert.equal(downAck.limits.maxUpload, PROD_MAX_UPLOAD, "degraded WS still advertises the 25 MiB upload ceiling");

    // Resources stay usable while the authority is down: file read + upload
    // are pure Host-mounted filesystem ops and are NOT runtime-guarded.
    const downRead = await fetchJson(`${origin}/v1/files?path=${encodeURIComponent(readme)}&op=read`);
    assert.match(downRead.content, /pix e2e project/);
    const downForm = new FormData();
    downForm.append("files", new Blob(["uploaded while down\n"]), "e2e-down-upload.txt");
    const downUpload = await fetch(`${origin}/v1/files?path=${encodeURIComponent(project)}`, { method: "POST", body: downForm });
    assert.equal(downUpload.status, 201, "file upload must remain available while sessiond is down");

    // A sessiond-dependent worktree write must 503 BEFORE touching the repo,
    // regardless of `force`. This is the mutation guard.
    const worktreeCreate = await fetch(`${origin}/v1/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, branch: "should-not-create" }),
    });
    assert.equal(worktreeCreate.status, 503, "worktree create must 503 while sessiond is down");
    assert.equal((await worktreeCreate.json()).code, "MUTATION_UNAVAILABLE");
    assert.throws(() => git(project, ["show-ref", "--verify", "refs/heads/should-not-create"]), "guard must run before any git side effect");

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
      upCaps: FULL_CAPS,
      degradedCaps: DEGRADED_CAPS,
      wsMaxUpload: PROD_MAX_UPLOAD,
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
    rmSync(project, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[pix:e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
