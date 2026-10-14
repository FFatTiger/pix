/**
 * Windows startup smoke (also runs on macOS/Linux — pure Node, no platform
 * branch): boots a REAL sessiond via the CLI bin, authenticates + pings it,
 * creates a session (real worker process spawn), stops it, boots the full
 * product entry (host + reused sessiond) and probes /health + capabilities,
 * then shuts the daemon down through the authenticated RPC authority.
 *
 * This is the CI counterpart of the Wine smoke in docs/windows.md; it
 * exercises the win32 lifecycle seams (named pipe endpoint, pid liveness,
 * lock acquisition, worker spawn env, atomic writes) on a real Windows
 * runner without any model API (no turn is submitted).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READINESS_TIMEOUT_MS = 90_000;
const HOST_HEALTH_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
const OVERALL_TIMEOUT_MS = 5 * 60_000;
const children = [];

const temporary = [];
function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startProcess(args, env, label) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const output = () => `--- ${label} stdout ---\n${stdout}\n--- ${label} stderr ---\n${stderr}`;
  return { child, output };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function main() {
  const { readInstanceLockStrict, sessiondPaths } = await import("@fffattiger/pix-sessiond/control");
  const { SessiondRpcClient } = await import("@fffattiger/pix-sessiond/client");
  const { PROTOCOL_VERSION } = await import("@fffattiger/pix-protocol");

  const home = temp("wsmoke-home-");
  const runtimeDir = join(home, "sessiond");
  const hostDir = join(home, "host");
  const agentDir = join(home, "agent");
  const project = join(home, "project");
  mkdirSync(join(agentDir, "agent"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# smoke project\n");

  const baseEnv = {
    ...process.env,
    // Isolate every persistent surface from the runner's real home.
    HOME: home,
    USERPROFILE: home,
    PIX_SESSIOND_DIR: runtimeDir,
    PIX_HOST_DIR: hostDir,
    PI_CODING_AGENT_DIR: agentDir,
    PIX_ALLOWED_ROOTS: project,
    PIX_CLIENT_DIST: join(ROOT, "packages", "client", "dist"),
    // Deterministic memory provider (never the networked Lore default).
    PI_MEMORY_PROVIDER: undefined,
  };
  const env = { ...baseEnv };
  delete env.PI_MEMORY_PROVIDER;

  // ---- phase 1: boot the daemon via the production bin --------------------
  const daemon = startProcess([join(ROOT, "packages", "cli", "bin", "pix-sessiond.mjs")], env, "sessiond");
  const paths = sessiondPaths(runtimeDir);
  let secret;
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    if (daemon.child.exitCode !== null) {
      throw new Error(`sessiond exited early (code ${daemon.child.exitCode})\n${daemon.output()}`);
    }
    try {
      secret = readFileSync(paths.secretFile, "utf8").trim();
    } catch { /* not published yet */ }
    const lock = await readInstanceLockStrict(paths).catch(() => ({ kind: "missing" }));
    if (secret && lock.kind === "ok") break;
    if (Date.now() > deadline) throw new Error(`sessiond did not become ready\n${daemon.output()}`);
    await delay(POLL_MS);
  }
  console.log("[smoke] sessiond booted");

  // ---- phase 2: authenticated ping over the platform endpoint -------------
  const client = new SessiondRpcClient({ endpoint: paths.endpoint, secret, timeoutMs: 10_000 });
  const hello = await client.call("system.hello", { clientName: "windows-smoke" });
  assert.equal(hello.protocolVersion, PROTOCOL_VERSION, "hello must answer the current protocol version");
  console.log("[smoke] authenticated system.hello ok");

  // ---- phase 3: create a session (real worker spawn) then stop it ---------
  const created = await client.call("runtime.create", {
    createRequestId: "smoke-create-1",
    cwd: project,
    projectRoot: project,
  });
  assert.ok(created.sessionId, "runtime.create must return a session id");
  console.log(`[smoke] session created (${created.sessionId}) — real worker spawned`);
  const stopped = await client.call("runtime.stop", { sessionId: created.sessionId });
  assert.ok(stopped, "runtime.stop must succeed");
  console.log("[smoke] session stopped (worker reaped)");

  // ---- phase 4: full product entry (host reuses the daemon) ---------------
  const port = await freePort();
  const host = startProcess(
    [join(ROOT, "scripts", "product-entry.mjs"), "start", "--hostname", "127.0.0.1", "--port", String(port), "--no-open"],
    env,
    "host",
  );
  let health;
  const healthDeadline = Date.now() + HOST_HEALTH_TIMEOUT_MS;
  for (;;) {
    if (host.child.exitCode !== null) {
      throw new Error(`host exited early (code ${host.child.exitCode})\n${host.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/bootstrap`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch { /* not listening yet */ }
    if (Date.now() > healthDeadline) throw new Error(`host did not become healthy\n${host.output()}`);
    await delay(500);
  }
  assert.equal(health.sessiond, "up", "host must report sessiond up (reused daemon)");
  assert.ok(health.capabilities.includes("agent"), "up capabilities must include the agent runtime");
  assert.ok(health.capabilities.includes("files"), "up capabilities must include the files surface");
  console.log("[smoke] host healthy with full capabilities");
  host.child.kill();

  // ---- phase 5: authenticated daemon shutdown ------------------------------
  // A wrong instance id is refused by the daemon authority (RPC error).
  const refused = await client.call("system.shutdown", { instanceId: "smoke" }).then(() => false, () => true);
  assert.equal(refused, true, "instance-fenced shutdown must refuse a wrong instance id");
  const lock = await readInstanceLockStrict(paths);
  assert.equal(lock.kind, "ok", "daemon must survive a wrong-instance shutdown request");
  const exact = lock.kind === "ok" ? lock.record.instanceId : undefined;
  const accepted = await client.call("system.shutdown", { instanceId: exact });
  assert.equal(accepted.accepted, true, "exact-instance shutdown must be accepted");
  const exitCode = await new Promise((resolveExit) => {
    if (daemon.child.exitCode !== null) return resolveExit(daemon.child.exitCode);
    daemon.child.once("exit", (code) => resolveExit(code));
    // Give the accepted graceful shutdown a moment, then terminate.
    setTimeout(() => { if (daemon.child.exitCode === null) daemon.child.kill(); }, 10_000).unref();
  });
  console.log(`[smoke] sessiond shut down (exit ${exitCode})`);
  client.destroy?.();
  console.log("[smoke] PASS");
}

const watchdog = setTimeout(() => {
  console.error(`[smoke] FAIL: overall timeout after ${OVERALL_TIMEOUT_MS}ms`);
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

main().then(() => {
  clearTimeout(watchdog);
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(0);
}, (error) => {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(1);
});
