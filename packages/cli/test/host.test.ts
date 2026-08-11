import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostApp,
  createNodeServer,
  EMPTY_HOST_CAPABILITIES,
  type NodeServerHandle,
} from "@fffattiger/pix-host";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import { resolveAllowedHosts } from "../src/commands/host-runner.js";
import { createSessiondProbe } from "../src/probe.js";
import { inspectSessiond } from "../src/supervise.js";

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

test("trusted hosts merge the bind address with operator configuration", () => {
  assert.deepEqual(resolveAllowedHosts("0.0.0.0", {
    PIX_HOSTNAME: " test-pi.huu.im ",
    PIX_ALLOWED_HOSTS: "test-pi.huu.im, pix.lan, ,192.168.31.77",
  }), ["0.0.0.0", "test-pi.huu.im", "pix.lan", "192.168.31.77"]);
  assert.deepEqual(resolveAllowedHosts("127.0.0.1", {}), ["127.0.0.1"]);
});

function buildClientFixture(): string {
  const dist = tempDir("pix-host-fixture-");
  const write = (rel: string, content: string): void => {
    const full = join(dist, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write(
    "index.html",
    '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head>' +
      '<body><div id="root"></div>' +
      '<script type="module" src="/assets/index-abcd.js"></script></body></html>',
  );
  write("assets/index-abcd.js", 'console.log("pix client boot");');
  write("manifest.webmanifest", '{"name":"pix","start_url":"/"}');
  return dist;
}

test("host composition: health/bootstrap/index are real and capabilities are empty", async () => {
  const dir = tempDir("pix-host-dir-");
  const fixture = buildClientFixture();
  let handle: NodeServerHandle | undefined;
  let daemon;
  try {
    daemon = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const host = createHostApp({
      exposureMode: "local",
      clientDist: fixture,
      allowedHosts: ["127.0.0.1"],
      capabilities: { full: EMPTY_HOST_CAPABILITIES, readonly: EMPTY_HOST_CAPABILITIES },
      sessiond: createSessiondProbe(sessiondPaths(dir)),
      gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
      logger: {},
    });
    handle = await createNodeServer(host, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${handle.port}`;

    const health = (await (await fetch(`${base}/v1/health`)).json()) as {
      ok: boolean;
      sessiond: string;
      capabilities: unknown[];
    };
    assert.equal(health.ok, true);
    assert.equal(health.sessiond, "up");
    assert.deepEqual(health.capabilities, []);

    const caps = (await (await fetch(`${base}/v1/capabilities`)).json()) as {
      capabilities: unknown[];
    };
    assert.deepEqual(caps.capabilities, []);

    const bootstrap = (await (await fetch(`${base}/v1/bootstrap`)).json()) as {
      ok: boolean;
      mode: string;
      protocolVersion: number;
      capabilities: unknown[];
    };
    assert.equal(bootstrap.ok, true);
    assert.equal(bootstrap.mode, "local");
    assert.equal(typeof bootstrap.protocolVersion, "number");
    assert.deepEqual(bootstrap.capabilities, []);

    const indexRes = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    assert.equal(indexRes.status, 200);
    assert.match(await indexRes.text(), /id="root"/);

    const assetRes = await fetch(`${base}/assets/index-abcd.js`);
    assert.equal(assetRes.status, 200);
    assert.match(await assetRes.text(), /pix client boot/);
  } finally {
    if (handle) await handle.close();
    if (daemon) await daemon.shutdown();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing the Host leaves the sessiond running on the same pid", async () => {
  const dir = tempDir("pix-host-lifecycle-");
  const fixture = buildClientFixture();
  let handle: NodeServerHandle | undefined;
  let daemon;
  try {
    daemon = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const before = await inspectSessiond(dir);
    assert.equal(before.pingable, true);
    const pidBefore = before.pid;

    const host = createHostApp({
      exposureMode: "local",
      clientDist: fixture,
      allowedHosts: ["127.0.0.1"],
      capabilities: { full: EMPTY_HOST_CAPABILITIES, readonly: EMPTY_HOST_CAPABILITIES },
      sessiond: createSessiondProbe(sessiondPaths(dir)),
      gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
      logger: {},
    });
    handle = await createNodeServer(host, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${handle.port}`;
    const health = (await (await fetch(`${base}/v1/health`)).json()) as {
      sessiond: string;
    };
    assert.equal(health.sessiond, "up");
    // Close ONLY the host (exactly what SIGINT does in runHost).
    await handle.close();
    handle = undefined;

    // sessiond must still be alive, pingable, on the SAME pid.
    const after = await inspectSessiond(dir);
    assert.equal(after.alive, true);
    assert.equal(after.pingable, true);
    assert.equal(after.pid, pidBefore);
  } finally {
    if (handle) await handle.close();
    if (daemon) await daemon.shutdown();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
