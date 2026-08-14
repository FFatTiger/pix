import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeError,
  SessionCatalogPort,
  SessionLocatorPort,
} from "@fffattiger/pix-runtime-core";
import { isRuntimeError } from "@fffattiger/pix-runtime-core";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import type { PiSdkSessionManager, PiSdkSessionsSurface } from "../src/internal/session-store.js";
import {
  createPiSdkSessionCatalog,
  createPiSdkSessionLocator,
  type PiSdkSessionStore,
} from "../src/sessions/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function usage() {
  return {
    input: 11,
    output: 22,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 40,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
  };
}

interface Fixture {
  root: string;
  sessionDir: string;
  cwd: string;
  catalog: SessionCatalogPort;
  locator: SessionLocatorPort;
  store: PiSdkSessionStore;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pix-sessions-adapter-"));
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const store = createPiSdkSessionStore({ sessionDir });
  return {
    root,
    sessionDir,
    cwd,
    store,
    catalog: createPiSdkSessionCatalog(store),
    locator: createPiSdkSessionLocator(store),
  };
}

/** Build a session populated with every mapped message shape, returning ids. */
async function seedRichSession(f: Fixture, cwdOverride?: string) {
  const manager = SessionManager.create(cwdOverride ?? f.cwd, f.sessionDir);
  const user = manager.appendMessage({ role: "user", content: "hello", timestamp: NOW });
  const assistant = manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "sure" },
      { type: "toolCall", id: "call-1", name: "search", arguments: { q: "pix" } },
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "claude-test",
    usage: usage(),
    stopReason: "toolUse",
    timestamp: NOW + 1,
  });
  const toolResult = manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "search",
    content: [{ type: "text", text: "hit" }],
    isError: false,
    timestamp: NOW + 2,
  });
  const bash = manager.appendMessage({
    role: "bashExecution",
    command: "echo hi",
    output: "hi",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: NOW + 3,
  });
  manager.appendCustomMessageEntry("my-extension", "injected", true, { meta: 1 });
  return { manager, sessionId: manager.getSessionId(), user, assistant, toolResult, bash };
}

function isNotFound(error: unknown): error is RuntimeError {
  return isRuntimeError(error) && error.code === "not_found";
}

// ---------------------------------------------------------------------------
// Injected-SDK fixtures: valid list info + a manager that never needs to read
// entries, letting tests prove list-time behavior deterministically.
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
    created: new Date(NOW),
    modified: new Date(NOW + 1),
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

// ---------------------------------------------------------------------------
// Real temp-JSONL: list / read / context / mapping
// ---------------------------------------------------------------------------

describe("pi-sdk sessions catalog (real JSONL)", () => {
  it("lists seeded sessions with canonical headers", async () => {
    const f = await setup();
    try {
      await seedRichSession(f);
      const headers = await f.catalog.listSessions();
      assert.equal(headers.length, 1);
      const [header] = headers;
      assert.ok(header);
      assert.equal(header.cwd, f.cwd);
      assert.equal(header.projectRoot, f.cwd);
      assert.equal(typeof header.createdAt, "number");
      assert.equal(typeof header.updatedAt, "number");
      assert.equal(typeof header.messageCount, "number");
      assert.ok(header.sessionFile?.endsWith(".jsonl"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("reads a session and maps thinking/tool/custom/bash messages", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      const detail = await f.catalog.readSession(sessionId);
      const entries = detail.entries ?? [];
      // user, assistant, toolResult, bash, custom_message -> 5 mapped entries
      assert.equal(entries.length, 5);

      const user = entries.find((e) => e.message.role === "user");
      assert.deepEqual(user?.message, { role: "user", content: "hello", timestamp: NOW });

      const assistant = entries.find((e) => e.message.role === "assistant");
      assert.equal(assistant?.message.role, "assistant");
      if (assistant?.message.role !== "assistant") throw new Error("unreachable");
      const blocks = assistant.message.content;
      assert.equal(blocks[0]?.type, "thinking");
      assert.equal(blocks[1]?.type, "text");
      const call = blocks[2];
      assert.equal(call?.type, "toolCall");
      if (call?.type === "toolCall") {
        assert.equal(call.toolCallId, "call-1");
        assert.equal(call.toolName, "search");
        assert.deepEqual(call.input, { q: "pix" });
      }
      assert.equal(assistant.message.model, "claude-test");
      assert.equal(assistant.message.provider, "anthropic");
      assert.equal(assistant.message.usage?.input, 11);
      assert.equal(assistant.message.usage?.output, 22);

      const toolResult = entries.find((e) => e.message.role === "toolResult");
      assert.equal(toolResult?.message.role, "toolResult");
      if (toolResult?.message.role !== "toolResult") throw new Error("unreachable");
      assert.equal(toolResult.message.toolCallId, "call-1");
      assert.equal(toolResult.message.isError, false);

      const bash = entries.find((e) => e.message.role === "bashExecution");
      assert.equal(bash?.message.role, "bashExecution");
      if (bash?.message.role !== "bashExecution") throw new Error("unreachable");
      assert.equal(bash.message.command, "echo hi");
      assert.equal(bash.message.output, "hi");
      assert.equal(bash.message.exitCode, 0);

      const custom = entries.find((e) => e.message.role === "custom");
      assert.equal(custom?.message.role, "custom");
      if (custom?.message.role !== "custom") throw new Error("unreachable");
      assert.equal(custom.message.customType, "my-extension");
      assert.equal(custom.message.display, true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("readSessionContext returns the active leaf path by default and a branch by leafId", async () => {
    const f = await setup();
    try {
      const { sessionId, user, assistant } = await seedRichSession(f);
      const full = await f.catalog.readSessionContext(sessionId);
      assert.equal(full.sessionId, sessionId);
      assert.ok(full.leafId);
      const fullIds = full.entries.map((e) => e.entryId);
      assert.ok(fullIds.includes(user));
      assert.ok(fullIds.includes(assistant));
      // every entry carries a leaf-resolved id chain
      assert.ok(full.entries.length >= 4);

      // Branch context: ask for the path up to the assistant entry only.
      const branched = await f.catalog.readSessionContext(sessionId, { leafId: assistant });
      const branchIds = branched.entries.map((e) => e.entryId);
      assert.ok(branchIds.includes(assistant));
      assert.ok(branchIds.includes(user));
      // the branch stops before later entries
      assert.equal(branchIds.includes(full.leafId!), false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("throws structured not_found for missing sessions", async () => {
    const f = await setup();
    try {
      await assert.rejects(() => f.catalog.readSession("nope"), isNotFound);
      await assert.rejects(() => f.catalog.readSessionContext("nope"), isNotFound);
      await assert.rejects(() => f.catalog.deleteSession("nope"), isNotFound);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("deleteSession removes the session file", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      await f.catalog.deleteSession(sessionId);
      const headers = await f.catalog.listSessions();
      assert.equal(headers.length, 0);
      await assert.rejects(() => f.catalog.readSession(sessionId), isNotFound);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real temp-JSONL: locator
// ---------------------------------------------------------------------------

describe("pi-sdk sessions locator (real JSONL)", () => {
  it("locates existing and missing sessions", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      const present = await f.locator.locate(sessionId);
      assert.equal(present.exists, true);
      assert.equal(present.sessionId, sessionId);
      assert.ok(present.sessionFile.endsWith(".jsonl"));

      const absent = await f.locator.locate("missing-id");
      assert.equal(absent.exists, false);
      assert.equal(absent.sessionId, "missing-id");
      assert.ok(absent.sessionFile.includes("missing-id"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("resolves the current leaf, a target entry, and rejects unknown targets", async () => {
    const f = await setup();
    try {
      const { sessionId, user, assistant } = await seedRichSession(f);

      const leaf = await f.locator.resolveLeafId(sessionId);
      assert.equal(typeof leaf, "string");
      assert.notEqual(leaf, sessionId); // a real entry id, not the fallback

      const targeted = await f.locator.resolveLeafId(sessionId, assistant);
      assert.equal(targeted, assistant);

      const earliest = await f.locator.resolveLeafId(sessionId, user);
      assert.equal(earliest, user);

      await assert.rejects(() => f.locator.resolveLeafId(sessionId, "bogus-entry"), isNotFound);
      await assert.rejects(() => f.locator.resolveLeafId("missing", user), isNotFound);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real temp-JSONL: fork provenance (pix-fork-provenance only)
// ---------------------------------------------------------------------------

describe("pi-sdk sessions fork provenance", () => {
  // The Pi SDK buffers a session in memory until the first assistant message
  // arrives, then flushes the JSONL. Seed an assistant turn so the file lands
  // on disk and the catalog can read it back.
  function flush(manager: SessionManager) {
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "anthropic",
      provider: "anthropic",
      model: "m",
      usage: usage(),
      stopReason: "stop",
      timestamp: NOW + 9,
    });
  }

  it("keeps pix-fork-provenance in the detail path, not in the list header", async () => {
    const f = await setup();
    try {
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      manager.appendMessage({ role: "user", content: "forked", timestamp: NOW });
      manager.appendCustomEntry("pix-fork-provenance", {
        parentSessionId: "parent-session",
        forkPointEntryId: "parent-entry",
      });
      flush(manager);
      const sessionId = manager.getSessionId();
      const headers = await f.catalog.listSessions();
      const [header] = headers;
      // The list derives parentSessionId only from the SDK-native
      // `parentSessionPath`; this session has none, and `forkPointEntryId`
      // requires reading entries, so neither appears in list headers.
      assert.equal(header?.parentSessionId, undefined);
      assert.equal(header?.forkPointEntryId, undefined);
      // The detail path retains full provenance behavior.
      const detail = await f.catalog.readSession(sessionId);
      assert.equal(detail.parentSessionId, "parent-session");
      assert.equal(detail.forkPointEntryId, "parent-entry");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("falls back to the SDK-native parentSession header and ignores other custom types", async () => {
    const f = await setup();
    try {
      const parent = SessionManager.create(join(f.root, "parent-cwd"), f.sessionDir);
      parent.appendMessage({ role: "user", content: "p", timestamp: NOW });
      flush(parent);

      const child = SessionManager.create(f.cwd, f.sessionDir, { parentSession: parent.getSessionFile()! });
      child.appendMessage({ role: "user", content: "child", timestamp: NOW });
      // a non-pix custom entry must NOT be treated as provenance
      child.appendCustomEntry("some-other-type", { parentSessionId: "should-be-ignored" });
      flush(child);

      const headers = await f.catalog.listSessions();
      const childHeader = headers.find((h) => h.sessionId === child.getSessionId());
      assert.equal(childHeader?.parentSessionId, parent.getSessionId());
      assert.equal(childHeader?.forkPointEntryId, undefined);

      // The detail path also resolves the SDK-native parent header to the
      // parent session id (via the warm path→id index, no second open).
      const detail = await f.catalog.readSession(child.getSessionId());
      assert.equal(detail.parentSessionId, parent.getSessionId());
      assert.equal(detail.forkPointEntryId, undefined);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Injected-SDK list performance + parent parity + cache semantics
// ---------------------------------------------------------------------------

describe("pi-sdk sessions list performance (injected SDK)", () => {
  it("lists headers from a single listAll without opening any session file", async () => {
    let openCalls = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
      },
      open() { openCalls += 1; throw new Error("SessionManager.open must not be called during list"); },
    };
    const store = createPiSdkSessionStore({ sdk });
    const headers = await store.listSessions();
    assert.equal(headers.length, 1);
    assert.equal(headers[0]?.sessionId, "s1");
    assert.equal(openCalls, 0);
  });

  it("derives parentSessionId from parentSessionPath via the normalized path map (legacy web parity)", async () => {
    const infos = [
      mkInfo({ path: "/repo/sessions/p.jsonl", id: "parent" }),
      mkInfo({ path: "/repo/sessions/c1.jsonl", id: "c1", parentSessionPath: "/repo/sessions/p.jsonl" }),
      mkInfo({ path: "/repo/sessions/c2.jsonl", id: "c2", parentSessionPath: "/repo/sub/../sessions/p.jsonl" }),
      mkInfo({ path: "/repo/sessions/c3.jsonl", id: "c3", parentSessionPath: "sessions/p.jsonl" }),
      mkInfo({ path: "/repo/sessions/c4.jsonl", id: "c4", parentSessionPath: "/repo/other/missing.jsonl" }),
      mkInfo({ path: "/repo/sessions/c5.jsonl", id: "c5" }),
    ];
    const sdk: PiSdkSessionsSurface = {
      async listAll() { return infos; },
      open() { throw new Error("unexpected open"); },
    };
    const store = createPiSdkSessionStore({ sdk });
    const headers = await store.listSessions();
    const byId = new Map(headers.map((h) => [h.sessionId, h]));
    assert.equal(byId.get("parent")?.parentSessionId, undefined); // no parent recorded
    assert.equal(byId.get("c1")?.parentSessionId, "parent");     // exact absolute match
    assert.equal(byId.get("c2")?.parentSessionId, "parent");     // dot segments normalize
    assert.equal(byId.get("c3")?.parentSessionId, undefined);     // relative path does not resolve
    assert.equal(byId.get("c4")?.parentSessionId, undefined);     // missing parent
    assert.equal(byId.get("c5")?.parentSessionId, undefined);     // no parentSessionPath
  });

  it("serves a 30s TTL cache, coalesces concurrent calls to one scan, and retries after failure", async () => {
    let now = 1_000;
    let scans = 0;
    let failNext = false;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (failNext) { failNext = false; throw new Error("scan failed"); }
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
      },
      open() { throw new Error("unexpected open"); },
    };
    const store = createPiSdkSessionStore({ sdk, now: () => now, listTtlMs: 30_000 });

    await store.listSessions();                 // cold
    assert.equal(scans, 1);
    await store.listSessions();                 // warm hit
    assert.equal(scans, 1);
    now += 30_001; await store.listSessions();  // expiry
    assert.equal(scans, 2);
    now += 30_001;
    await Promise.all([1, 2, 3, 4].map(() => store.listSessions())); // 4 concurrent → 1 scan
    assert.equal(scans, 3);
    now += 30_001;
    failNext = true;
    await assert.rejects(() => store.listSessions(), /scan failed/); // failure → no cache
    assert.equal(scans, 4);
    await store.listSessions();                 // retry succeeds
    assert.equal(scans, 5);
  });

  it("never returns a wrong session when a path was reused by another session id", async () => {
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "requested" })];
      },
      open() { return fakeManager("different-session"); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await assert.rejects(() => store.readSession("requested"), isNotFound);
    await assert.rejects(() => store.readSessionContext("requested"), isNotFound);
    const located = await store.locate("requested");
    assert.equal(located.exists, false);
  });
});

// ---------------------------------------------------------------------------
// Real-JSONL warm reads reuse the list index (scan counting via injected SDK)
// ---------------------------------------------------------------------------

describe("pi-sdk sessions warm reads reuse the list index (real JSONL)", () => {
  it("read/context/locate/resolveLeafId do not re-scan after a warm list; stale paths rebuild once", async () => {
    const f = await setup();
    try {
      const { sessionId, assistant } = await seedRichSession(f);
      let scans = 0;
      const sdk: PiSdkSessionsSurface = {
        async listAll(dir?: string) {
          scans += 1;
          return dir === undefined ? SessionManager.listAll() : SessionManager.listAll(dir);
        },
        open: (path: string) => SessionManager.open(path) as unknown as PiSdkSessionManager,
      };
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir, sdk });
      const catalog = createPiSdkSessionCatalog(store);
      const locator = createPiSdkSessionLocator(store);

      // cold read → exactly one scan
      await catalog.readSession(sessionId);
      assert.equal(scans, 1);

      // warm read / context / locate / resolveLeafId → no additional scan
      await catalog.readSession(sessionId);
      await catalog.readSessionContext(sessionId, { leafId: assistant });
      const located = await locator.locate(sessionId);
      await locator.resolveLeafId(sessionId, assistant);
      assert.equal(located.exists, true);
      assert.equal(scans, 1);

      // externally deleted file → warm read rebuilds once then not_found
      await rm(located.sessionFile);
      await assert.rejects(() => catalog.readSession(sessionId), isNotFound);
      assert.equal(scans, 2);

      // a newly created session recovers with a single fresh scan
      const { sessionId: newId } = await seedRichSession(f);
      const detail = await catalog.readSession(newId);
      assert.equal(detail.sessionId, newId);
      assert.equal(scans, 3);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Controllable fixture: catalog filter + delegation
// ---------------------------------------------------------------------------

describe("pi-sdk sessions catalog filter (injected store)", () => {
  function fixtureStore(sessions: { sessionId: string; cwd: string }[]): PiSdkSessionStore {
    const headers = sessions.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      projectRoot: s.cwd,
      createdAt: NOW,
      updatedAt: NOW,
      lastMessageAt: NOW,
      messageCount: 1,
    }));
    const base: PiSdkSessionStore = {
      async listSessions() { return headers; },
      async readSession(id) { return { ...headers.find((h) => h.sessionId === id)!, entries: [] }; },
      async readSessionContext(id) { return { sessionId: id, entries: [] }; },
      async deleteSession() {},
      async locate(id) { return { sessionId: id, sessionFile: `${id}.jsonl`, exists: true }; },
      async resolveLeafId(id) { return id; },
    };
    return base;
  }

  it("filters by cwd and applies offset/limit", async () => {
    const store = fixtureStore([
      { sessionId: "a", cwd: "/p1" },
      { sessionId: "b", cwd: "/p2" },
      { sessionId: "c", cwd: "/p1" },
      { sessionId: "d", cwd: "/p1" },
    ]);
    const catalog = createPiSdkSessionCatalog(store);

    const p1 = await catalog.listSessions({ cwd: "/p1" });
    assert.deepEqual(p1.map((h) => h.sessionId), ["a", "c", "d"]);

    const limited = await catalog.listSessions({ limit: 2 });
    assert.equal(limited.length, 2);

    const paged = await catalog.listSessions({ offset: 1, limit: 1 });
    assert.deepEqual(paged.map((h) => h.sessionId), ["b"]);
  });

  it("delegates read/context/delete/locate/resolveLeafId to the store", async () => {
    const store = fixtureStore([{ sessionId: "x", cwd: "/p" }]);
    const catalog = createPiSdkSessionCatalog(store);
    const locator = createPiSdkSessionLocator(store);

    const detail = await catalog.readSession("x");
    assert.equal(detail.sessionId, "x");
    const ctx = await catalog.readSessionContext("x", { leafId: "x" });
    assert.equal(ctx.sessionId, "x");
    const loc = await locator.locate("x");
    assert.equal(loc.exists, true);
    const leaf = await locator.resolveLeafId("x", "x");
    assert.equal(leaf, "x");
    await catalog.deleteSession("x");
  });
});

// ---------------------------------------------------------------------------
// Public surface + zero-Worker boundary
// ---------------------------------------------------------------------------

describe("pi-sdk sessions public surface", () => {
  it("exposes catalog/locator factories returning backend-neutral ports", () => {
    const catalog = createPiSdkSessionCatalog();
    const locator = createPiSdkSessionLocator();
    for (const value of [catalog, locator]) {
      const names = Object.getOwnPropertyNames(value);
      const leaked = names.some((name) =>
        /AgentSession|SessionManager|ModelRuntime|ResourceLoader|TrustStore|AuthStorage/.test(name),
      );
      assert.equal(leaked, false);
    }
    // The returned objects satisfy the runtime-core port contracts.
    assert.equal(typeof catalog.listSessions, "function");
    assert.equal(typeof catalog.readSession, "function");
    assert.equal(typeof catalog.readSessionContext, "function");
    assert.equal(typeof catalog.deleteSession, "function");
    assert.equal(typeof locator.locate, "function");
    assert.equal(typeof locator.resolveLeafId, "function");
  });

  it("constructs without touching the network or spawning a worker (default store)", async () => {
    // Constructing and listing must not throw even when the real agent dir is
    // empty/absent — it is pure read-only filesystem access.
    const catalog = createPiSdkSessionCatalog();
    const list = await catalog.listSessions();
    assert.ok(Array.isArray(list));
  });
});
