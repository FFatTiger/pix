import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync, lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { HostCapabilitiesSchema, PROTOCOL_VERSION } from "@fffattiger/pix-protocol";
import { createSecureStateBackend } from "@fffattiger/pix-local-authority/state";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const STEP_TIMEOUT_MS = 12_000;
const PROD_MAX_UPLOAD = 25 * 1024 * 1024;
const WINDOWS_HOST_CONTROL = new URL("./fixtures/graceful-host-control.mjs", import.meta.url).href;
const WINDOWS_GRACEFUL_SHUTDOWN_MESSAGE = "pix-e2e-graceful-host-shutdown";

// D3A-1 + D3B-R1B + D3A Worktrees frozen capability surfaces. The resource
// layer (files/git/watch/upload + read-only worktree list) and the four catalog
// tokens are mounted on the Host and stay advertised in BOTH states; `agent`
// (the runtime), `sessions` (read-only history), and the three session mutation
// tokens are added only while sessiond is up. `worktree` is the read-only list
// token (no write token). Parse the expected lists through the Protocol owner so
// the E2E cannot invent an out-of-vocabulary capability string.
const FULL_CAPS = HostCapabilitiesSchema.parse([
  "agent",
  "sessions",
  "session.delete",
  "session.write",
  "session.settings",
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
  "worktree",
  "worktree.write",
  "models",
  "auth.providers",
  "skills",
  "plugins",
  "themes",
  "project.trust",
]);
const DEGRADED_CAPS = HostCapabilitiesSchema.parse([
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
  "worktree",
  "models",
  "auth.providers",
  "skills",
  "plugins",
  "themes",
  "project.trust",
]);

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

function startProcess(args, env, stdio = ["ignore", "pipe", "pipe"], { gracefulHost = false } = {}) {
  const useWindowsControl = gracefulHost && process.platform === "win32";
  const execArgs = useWindowsControl ? ["--import", WINDOWS_HOST_CONTROL, ...args] : args;
  const childStdio = useWindowsControl ? [stdio[0], stdio[1], stdio[2], "ipc"] : stdio;
  const child = spawn(process.execPath, execArgs, { cwd: ROOT, env, stdio: childStdio });
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
          payload: { protocolVersion: PROTOCOL_VERSION, client: { shell: "web", platform: "mac" }, features: [] },
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
        const ack = await runtimeAck(origin);
        if (ack.protocolVersion !== PROTOCOL_VERSION) {
          last = { wsVersion: ack.protocolVersion, expected: PROTOCOL_VERSION };
        } else if (JSON.stringify(ack.host.capabilities) === JSON.stringify(caps)) {
          return ack;
        } else {
          last = { ws: ack.host.capabilities };
        }
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
    if (process.platform === "win32") {
      assert.equal(running.child.connected, true, "Windows graceful Host fixture requires IPC control");
      running.child.send(WINDOWS_GRACEFUL_SHUTDOWN_MESSAGE);
    } else {
      running.child.kill("SIGTERM");
    }
  }
  const result = await waitForExit(running.child);
  assert.equal(result.code, 0, `Host should exit 0 after graceful shutdown (signal=${result.signal})`);
}

// SIGKILL a host (crash simulation): the lifetime lock must remain on disk.
async function sigkillHost(running) {
  assert.equal(running.child.exitCode, null, "host must be running before SIGKILL");
  assert.equal(running.child.kill("SIGKILL"), true, "host crash signal must be delivered");
  const result = await waitForExit(running.child);
  if (process.platform !== "win32") {
    assert.equal(result.signal, "SIGKILL", `SIGKILL expected (got signal=${result.signal}, code=${result.code})`);
  } else {
    // Node implements Windows signals with forced termination; its exit event
    // may report a platform exit code instead of the requested POSIX signal.
    assert.ok(result.signal !== null || result.code !== 0, `forced termination must not report clean exit (${JSON.stringify(result)})`);
  }
}

// Run a pix-host to completion (it should exit on its own — failure path) and
// return its exit code + output. Used for "must fail before listen" assertions.
async function runHostToCompletion(env) {
  return await runProcess([
    "packages/cli/bin/pix-host.mjs",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(await freePort()),
    "--no-open",
  ], env);
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
  // realpath only PIX_HOST_DIR (not sessiond dir): macOS `/var` is a symlink and
  // ensurePixHostDir refuses intermediate path-text symlinks. Leave sessiond on
  // the shorter `/var/...` form so the AF_UNIX socket path stays within 104 bytes.
  const hostDir = join(realpathSync(temp), "host");
  // Empty agent dir so gate does not pick up the operator ~/.pi/pix.json password.
  const agentDir = join(temp, "agent");
  const env = {
    ...process.env,
    PIX_SESSIOND_DIR: runtimeDir,
    PIX_CLIENT_DIST: join(ROOT, "packages", "client", "dist"),
    // D3A-1: freeze the allowed root to the throwaway project so resource
    // operations never touch the repository working tree.
    PIX_ALLOWED_ROOTS: project,
    // D3A-P0: isolate the Host durable trusted-roots ledger from the operator home.
    PIX_HOST_DIR: hostDir,
    // Isolate gate/catalog agent dir away from operator ~/.pi.
    PI_CODING_AGENT_DIR: agentDir,
  };
  delete env.PIX_PASSWORD;
  delete env.PIX_GATE_DISABLED;
  delete env.PIX_GATE_CONFIG;
  let firstHost;
  let secondHost;
  let thirdHost;
  let currentHost;
  let sessiondPid;

  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const readme = join(project, "README.md");
    const ledgerPath = join(hostDir, "trusted-roots.json");
    const hostLockPath = join(hostDir, "trusted-roots.lock");

    // ---- phase 1: start product (host + sessiond); sessiond up ------------
    firstHost = startProcess([
      "scripts/product-entry.mjs",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env, ["ignore", "pipe", "pipe"], { gracefulHost: true });

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

    // ---- D3B catalog surface (Client Catalog dock contract) --------------
    const models = await fetchJson(`${origin}/v1/models?cwd=${encodeURIComponent(project)}`);
    assert.equal(Array.isArray(models.models), true, "models must be an array");
    assert.ok("defaultModel" in models, "models response includes defaultModel");
    const providers = await fetchJson(`${origin}/v1/auth/providers`);
    assert.equal(Array.isArray(providers.providers), true);
    if (providers.providers.length > 0) {
      const providerId = providers.providers[0].id;
      const status = await fetchJson(`${origin}/v1/auth/providers/${encodeURIComponent(providerId)}/status`);
      assert.ok(status.status && typeof status.status.providerId === "string");
      assert.equal(typeof status.configured, "boolean");
    }
    const skills = await fetchJson(`${origin}/v1/skills?cwd=${encodeURIComponent(project)}`);
    assert.equal(Array.isArray(skills.skills), true);
    const plugins = await fetchJson(`${origin}/v1/plugins?cwd=${encodeURIComponent(project)}`);
    assert.equal(Array.isArray(plugins.plugins), true);
    const commands = await fetchJson(`${origin}/v1/commands?cwd=${encodeURIComponent(project)}`);
    assert.equal(Array.isArray(commands.commands), true);
    const trust = await fetchJson(`${origin}/v1/trust?cwd=${encodeURIComponent(project)}`);
    assert.equal(trust.cwd, project);
    assert.ok(["unknown", "trusted", "denied"].includes(trust.level));

    // ---- D3B trust-mutation surface (POST /v1/trust) ----------------------
    // Real end-to-end persistence: the production trust-mutation seam writes
    // the agent-dir trust.json through the real Pi SDK trust API and the read
    // surface reflects it immediately. Adversarial probes: strict body, no
    // query surface, out-of-root cwd and unauthorized-shape cwd fail closed
    // with fixed sanitized codes, and the persisted file is owner-only.
    const badQuery = await fetch(`${origin}/v1/trust?cwd=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, level: "trusted" }),
    });
    assert.equal(badQuery.status, 400);
    assert.equal((await badQuery.json()).code, "INVALID_QUERY");

    const badLevel = await fetch(`${origin}/v1/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, level: "denied" }),
    });
    assert.equal(badLevel.status, 400);
    assert.equal((await badLevel.json()).code, "UNSUPPORTED_TRUST_LEVEL");

    const escape = await fetch(`${origin}/v1/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: temp, level: "trusted" }),
    });
    assert.equal(escape.status, 403, "out-of-root cwd must be rejected");

    const mutated = await fetch(`${origin}/v1/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, level: "trusted" }),
    });
    assert.equal(mutated.status, 200);
    const mutatedBody = await mutated.json();
    assert.equal(mutatedBody.cwd, project);
    assert.equal(mutatedBody.level, "trusted");
    assert.equal(mutatedBody.trusted, true);
    assert.deepEqual(mutatedBody.canReloadResources, { allowed: true, level: "trusted" });
    // Read-after-write through the GET surface + real persisted trust.json.
    const trustAfter = await fetchJson(`${origin}/v1/trust?cwd=${encodeURIComponent(project)}`);
    assert.equal(trustAfter.level, "trusted");
    assert.equal(trustAfter.trusted, true);
    // The persisted decision is owned by the Pi profile store. Pix verifies
    // the public ProjectTrustStore result but does not invent or enforce a
    // file-mode contract for Pi-owned trust.json on any platform.
    const persisted = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"));
    assert.equal(persisted[project], true, "real Pi SDK trust.json must carry the decision");

    // ---- D3B-R6 read-only theme catalog surface ---------------------------
    // Real catalog reads: builtin sets are listed/resolved with zero Workers,
    // and strict query/name/mode validation answers fixed sanitized errors.
    const themes = await fetchJson(`${origin}/v1/themes?cwd=${encodeURIComponent(project)}`);
    assert.equal(Array.isArray(themes.themeSets), true, "themeSets must be an array");
    const gruvbox = themes.themeSets.find((set) => set.name === "gruvbox");
    assert.ok(gruvbox && gruvbox.builtin === true && gruvbox.hasDark === true && gruvbox.hasLight === true);
    assert.equal(themes.themeSets.length, 5, "exactly the five built-in sets with an empty agent dir");
    const gruvboxDark = await fetchJson(`${origin}/v1/themes/gruvbox?mode=dark&cwd=${encodeURIComponent(project)}`);
    assert.equal(gruvboxDark.name, "gruvbox");
    assert.equal(gruvboxDark.isDark, true);
    assert.equal(gruvboxDark.cssVars["--bg"], "#282828");
    assert.equal(Object.keys(gruvboxDark.cssVars).length, 29);
    const gruvboxLight = await fetchJson(`${origin}/v1/themes/gruvbox?mode=light&cwd=${encodeURIComponent(project)}`);
    assert.equal(gruvboxLight.isDark, false);
    for (const value of Object.values(gruvboxDark.cssVars)) {
      assert.match(value, /^(?:#[0-9a-f]{3,6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0(?:\.\d+)?|1(?:\.0+)?)\))$/);
    }
    const themesNoCwd = await fetch(`${origin}/v1/themes`);
    assert.equal(themesNoCwd.status, 400);
    assert.equal((await themesNoCwd.json()).code, "CWD_REQUIRED");
    const themesBadMode = await fetch(`${origin}/v1/themes/gruvbox?mode=auto&cwd=${encodeURIComponent(project)}`);
    assert.equal(themesBadMode.status, 400);
    const themesBadName = await fetch(`${origin}/v1/themes/..?cwd=${encodeURIComponent(project)}`);
    assert.ok(themesBadName.status === 400 || themesBadName.status === 404);
    const themesMissing = await fetch(`${origin}/v1/themes/does-not-exist?cwd=${encodeURIComponent(project)}`);
    assert.equal(themesMissing.status, 404);
    assert.equal((await themesMissing.json()).code, "THEME_NOT_FOUND");

    const missingCwd = await fetch(`${origin}/v1/models`);
    assert.equal(missingCwd.status, 400);
    assert.equal((await missingCwd.json()).code, "CWD_REQUIRED");
    assert.equal(existsSync(clientIndex), true);
    assert.equal(existsSync(join(ROOT, "packages", "client", "dist", "assets")), true);

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
    ], env, ["ignore", "pipe", "pipe"], { gracefulHost: true });
    await waitForHealthy(origin, secondHost);
    await waitForCaps(origin, secondHost, { sessiond: "up", caps: FULL_CAPS });
    assert.equal((await readLock(lockFile)).pid, sessiondPid, "Host restart must reuse sessiond PID");
    currentHost = secondHost;

    // ---- phase 3a: resource writes (upload) work while up -----------------
    const form = new FormData();
    form.append("files", new Blob(["uploaded by e2e\n"]), "e2e-upload.txt");
    const upload = await fetch(`${origin}/v1/files?path=${encodeURIComponent(project)}`, { method: "POST", body: form });
    assert.equal(upload.status, 201, `upload should succeed while up (got ${upload.status})`);
    assert.deepEqual((await upload.json()).uploaded, ["e2e-upload.txt"]);

    // ---- phase 3b: managed create → managed sidecar → restart rehydrate ----
    const managedLedgerPath = join(hostDir, "managed-worktrees.json");
    const createWt = await fetch(`${origin}/v1/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, branch: "e2e-managed-a" }),
    });
    assert.equal(createWt.status, 201, `worktree create should succeed while sessiond is up (got ${createWt.status})`);
    const createBody = await createWt.json();
    assert.equal(createBody.managedByPix, true, "create response reports managedByPix:true");
    const managedPath = createBody.path;
    assert.equal(createBody.branch, "e2e-managed-a");
    const beforeRestart = await fetchJson(`${origin}/v1/worktrees?cwd=${encodeURIComponent(project)}`);
    const managedEntry = beforeRestart.worktrees.find((entry) => entry.path === managedPath);
    assert.equal(managedEntry?.authorized, true, "created managed worktree must be authorized before Host restart");
    assert.equal(managedEntry?.managedByPix, true, "created managed worktree reports managedByPix:true");
    assert.equal(existsSync(managedLedgerPath), true, "create must persist the managed-worktrees sidecar");
    assert.equal(existsSync(ledgerPath), true, "trusted-roots.json exists (empty claims)");
    if (process.platform !== "win32") {
      assert.equal(lstatSync(hostDir).mode & 0o777, 0o700, "PIX_HOST_DIR must be mode 0700 on POSIX");
      assert.equal(lstatSync(managedLedgerPath).mode & 0o777, 0o600, "managed-worktrees.json must be mode 0600 on POSIX");
    }
    assert.equal(lstatSync(managedLedgerPath).isSymbolicLink(), false);
    assert.equal(lstatSync(managedLedgerPath).isFile(), true);
    const managedAfterCreate = JSON.parse(readFileSync(managedLedgerPath, "utf8"));
    assert.equal(managedAfterCreate.records.length, 1, "managed sidecar holds the created record");
    assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).claims.length, 0, "NO trusted-root claim for a managed worktree");

    // Graceful Host-only restart rehydrates workspace access, never the
    // destructive ownership token. CP-57 requires a current-process
    // recordCreated() identity before DELETE can advertise managedByPix:true.
    await stopHost(currentHost);
    currentHost = undefined;
    assert.equal(pidAlive(sessiondPid), true, "sessiond must survive Host exit before rehydrate restart");
    assert.equal((await readLock(lockFile)).pid, sessiondPid, "Host-only restart must keep the same sessiond lock pid");
    thirdHost = startProcess([
      "packages/cli/bin/pix-host.mjs",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env, ["ignore", "pipe", "pipe"], { gracefulHost: true });
    await waitForHealthy(origin, thirdHost);
    await waitForCaps(origin, thirdHost, { sessiond: "up", caps: FULL_CAPS });
    assert.equal((await readLock(lockFile)).pid, sessiondPid, "rehydrate Host restart must reuse sessiond PID");
    currentHost = thirdHost;
    const afterRestart = await fetchJson(`${origin}/v1/worktrees?cwd=${encodeURIComponent(project)}`);
    const afterRestartEntry = afterRestart.worktrees.find((entry) => entry.path === managedPath);
    assert.equal(afterRestartEntry?.authorized, true, "managed record must rehydrate + authorize after Host restart");
    assert.equal(afterRestartEntry?.managedByPix, false, "Host restart must not restore destructive managed ownership");
    const managedFile = await fetchJson(`${origin}/v1/files?path=${encodeURIComponent(join(managedPath, "README.md"))}&op=read`);
    assert.match(managedFile.content, /pix e2e project/);

    // ---- phase 3c: strict single Host — a second Host on the SAME PIX_HOST_DIR
    // fails before listen (LEDGER_LOCK_BUSY), with a fixed sanitized error and
    // no ledger/record mutation ---------------------------------------------
    const intruder = await runHostToCompletion(env);
    assert.equal(intruder.code, 1, `second Host must exit 1 before listen (got ${intruder.code})`);
    assert.match(intruder.stderr + intruder.stdout, /PIX_HOST_DIR rejected \(LEDGER_LOCK_BUSY\)/, "fixed sanitized lock-busy error");
    assert.ok(!(intruder.stdout + intruder.stderr).includes("host listening"), "second Host must never reach listen");
    assert.equal(existsSync(hostLockPath), true, "first Host still holds the lifetime lock");
    assert.equal(JSON.parse(readFileSync(managedLedgerPath, "utf8")).records.length, 1, "intruder must not touch the managed sidecar");

    // ---- phase 3d: external (outside base) + planted (inside base) DELETE denied --
    const externalBase = join(project, "..", `pix-e2e-external-${process.pid}`);
    mkdirSync(externalBase, { recursive: true });
    const externalPath = join(externalBase, "external-b");
    git(project, ["worktree", "add", "-b", "e2e-external", "--", externalPath]);
    const plantedPath = join(`${realpathSync(project)}-worktrees`, "planted-b");
    git(project, ["worktree", "add", "-b", "e2e-planted", "--", plantedPath]);
    for (const target of [externalPath, plantedPath]) {
      const denied = await fetch(`${origin}/v1/worktrees`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: project, path: target }),
      });
      assert.equal(denied.status, 403, `external/planted delete must be denied (${target})`);
      assert.equal((await denied.json()).code, "WORKTREE_NOT_MANAGED");
      assert.equal(existsSync(target), true, `external/planted marker retained (${target})`);
    }

    // ---- phase 3e: dirty no-force denied → forced managed delete succeeds ----
    const delWtCreate = await fetch(`${origin}/v1/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, branch: "e2e-delete-me" }),
    });
    assert.equal(delWtCreate.status, 201, `delete-phase worktree create should succeed (got ${delWtCreate.status})`);
    const delWtPath = (await delWtCreate.json()).path;
    assert.equal(JSON.parse(readFileSync(managedLedgerPath, "utf8")).records.length, 2, "managed sidecar holds both records");
    writeFileSync(join(delWtPath, "dirty.txt"), "x");

    // No-force dirty delete → 409 WORKTREE_DIRTY, marker retained.
    const dirtyDelete = await fetch(`${origin}/v1/worktrees`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, path: delWtPath }),
    });
    assert.equal(dirtyDelete.status, 409, "dirty delete without force must be denied");
    assert.equal((await dirtyDelete.json()).code, "WORKTREE_DIRTY");
    assert.equal(existsSync(delWtPath), true, "dirty worktree retained after denied delete");

    const delWt = await fetch(`${origin}/v1/worktrees`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, path: delWtPath, force: true }),
    });
    assert.equal(delWt.status, 200, `forced managed delete should succeed while sessiond is up (got ${delWt.status})`);
    const delBody = await delWt.json();
    assert.equal(delBody.success, true);
    assert.equal(delBody.fallbackCwd, realpathSync(project), "fallbackCwd is the canonical main worktree");
    assert.equal(delBody.branchRetained, true, "branch is retained after forced managed delete");
    assert.equal(existsSync(delWtPath), false, "worktree path removed after forced delete");
    assert.doesNotThrow(() => git(project, ["show-ref", "--verify", "refs/heads/e2e-delete-me"]), "branch retained");
    assert.equal(JSON.parse(readFileSync(managedLedgerPath, "utf8")).records.length, 1, "delete removes only the deleted record");

    // Restart → no resurrection of the deleted managed worktree.
    await stopHost(currentHost);
    currentHost = undefined;
    assert.equal(pidAlive(sessiondPid), true, "sessiond must survive delete-phase Host exit");
    currentHost = startProcess([
      "packages/cli/bin/pix-host.mjs",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env, ["ignore", "pipe", "pipe"], { gracefulHost: true });
    await waitForHealthy(origin, currentHost);
    await waitForCaps(origin, currentHost, { sessiond: "up", caps: FULL_CAPS });
    const afterDeleteRestart = await fetchJson(`${origin}/v1/worktrees?cwd=${encodeURIComponent(project)}`);
    assert.ok(
      !afterDeleteRestart.worktrees.some((entry) => entry.path === delWtPath),
      "deleted managed worktree must NOT be resurrected after Host restart",
    );
    assert.ok(
      afterDeleteRestart.worktrees.some((entry) => entry.path === managedPath && entry.authorized === true && entry.managedByPix === false),
      "the surviving record must rehydrate access without destructive ownership",
    );
    assert.equal(JSON.parse(readFileSync(managedLedgerPath, "utf8")).records.length, 1, "managed sidecar stays at one record after restart");

    // ---- phase 3f: SIGKILL leaves a stale lock → restart fails closed ----
    const managedBytesBeforeSigkill = readFileSync(managedLedgerPath);
    const managedInoBeforeSigkill = lstatSync(managedLedgerPath).ino;
    await sigkillHost(currentHost);
    currentHost = undefined;
    // The stale lifetime lock must remain on disk (no auto-reclaim).
    assert.equal(existsSync(hostLockPath), true, "SIGKILL must leave the stale lifetime lock");
    const staleRestart = await runHostToCompletion(env);
    assert.equal(staleRestart.code, 1, `restart after SIGKILL must fail closed (got ${staleRestart.code})`);
    assert.match(staleRestart.stderr + staleRestart.stdout, /PIX_HOST_DIR rejected \(LEDGER_LOCK_STALE\)/, "fixed sanitized stale-lock error");
    assert.ok(!(staleRestart.stdout + staleRestart.stderr).includes("host listening"), "stale-lock restart must never listen");
    assert.deepEqual(readFileSync(managedLedgerPath), managedBytesBeforeSigkill, "SIGKILL/stale restart must leave the managed sidecar byte-identical");
    assert.equal(lstatSync(managedLedgerPath).ino, managedInoBeforeSigkill, "SIGKILL/stale restart must leave the managed sidecar inode unchanged");

    // Operator explicitly removes the fixture stale lock after proving the old
    // pid is dead (no automatic crash recovery is claimed), then restart works.
    rmSync(hostLockPath, { force: true });
    currentHost = startProcess([
      "packages/cli/bin/pix-host.mjs",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env, ["ignore", "pipe", "pipe"], { gracefulHost: true });
    await waitForHealthy(origin, currentHost);
    await waitForCaps(origin, currentHost, { sessiond: "up", caps: FULL_CAPS });
    const afterRecovery = await fetchJson(`${origin}/v1/worktrees?cwd=${encodeURIComponent(project)}`);
    assert.ok(
      afterRecovery.worktrees.some((entry) => entry.path === managedPath && entry.authorized === true && entry.managedByPix === false),
      "after explicit stale-lock removal, restart restores access but not destructive ownership",
    );

    // ---- phase 3g: a corrupt managed sidecar fails the Host BEFORE listen ----
    await stopHost(currentHost);
    currentHost = undefined;
    // Build the fixture through the same platform secure-state backend used by
    // production. On Windows, mkdir/mode cannot create the required DACL.
    const corruptHostDir = join(realpathSync(temp), "host-corrupt");
    const secureState = createSecureStateBackend();
    const canonicalCorruptHostDir = await secureState.canonicalizePath(corruptHostDir);
    await secureState.ensurePrivateDirectory(canonicalCorruptHostDir, { requireMode: 0o700 });
    await secureState.writeStateDocument(
      join(canonicalCorruptHostDir, "managed-worktrees.json"),
      "{not-json",
      { maxBytes: 1024 * 1024 },
    );
    const corruptEnv = { ...env, PIX_HOST_DIR: canonicalCorruptHostDir };
    const corruptBoot = await runHostToCompletion(corruptEnv);
    assert.equal(corruptBoot.code, 1, "corrupt managed sidecar must fail the Host before listen");
    assert.match(corruptBoot.stderr + corruptBoot.stdout, /PIX_HOST_DIR rejected \(MANAGED_CORRUPT\)/, "fixed sanitized corrupt-managed error");
    assert.ok(!(corruptBoot.stdout + corruptBoot.stderr).includes("host listening"), "corrupt-managed Host must never listen");
    assert.equal(readFileSync(join(canonicalCorruptHostDir, "managed-worktrees.json"), "utf8"), "{not-json", "corrupt sidecar stays immutable");
    assert.equal(existsSync(join(canonicalCorruptHostDir, "trusted-roots.lock")), false, "no lock created for a corrupt managed sidecar");

    // ---- phase 4: sessiond down while Host runs --------------------------
    currentHost = startProcess([
      "packages/cli/bin/pix-host.mjs",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ], env, ["ignore", "pipe", "pipe"], { gracefulHost: true });
    await waitForHealthy(origin, currentHost);
    await waitForCaps(origin, currentHost, { sessiond: "up", caps: FULL_CAPS });
    const down = await runProcess(["scripts/product-entry.mjs", "cli", "down", "--all"], env);
    assert.equal(down.code, 0, `${down.stdout}\n${down.stderr}`);
    assert.match(down.stdout, new RegExp(`terminated \\(pid ${sessiondPid}\\)`));

    // Four surfaces degrade to the resource-only surface: no agent/sessions and
    // NO worktree.write (sessiond-guarded write capability); the read-only
    // worktree list stays advertised.
    const downAck = await waitForCaps(origin, currentHost, { sessiond: "down", caps: DEGRADED_CAPS });
    assert.equal(downAck.limits.maxUpload, PROD_MAX_UPLOAD, "degraded WS still advertises the 25 MiB upload ceiling");
    assert.ok(!DEGRADED_CAPS.includes("worktree.write"), "degraded must exclude worktree.write");
    // D4: session.delete is the sessiond-guarded delete capability — full only.
    assert.ok(FULL_CAPS.includes("session.delete"), "full must include session.delete");
    assert.ok(!DEGRADED_CAPS.includes("session.delete"), "degraded must exclude session.delete");
    // D4: session.write is the sessiond-guarded rename capability — full only.
    assert.ok(FULL_CAPS.includes("session.write"), "full must include session.write");
    assert.ok(!DEGRADED_CAPS.includes("session.write"), "degraded must exclude session.write");

    assert.ok(FULL_CAPS.includes("session.settings"), "full must include session.settings");
    assert.ok(!DEGRADED_CAPS.includes("session.settings"), "degraded must exclude session.settings");

    // Resources stay usable while the authority is down: file read + upload
    // are pure Host-mounted filesystem ops and are NOT runtime-guarded.
    const downRead = await fetchJson(`${origin}/v1/files?path=${encodeURIComponent(readme)}&op=read`);
    assert.match(downRead.content, /pix e2e project/);

    // `worktree` is a read-only list token: the real GET remains available
    // while sessiond is down and returns the main + rehydrated managed topology.
    const downWorktrees = await fetchJson(`${origin}/v1/worktrees?cwd=${encodeURIComponent(project)}`);
    assert.equal(downWorktrees.isGit, true, "worktree GET must remain available while sessiond is down");
    // Themes are sessiond-independent: the degraded host honestly keeps the
    // token AND serves real reads (no sessiond, no Worker).
    const downThemes = await fetchJson(`${origin}/v1/themes?cwd=${encodeURIComponent(project)}`);
    assert.equal(downThemes.themeSets.length, 5, "degraded host still lists built-in themes");
    assert.equal(downWorktrees.isGit, true, "worktree GET must remain available while sessiond is down");
    assert.ok(
      downWorktrees.worktrees.some((entry) => entry.path === managedPath && entry.authorized === true && entry.managedByPix === false),
      "rehydrated worktree must stay accessible without destructive ownership while sessiond is down",
    );
    assert.ok(
      downWorktrees.worktrees.some((entry) => entry.path === externalPath && entry.managedByPix === false),
      "external worktree reports managedByPix:false",
    );
    const downManagedFile = await fetchJson(`${origin}/v1/files?path=${encodeURIComponent(join(managedPath, "README.md"))}&op=read`);
    assert.match(downManagedFile.content, /pix e2e project/);

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

    // The trust mutation is a Host catalog capability and is NOT sessiond-
    // guarded: it keeps working while the Worker authority is down (the seam
    // fail-closes on its own trust-store authority, not on sessiond).
    const downTrust = await fetch(`${origin}/v1/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, level: "trusted" }),
    });
    assert.equal(downTrust.status, 200, "trust mutation must work while sessiond is down");
    assert.equal((await downTrust.json()).level, "trusted");
    const worktreeDelete = await fetch(`${origin}/v1/worktrees`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, path: managedPath, force: true }),
    });
    assert.equal(worktreeDelete.status, 503, "worktree delete must 503 while sessiond is down");
    assert.equal((await worktreeDelete.json()).code, "MUTATION_UNAVAILABLE");
    assert.equal(existsSync(managedPath), true, "guard must run before any git side effect");
    assert.equal(JSON.parse(readFileSync(managedLedgerPath, "utf8")).records.length, 1, "blocked POST/DELETE must not touch the managed sidecar");


    // Now stop the Host (graceful — releases its lifetime lock); sessiond is down.
    await stopHost(currentHost);
    currentHost = undefined;

    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && (existsSync(lockFile) || pidAlive(sessiondPid))) {
      await delay(50);
    }
    assert.equal(existsSync(lockFile), false, "down --all must remove the lock");
    if (process.platform !== "win32") {
      assert.equal(existsSync(socketFile), false, "down --all must remove the Unix socket");
    }
    assert.equal(pidAlive(sessiondPid), false, "down --all must stop sessiond");
    assert.equal(existsSync(hostLockPath), false, "graceful Host shutdown must release the lifetime lock");

    const finalStatus = await runProcess(["scripts/product-entry.mjs", "cli", "status"], env);
    assert.equal(finalStatus.code, 0, finalStatus.stderr);
    assert.match(finalStatus.stdout, /sessiond: not running/);

    console.log(JSON.stringify({
      ok: true,
      port,
      sessiondPid,
      hostRestartReusedSessiond: true,
      managedWorktreesLedger: true,
      hostDirIsolated: true,
      secondHostFailsBeforeListen: true,
      externalAndPlantedDeleteDenied: true,
      deleteNoResurrection: true,
      dirtyRequiresForceAndBranchRetained: true,
      corruptManagedSidecarFailsBeforeListen: true,
      sigkillStaleLockFailsClosed: true,
      explicitStaleLockRemovalRestores: true,
      degradedExcludesWorktreeWrite: true,
      upCaps: FULL_CAPS,
      degradedCaps: DEGRADED_CAPS,
      wsMaxUpload: PROD_MAX_UPLOAD,
    }));
  } finally {
    for (const running of [firstHost, secondHost, thirdHost, currentHost]) {
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
    const worktreesBase = `${realpathSync(project)}-worktrees`;
    const externalDir = join(project, "..", `pix-e2e-external-${process.pid}`);
    rmSync(worktreesBase, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[pix:e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
