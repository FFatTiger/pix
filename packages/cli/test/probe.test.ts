import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import { pingSessiond, createSessiondProbe, probeSessiondCompatibility, isProtocolCurrent, helloProtocolVersion } from "../src/probe.js";
import { resolveCliPackageRoot } from "../src/paths.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-probe-"));

/** A raw net server that AUTHs but never answers any request (hello hangs). */
function startHangingServer(): Promise<{ socketPath: string; secret: string; server: ReturnType<typeof createServer> }> {
  return new Promise((resolve) => {
    const socketPath = join(tmpdir(), `pix-hang-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const secret = "s".repeat(43);
    const server = createServer((socket) => {
      socket.setNoDelay(true);
      let authenticated = false;
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        let nl;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (!authenticated) {
            authenticated = line.startsWith("AUTH ") && line.slice(5) === secret;
            if (!authenticated) { socket.destroy(); return; }
            socket.write("OK\n");
            continue;
          }
          // Never respond — any request (incl. system.hello) hangs → client timeout.
        }
      });
    });
    server.listen(socketPath, () => resolve({ socketPath, secret, server }));
  });
}

test("pingSessiond returns true against a running daemon", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    assert.equal(await pingSessiond(handle.endpoint, handle.secret), true);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pingSessiond returns false against a dead endpoint", async () => {
  const dir = await tempDir();
  try {
    const paths = sessiondPaths(dir);
    assert.equal(await pingSessiond(paths.endpoint, "wrong-or-dead-secret", 500), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSessiondProbe reports available while the daemon runs", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const probe = createSessiondProbe(sessiondPaths(dir));
    assert.equal(await probe.isAvailable(), true);
    await handle.shutdown();
    assert.equal(await probe.isAvailable(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Protocol-v2 compatibility classification (current / knownLegacy / unverifiable) ---

test("probeSessiondCompatibility: a real daemon is positively current", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.deepEqual(compat, { state: "current" });
    assert.equal(await isProtocolCurrent(handle.endpoint, handle.secret), true);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protocol-version authority is singular: the daemon the CLI classifies current speaks the exact PROTOCOL_VERSION the WS handshake advertises", async () => {
  const { PROTOCOL_VERSION } = await import("@fffattiger/pix-protocol");
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.equal(compat.state, "current");
    // The positively-verified hello version equals the single protocol constant
    // (the same one the runtime WS handshake advertises on the host).
    assert.equal(await helloProtocolVersion(handle.endpoint, handle.secret), PROTOCOL_VERSION);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeSessiondCompatibility: a wrong secret is unverifiable(auth), never current", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const compat = await probeSessiondCompatibility(handle.endpoint, "wrong-secret-wrong-secret-wrong-secret-xx");
    assert.equal(compat.state, "unverifiable");
    assert.equal(compat.reason, "auth");
    assert.equal(await isProtocolCurrent(handle.endpoint, "wrong-secret-wrong-secret-wrong-secret-xx"), false);
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probeSessiondCompatibility: a transient hello timeout is unverifiable(timeout), never current", async () => {
  const hanging = await startHangingServer();
  try {
    const compat = await probeSessiondCompatibility(hanging.socketPath, hanging.secret, 300);
    assert.equal(compat.state, "unverifiable");
    assert.equal(compat.reason, "timeout");
  } finally {
    hanging.server.close();
    rm(hanging.socketPath, { force: true });
  }
});

test("probeSessiondCompatibility: a pingable protocol-v1 daemon is positively knownLegacy(1)", async () => {
  const dir = await tempDir();
  const fixturePath = join(resolveCliPackageRoot(), "test", "fixtures", "fake-v1-daemon.mjs");
  let stale: import("node:child_process").ChildProcess | undefined;
  try {
    stale = spawn(process.execPath, [fixturePath], {
      env: { ...process.env, PIX_SESSIOND_DIR: dir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("fake v1 daemon did not become ready")), 5_000);
      stale!.stdout?.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes("fake-v1-ready")) { clearTimeout(timer); resolve(); }
      });
      stale!.on("exit", (code) => { clearTimeout(timer); reject(new Error(`fake v1 daemon exited early (${code})`)); });
    });
    const paths = sessiondPaths(dir);
    const secret = (await readFile(paths.secretFile, "utf8")).trim();
    const compat = await probeSessiondCompatibility(paths.endpoint, secret);
    assert.deepEqual(compat, { state: "knownLegacy", version: 1 });
    assert.equal(await isProtocolCurrent(paths.endpoint, secret), false);
  } finally {
    if (stale && stale.exitCode === null) stale.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
