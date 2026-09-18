import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAllowedRootService, createRuntimeWorkspaceAuthorizer } from "../dist/index.js";

const temporary = [];
function temp(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return realpathSync(value);
}
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

function rpcError(code, message, retryable = false) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

function liveItem(over = {}) {
  return {
    sessionId: "s-live",
    cwd: over.cwd,
    projectRoot: over.projectRoot,
    workerStatus: "ready",
    epoch: "e-live",
    ...over,
  };
}

async function makeAuthorizer({ roots, live, catalog, listTimeoutMs } = {}) {
  const client = {
    calls: [],
    async call(method, params, timeoutMs) {
      this.calls.push(timeoutMs === undefined ? { method, params } : { method, params, timeoutMs });
      if (method === "runtime.listRunning") {
        if (typeof live === "function") return live();
        if (live instanceof Error) throw live;
        return live ?? { sessions: [] };
      }
      if (method === "sessions.read") {
        if (typeof catalog === "function") return catalog(params);
        if (catalog instanceof Error) throw catalog;
        if (catalog === undefined) throw rpcError("not_found", "missing");
        return catalog;
      }
      throw rpcError("internal", `unexpected ${method}`);
    },
  };
  return {
    client,
    authorizer: createRuntimeWorkspaceAuthorizer({
      client,
      roots,
      ...(listTimeoutMs === undefined ? {} : { listTimeoutMs }),
    }),
  };
}

test("FIRST: catalog-invisible newborn live record is authorized from listRunning, never catalog", async () => {
  const root = temp("pix-auth-newborn-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [liveItem({ cwd: root, projectRoot: root })] },
    catalog: () => {
      throw new Error("catalog must not be consulted when the live snapshot already has the exact id");
    },
  });
  for (const intent of ["observe", "activate"]) {
    const decision = await authorizer.authorize({ sessionId: "s-live", intent });
    assert.equal(decision.ok, true, intent);
    assert.equal(decision.source, "live", intent);
    assert.equal(decision.identity.sessionId, "s-live", intent);
    assert.equal(decision.identity.cwd, root, intent);
    assert.equal(decision.identity.projectRoot, root, intent);
    assert.equal(decision.identity.epoch, "e-live", intent);
    assert.deepEqual(decision.access, { state: "authorized", reason: "allowed_root" });
  }
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning", "runtime.listRunning"]);
});

test("catalog-only inactive session is authorized from exact sessions.read for activate, not observe", async () => {
  const root = temp("pix-auth-catalog-");
  const nested = join(root, "nested");
  mkdirSync(nested);
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [] },
    catalog: { sessionId: "s-idle", cwd: nested, projectRoot: root },
  });
  const observe = await authorizer.authorize({ sessionId: "s-idle", intent: "observe" });
  assert.equal(observe.ok, false);
  assert.equal(observe.error.code, "worker_unavailable");
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning"]);

  const activate = await authorizer.authorize({ sessionId: "s-idle", intent: "activate" });
  assert.equal(activate.ok, true);
  assert.equal(activate.source, "catalog");
  assert.equal(activate.identity.sessionId, "s-idle");
  assert.equal(activate.identity.cwd, nested);
  assert.equal(activate.identity.projectRoot, root);
  assert.equal(activate.identity.epoch, undefined);
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning", "runtime.listRunning", "sessions.read"]);
});

test("missing both live and catalog identities is not_found with zero later RPC from the authorizer", async () => {
  const root = temp("pix-auth-missing-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [] },
    catalog: rpcError("not_found", "gone"),
  });
  const decision = await authorizer.authorize({ sessionId: "s-absent", intent: "activate" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "not_found");
  assert.equal(decision.error.retryable, false);
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning", "sessions.read"]);
});

test("wrong live id never authorizes a sibling record", async () => {
  const root = temp("pix-auth-wrong-id-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [liveItem({ sessionId: "s-other", cwd: root, projectRoot: root })] },
    catalog: rpcError("not_found", "gone"),
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "activate" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "not_found");
});

test("failed live lookup is unavailable and never pretends empty / never reads catalog", async () => {
  const root = temp("pix-auth-live-fail-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: rpcError("timeout", "listRunning timed out", true),
    catalog: { sessionId: "s-live", cwd: root, projectRoot: root },
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "unavailable");
  assert.equal(decision.error.retryable, false);
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning"]);
});

test("malformed live snapshot is unavailable, not treated as empty", async () => {
  const root = temp("pix-auth-malformed-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [{ sessionId: "s-live", cwd: root }] },
    catalog: { sessionId: "s-live", cwd: root, projectRoot: root },
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "activate" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "unavailable");
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning"]);
});

test("unauthorized live root is history_only and does not fall through to catalog", async () => {
  const allowed = temp("pix-auth-allowed-");
  const outside = temp("pix-auth-outside-");
  const roots = await createAllowedRootService({ roots: [allowed] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [liveItem({ cwd: outside, projectRoot: outside })] },
    catalog: () => {
      throw new Error("catalog must not override a live unauthorized identity");
    },
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "forbidden");
  assert.equal(decision.access.state, "history_only");
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning"]);
});

test("client-supplied cwd/access flags are ignored; Host classifies trusted identity only", async () => {
  const allowed = temp("pix-auth-ignore-client-");
  const outside = temp("pix-auth-ignore-outside-");
  const roots = await createAllowedRootService({ roots: [allowed] });
  const { authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [] },
    catalog: { sessionId: "s-idle", cwd: outside, projectRoot: outside, workspaceAccess: { state: "authorized", reason: "allowed_root" } },
  });
  const decision = await authorizer.authorize({
    sessionId: "s-idle",
    intent: "activate",
    cwd: allowed,
    projectRoot: allowed,
    workspaceAccess: { state: "authorized", reason: "allowed_root" },
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "forbidden");
  assert.equal(decision.identity?.cwd, outside);
});

test("duplicate live ids fail closed as unavailable", async () => {
  const root = temp("pix-auth-dup-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { authorizer } = await makeAuthorizer({
    roots,
    live: {
      sessions: [
        liveItem({ cwd: root, projectRoot: root }),
        liveItem({ cwd: root, projectRoot: root, epoch: "e-other" }),
      ],
    },
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "unavailable");
});

test("crashed/unavailable/stopped/stopping live worker status is worker_unavailable, never catalog fallback", async () => {
  const root = temp("pix-auth-crashed-");
  const roots = await createAllowedRootService({ roots: [root] });
  for (const workerStatus of ["crashed", "unavailable", "stopped", "stopping"]) {
    const { client, authorizer } = await makeAuthorizer({
      roots,
      live: { sessions: [liveItem({ cwd: root, projectRoot: root, workerStatus })] },
      catalog: { sessionId: "s-live", cwd: root, projectRoot: root },
    });
    const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
    assert.equal(decision.ok, false, workerStatus);
    assert.equal(decision.error.code, "worker_unavailable", workerStatus);
    assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning"]);
  }
});

test("starting/idle/ready/busy live statuses remain attachable, matching requireActive", async () => {
  const root = temp("pix-auth-active-");
  const roots = await createAllowedRootService({ roots: [root] });
  for (const workerStatus of ["starting", "idle", "ready", "busy"]) {
    const { authorizer } = await makeAuthorizer({
      roots,
      live: { sessions: [liveItem({ cwd: root, projectRoot: root, workerStatus })] },
      catalog: () => { throw new Error("catalog must not run for an active live record"); },
    });
    const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
    assert.equal(decision.ok, true, workerStatus);
    assert.equal(decision.source, "live", workerStatus);
  }
});

test("sessions.read header-only identity (no entries) authorizes inactive activate", async () => {
  const root = temp("pix-auth-header-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [] },
    catalog: {
      sessionId: "s-idle",
      cwd: root,
      projectRoot: root,
      title: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const decision = await authorizer.authorize({ sessionId: "s-idle", intent: "activate" });
  assert.equal(decision.ok, true);
  assert.equal(decision.source, "catalog");
  assert.equal(decision.identity.cwd, root);
});

test("absent/malformed sessionId is invalid_input with zero RPC", async () => {
  const root = temp("pix-auth-malformed-id-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [liveItem({ cwd: root, projectRoot: root })] },
  });
  for (const sessionId of ["", "   ", null, undefined]) {
    const decision = await authorizer.authorize({ sessionId, intent: "observe" });
    assert.equal(decision.ok, false);
    assert.equal(decision.error.code, "invalid_input");
  }
  assert.equal(client.calls.length, 0);
});

test("live disappearance after an empty snapshot is worker_unavailable for observe and never activates via catalog", async () => {
  const root = temp("pix-auth-disappear-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { client, authorizer } = await makeAuthorizer({
    roots,
    live: { sessions: [] },
    catalog: { sessionId: "s-live", cwd: root, projectRoot: root },
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "worker_unavailable");
  assert.deepEqual(client.calls.map((call) => call.method), ["runtime.listRunning"]);
});

test("errors never echo paths or raw backend messages", async () => {
  const root = temp("pix-auth-sanitize-");
  const roots = await createAllowedRootService({ roots: [root] });
  const { authorizer } = await makeAuthorizer({
    roots,
    live: rpcError("timeout", `rpc failed for ${root}`, true),
  });
  const decision = await authorizer.authorize({ sessionId: "s-live", intent: "observe" });
  assert.equal(decision.ok, false);
  assert.equal(JSON.stringify(decision.error).includes(root), false);
  assert.equal(decision.error.message.includes(root), false);
});
