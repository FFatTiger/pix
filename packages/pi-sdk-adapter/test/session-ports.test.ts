import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import type { PiSdkSessionManager, PiSdkSessionsSurface } from "../src/internal/session-store.js";
import {
  createPiSdkSessionCatalog,
  createPiSdkSessionLocator,
  createPiSdkSessionPorts,
} from "../src/sessions/index.js";

// ---------------------------------------------------------------------------
// Injected-SDK fixtures (deterministic scan counting). Mirrors the fixtures in
// sessions.test.ts without touching that file (owned by WP-1).
// ---------------------------------------------------------------------------

interface FakeSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

function mkInfo(overrides: { path: string; id: string } & Partial<Omit<FakeSessionInfo, "path" | "id">>): FakeSessionInfo {
  return {
    cwd: "/workspace",
    created: new Date(1_700_000_000_000),
    modified: new Date(1_700_000_000_001),
    messageCount: 1,
    firstMessage: "hi",
    allMessagesText: "hi",
    ...overrides,
  };
}

function fakeManager(id: string): PiSdkSessionManager {
  return {
    getEntries: () => [],
    getBranch: () => [],
    buildContextEntries: () => [],
    getLeafId: () => null,
    getEntry: () => undefined,
    getSessionId: () => id,
    getHeader: () => undefined,
  };
}

/** An SDK surface whose single `listAll` counts cold scans. */
function countingSdk(counter: { scans: number }): PiSdkSessionsSurface {
  return {
    async listAll() {
      counter.scans += 1;
      return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
    },
    open() { return fakeManager("s1"); },
  };
}

// ---------------------------------------------------------------------------
// Shared production pair (WP-2: one store / one cache for catalog + locator)
// ---------------------------------------------------------------------------

describe("pi-sdk session ports (shared pair)", () => {
  it("default pair shares one store: a cold locate then a catalog read runs a single listAll", async () => {
    const counter = { scans: 0 };
    const store = createPiSdkSessionStore({ sdk: countingSdk(counter) });
    const { catalog, locator } = createPiSdkSessionPorts(store);

    // Cold locate → exactly one scan on the shared store.
    const located = await locator.locate("s1");
    assert.equal(located.exists, true);
    assert.equal(located.sessionId, "s1");
    assert.equal(counter.scans, 1);

    // Warm catalog read on the SAME store → reuses the shared cache, no scan.
    const detail = await catalog.readSession("s1");
    assert.equal(detail.sessionId, "s1");
    assert.equal(counter.scans, 1, "locate→catalog read must run a single listAll");
  });

  it("separately created catalog/locator stores stay independent: the same sequence costs two scans", async () => {
    const counter = { scans: 0 };
    const catalog = createPiSdkSessionCatalog(createPiSdkSessionStore({ sdk: countingSdk(counter) }));
    const locator = createPiSdkSessionLocator(createPiSdkSessionStore({ sdk: countingSdk(counter) }));

    await locator.locate("s1");      // store A cold scan
    await catalog.readSession("s1"); // store B cold scan (independent cache)
    assert.equal(counter.scans, 2, "separate explicit stores must not share a cache");
  });

  it("pair delegates every port method to the shared store and leaks no SDK names", async () => {
    const counter = { scans: 0 };
    const store = createPiSdkSessionStore({ sdk: countingSdk(counter) });
    const { catalog, locator } = createPiSdkSessionPorts(store);

    const headers = await catalog.listSessions();
    assert.equal(headers.length, 1);
    assert.equal(headers[0]?.sessionId, "s1");

    const ctx = await catalog.readSessionContext("s1");
    assert.equal(ctx.sessionId, "s1");

    const leaf = await locator.resolveLeafId("s1");
    assert.equal(typeof leaf, "string");

    for (const value of [catalog, locator]) {
      const names = Object.getOwnPropertyNames(value);
      const leaked = names.some((name) =>
        /AgentSession|SessionManager|ModelRuntime|ResourceLoader|TrustStore|AuthStorage/.test(name),
      );
      assert.equal(leaked, false);
    }
  });

  it("default pair constructs lazily and lists without touching the network or a worker", async () => {
    // Constructing and listing must not throw even when the real agent dir is
    // empty/absent — it is pure read-only filesystem access.
    const { catalog, locator } = createPiSdkSessionPorts();
    const list = await catalog.listSessions();
    assert.ok(Array.isArray(list));
    assert.equal(typeof locator.locate, "function");
  });
});
