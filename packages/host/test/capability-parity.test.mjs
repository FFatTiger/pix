import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostApp,
  createCapabilityResolver,
  SessiondRuntimeGateway,
  PRODUCTION_FULL_CAPABILITIES,
} from "../dist/index.js";

/**
 * Unified capability authority (D-capability parity verifier): HTTP
 * health/capabilities/bootstrap and the WS runtime handshake consume the SAME
 * seam-normalized CapabilityResolver output. A raw production capability list
 * (e.g. PRODUCTION_FULL_CAPABILITIES) can NEVER bypass mounted-seam
 * normalization on one surface while the other normalizes — catalog tokens and
 * session-mutation tokens are stripped on BOTH surfaces when the matching seam
 * is not mounted.
 */

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };

const hello = JSON.stringify({
  type: "handshake",
  payload: { protocolVersion: 2, client: { shell: "web", platform: "mac" }, features: [] },
});

class FakeSession {
  constructor() {
    this.sent = [];
    this.closed = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code: code ?? null, reason: reason ?? "" };
  }
  onMessage() {
    return () => {};
  }
  onClose() {
    return () => {};
  }
}

class NoopClient {
  async call(method) {
    throw new Error(`no handler for ${method}`);
  }
  async attach() {
    throw new Error("no attach handler");
  }
}

/**
 * Build the shared deps for the parity matrix: sessiond is up, the raw full
 * list is the production surface (includes session-mutation + catalog tokens),
 * but ONLY the seams explicitly passed are actually mounted.
 */
function makeParityApp({ withMutationSeams = false, withCatalogs = false }) {
  const deps = {
    logger: {},
    gate: { config: DISABLED_GATE },
    exposureMode: "local",
    sessiond: { isAvailable: async () => true },
    capabilities: {
      full: [...PRODUCTION_FULL_CAPABILITIES],
      readonly: ["files"],
    },
  };
  if (withMutationSeams) {
    deps.sessions = {
      client: {
        async list() { return { sessions: [] }; },
        async read() { return {}; },
        async context() { return { sessionId: "s", entries: [] }; },
        async tree() { return { sessionId: "s", roots: [], entryCount: 0 }; },
      },
      delete: {
        client: { async delete(id) { return { sessionId: id, deleted: true }; } },
        mutationGuard: { async assertAvailable() {} },
      },
      rename: {
        client: { async rename(id, name) { return { sessionId: id, name }; } },
        mutationGuard: { async assertAvailable() {} },
      },
      settings: {
        client: {
          async getIdleTimeoutMs() { return { idleTimeoutMs: 86_400_000 }; },
          async setIdleTimeoutMs(ms) { return { idleTimeoutMs: ms }; },
        },
        mutationGuard: { async assertAvailable() {} },
      },
    };
  }
  if (withCatalogs) {
    deps.catalogs = {
      roots: { isAuthorized: () => true },
      models: {},
      credentials: {},
      resources: {},
      trust: {},
      trustMutation: {},
      themes: {},
    };
  }
  // The SINGLE seam-normalized authority both surfaces consume.
  const capabilityResolver = createCapabilityResolver(deps);
  const host = createHostApp({ ...deps, capabilityResolver });
  return { host, capabilityResolver };
}

async function httpCapabilities(host) {
  const res = await host.app.request("http://localhost/v1/capabilities", { headers: { host: "localhost" } });
  assert.equal(res.status, 200);
  return res.json();
}

async function wsHandshakeCapabilities(resolver) {
  const gateway = new SessiondRuntimeGateway({
    mode: "local",
    capabilities: [],
    client: new NoopClient(),
    now: () => 1_700_000_000_000,
    resolveCapabilities: () => resolver.resolve(),
  });
  const session = new FakeSession();
  await gateway.attach(session, hello);
  const ack = JSON.parse(session.sent[0]);
  assert.equal(ack.type, "handshake_ack");
  return ack.payload.host.capabilities;
}

// The raw production list includes session.delete / session.write and every
// catalog token, but none of those seams are mounted here.
test("missing-seam parity: no mutation/catalog seams ⇒ HTTP and WS BOTH strip all seam-bound tokens", async () => {
  const { host, capabilityResolver } = makeParityApp({});
  const http = await httpCapabilities(host);
  const ws = await wsHandshakeCapabilities(capabilityResolver);

  assert.equal(http.sessiond, "up");
  // Neither surface advertises a seam-bound token: no session.delete /
  // session.write / models / auth.providers / skills / plugins / themes /
  // project.trust, even though the raw full list names them.
  const httpList = http.capabilities;
  const wsList = ws;
  assert.deepEqual(wsList, httpList, "WS handshake must mirror HTTP capabilities");
  assert.deepEqual(httpList, ["agent", "sessions", "files", "files.write", "files.watch", "files.upload", "git", "worktree", "worktree.write"]);
  for (const forbidden of ["session.delete", "session.write", "session.settings", "models", "auth.providers", "skills", "plugins", "themes", "project.trust"]) {
    assert.ok(!httpList.includes(forbidden), `HTTP must not advertise unmounted token ${forbidden}`);
    assert.ok(!wsList.includes(forbidden), `WS must not advertise unmounted token ${forbidden}`);
  }
});

test("missing-seam parity: only the delete seam mounted ⇒ session.delete on BOTH, session.write/catalog still stripped on BOTH", async () => {
  // Rebuild with only the delete seam.
  const deps = {
    logger: {},
    gate: { config: DISABLED_GATE },
    exposureMode: "local",
    sessiond: { isAvailable: async () => true },
    capabilities: { full: [...PRODUCTION_FULL_CAPABILITIES], readonly: ["files"] },
    sessions: {
      client: {
        async list() { return { sessions: [] }; },
        async read() { return {}; },
        async context() { return { sessionId: "s", entries: [] }; },
        async tree() { return { sessionId: "s", roots: [], entryCount: 0 }; },
      },
      delete: {
        client: { async delete(id) { return { sessionId: id, deleted: true }; } },
        mutationGuard: { async assertAvailable() {} },
      },
    },
  };
  const resolver = createCapabilityResolver(deps);
  const host = createHostApp({ ...deps, capabilityResolver: resolver });

  const http = await httpCapabilities(host);
  const ws = await wsHandshakeCapabilities(resolver);
  assert.deepEqual(ws, http.capabilities, "WS handshake must mirror HTTP capabilities");
  assert.ok(http.capabilities.includes("session.delete"), "mounted delete seam keeps session.delete on HTTP");
  assert.ok(ws.includes("session.delete"), "mounted delete seam keeps session.delete on WS");
  assert.ok(!http.capabilities.includes("session.write"), "unmounted rename seam strips session.write on HTTP");
  assert.ok(!ws.includes("session.write"), "unmounted rename seam strips session.write on WS");
  assert.ok(!http.capabilities.includes("models"), "unmounted catalog seam strips models on HTTP");
  assert.ok(!ws.includes("models"), "unmounted catalog seam strips models on WS");
});

test("all seams mounted ⇒ HTTP and WS both advertise the full production surface (no drift)", async () => {
  const { host, capabilityResolver } = makeParityApp({ withMutationSeams: true, withCatalogs: true });
  const http = await httpCapabilities(host);
  const ws = await wsHandshakeCapabilities(capabilityResolver);
  assert.deepEqual(ws, http.capabilities, "WS handshake must mirror HTTP capabilities");
  assert.deepEqual(http.capabilities, [...PRODUCTION_FULL_CAPABILITIES]);
});

test("sessiond down ⇒ HTTP and WS both degrade to the read-only projection (no drift)", async () => {
  const deps = {
    logger: {},
    gate: { config: DISABLED_GATE },
    exposureMode: "local",
    sessiond: { isAvailable: async () => false },
    capabilities: {
      full: [...PRODUCTION_FULL_CAPABILITIES],
      readonly: ["files", "git", "worktree", "themes", "project.trust"],
    },
  };
  const resolver = createCapabilityResolver(deps);
  const host = createHostApp({ ...deps, capabilityResolver: resolver });
  const http = await httpCapabilities(host);
  const ws = await wsHandshakeCapabilities(resolver);
  assert.equal(http.sessiond, "down");
  assert.deepEqual(ws, http.capabilities, "WS handshake must mirror the HTTP degraded projection");
  // catalog tokens (themes/project.trust) are stripped because no catalog seam
  // is mounted — even in the degraded/read-only projection.
  assert.deepEqual(http.capabilities, ["files", "git", "worktree"]);
});

test("bootstrap uses the same capabilityResolver output as health/capabilities", async () => {
  const { host, capabilityResolver } = makeParityApp({});
  const res = await host.app.request("http://localhost/v1/bootstrap", { headers: { host: "localhost" } });
  const body = await res.json();
  const http = await httpCapabilities(host);
  const ws = await wsHandshakeCapabilities(capabilityResolver);
  assert.deepEqual(body.capabilities, http.capabilities, "bootstrap must mirror /v1/capabilities");
  assert.deepEqual(body.capabilities, ws, "bootstrap must mirror the WS handshake");
});
