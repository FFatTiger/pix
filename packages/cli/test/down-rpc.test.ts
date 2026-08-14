/**
 * RPC-only `pix down --all` production authority: wrong secret / wrong instance
 * / unsupported / hung response all return sanitized non-zero and leave the
 * target process untouched (no SIGTERM/PID fallback). A static source check
 * forbids any process.kill(SIGTERM/SIGKILL), taskkill, powershell or unix `kill`
 * fallback in the production down path. PID is used only as a final observation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessiondPaths, SESSIOND_DIR_ENV } from "@fffattiger/pix-sessiond/control";
import { ensureSessiond, shutdownSessiond } from "../src/supervise.js";
import { downCommand } from "../src/commands/down.js";
import { resolveCliPackageRoot } from "../src/paths.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-down-rpc-"));

interface Capture {
  code: number;
  out: string[];
  err: string[];
}

async function capture(fn: () => Promise<number>): Promise<Capture> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (message?: unknown) => { out.push(String(message)); };
  console.error = (message?: unknown) => { err.push(String(message)); };
  try {
    return { code: await fn(), out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function withDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[SESSIOND_DIR_ENV];
  process.env[SESSIOND_DIR_ENV] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[SESSIOND_DIR_ENV];
    else process.env[SESSIOND_DIR_ENV] = prev;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  const proc = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture child did not signal ready")), timeoutMs);
    proc.stdout?.on("data", () => { clearTimeout(timer); resolve(); });
    proc.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  const proc = child;
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  }
}

test("down --all with a wrong on-disk secret refuses (obstructed), nonzero, target untouched", async () => {
  const dir = await tempDir();
  try {
    const ensured = await ensureSessiond(dir);
    const pid = ensured.pid!;
    const paths = sessiondPaths(dir);
    const originalSecret = (await readFile(paths.secretFile, "utf8")).trim();
    // A different but structurally-valid secret on disk: the daemon cannot be
    // authenticated, so down must refuse and never touch the process.
    await writeFile(paths.secretFile, "w".repeat(43));
    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 1, "wrong secret must exit non-zero");
    assert.ok(down.err.some((l) => l.includes("refusing to stop (obstructed)")), `expected refusal; got ${down.err.join(" | ")}`);
    assert.ok(!down.err.some((l) => /UnsafeSecretError|Error:|\s+at\s/.test(l)), `no stack leak: ${down.err.join(" | ")}`);
    assert.equal(pidAlive(pid), true, "wrong secret must never stop the target");
    assert.equal(existsSync(paths.lockFile), true);
    // Restore the secret so cleanup can stop the real daemon via RPC.
    await writeFile(paths.secretFile, originalSecret);
    const stop = await shutdownSessiond(dir);
    assert.equal(stop.action, "terminated");
  } finally {
    await shutdownSessiond(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("down --all with an instance mismatch fails sanitized (forbidden), nonzero, target untouched", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets only");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // Real SessiondRpcServer whose authority instance is "server-instance" while
    // the on-disk lock names "lock-instance": inspect sees a healthy pingable
    // daemon, but the RPC fence refuses — down must fail without touching it.
    const script =
      `import { mkdirSync, writeFileSync } from 'node:fs';` +
      `import { join } from 'node:path';` +
      `import { SessiondRpcServer } from '@fffattiger/pix-sessiond';` +
      `const dir=${JSON.stringify(dir)};` +
      `mkdirSync(dir,{recursive:true});` +
      `const secret='s'.repeat(43);` +
      `writeFileSync(join(dir,'sessiond.lock'),JSON.stringify({pid:process.pid,instanceId:'lock-instance',createdAt:Date.now()}));` +
      `writeFileSync(join(dir,'sessiond.secret'),secret);` +
      `const server=new SessiondRpcServer({endpoint:join(dir,'sessiond.sock'),secret,handler:{handle:async(m)=>(m==='system.ping'?{pong:true,serverTime:Date.now()}:{pong:true})},shutdownAuthority:{instanceId:'server-instance',initiate:()=>{}},logger:()=>{}});` +
      `await server.listen();` +
      `process.stdout.write('ready');setInterval(()=>{},60000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    await waitForReady(child);
    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 1, "instance mismatch must exit non-zero");
    assert.ok(down.err.some((l) => l.includes("instance mismatch")), `expected instance-mismatch refusal; got ${down.err.join(" | ")}`);
    assert.ok(!down.err.some((l) => /UnsafeSecretError|Error:|\s+at\s|server-instance|lock-instance/.test(l)), `no stack/instance leak: ${down.err.join(" | ")}`);
    assert.equal(pidAlive(child.pid!), true, "instance mismatch must never stop the target");
    assert.equal(existsSync(sessiondPaths(dir).lockFile), true);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("down --all with a hung shutdown response fails sanitized, nonzero, target untouched", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets only");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // Raw net server that answers system.ping (so inspect reports healthy) but
    // never responds to system.shutdown: down times out and must not kill it.
    const scriptPath = join(dir, "hung-server.mjs");
    await writeFile(scriptPath, [
      `import { mkdirSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { createServer } from "node:net";`,
      `const dir = ${JSON.stringify(dir)};`,
      `mkdirSync(dir, { recursive: true });`,
      `const secret = "s".repeat(43);`,
      `writeFileSync(join(dir, "sessiond.lock"), JSON.stringify({ pid: process.pid, instanceId: "hung", createdAt: Date.now() }));`,
      `writeFileSync(join(dir, "sessiond.secret"), secret);`,
      `const server = createServer((socket) => {`,
      `  let authed = false;`,
      `  let buf = "";`,
      `  socket.on("data", (c) => {`,
      `    buf += c.toString("utf8");`,
      `    const lines = buf.split("\\n");`,
      `    buf = lines.pop();`,
      `    for (const line of lines) {`,
      `      if (!authed) {`,
      `        if (line === "AUTH " + secret) { authed = true; socket.write("OK\\n"); }`,
      `        else socket.destroy();`,
      `        continue;`,
      `      }`,
      `      try {`,
      `        const req = JSON.parse(line);`,
      `        if (req.method === "system.ping") {`,
      `          socket.write(JSON.stringify({ id: req.id, ok: true, method: "system.ping", result: { pong: true, serverTime: Date.now() } }) + "\\n");`,
      `        }`,
      `      } catch {}`,
      `    }`,
      `  });`,
      `});`,
      `await new Promise((res) => server.listen(join(dir, "sessiond.sock"), res));`,
      `process.stdout.write("ready");`,
      `setInterval(() => {}, 60000);`,
      "",
    ].join("\n"));
    child = spawn(process.execPath, [scriptPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await waitForReady(child);
    // The RPC call is bounded: a hung daemon never answers, so the shutdown
    // fails on the client timeout and the target is left untouched.
    const result = await withDir(dir, () => shutdownSessiond(dir, { timeoutMs: 300 }));
    assert.equal(result.action, "failed");
    assert.match(result.reason, /timeout/);
    assert.ok(!/[a-f0-9]{40}|sessiond\.sock|s{10,}/.test(result.reason), `no secret/endpoint leak: ${result.reason}`);
    assert.equal(pidAlive(child.pid!), true, "hung response must never stop the target");
    assert.equal(existsSync(sessiondPaths(dir).lockFile), true);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("down --all refuses unsupported (old daemon) sanitized, nonzero, target untouched", async (t) => {
  if (process.platform === "win32") return t.skip("Unix sockets only");
  const dir = await tempDir();
  let child: ChildProcess | undefined;
  try {
    // A legacy-style reachable daemon without the shutdown authority: down must
    // refuse as unsupported and never kill it via a PID/SIGTERM fallback.
    const script =
      `import { mkdirSync, writeFileSync } from 'node:fs';` +
      `import { join } from 'node:path';` +
      `import { SessiondRpcServer } from '@fffattiger/pix-sessiond';` +
      `const dir=${JSON.stringify(dir)};` +
      `mkdirSync(dir,{recursive:true});` +
      `const secret='s'.repeat(43);` +
      `writeFileSync(join(dir,'sessiond.lock'),JSON.stringify({pid:process.pid,instanceId:'legacy',createdAt:Date.now()}));` +
      `writeFileSync(join(dir,'sessiond.secret'),secret);` +
      `const server=new SessiondRpcServer({endpoint:join(dir,'sessiond.sock'),secret,handler:{handle:async(m)=>(m==='system.ping'?{pong:true,serverTime:Date.now()}:{pong:true})},logger:()=>{}});` +
      `await server.listen();` +
      `process.stdout.write('ready');setInterval(()=>{},60000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: resolveCliPackageRoot(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    await waitForReady(child);
    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 1, "unsupported must exit non-zero");
    assert.ok(down.err.some((l) => l.includes("does not support remote shutdown")), `expected unsupported; got ${down.err.join(" | ")}`);
    assert.ok(!down.err.some((l) => /UnsafeSecretError|Error:|\s+at\s/.test(l)), `no stack leak: ${down.err.join(" | ")}`);
    assert.equal(pidAlive(child.pid!), true, "unsupported must never stop the target");
    assert.equal(existsSync(sessiondPaths(dir).lockFile), true);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("down --all happy path: authenticated RPC stops an external daemon and removes lock + socket", async () => {
  const dir = await tempDir();
  try {
    const ensured = await ensureSessiond(dir);
    const pid = ensured.pid!;
    const paths = sessiondPaths(dir);
    const down = await withDir(dir, () => capture(() => downCommand(["--all"])));
    assert.equal(down.code, 0, `${down.out.join(" | ")} ${down.err.join(" | ")}`);
    assert.ok(down.out.some((l) => l.includes(`terminated (pid ${pid})`)), `expected terminated; got ${down.out.join(" | ")}`);
    assert.equal(existsSync(paths.lockFile), false);
    if (process.platform !== "win32") {
      assert.equal(existsSync(paths.endpoint), false);
    }
    assert.equal(pidAlive(pid), false, "the external daemon must have exited");
  } finally {
    await shutdownSessiond(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("static: production down path forbids SIGTERM/SIGKILL/taskkill/powershell/unix-kill fallback", () => {
  const cliRoot = resolveCliPackageRoot();
  const source = readFileSync(join(cliRoot, "src", "supervise.ts"), "utf8");
  // A liveness probe (process.kill(pid, 0)) is allowed, but any signal-name kill
  // is a forbidden production fallback.
  assert.ok(!/process\.kill\(\s*[^)]*,\s*["']SIG(?:TERM|KILL)["']/.test(source), "no process.kill(SIGTERM/SIGKILL) in supervise");
  assert.ok(!/taskkill/i.test(source), "no taskkill fallback");
  assert.ok(!/powershell/i.test(source), "no powershell fallback");
  assert.ok(!/(^|[^.\w])kill\s+(-|[\w.])/.test(source), "no unix kill-command fallback");
  // The down command itself must not signal either.
  const downSource = readFileSync(join(cliRoot, "src", "commands", "down.ts"), "utf8");
  assert.ok(!/process\.kill\(\s*[^)]*,\s*["']SIG(?:TERM|KILL)["']/.test(downSource), "no process.kill(SIGTERM/SIGKILL) in down command");
  assert.ok(!/taskkill|powershell/i.test(downSource), "no taskkill/powershell in down command");
});
