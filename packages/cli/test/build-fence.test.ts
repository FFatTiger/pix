import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import { SESSIOND_BUILD_IDENTITY } from "@fffattiger/pix-protocol";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import { ensureSessiond, inspectSessiond, revalidateSessiondInstance, shutdownSessiond } from "../src/supervise.js";
import { probeSessiondCompatibility } from "../src/probe.js";
import { resolveCliPackageRoot } from "../src/paths.js";

/**
 * Phase 7A build-compatibility fence (CLI side): `pix start` reuse is decided
 * by the explicit build matrix, never by "same protocol major". Deterministic
 * coverage: stale same-major builds are classified and ordinary start/ensure
 * MUST preserve a live incompatible daemon (no auto-shutdown, even idle);
 * unknown/malformed builds stay fail-closed; the probe→reuse race is
 * revalidated and bounded. Explicit `shutdownSessiond` remains authorized.
 */

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-build-fence-"));

interface FixtureHandle {
  dir: string;
  pid: number | undefined;
  child: ChildProcess;
  endpoint: string;
  secret: string;
  instanceId: string;
  rpcLog: string;
}

async function spawnStaleBuildFixture(
  env: Record<string, string>,
): Promise<FixtureHandle> {
  const dir = await tempDir();
  const rpcLog = join(dir, "rpc.log");
  const fixturePath = join(resolveCliPackageRoot(), "test", "fixtures", "stale-build-daemon.mjs");
  const child = spawn(process.execPath, [fixturePath], {
    env: { ...process.env, PIX_SESSIOND_DIR: dir, PIX_RPC_LOG: rpcLog, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("stale-build fixture did not become ready")), 5_000);
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("stale-build-ready")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`stale-build fixture exited early (${code})`)); });
  });
  const paths = sessiondPaths(dir);
  const lock = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid: number; instanceId: string };
  const secret = (await readFile(paths.secretFile, "utf8")).trim();
  return { dir, pid: lock.pid, child, endpoint: paths.endpoint, secret, instanceId: lock.instanceId, rpcLog };
}

const fixtureAlive = (handle: FixtureHandle): boolean =>
  handle.child.exitCode === null && handle.pid !== undefined;

const cleanupFixture = async (handle: FixtureHandle): Promise<void> => {
  if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
  await rm(handle.dir, { recursive: true, force: true });
};

async function rpcMethods(logFile: string): Promise<string[]> {
  try {
    return (await readFile(logFile, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function assertNoSpawnLogs(logs: string[]): void {
  assert.equal(logs.some((line) => line.includes("starting sessiond")), false, "ordinary ensure must not spawn");
  assert.equal(logs.some((line) => line.includes("replaced stale sessiond")), false, "ordinary ensure must not auto-replace");
}

test("probe: a same-protocol daemon without a build block is staleBuild(missing_build), never current", async () => {
  const handle = await spawnStaleBuildFixture({ PIX_STALE_BUILD: "none" });
  try {
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.deepEqual(compat, { state: "staleBuild", reason: "missing_build" });
  } finally {
    await cleanupFixture(handle);
  }
});

test("probe: a same-protocol daemon with a stale Worker contract is staleBuild(worker_contract)", async () => {
  const handle = await spawnStaleBuildFixture({ PIX_STALE_BUILD: "contract" });
  try {
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.deepEqual(compat, { state: "staleBuild", reason: "worker_contract" });
  } finally {
    await cleanupFixture(handle);
  }
});

test("probe: a same-protocol daemon from another product build is staleBuild(product)", async () => {
  const handle = await spawnStaleBuildFixture({ PIX_STALE_BUILD: "product" });
  try {
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.deepEqual(compat, { state: "staleBuild", reason: "product" });
  } finally {
    await cleanupFixture(handle);
  }
});

test("probe: a malformed build block fails the strict hello schema and is unverifiable (preserved)", async () => {
  const handle = await spawnStaleBuildFixture({ PIX_STALE_BUILD: "malformed" });
  try {
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.equal(compat.state, "unverifiable");
    // The daemon is untouched by the probe.
    assert.ok(fixtureAlive(handle), "a malformed-build daemon must be preserved");
  } finally {
    await cleanupFixture(handle);
  }
});

test("probe: a daemon carrying the exact compiled build identity is current", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const compat = await probeSessiondCompatibility(handle.endpoint, handle.secret);
    assert.deepEqual(compat, { state: "current" });
    await handle.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureSessiond preserves a live stale-build daemon whether occupancy is busy or idle", async () => {
  // Fixture-owned runtime.listRunning occupancy (no SDK Worker). The test
  // queries occupancy itself to prove the busy record exists; ensureSessiond
  // must still never call listRunning or shutdown.
  for (const occupancy of ["busy", "idle"] as const) {
    const handle = await spawnStaleBuildFixture({
      PIX_STALE_BUILD: "contract",
      PIX_FIXTURE_OCCUPANCY: occupancy,
    });
    try {
      const listed = await new SessiondRpcClient({
        endpoint: handle.endpoint,
        secret: handle.secret,
        timeoutMs: 2_000,
      }).call("runtime.listRunning", {});
      if (occupancy === "busy") {
        assert.equal(listed.sessions.length, 1, "busy fixture must advertise a live record");
        assert.equal(listed.sessions[0]?.sessionId, "fixture-busy-session");
        assert.equal(listed.sessions[0]?.workerStatus, "busy");
      } else {
        assert.deepEqual(listed.sessions, [], "idle fixture must advertise no running records");
      }
      const methodsBefore = await rpcMethods(handle.rpcLog);
      assert.equal(methodsBefore.includes("runtime.listRunning"), true);
      assert.equal(methodsBefore.includes("system.shutdown"), false);

      const logs: string[] = [];
      await assert.rejects(
        () => ensureSessiond(handle.dir, (line) => logs.push(line)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /incompatible pix build/);
          assert.match(error.message, /`pix down --all`/);
          assert.match(error.message, /will end sessions/);
          assert.doesNotMatch(error.message, /sessiond-down/);
          return true;
        },
      );
      assertNoSpawnLogs(logs);
      assert.ok(fixtureAlive(handle), `${occupancy} stale-build daemon must remain alive`);
      const after = await inspectSessiond(handle.dir);
      assert.equal(after.pid, handle.pid);
      assert.equal(after.instanceId, handle.instanceId);
      const methodsAfter = await rpcMethods(handle.rpcLog);
      assert.equal(
        methodsAfter.filter((method) => method === "runtime.listRunning").length,
        methodsBefore.filter((method) => method === "runtime.listRunning").length,
        "ordinary ensure must not query runtime.listRunning",
      );
      assert.equal(methodsAfter.includes("system.shutdown"), false);
    } finally {
      await cleanupFixture(handle);
    }
  }
});

test("ensureSessiond preserves a positively authenticated stale-build daemon (zero shutdown RPC, zero spawn)", async () => {
  // Replacement for the prior auto-replacement assertion: LC-04 ordinary
  // start/ensure must leave any live incompatible daemon intact (this fixture
  // is live and idle; the harness cannot prove authority-busy, and this slice
  // adds no auto-maintenance/quiescent replacement API). Equal-or-stronger
  // identity coverage: exact pid/instance preserved, sanitized instruction,
  // zero shutdown RPC, zero spawn; explicit shutdown still fences the instance.
  const handle = await spawnStaleBuildFixture({ PIX_STALE_BUILD: "none" });
  try {
    const before = await inspectSessiond(handle.dir);
    assert.equal(before.pingable, true);
    assert.equal(before.pid, handle.pid);
    const logs: string[] = [];
    await assert.rejects(
      () => ensureSessiond(handle.dir, (line) => logs.push(line)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /incompatible pix build/);
        assert.match(error.message, /`pix down --all`/);
        assert.match(error.message, /will end sessions/);
        assert.doesNotMatch(error.message, /sessiond-down/);
        assert.doesNotMatch(error.message, /\d{2,}/);
        return true;
      },
    );
    assertNoSpawnLogs(logs);
    assert.ok(fixtureAlive(handle), "a live stale-build daemon must be preserved even when idle");
    const after = await inspectSessiond(handle.dir);
    assert.equal(after.pid, handle.pid);
    assert.equal(after.instanceId, handle.instanceId);
    assert.equal(after.pingable, true);
    assert.equal((await rpcMethods(handle.rpcLog)).includes("system.shutdown"), false, "ordinary ensure must not send shutdown RPC");

    const explicit = await shutdownSessiond(handle.dir);
    assert.equal(explicit.action, "terminated");
    assert.equal(explicit.pid, handle.pid);
    assert.equal((await rpcMethods(handle.rpcLog)).includes("system.shutdown"), true, "explicit shutdown must still send authenticated shutdown");
  } finally {
    await cleanupFixture(handle);
  }
});

test("ensureSessiond fails closed and PRESERVES the daemon without attempting authenticated restart", async () => {
  // Replacement: ordinary ensure no longer attempts shutdown, so refuse-shutdown
  // is no longer a special path. Keep equal identity/security coverage: live
  // stale-build daemon (this fixture also refuses shutdown) stays exact pid/
  // instance, zero shutdown RPC, zero spawn, sanitized instruction.
  const handle = await spawnStaleBuildFixture({
    PIX_STALE_BUILD: "none",
    PIX_REFUSE_SHUTDOWN: "1",
  });
  try {
    const logs: string[] = [];
    await assert.rejects(
      () => ensureSessiond(handle.dir, (line) => logs.push(line)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /incompatible pix build/);
        assert.match(error.message, /`pix down --all`/);
        assert.match(error.message, /will end sessions/);
        assert.doesNotMatch(error.message, /sessiond-down/);
        assert.doesNotMatch(error.message, /\d{2,}/);
        return true;
      },
    );
    assertNoSpawnLogs(logs);
    assert.ok(fixtureAlive(handle), "a live stale-build daemon must be preserved");
    const status = await inspectSessiond(handle.dir);
    assert.equal(status.pid, handle.pid);
    assert.equal(status.instanceId, handle.instanceId);
    assert.equal(status.pingable, true);
    assert.equal((await rpcMethods(handle.rpcLog)).includes("system.shutdown"), false);
  } finally {
    await cleanupFixture(handle);
  }
});

test("ensureSessiond re-decides (bounded) when the probed daemon is lost before the reuse commit", async () => {
  // Valid injected build → probe classifies current; the fixture then exits
  // cleanly (lock + socket removed) BEFORE the reuse commit, so the
  // revalidation fence must observe the loss and spawn a fresh daemon
  // deterministically instead of silently "reusing" a dead instance.
  const handle = await spawnStaleBuildFixture({
    PIX_FAKE_BUILD_JSON: JSON.stringify(SESSIOND_BUILD_IDENTITY),
    PIX_EXIT_AFTER_HELLO: "1",
  });
  try {
    const logs: string[] = [];
    const ensured = await ensureSessiond(handle.dir, (line) => logs.push(line));
    assert.equal(ensured.reused, false, "a daemon lost mid-probe must never be reported as reused");
    assert.notEqual(ensured.pid, handle.pid);
    assert.ok(logs.some((line) => line.includes("starting sessiond")), "lost-instance re-decision may spawn after the original is gone");
    assert.equal(logs.some((line) => line.includes("replaced stale sessiond")), false);
    const status = await inspectSessiond(handle.dir);
    assert.equal(status.pingable, true);
    await shutdownSessiond(handle.dir);
    handle.child.kill("SIGKILL");
    await rm(handle.dir, { recursive: true, force: true });
  } finally {
    await cleanupFixture(handle);
  }
});

test("revalidateSessiondInstance accepts only the exact live authenticated instance", async () => {
  const dir = await tempDir();
  try {
    const handle = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
    const paths = sessiondPaths(dir);
    const status = await inspectSessiond(dir);
    assert.equal(status.pingable, true);
    // Exact observed instance → true.
    assert.equal(
      await revalidateSessiondInstance(paths, { pid: status.pid, instanceId: status.instanceId }, handle.secret),
      true,
    );
    // Different pid → false.
    assert.equal(
      await revalidateSessiondInstance(paths, { pid: 4_194_303, instanceId: status.instanceId }, handle.secret),
      false,
    );
    // Different instanceId → false.
    assert.equal(
      await revalidateSessiondInstance(paths, { pid: status.pid, instanceId: "not-the-instance" }, handle.secret),
      false,
    );
    // Missing observation → false.
    assert.equal(await revalidateSessiondInstance(paths, { pid: undefined, instanceId: undefined }, handle.secret), false);
    await handle.shutdown();
    // Lock gone → false (never revalidate against a dead directory).
    assert.equal(
      await revalidateSessiondInstance(paths, { pid: status.pid, instanceId: status.instanceId }, handle.secret),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
