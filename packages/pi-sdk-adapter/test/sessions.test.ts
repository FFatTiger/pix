import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  RuntimeError,
  SessionCatalogPort,
  SessionLocatorPort,
} from "@fffattiger/pix-runtime-core";
import { isRuntimeError, makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { createPiSdkSessionStore, deferHistoryEntry } from "../src/internal/session-store.js";
import type { PiSdkSessionManager, PiSdkSessionsSurface } from "../src/internal/session-store.js";
import {
  createPiSdkSessionCatalog,
  createPiSdkSessionLocator,
  createPiSdkSessionMutation,
  createPiSdkSessionPorts,
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
    appendSessionInfo: () => "",
  };
}

/** Derive a fake session id from a path like "/repo/sessions/s2.jsonl". */
function idFromPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.jsonl$/, "");
}

/** Yield to the macrotask queue so all pending microtasks flush. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
      assert.deepEqual(full.settings, {
        model: { provider: "anthropic", modelId: "claude-test" },
        thinkingLevel: "off",
      });

      // Branch context: ask for the path up to the assistant entry only.
      const branched = await f.catalog.readSessionContext(sessionId, { leafId: assistant });
      const branchIds = branched.entries.map((e) => e.entryId);
      assert.ok(branchIds.includes(assistant));
      assert.ok(branchIds.includes(user));
      // the branch stops before later entries
      assert.equal(branchIds.includes(full.leafId!), false);
      assert.deepEqual(branched.settings, full.settings);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("projects model and thinking changes from the selected JSONL branch", async () => {
    const f = await setup();
    try {
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      manager.appendMessage({ role: "user", content: "hello", timestamp: NOW });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "openai",
        provider: "openai",
        model: "gpt-4",
        usage: usage(),
        stopReason: "stop",
        timestamp: NOW + 1,
      });
      const modelLeaf = manager.appendModelChange("openai", "gpt-5");
      manager.appendThinkingLevelChange("high");
      const context = await f.catalog.readSessionContext(manager.getSessionId());
      assert.deepEqual(context.settings, {
        model: { provider: "openai", modelId: "gpt-5" },
        thinkingLevel: "high",
      });
      const beforeThinking = await f.catalog.readSessionContext(manager.getSessionId(), { leafId: modelLeaf });
      assert.deepEqual(beforeThinking.settings, {
        model: { provider: "openai", modelId: "gpt-5" },
        thinkingLevel: "off",
      });
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
// Real temp-JSONL: offline rename (D4 adapter foundation)
// ---------------------------------------------------------------------------

describe("pi-sdk sessions rename (real JSONL)", () => {
  it("appends session_info, keeps the same file/id/history/context, and makes the title immediate + persistent", async () => {
    const f = await setup();
    try {
      const { sessionId, user, assistant } = await seedRichSession(f);
      const before = await f.catalog.readSession(sessionId);
      const beforeFile = before.sessionFile;
      const beforeIds = (before.entries ?? []).map((entry) => entry.entryId);

      await f.store.renameSession(sessionId, "  Renamed Session 🎉  ");

      // List title is observable IMMEDIATELY (rename invalidates the shared
      // store; no 30s TTL wait and no manual invalidation in the test).
      const headers = await f.catalog.listSessions();
      assert.equal(headers.length, 1);
      assert.equal(headers[0]?.title, "Renamed Session 🎉");

      // Detail header title reflects the same new name (source of truth: the
      // latest session_info entry, read by listAll's `name`).
      const detail = await f.catalog.readSession(sessionId);
      assert.equal(detail.sessionId, sessionId);
      assert.equal(detail.title, "Renamed Session 🎉");
      assert.equal(detail.sessionFile, beforeFile, "file path must not change");

      // sessionId / history / context unchanged by the rename.
      const ctx = await f.catalog.readSessionContext(sessionId);
      assert.equal(ctx.sessionId, sessionId);
      assert.deepEqual(
        (detail.entries ?? []).map((entry) => entry.entryId),
        beforeIds,
        "entries must be unchanged by rename",
      );
      assert.deepEqual(ctx.entries.map((entry) => entry.entryId), beforeIds);
      // Locator still resolves the same canonical file.
      const located = await f.locator.locate(sessionId);
      assert.equal(located.exists, true);
      assert.equal(located.sessionFile, beforeFile);
      assert.equal(await f.locator.resolveLeafId(sessionId, assistant), assistant);
      assert.ok(beforeIds.includes(user));

      // A FRESH store/catalog (independent instance) observes the persisted
      // rename — the session_info entry was written to the JSONL file. It must
      // point at the SAME session dir to prove on-disk persistence.
      const freshStore = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const freshCatalog = createPiSdkSessionCatalog(freshStore);
      const reopened = await freshCatalog.listSessions();
      assert.equal(reopened.length, 1);
      assert.equal(reopened[0]?.title, "Renamed Session 🎉");
      const reopenedDetail = await freshCatalog.readSession(sessionId);
      assert.equal(reopenedDetail.title, "Renamed Session 🎉");
      assert.equal(reopenedDetail.sessionId, sessionId);
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
    // deleteSession of a wrong-id-resolved session fails closed and never
    // reaches rm (no file is removed).
    await assert.rejects(() => store.deleteSession("requested"), isNotFound);
  });
});

// ---------------------------------------------------------------------------
// Injected-SDK rename: name normalization/validation, identity safety, append
// error sanitization, cache behavior (deterministic, no real filesystem)
// ---------------------------------------------------------------------------

describe("pi-sdk sessions rename validation + identity (injected SDK)", () => {
  function isInvalidInput(error: unknown): error is RuntimeError {
    return isRuntimeError(error) && error.code === "invalid_input";
  }

  /** An SDK surface whose fake managers record appended names per session id. */
  function recordingSurface(infos: FakeSessionInfo[], appended: Map<string, string[]>): PiSdkSessionsSurface {
    return {
      async listAll() { return infos; },
      open(path) {
        const info = infos.find((item) => item.path === path);
        const id = info?.id ?? idFromPath(path);
        return {
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
          getLeafId: () => null,
          getEntry: () => undefined,
          getSessionId: () => id,
          getHeader: () => undefined,
          appendSessionInfo: (name: string) => {
            appended.get(id)?.push(name);
            return "";
          },
        };
      },
    };
  }

  it("trims outer whitespace and appends the canonical trimmed name", async () => {
    const appended = new Map<string, string[]>();
    const sdk = recordingSurface([mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })], appended);
    const store = createPiSdkSessionStore({ sdk });
    appended.set("s1", []);
    await store.renameSession("s1", "   Hello   World   ");
    assert.deepEqual(appended.get("s1"), ["Hello   World"]);
  });

  it("accepts Unicode, emoji, and internal spaces, and caps at 200 Unicode JS code units", async () => {
    const appended = new Map<string, string[]>();
    const sdk = recordingSurface([mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })], appended);
    const store = createPiSdkSessionStore({ sdk });
    appended.set("s1", []);

    await store.renameSession("s1", "你好 🌍 世界 with spaces");
    assert.deepEqual(appended.get("s1"), ["你好 🌍 世界 with spaces"]);

    const exactly200 = "x".repeat(200);
    appended.get("s1")!.length = 0;
    await store.renameSession("s1", exactly200);
    assert.deepEqual(appended.get("s1"), [exactly200]);

    // 201 code units is rejected and nothing is appended.
    appended.get("s1")!.length = 0;
    await assert.rejects(() => store.renameSession("s1", "x".repeat(201)), isInvalidInput);
    assert.deepEqual(appended.get("s1"), []);
    // Emoji counts as 2 UTF-16 code units: 100 emoji = 200 is fine, 101 = 202 rejected.
    appended.get("s1")!.length = 0;
    await store.renameSession("s1", "😀".repeat(100));
    assert.deepEqual(appended.get("s1"), ["😀".repeat(100)]);
    appended.get("s1")!.length = 0;
    await assert.rejects(() => store.renameSession("s1", "😀".repeat(101)), isInvalidInput);
    assert.deepEqual(appended.get("s1"), []);
  });

  it("rejects blank, non-string, NUL, all C0, and DEL control characters without appending or leaking the name", async () => {
    const appended = new Map<string, string[]>();
    const sdk = recordingSurface([mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })], appended);
    const store = createPiSdkSessionStore({ sdk });
    appended.set("s1", []);

    // Edge whitespace trims away, so a name that is only whitespace is BLANK
    // (rejected as-is, nothing to leak).
    for (const input of ["", "   ", "\t", "\n", "\r"]) {
      await assert.rejects(() => store.renameSession("s1", input), isInvalidInput);
    }
    // NUL / C0 / DEL controls that are NOT trimmed away (internal or
    // non-whitespace) are rejected outright; a malicious suffix must never
    // leak into the error.
    for (const input of ["a\u0000b", "a\u0001b", "a\u001fb", "a\u007fb", "a\tb", "a\nb", "a\rb", "\u0000", "\u0001", "\u001f", "\u007f"]) {
      const marker = "MALICIOUS-NAME";
      const raw = `${input}${marker}`;
      await assert.rejects(
        () => store.renameSession("s1", raw),
        (error: unknown) => {
          assert.ok(isRuntimeError(error));
          if (!isRuntimeError(error)) return false;
          assert.equal(error.code, "invalid_input");
          // Never echo the raw name (incl. control bytes or the marker).
          assert.ok(!JSON.stringify(error).includes(marker));
          assert.ok(!JSON.stringify(error).includes(input));
          return true;
        },
      );
    }
    // Non-string input is also rejected and nothing is appended.
    await assert.rejects(
      () => store.renameSession("s1", 42 as unknown as string),
      isInvalidInput,
    );
    // Nothing was ever appended to the SDK for any rejected input.
    assert.deepEqual(appended.get("s1"), []);
  });

  it("returns not_found for a missing id and never creates a session or appends", async () => {
    const appended = new Map<string, string[]>();
    const sdk = recordingSurface([mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })], appended);
    const store = createPiSdkSessionStore({ sdk });
    appended.set("s1", []);
    await assert.rejects(() => store.renameSession("missing", "X"), isNotFound);
    assert.deepEqual(appended.get("s1"), []);
  });

  it("never mutates a reused/stale path whose on-disk id differs (fail closed, no append)", async () => {
    let appendCalls = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        return [mkInfo({ path: "/repo/sessions/shared.jsonl", id: "requested" })];
      },
      open() {
        return {
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
          getLeafId: () => null,
          getEntry: () => undefined,
          getSessionId: () => "different-session", // path was reused by another session
          getHeader: () => undefined,
          appendSessionInfo: () => { appendCalls += 1; return ""; },
        };
      },
    };
    const store = createPiSdkSessionStore({ sdk });
    await assert.rejects(() => store.renameSession("requested", "X"), isNotFound);
    assert.equal(appendCalls, 0, "rename must never append to a reused path");
  });

  it("maps an append failure to a sanitized external/retryable file-kind error without leaking path or name", async () => {
    const sessionFile = "/repo/sessions/s1.jsonl";
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        return [mkInfo({ path: sessionFile, id: "s1" })];
      },
      open() {
        return {
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
          getLeafId: () => null,
          getEntry: () => undefined,
          getSessionId: () => "s1",
          getHeader: () => undefined,
          appendSessionInfo: () => { throw new Error("disk full raw-sdk-message"); },
        };
      },
    };
    const store = createPiSdkSessionStore({ sdk });
    await assert.rejects(
      () => store.renameSession("s1", "TARGET-NAME"),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        if (!isRuntimeError(error)) return false;
        assert.equal(error.code, "external");
        assert.equal(error.retryable, true);
        assert.equal(error.cause?.kind, "file");
        // Never leak the raw path, the SDK message, or the target name.
        assert.ok(!JSON.stringify(error).includes(sessionFile));
        assert.ok(!JSON.stringify(error).includes("disk full raw-sdk-message"));
        assert.ok(!JSON.stringify(error).includes("TARGET-NAME"));
        return true;
      },
    );
  });

  it("invalidates the shared list so the next list/read observes the new title with a bounded single rescan", async () => {
    let scans = 0;
    let name: string | undefined = "Old Title";
    const appended: string[] = [];
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1", ...(name === undefined ? {} : { name }) })];
      },
      open() {
        return {
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
          getLeafId: () => null,
          getEntry: () => undefined,
          getSessionId: () => "s1",
          getHeader: () => undefined,
          appendSessionInfo: (value: string) => { appended.push(value); name = value; return ""; },
        };
      },
    };
    const store = createPiSdkSessionStore({ sdk });

    await store.listSessions();        // cold scan → cache [s1] with "Old Title"
    assert.equal(scans, 1);
    const warm = await store.listSessions(); // warm hit, no scan
    assert.equal(warm[0]?.title, "Old Title");
    assert.equal(scans, 1);

    await store.renameSession("s1", "New Title"); // warm open (no scan) + append + invalidate
    assert.deepEqual(appended, ["New Title"]);
    assert.equal(scans, 1, "rename must not add a scan for a warm index hit");

    const after = await store.listSessions(); // cold rescan → new title
    assert.equal(after[0]?.title, "New Title");
    assert.equal(scans, 2, "exactly one rescan observes the new title");
    const detail = await store.readSession("s1"); // warm after the rescan, no scan
    assert.equal(detail.title, "New Title");
    assert.equal(scans, 2);
  });
});

// ---------------------------------------------------------------------------
// Injected-SDK cache hardening: coalesced warm-miss rebuilds, per-generation
// negatives, generation-safe invalidation, ENOENT idempotent delete
// ---------------------------------------------------------------------------

describe("pi-sdk sessions cache hardening (injected SDK)", () => {
  it("coalesces concurrent warm-index misses onto one fresh scan", async () => {
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (scans === 1) return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }),
          mkInfo({ path: "/repo/sessions/s3.jsonl", id: "s3" }),
          mkInfo({ path: "/repo/sessions/s4.jsonl", id: "s4" }),
        ];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // cold snapshot: scans = 1, cache = [s1]
    assert.equal(scans, 1);
    // Three concurrent warm misses for sessions absent from the snapshot must
    // share ONE coalesced fresh scan (not three separate listAll calls).
    const details = await Promise.all(["s2", "s3", "s4"].map((id) => store.readSession(id)));
    assert.deepEqual(details.map((d) => d.sessionId).sort(), ["s2", "s3", "s4"]);
    assert.equal(scans, 2);
    // Now warm index hits: no further scans.
    await store.readSession("s3");
    assert.equal(scans, 2);
  });

  it("retries after a failed warm-index-miss scan without caching the failure", async () => {
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (scans === 1) return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        if (scans === 2) throw new Error("scan failed");
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }),
        ];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // scans = 1
    await assert.rejects(() => store.readSession("s2"), /scan failed/); // warm-miss scan fails
    assert.equal(scans, 2);
    // The failure is neither cached nor recorded as a negative: a retry uses a
    // fresh scan and finds the session.
    const detail = await store.readSession("s2");
    assert.equal(detail.sessionId, "s2");
    assert.equal(scans, 3);
  });

  it("bounds repeated reads of a missing session to one fresh scan per generation", async () => {
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // scans = 1
    await assert.rejects(() => store.readSession("missing"), isNotFound); // warm miss → one fresh scan, negative recorded
    assert.equal(scans, 2);
    // Repeated reads (read + locate + context) in the same generation never rescan.
    await assert.rejects(() => store.readSession("missing"), isNotFound);
    const located = await store.locate("missing");
    assert.equal(located.exists, false);
    await assert.rejects(() => store.readSessionContext("missing"), isNotFound);
    assert.equal(scans, 2);
  });

  it("permits a retry after TTL expiry resets the negative result", async () => {
    let now = 1_000;
    let scans = 0;
    let appeared = false;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          ...(appeared ? [mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" })] : []),
        ];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk, now: () => now, listTtlMs: 30_000 });
    await store.listSessions(); // scans = 1
    await assert.rejects(() => store.readSession("s2"), isNotFound); // scans = 2, negative recorded
    assert.equal(scans, 2);
    await assert.rejects(() => store.readSession("s2"), isNotFound); // negative hit, no scan
    assert.equal(scans, 2);
    // The session appears; after TTL expiry a cold rescan resets the negative
    // and permits a retry.
    appeared = true;
    now += 30_001;
    const detail = await store.readSession("s2"); // cold rescan → found
    assert.equal(detail.sessionId, "s2");
    assert.equal(scans, 3);
  });

  it("permits a retry after invalidation resets the negative result", async () => {
    let scans = 0;
    let s2exists = false;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          ...(s2exists ? [mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" })] : []),
        ];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // scans = 1
    await assert.rejects(() => store.readSession("s2"), isNotFound); // scans = 2, negative recorded
    assert.equal(scans, 2);
    // The session appears; deleting another session invalidates the list and
    // resets the negative set, so the next read retries with a fresh scan.
    s2exists = true;
    await store.deleteSession("s1"); // id-validated open + ENOENT rm → idempotent, invalidates
    const detail = await store.readSession("s2");
    assert.equal(detail.sessionId, "s2");
    assert.equal(scans, 3);
  });

  it("recovers a session created after the cached snapshot with exactly one fresh scan", async () => {
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (scans === 1) return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          mkInfo({ path: "/repo/sessions/new.jsonl", id: "new" }),
        ];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // scans = 1, snapshot lacks "new"
    const detail = await store.readSession("new"); // warm miss → exactly one fresh scan
    assert.equal(detail.sessionId, "new");
    assert.equal(scans, 2);
    await store.readSession("new"); // now a warm index hit
    assert.equal(scans, 2);
  });

  it("coalesces concurrent warm misses for missing ids into one scan and returns not_found", async () => {
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // scans = 1
    await Promise.all([
      assert.rejects(() => store.readSession("m1"), isNotFound),
      assert.rejects(() => store.readSession("m2"), isNotFound),
      assert.rejects(() => store.readSession("m3"), isNotFound),
    ]);
    // One coalesced fresh scan served all three misses.
    assert.equal(scans, 2);
    // Each id is now a per-generation negative: no further scans.
    await Promise.all([
      assert.rejects(() => store.readSession("m1"), isNotFound),
      assert.rejects(() => store.readSession("m2"), isNotFound),
      assert.rejects(() => store.readSession("m3"), isNotFound),
    ]);
    assert.equal(scans, 2);
  });

  it("an invalidated warm-miss scan never repopulates the cache or clears a newer in-flight scan", async () => {
    let scans = 0;
    let releaseGen0: ((infos: FakeSessionInfo[]) => void) | undefined;
    let releaseGen1: ((infos: FakeSessionInfo[]) => void) | undefined;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (scans === 1) return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        if (scans === 2) return new Promise<FakeSessionInfo[]>((resolve) => { releaseGen0 = resolve; });
        if (scans === 3) return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        if (scans === 4) return new Promise<FakeSessionInfo[]>((resolve) => { releaseGen1 = resolve; });
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk });

    await store.listSessions(); // scans = 1, warm cache [s1] (gen 0)
    const p1 = store.readSession("s2"); // gen-0 warm miss → scanOnce (scan 2) held open
    await tick();
    assert.ok(releaseGen0);

    // Invalidate: delete of the warm s1 (file absent → ENOENT idempotent) bumps
    // the generation and clears the cache.
    await store.deleteSession("s1");
    await store.listSessions(); // cold rescan (scan 3) → cache [s1] (gen 1)

    const p2 = store.readSession("s3"); // gen-1 warm miss → scanOnce (scan 4) held open
    await tick();
    assert.ok(releaseGen1);

    // Release the STALE gen-0 scan: it must not repopulate the cache, and its
    // finally must not clear the gen-1 in-flight slot.
    releaseGen0!([
      mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
      mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }),
    ]);
    await assert.rejects(() => p1, isNotFound); // stale result is not trusted → fail closed

    // The gen-1 in-flight slot survived: a new caller joins it instead of scanning.
    const p4 = store.readSession("s5");
    await tick();

    // Release the current gen-1 scan; every pending gen-1 reader settles against it.
    releaseGen1!([mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })]);
    await assert.rejects(() => p2, isNotFound);
    await assert.rejects(() => p4, isNotFound);
    // Exactly four listAll calls total: no extra scan was spawned by the stale
    // gen-0 completion or by the joining callers.
    assert.equal(scans, 4);
  });

  it("deleteSession treats ENOENT between open and rm as idempotent success and invalidates the list", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-sessions-adapter-"));
    const sessionDir = join(root, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "s1.jsonl");
    await writeFile(sessionFile, "{}\n"); // a real file so rm can observe its disappearance
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [mkInfo({ path: sessionFile, id: "s1" })];
      },
      open() { return fakeManager("s1"); }, // id-validated open succeeds
    };
    const store = createPiSdkSessionStore({ sdk });
    await store.listSessions(); // warm cache with s1
    assert.equal(scans, 1);
    await rm(sessionFile); // the file vanishes after the store's snapshot
    // The id-validated open succeeds (injected), then rm hits ENOENT → idempotent.
    await store.deleteSession("s1");
    await store.deleteSession("s1"); // idempotent across the invalidation too
    // Every delete invalidated the warm list: the next list re-scans.
    const headers = await store.listSessions();
    assert.equal(headers.length, 1);
    assert.equal(scans, 3);
    await rm(root, { recursive: true, force: true });
  });

  it("deleteSession maps non-ENOENT filesystem failures to a sanitized error without leaking the path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-sessions-adapter-"));
    const blocker = join(root, "blocker");
    await writeFile(blocker, "x"); // a regular file where a directory is needed
    const sessionFile = join(blocker, "sub", "s1.jsonl"); // rm → ENOTDIR (not ENOENT)
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        return [mkInfo({ path: sessionFile, id: "s1" })];
      },
      open() { return fakeManager("s1"); },
    };
    const store = createPiSdkSessionStore({ sdk });
    await assert.rejects(
      () => store.deleteSession("s1"),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        if (!isRuntimeError(error)) return false;
        assert.equal(error.code, "external");
        assert.equal(error.retryable, true);
        assert.equal(error.cause?.kind, "file");
        // The raw path must never leak through the sanitized error.
        assert.ok(!JSON.stringify(error).includes(sessionFile));
        assert.ok(!JSON.stringify(error).includes(root));
        return true;
      },
    );
    await rm(root, { recursive: true, force: true });
  });

  it("F1: an older scanOnce finishing after a newer TTL list refresh cannot overwrite the cache or poison the session", async () => {
    let now = 1_000;
    let scans = 0;
    let releaseOld: ((infos: FakeSessionInfo[]) => void) | undefined;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (scans === 1) return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        if (scans === 2) return new Promise<FakeSessionInfo[]>((resolve) => { releaseOld = resolve; });
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }),
        ];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk, now: () => now, listTtlMs: 30_000 });
    await store.listSessions(); // scan1 → [s1]
    const p1 = store.readSession("s2"); // warm miss → scanOnce (scan2, OLD) held open
    await tick();
    assert.ok(releaseOld);

    // TTL expiry triggers a NEWER listInfos cold refresh that returns s2 first.
    now += 30_001;
    await store.listSessions(); // scan3 → [s1, s2] applied (newer revision)
    assert.equal(scans, 3);

    // The OLD scanOnce completes late with stale [s1]: the shared revision fence
    // must discard it (never overwrite the newer cache).
    releaseOld!([mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })]);
    // The reader that waited on the discarded scan re-checks the CURRENT cache
    // and finds s2 there — no not_found, no negative poisoning.
    const detail = await p1;
    assert.equal(detail.sessionId, "s2");
    // The current cache still holds [s1, s2] (stale scan was discarded).
    const headers = await store.listSessions();
    assert.deepEqual(headers.map((h) => h.sessionId).sort(), ["s1", "s2"]);
    // A fresh read succeeds too (no negative was recorded for s2).
    const again = await store.readSession("s2");
    assert.equal(again.sessionId, "s2");
    assert.equal(scans, 3);
  });

  it("F2: unrelated warm-miss scans cannot extend a negative past its recording-time deadline", async () => {
    let now = 1_000;
    let scans = 0;
    let s2exists = false;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        const infos = [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
        if (s2exists) infos.push(mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }));
        return infos;
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk, now: () => now, listTtlMs: 30_000 });
    await store.listSessions(); // scan1 → [s1]
    await assert.rejects(() => store.readSession("s2"), isNotFound); // scan2 → negative s2 @ t=1000
    assert.equal(scans, 2);

    // For >100s, unrelated warm-miss scans for OTHER missing ids keep the cache
    // timestamp fresh, while s2 stays absent from every scan (its negative is
    // never re-armed by a scan that contains it).
    let id = 100;
    for (let i = 0; i < 40; i++) {
      now += 3_000;
      await assert.rejects(() => store.readSession(`other-${id++}`), isNotFound); // warm miss → one fresh scan
    }
    assert.ok(now - 1_000 > 30_000, ">100s elapsed since s2's negative was recorded");

    // s2 appears. Its negative expired by recording-time, so a retry works even
    // though unrelated scans refreshed the cache timestamp the whole time.
    s2exists = true;
    const detail = await store.readSession("s2"); // warm miss → fresh scan → found
    assert.equal(detail.sessionId, "s2");
  });

  it("F3: the negative cache is bounded (LRU eviction at max capacity)", async () => {
    let scans = 0;
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        return [mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" })];
      },
      open(path) { return fakeManager(idFromPath(path)); },
    };
    const store = createPiSdkSessionStore({ sdk, maxNegatives: 8 });
    await store.listSessions(); // scan1 (cold)
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    for (const id of ids) {
      await assert.rejects(() => store.readSession(id), isNotFound);
    }
    // 9 distinct negatives recorded against a capacity of 8 → "a" (oldest) evicted.
    assert.equal(scans, 10); // 1 cold + 9 warm-miss scans
    // The evicted oldest id must be re-scanned (its negative is gone)…
    await assert.rejects(() => store.readSession("a"), isNotFound);
    assert.equal(scans, 11);
    // …while a recent id is still a negative hit (no scan).
    await assert.rejects(() => store.readSession("i"), isNotFound);
    assert.equal(scans, 11);
  });
});

// ---------------------------------------------------------------------------
// Per-session mutation serialization: rename/rename FIFO, rename/delete
// determinism, duplicate delete ENOENT, and different-id parallelism
// ---------------------------------------------------------------------------

describe("pi-sdk sessions mutation serialization (rename/delete)", () => {
  it("same-session concurrent renames are FIFO and the last committed append wins (real JSONL)", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      // Both renames enqueue synchronously (FIFO): A appends first, B second.
      const [a, b] = await Promise.allSettled([
        f.store.renameSession(sessionId, "First Name"),
        f.store.renameSession(sessionId, "Second Name"),
      ]);
      assert.equal(a.status, "fulfilled");
      assert.equal(b.status, "fulfilled");
      const headers = await f.catalog.listSessions();
      assert.equal(headers[0]?.title, "Second Name", "last committed append wins");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("delete then rename: delete wins and rename returns not_found without recreating or appending", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      const sessionFile = (await f.catalog.readSession(sessionId)).sessionFile;
      assert.ok(sessionFile, "seeded session must have a file");
      // Enqueue delete first, then rename (both FIFO on the same session id).
      const deleteP = f.store.deleteSession(sessionId);
      const renameP = f.store.renameSession(sessionId, "Ghost");
      await deleteP;
      await assert.rejects(() => renameP, isNotFound);
      // The file is gone and the rename never recreated it / appended anything.
      const headers = await f.catalog.listSessions();
      assert.equal(headers.length, 0);
      await assert.rejects(() => f.catalog.readSession(sessionId), isNotFound);
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(sessionFile), false, "delete wins: file must stay removed");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("rename then delete: rename commits then delete removes the renamed session", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      const sessionFile = (await f.catalog.readSession(sessionId)).sessionFile;
      assert.ok(sessionFile, "seeded session must have a file");
      const renameP = f.store.renameSession(sessionId, "Will Be Deleted");
      const deleteP = f.store.deleteSession(sessionId);
      await renameP;
      await deleteP;
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(sessionFile), false, "rename-then-delete leaves no file");
      const headers = await f.catalog.listSessions();
      assert.equal(headers.length, 0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("duplicate delete after a successful delete still reports not_found (ENOENT idempotency preserved elsewhere)", async () => {
    const f = await setup();
    try {
      const { sessionId } = await seedRichSession(f);
      await f.store.deleteSession(sessionId);
      // A second delete of the now-missing session is not_found (never a
      // per-session lock leak, never a crash).
      await assert.rejects(() => f.store.deleteSession(sessionId), isNotFound);
      // And a rename of the deleted session is not_found too (no recreation).
      await assert.rejects(() => f.store.renameSession(sessionId, "Nope"), isNotFound);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("different session ids mutate concurrently (no global lock): one rename completes while another session's rename is in flight", async () => {
    let scans = 0;
    let releaseS1Scan: ((infos: FakeSessionInfo[]) => void) | undefined;
    const appended = new Map<string, string[]>();
    const sdk: PiSdkSessionsSurface = {
      async listAll() {
        scans += 1;
        if (scans === 1) return [mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" })];
        if (scans === 2) return new Promise<FakeSessionInfo[]>((resolve) => { releaseS1Scan = resolve; });
        return [
          mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
          mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }),
        ];
      },
      open(path) {
        const id = idFromPath(path);
        return {
          getEntries: () => [],
          getBranch: () => [],
          buildContextEntries: () => [],
          getLeafId: () => null,
          getEntry: () => undefined,
          getSessionId: () => id,
          getHeader: () => undefined,
          appendSessionInfo: (name: string) => {
            appended.get(id)?.push(name);
            return "";
          },
        };
      },
    };
    const store = createPiSdkSessionStore({ sdk });
    appended.set("s1", []);
    appended.set("s2", []);

    await store.listSessions(); // scan 1 → cache [s2]; s1 is a warm miss

    // s1's rename (enqueued FIRST) triggers a warm-miss scan (scan 2) that we
    // hold open, so the s1 mutation stays in flight.
    let s1Done = false;
    const s1P = store.renameSession("s1", "Slow").then(() => { s1Done = true; });
    await tick();
    assert.ok(releaseS1Scan, "s1 mutation must be in flight (warm-miss scan held)");

    // s2's rename — a DIFFERENT session id and a separate per-session queue —
    // completes while s1's mutation is still pending. A global (all-session)
    // lock would have blocked it behind s1's held task.
    await store.renameSession("s2", "Fast");
    assert.equal(s1Done, false, "s1 mutation must still be in flight");
    assert.deepEqual(appended.get("s2"), ["Fast"]);
    assert.deepEqual(appended.get("s1"), [], "s1 append must not have run yet");

    // s2's committed rename invalidated the shared list, superseding s1's
    // in-flight scan. Releasing it must fail CLOSED (no append, no recreation):
    // s1's rename reports not_found because its scan is no longer the newest
    // trusted snapshot — never a wrong-session mutation.
    releaseS1Scan!([
      mkInfo({ path: "/repo/sessions/s1.jsonl", id: "s1" }),
      mkInfo({ path: "/repo/sessions/s2.jsonl", id: "s2" }),
    ]);
    await assert.rejects(() => s1P, isNotFound);
    assert.deepEqual(appended.get("s1"), [], "superseded rename must never append");
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
      async readSessionContext(id) { return { sessionId: id, entries: [], pageInfo: { hasMore: false } }; },
      async readSessionThinking(id, entryId) { throw makeRuntimeError("not_found", `session not found: ${id}/${entryId}`); },
      async readSessionTree(id) { return { sessionId: id, roots: [], entryCount: 0 }; },
      async deleteSession() {},
      async renameSession() {},
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

  it("exposes a narrow backend-neutral mutation factory with no SDK names and lazy/zero-worker construction", async () => {
    const mutation = createPiSdkSessionMutation();
    // Method surface is exactly renameSession (instance owns only the private
    // store dependency; methods live on the prototype, matching catalog/locator).
    const surface = [
      ...Object.getOwnPropertyNames(mutation),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(mutation)),
    ];
    const methods = surface.filter((name) => name !== "store" && name !== "constructor");
    assert.deepEqual(methods, ["renameSession"], "mutation port method surface is exactly renameSession");
    assert.equal(
      surface.some((name) =>
        /AgentSession|SessionManager|ModelRuntime|ResourceLoader|TrustStore|AuthStorage/.test(name),
      ),
      false,
      "mutation port must not leak SDK names",
    );
    // Constructing and operating offline never touches the network or a worker.
    await assert.rejects(() => mutation.renameSession("missing-id", "X"), isNotFound);
  });

  it("createPiSdkSessionPorts returns catalog + locator + mutation sharing one store (backward compatible destructuring)", async () => {
    const { catalog, locator, mutation } = createPiSdkSessionPorts();
    assert.equal(typeof catalog.listSessions, "function");
    assert.equal(typeof locator.locate, "function");
    assert.equal(typeof mutation.renameSession, "function");
    // Backward compatible: the pair destructure still works.
    const pair = createPiSdkSessionPorts();
    const { catalog: c2, locator: l2 } = pair;
    assert.equal(typeof c2.listSessions, "function");
    assert.equal(typeof l2.locate, "function");
  });
});

// ---------------------------------------------------------------------------
// Direct source-history parity: complete-branch default, defer flags,
// exact-identity deferred-thinking resolution. Real temp-JSONL, zero workers.
// ---------------------------------------------------------------------------

describe("pi-sdk sessions catalog (direct source history)", () => {
  /** Seed one session with thinking + inline base64/URL tool-result media. */
  async function seedHistorySession(f: Fixture) {
    const manager = SessionManager.create(f.cwd, f.sessionDir);
    const user = manager.appendMessage({ role: "user", content: "show me the logo", timestamp: NOW });
    const assistant = manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deep thought" },
        { type: "thinking", thinking: "   " },
        { type: "text", text: "looking" },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-test",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: NOW + 1,
    });
    const toolCall = manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "screenshot", arguments: {} }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-test",
      usage: usage(),
      stopReason: "toolUse",
      timestamp: NOW + 2,
    });
    const toolResult = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "screenshot",
      content: [
        { type: "text", text: "captured" },
        // SDK image shape (data/mimeType): 5 decoded bytes each ("hello").
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
      ],
      isError: false,
      timestamp: NOW + 3,
    });
    return { manager, sessionId: manager.getSessionId(), user, assistant, toolCall, toolResult };
  }

  it("omitted limit returns the COMPLETE selected projected branch; explicit limit/before stay paginated", async () => {
    const f = await setup();
    try {
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      const ids: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        // Alternate user/assistant: the SDK persists a session file only once
        // an assistant message exists, so a user-only seed would never land.
        ids.push(manager.appendMessage({ role: "user", content: `m${index}`, timestamp: NOW + index }));
        ids.push(manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `a${index}` }],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-test",
          usage: usage(),
          stopReason: "stop",
          timestamp: NOW + index + 1,
        }));
      }
      const sessionId = manager.getSessionId();

      // No limit → the complete branch, hasMore false, no cursor.
      const complete = await f.catalog.readSessionContext(sessionId);
      assert.equal(complete.entries.length, 60);
      assert.deepEqual(complete.pageInfo, { hasMore: false });
      assert.equal(complete.entries[0]!.entryId, ids[0]);
      assert.equal(complete.entries.at(-1)!.entryId, ids.at(-1));

      // before without limit → the complete older-than-cursor slice.
      const older = await f.catalog.readSessionContext(sessionId, { before: ids[10]! });
      assert.equal(older.entries.length, 10);
      assert.deepEqual(older.pageInfo, { hasMore: false });

      // Explicit limit keeps the bounded compatibility page + cursor.
      const page = await f.catalog.readSessionContext(sessionId, { limit: 50 });
      assert.equal(page.entries.length, 50);
      assert.equal(page.pageInfo.hasMore, true);
      assert.equal(page.pageInfo.nextCursor, ids[10]!);
      const next = await f.catalog.readSessionContext(sessionId, { before: page.pageInfo.nextCursor, limit: 50 });
      assert.equal(next.entries.length, 10);
      assert.deepEqual(next.pageInfo, { hasMore: false });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("deferThinking projects only nonempty assistant thinking as empty deferred placeholders", async () => {
    const f = await setup();
    try {
      const { sessionId, assistant, user } = await seedHistorySession(f);
      const context = await f.catalog.readSessionContext(sessionId, { deferThinking: true });
      const entry = context.entries.find((e) => e.entryId === assistant)!;
      assert.equal(entry.message.role, "assistant");
      if (entry.message.role !== "assistant") throw new Error("unreachable");
      // Nonempty thinking → empty + deferred (placeholder for sessions.thinking).
      assert.deepEqual(entry.message.content[0], { type: "thinking", thinking: "", deferred: true });
      // Whitespace-only thinking is NOT deferred (already empty on the wire).
      assert.deepEqual(entry.message.content[1], { type: "thinking", thinking: "   " });
      // Text blocks pass through untouched.
      assert.deepEqual(entry.message.content[2], { type: "text", text: "looking" });
      // Non-assistant roles are never touched.
      const userEntry = context.entries.find((e) => e.entryId === user)!;
      assert.deepEqual(userEntry.message, { role: "user", content: "show me the logo", timestamp: NOW });
      // Without the flag the thinking text stays inline.
      const inline = await f.catalog.readSessionContext(sessionId);
      const inlineEntry = inline.entries.find((e) => e.entryId === assistant)!;
      if (inlineEntry.message.role !== "assistant") throw new Error("unreachable");
      assert.deepEqual(inlineEntry.message.content[0], { type: "thinking", thinking: "deep thought" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("deferMedia omits only toolResult base64 images with a truthful source summary; URL sources and other roles stay inline", async () => {
    const f = await setup();
    try {
      const { sessionId, toolResult, assistant } = await seedHistorySession(f);
      const context = await f.catalog.readSessionContext(sessionId, { deferMedia: true });
      const entry = context.entries.find((e) => e.entryId === toolResult)!;
      assert.equal(entry.message.role, "toolResult");
      if (entry.message.role !== "toolResult") throw new Error("unreachable");
      const content = entry.message.content;
      // Text kept first; both base64 images replaced by ONE truthful summary.
      assert.deepEqual(content[0], { type: "text", text: "captured" });
      assert.equal(content.length, 2);
      const summary = content[1];
      if (summary === undefined || summary.type !== "text") throw new Error("unreachable");
      // Exact source wording: 2 images, both media types, ~10 decoded bytes.
      assert.equal(
        summary.text,
        "[2 tool result images omitted from initial history payload: image/png, image/jpeg, ~10 bytes]",
      );
      // Assistant entries are never media-deferred (the source omits tool results only).
      const assistantEntry = context.entries.find((e) => e.entryId === assistant)!;
      assert.equal(assistantEntry.message.role, "assistant");
      // No base64 payload survives anywhere in the deferred page.
      assert.equal(JSON.stringify(context).includes("aGVsbG8="), false);
      // Without the flag the base64 media stays inline.
      const inline = await f.catalog.readSessionContext(sessionId);
      assert.equal(JSON.stringify(inline).includes("aGVsbG8="), true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("deferHistoryEntry (pure): URL image sources are kept verbatim next to the omission summary", () => {
    const entry: import("@fffattiger/pix-runtime-core").SessionEntry = {
      entryId: "entry-media",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
      },
    };
    const deferred = deferHistoryEntry(entry, { deferThinking: true, deferMedia: true });
    if (deferred.message.role !== "toolResult") throw new Error("unreachable");
    assert.equal(deferred.message.content.length, 2);
    // URL source kept verbatim (never omitted, never rewritten).
    assert.deepEqual(deferred.message.content[0], {
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    });
    const summary = deferred.message.content[1];
    if (summary === undefined || summary.type !== "text") throw new Error("unreachable");
    assert.equal(summary.text, "[1 tool result image omitted from initial history payload: image/png, ~5 bytes]");
    // Pure projection: the input entry is never mutated.
    if (entry.message.role !== "toolResult") throw new Error("unreachable");
    assert.equal(entry.message.content.length, 2);
    assert.equal(entry.message.content[0]?.type, "image");
  });

  it("readSessionThinking resolves the exact deferred block identity and fails closed otherwise", async () => {
    const f = await setup();
    try {
      const { sessionId, assistant, user, toolResult } = await seedHistorySession(f);
      // The placeholder index in a deferred page resolves to the same block.
      const deferred = await f.catalog.readSessionContext(sessionId, { deferThinking: true });
      const deferredEntry = deferred.entries.find((e) => e.entryId === assistant)!;
      if (deferredEntry.message.role !== "assistant") throw new Error("unreachable");
      assert.deepEqual(deferredEntry.message.content[0], { type: "thinking", thinking: "", deferred: true });
      const block = await f.catalog.readSessionThinking(sessionId, assistant, 0);
      assert.deepEqual(block, { sessionId, entryId: assistant, blockIndex: 0, thinking: "deep thought" });

      // Whitespace-only block (index 1) resolves verbatim — never coerced.
      assert.equal((await f.catalog.readSessionThinking(sessionId, assistant, 1)).thinking, "   ");

      // Fail-closed identity errors: non-thinking block, out-of-range index,
      // non-assistant entries, unknown entry, unknown session.
      await assert.rejects(() => f.catalog.readSessionThinking(sessionId, assistant, 2), isNotFound);
      await assert.rejects(() => f.catalog.readSessionThinking(sessionId, assistant, 99), isNotFound);
      await assert.rejects(() => f.catalog.readSessionThinking(sessionId, user, 0), isNotFound);
      await assert.rejects(() => f.catalog.readSessionThinking(sessionId, toolResult, 0), isNotFound);
      await assert.rejects(() => f.catalog.readSessionThinking(sessionId, "entry-does-not-exist", 0), isNotFound);
      await assert.rejects(() => f.catalog.readSessionThinking("nope", assistant, 0), isNotFound);
      // Malformed block index → invalid_input (never a coerced lookup).
      const badIndex = await f.catalog.readSessionThinking(sessionId, assistant, -1).catch((error: unknown) => error);
      assert.ok(isRuntimeError(badIndex) && badIndex.code === "invalid_input");
      const fractional = await f.catalog.readSessionThinking(sessionId, assistant, 1.5).catch((error: unknown) => error);
      assert.ok(isRuntimeError(fractional) && fractional.code === "invalid_input");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
