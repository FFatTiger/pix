/**
 * Assistant feature tests (Host side):
 *  - `createAssistantWorkspaceResource`: derives the fixed
 *    `<home>/.pi/pix/assistant` directory, creates it 0700, authorizes it
 *    against AllowedRoots (null + no trust writes when outside roots) and
 *    ensures a one-time project-trust decision through the same seams
 *    POST /v1/trust uses (read-first; write only when untrusted);
 *  - `GET /v1/assistant`: returns the cwd + latest session id, 503 when the
 *    sessiond-backed lookup fails, 404 when the seam is not mounted;
 *  - capability projection: `assistant` advertised in the full projection
 *    only while the seam is mounted, always stripped from the degraded
 *    (readonly) projection.
 */
import { tempDir } from "./canon-tmp.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../dist/index.js";
import {
  createAllowedRootService,
  createAssistantWorkspaceResource,
  createHostApp,
  registerAssistantRoutes,
  resolveCapabilities,
} from "../dist/index.js";

const DISABLED_GATE = { read: () => ({ status: "disabled", source: "test" }) };
const call = (app, path) => app.request(`http://localhost${path}`, { headers: { host: "localhost" } });

function recordingTrust(initialTrusted) {
  const calls = { isTrusted: [], setTrusted: [] };
  return {
    calls,
    trust: {
      getProjectTrustState: async (cwd) => ({ cwd, level: initialTrusted ? "trusted" : "unknown" }),
      isTrusted: async (cwd) => {
        calls.isTrusted.push(cwd);
        return initialTrusted;
      },
      canReloadResources: async (cwd) => ({ cwd, reload: true }),
    },
    mutation: {
      setTrusted: async (cwd) => {
        calls.setTrusted.push(cwd);
        return { cwd, level: "trusted", source: "saved" };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// createAssistantWorkspaceResource
// ---------------------------------------------------------------------------

test("assistant workspace resource creates the derived directory 0700 and trusts it once", async () => {
  const root = tempDir("pix-assistant-host-");
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const roots = await createAllowedRootService({ roots: [home], allowLocalExpansion: false, allowLanExpansion: false });
    const { calls, trust, mutation } = recordingTrust(false);
    const resource = await createAssistantWorkspaceResource({ home, roots, trust, trustMutation: mutation, logger: {} });
    assert.ok(resource, "resource mounts when home is an allowed root");
    // Canonical (realpath'd on macOS /var -> /private/var).
    assert.equal(resource.cwd, realpathSync(join(home, ".pi", "pix", "assistant")));
    const stats = statSync(resource.cwd);
    assert.ok(stats.isDirectory());
    // 0700 (plus setuid-style bits are never set by mkdir mode on purpose).
    // NTFS has no POSIX mode bits — every file reads 0o666 — so the win32
    // equivalent is existence + the same read-first trust ensure below.
    if (process.platform !== "win32") {
      assert.equal(stats.mode & 0o777, 0o700);
    }
    // Read-first trust ensure: exactly one read, one write, on the canonical dir.
    assert.deepEqual(calls.isTrusted, [resource.cwd]);
    assert.deepEqual(calls.setTrusted, [resource.cwd]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("already-trusted deployments write nothing at boot", async () => {
  const root = tempDir("pix-assistant-host-");
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const roots = await createAllowedRootService({ roots: [home], allowLocalExpansion: false, allowLanExpansion: false });
    const { calls, trust, mutation } = recordingTrust(true);
    const resource = await createAssistantWorkspaceResource({ home, roots, trust, trustMutation: mutation, logger: {} });
    assert.ok(resource);
    assert.deepEqual(calls.isTrusted, [resource.cwd]);
    assert.deepEqual(calls.setTrusted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant outside AllowedRoots stays disabled with no trust writes", async () => {
  const root = tempDir("pix-assistant-host-");
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const otherRoot = join(root, "elsewhere");
    mkdirSync(otherRoot, { recursive: true });
    const roots = await createAllowedRootService({ roots: [otherRoot], allowLocalExpansion: false, allowLanExpansion: false });
    const { calls, trust, mutation } = recordingTrust(false);
    const resource = await createAssistantWorkspaceResource({ home, roots, trust, trustMutation: mutation, logger: {} });
    assert.equal(resource, null);
    assert.deepEqual(calls.setTrusted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trust-write failure is non-fatal (empty dir needs no trust decision)", async () => {
  const root = tempDir("pix-assistant-host-");
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const roots = await createAllowedRootService({ roots: [home], allowLocalExpansion: false, allowLanExpansion: false });
    const warnings = [];
    const resource = await createAssistantWorkspaceResource({
      home,
      roots,
      trust: {
        getProjectTrustState: async (cwd) => ({ cwd, level: "unknown" }),
        isTrusted: async () => false,
        canReloadResources: async (cwd) => ({ cwd, reload: true }),
      },
      trustMutation: {
        setTrusted: async () => {
          throw new Error("write failed");
        },
      },
      logger: { warn: (message) => warnings.push(message) },
    });
    assert.ok(resource, "resource still mounts");
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/assistant
// ---------------------------------------------------------------------------

function assistantApp(client) {
  const app = createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    assistant: { cwd: "/home/x/.pi/pix/assistant", client },
  }).app;
  return app;
}

test("GET /v1/assistant returns the cwd and latest assistant session id", async () => {
  let seenCwd;
  const app = assistantApp({
    async findLatest(cwd) {
      seenCwd = cwd;
      return { cwd, sessionId: "assistant-session-1" };
    },
  });
  const res = await call(app, "/v1/assistant");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cwd, "/home/x/.pi/pix/assistant");
  assert.equal(body.sessionId, "assistant-session-1");
  assert.equal(seenCwd, "/home/x/.pi/pix/assistant");
});

test("GET /v1/assistant answers null before the first assistant message", async () => {
  const app = assistantApp({
    async findLatest(cwd) {
      return { cwd, sessionId: null };
    },
  });
  const res = await call(app, "/v1/assistant");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sessionId, null);
});

test("GET /v1/assistant maps a sessiond outage to a fixed 503", async () => {
  const app = assistantApp({
    async findLatest() {
      throw new Error("sessiond down");
    },
  });
  const res = await call(app, "/v1/assistant");
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "SESSIONS_UNAVAILABLE");
  assert.equal(body.message, "Session history is unavailable");
});

test("the assistant route is not mounted without the seam (404)", async () => {
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE } }).app;
  const res = await call(app, "/v1/assistant");
  assert.equal(res.status, 404);
});

test("registerAssistantRoutes requires exact deps (compile-level contract via runtime shape)", async () => {
  // Direct registration keeps the narrow seam explicit for embedders.
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE } }).app;
  registerAssistantRoutes(app, {
    cwd: "/h/.pi/pix/assistant",
    client: { async findLatest(cwd) { return { cwd, sessionId: "s" }; } },
  });
  const res = await call(app, "/v1/assistant");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sessionId, "s");
});

// ---------------------------------------------------------------------------
// GET /v1/assistant?sessionId= — EXACT conversation selection
// ---------------------------------------------------------------------------

/** Assistant app + a client recorder proving what the route did/did not call. */
function assistantSelectorApp(client) {
  const app = createHostApp({
    logger: {},
    gate: { config: DISABLED_GATE },
    assistant: { cwd: "/home/x/.pi/pix/assistant", client },
  }).app;
  return app;
}

test("GET /v1/assistant?sessionId= returns the binding for an exact assistant root session", async () => {
  let readId;
  const app = assistantSelectorApp({
    async findLatest() {
      throw new Error("the selector must never fall back to a latest lookup");
    },
    async read(sessionId) {
      readId = sessionId;
      return { session: { sessionId, cwd: "/home/x/.pi/pix/assistant", projectRoot: "/home/x/.pi/pix/assistant", createdAt: 1, updatedAt: 2, messageCount: 3 } };
    },
  });
  const res = await call(app, "/v1/assistant?sessionId=old-conversation");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cwd: "/home/x/.pi/pix/assistant", sessionId: "old-conversation" });
  assert.equal(readId, "old-conversation");
});

test("GET /v1/assistant?sessionId= accepts the REAL flat SessionDetail shape from sessiond", async () => {
  // sessiond `sessions.read` releases the SessionDetail object itself (no
  // wrapper field). Production composition must work with that exact shape.
  let readId;
  const app = assistantSelectorApp({
    async findLatest() { throw new Error("unused"); },
    async read(sessionId) {
      readId = sessionId;
      return {
        sessionId,
        cwd: "/home/x/.pi/pix/assistant",
        projectRoot: "/home/x/.pi/pix/assistant",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        lastMessageAt: 1_700_000_100_000,
        messageCount: 4,
        title: "Old Pixie chat",
        workspaceAccess: { state: "authorized", reason: "allowed_root" },
      };
    },
  });
  const res = await call(app, "/v1/assistant?sessionId=flat-conversation");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cwd: "/home/x/.pi/pix/assistant", sessionId: "flat-conversation" });
  assert.equal(readId, "flat-conversation");
});

test("GET /v1/assistant?sessionId= answers a fixed 404 (never latest) for a foreign, child or missing id", async () => {
  const cases = {
    foreign: { sessionId: "foreign", cwd: "/repo", projectRoot: "/repo", createdAt: 1, updatedAt: 2, messageCount: 1 },
    child: { sessionId: "child", cwd: "/home/x/.pi/pix/assistant", projectRoot: "/home/x/.pi/pix/assistant", parentSessionId: "parent", createdAt: 1, updatedAt: 2, messageCount: 1 },
    // A sibling directory that merely shares a prefix is a different workspace.
    sibling: { sessionId: "sibling", cwd: "/home/x/.pi/pix/assistantx", projectRoot: "/home/x/.pi/pix/assistantx", createdAt: 1, updatedAt: 2, messageCount: 1 },
    // A case-different directory is a REAL different directory on a
    // case-sensitive filesystem: identity is byte-for-byte, never case folded.
    cased: { sessionId: "cased", cwd: "/HOME/X/.pi/pix/assistant", projectRoot: "/HOME/X/.pi/pix/assistant", createdAt: 1, updatedAt: 2, messageCount: 1 },
    // A case-different ID for the SAME cwd is not the requested identity.
    casedId: { sessionId: "CASED", cwd: "/home/x/.pi/pix/assistant", projectRoot: "/home/x/.pi/pix/assistant", createdAt: 1, updatedAt: 2, messageCount: 1 },
    // Identity echo mismatch (stale read) must not be trusted either.
    mismatched: { sessionId: "other-id", cwd: "/home/x/.pi/pix/assistant", projectRoot: "/home/x/.pi/pix/assistant", createdAt: 1, updatedAt: 2, messageCount: 1 },
  };
  for (const [name, header] of Object.entries(cases)) {
    let latestCalls = 0;
    const app = assistantSelectorApp({
      async findLatest() {
        latestCalls += 1;
        return { cwd: "/home/x/.pi/pix/assistant", sessionId: "latest" };
      },
      async read() { return { session: header }; },
    });
    const res = await call(app, `/v1/assistant?sessionId=${name === "casedId" ? "cased-id" : name}`);
    assert.equal(res.status, 404, name);
    const body = await res.json();
    assert.equal(body.code, "ASSISTANT_SESSION_NOT_FOUND", name);
    assert.equal(latestCalls, 0, `${name}: never a latest fallback`);
  }
});

test("GET /v1/assistant?sessionId= maps an unknown id to 404 and a sessiond outage to 503", async () => {
  const notFoundApp = assistantSelectorApp({
    async findLatest() { throw new Error("unused"); },
    async read() {
      const error = new Error("session not found");
      error.code = "not_found";
      throw error;
    },
  });
  const missing = await call(notFoundApp, "/v1/assistant?sessionId=gone");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "ASSISTANT_SESSION_NOT_FOUND");

  const downApp = assistantSelectorApp({
    async findLatest() { throw new Error("unused"); },
    async read() { throw new Error("sessiond down"); },
  });
  const down = await call(downApp, "/v1/assistant?sessionId=any");
  assert.equal(down.status, 503);
  assert.equal((await down.json()).code, "SESSIONS_UNAVAILABLE");
});

test("GET /v1/assistant rejects unknown/empty selectors with a fixed error", async () => {
  const app = assistantSelectorApp({
    async findLatest() { throw new Error("unused"); },
    async read() { throw new Error("unused"); },
  });
  const unknown = await call(app, "/v1/assistant?sessionId=a&page=2");
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, "INVALID_QUERY");
  const empty = await call(app, "/v1/assistant?sessionId=");
  assert.equal(empty.status, 404);
});

// ---------------------------------------------------------------------------
// GET /v1/assistant/sessions — assistant workspace conversation history page
// ---------------------------------------------------------------------------

function assistantPage(overrides = {}) {
  return {
    sessions: [
      { sessionId: "newest", cwd: "/home/x/.pi/pix/assistant", projectRoot: "/home/x/.pi/pix/assistant", createdAt: 1, updatedAt: 3, messageCount: 2, title: "Newest" },
      { sessionId: "older", cwd: "/home/x/.pi/pix/assistant", projectRoot: "/home/x/.pi/pix/assistant", createdAt: 1, updatedAt: 2, messageCount: 2, title: "Older" },
    ],
    page: 1,
    pageSize: 20,
    total: 2,
    totalPages: 1,
    catalogRevision: 4,
    ...overrides,
  };
}

test("GET /v1/assistant/sessions serves the canonical SessionPage with the AllowedRoots projection", async () => {
  const root = tempDir("pix-assistant-page-");
  try {
    const assistantDir = join(root, "home", ".pi", "pix", "assistant");
    mkdirSync(assistantDir, { recursive: true });
    const roots = await createAllowedRootService({ roots: [join(root, "home")], allowLocalExpansion: false, allowLanExpansion: false });
    const canonical = realpathSync(assistantDir);
    const seen = [];
    const app = createHostApp({
      logger: {},
      gate: { config: DISABLED_GATE },
      assistant: {
        cwd: canonical,
        roots,
        client: {
          async findLatest(cwd) { return { cwd, sessionId: "newest" }; },
          async listAssistant(params) {
            seen.push(params);
            return assistantPage({
              sessions: [
                { sessionId: "newest", cwd: canonical, projectRoot: canonical, createdAt: 1, updatedAt: 3, messageCount: 2 },
                { sessionId: "older", cwd: canonical, projectRoot: canonical, createdAt: 1, updatedAt: 2, messageCount: 2 },
              ],
            });
          },
          async read() { throw new Error("unused"); },
        },
      },
    }).app;
    const res = await call(app, "/v1/assistant/sessions?page=1&pageSize=20");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 20);
    assert.equal(body.total, 2);
    assert.equal(body.totalPages, 1);
    assert.equal(body.catalogRevision, 4);
    assert.deepEqual(body.sessions.map((session) => session.sessionId), ["newest", "older"]);
    // Host is the authorization authority: every row carries the AllowedRoots
    // classification (never an adapter-supplied guess).
    for (const session of body.sessions) {
      assert.equal(session.workspaceAccess.state, "authorized");
      assert.equal(session.workspaceAccess.reason, "allowed_root");
    }
    // No cwd ever travels out: sessiond derives the assistant workspace itself.
    assert.deepEqual(seen, [{ page: 1, pageSize: 20 }]);
    // Defaulting mirrors /v1/sessions (page 1 / pageSize 50).
    await call(app, "/v1/assistant/sessions");
    assert.deepEqual(seen[1], { page: 1, pageSize: 50 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /v1/assistant/sessions validates its page query before any RPC", async () => {
  let calls = 0;
  const app = assistantApp({
    async findLatest(cwd) { return { cwd, sessionId: null }; },
    async listAssistant() { calls += 1; return assistantPage(); },
    async read() { throw new Error("unused"); },
  });
  for (const path of [
    "/v1/assistant/sessions?page=0",
    "/v1/assistant/sessions?pageSize=0",
    "/v1/assistant/sessions?pageSize=101",
    "/v1/assistant/sessions?page=1e3",
    "/v1/assistant/sessions?page=1&page=2",
    "/v1/assistant/sessions?cwd=/repo",
    "/v1/assistant/sessions?query=secret",
  ]) {
    const res = await call(app, path);
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).code, "INVALID_QUERY", path);
  }
  assert.equal(calls, 0, "no RPC is issued for an invalid page request");
});

test("GET /v1/assistant/sessions maps catalog failures to a fixed 503 and never fakes an empty page", async () => {
  const unavailable = assistantApp({
    async findLatest(cwd) { return { cwd, sessionId: null }; },
    async listAssistant() { throw new Error("sessiond down"); },
    async read() { throw new Error("unused"); },
  });
  const res = await call(unavailable, "/v1/assistant/sessions?page=1&pageSize=20");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "SESSIONS_UNAVAILABLE");

  // A missing seam method is an honest 503 too, never an empty page.
  const seamless = assistantApp({
    async findLatest(cwd) { return { cwd, sessionId: null }; },
  });
  const seamlessRes = await call(seamless, "/v1/assistant/sessions?page=1&pageSize=20");
  assert.equal(seamlessRes.status, 503);
  assert.equal((await seamlessRes.json()).code, "SESSIONS_UNAVAILABLE");

  // A malformed payload (not a SessionPage) is a 503, never a pass-through.
  const malformed = assistantApp({
    async findLatest(cwd) { return { cwd, sessionId: null }; },
    async listAssistant() { return { sessions: [] }; },
    async read() { throw new Error("unused"); },
  });
  const malformedRes = await call(malformed, "/v1/assistant/sessions?page=1&pageSize=20");
  assert.equal(malformedRes.status, 503);
});

test("GET /v1/assistant/sessions is not mounted without the assistant seam (404)", async () => {
  const app = createHostApp({ logger: {}, gate: { config: DISABLED_GATE } }).app;
  const res = await call(app, "/v1/assistant/sessions?page=1&pageSize=20");
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Capability projection
// ---------------------------------------------------------------------------

const FULL_LIST = ["agent", "sessions", "assistant", "files"];

test("the assistant token is advertised in the full projection only while the seam is mounted", async () => {
  const base = {
    logger: {},
    gate: { config: DISABLED_GATE },
    capabilities: { full: [...FULL_LIST], readonly: [...FULL_LIST] },
    sessiond: { isAvailable: async () => true },
  };
  const mounted = await resolveCapabilities({
    ...base,
    assistant: { cwd: "/h/.pi/pix/assistant", client: { async findLatest(cwd) { return { cwd, sessionId: null }; } } },
  });
  assert.ok(mounted.capabilities.includes("assistant"));

  const unmounted = await resolveCapabilities(base);
  assert.equal(unmounted.capabilities.includes("assistant"), false);
  assert.ok(unmounted.capabilities.includes("agent"));
});

test("the assistant token is stripped from the degraded projection even with the seam mounted", async () => {
  const result = await resolveCapabilities({
    logger: {},
    gate: { config: DISABLED_GATE },
    capabilities: { full: [...FULL_LIST], readonly: [...FULL_LIST] },
    sessiond: { isAvailable: async () => false },
    assistant: { cwd: "/h/.pi/pix/assistant", client: { async findLatest(cwd) { return { cwd, sessionId: null }; } } },
  });
  assert.equal(result.sessiond, "down");
  assert.equal(result.capabilities.includes("assistant"), false);
});
