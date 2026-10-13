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
  const root = mkdtempSync(join(tmpdir(), "pix-assistant-host-"));
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
    assert.equal(stats.mode & 0o777, 0o700);
    // Read-first trust ensure: exactly one read, one write, on the canonical dir.
    assert.deepEqual(calls.isTrusted, [resource.cwd]);
    assert.deepEqual(calls.setTrusted, [resource.cwd]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("already-trusted deployments write nothing at boot", async () => {
  const root = mkdtempSync(join(tmpdir(), "pix-assistant-host-"));
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
  const root = mkdtempSync(join(tmpdir(), "pix-assistant-host-"));
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
  const root = mkdtempSync(join(tmpdir(), "pix-assistant-host-"));
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
