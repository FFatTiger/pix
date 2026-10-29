/**
 * `sessions.findLatest` / `sessions.listAssistant` RPCs (assistant conversation
 * lookup + history page).
 *
 * The Host's GET /v1/assistant resolves "the latest session in the fixed
 * assistant directory" through the first RPC; GET /v1/assistant/sessions pages
 * that workspace's OWN conversations through the second. Both handlers are
 * read-only (zero workers) and fail closed with `unavailable` when the mounted
 * catalog does not implement the exact-cwd surface — they must never fall back
 * to `sessions.list`, which cannot see the hidden assistant workspace. The
 * history page derives the canonical directory INSIDE sessiond; its wire params
 * carry no cwd at all.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionsFindLatestResultSchema, SessionsListAssistantResultSchema } from "@fffattiger/pix-protocol";
import { resolveAssistantWorkspaceDir, type SessionCatalogPort, type SessionHeader, type SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondRpcClient } from "../src/rpc.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";
import { startDaemon } from "../src/composition/index.js";

const ASSISTANT_DIR = "/home/demo/.pi/pix/assistant";

function header(sessionId: string, cwd: string, updatedAt: number): SessionHeader {
  return { sessionId, cwd, projectRoot: cwd, createdAt: updatedAt - 1, updatedAt, messageCount: 1 };
}

interface Harness {
  rpc: SessiondRpcClient;
  close: () => Promise<void>;
  dir: string;
}

async function harness(catalog: SessionCatalogPort | null): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pix-sessiond-findlatest-"));
  const handle = await startDaemon({
    directory: dir,
    workerFactory: new FakeWorkerFactory({ readyDelayMs: 0 }),
    sessionLocator: {
      async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
      async resolveLeafId() { return "leaf"; },
    } satisfies SessionLocatorPort,
    ...(catalog === null ? {} : { sessionCatalog: catalog }),
    serviceOptions: { idleTimeoutMs: 0 },
  });
  return {
    dir,
    rpc: new SessiondRpcClient({ endpoint: handle.endpoint, secret: handle.secret }),
    close: async () => {
      await handle.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("sessions.findLatest returns the newest session id for the exact cwd (zero workers)", async () => {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async findLatestSessionByCwd(cwd) {
      assert.equal(cwd, ASSISTANT_DIR);
      return header("latest", cwd, 2_000);
    },
  };
  const h = await harness(catalog);
  try {
    const result = await h.rpc.call("sessions.findLatest", { cwd: ASSISTANT_DIR });
    assert.equal(result.sessionId, "latest");
    assert.equal(result.cwd, ASSISTANT_DIR);
    // The RPC boundary releases schema-valid identity echoes only.
    assert.equal(SessionsFindLatestResultSchema.safeParse(result).success, true);
  } finally {
    await h.close();
  }
});

test("sessions.findLatest answers null for an empty assistant directory", async () => {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async findLatestSessionByCwd() { return null; },
  };
  const h = await harness(catalog);
  try {
    const result = await h.rpc.call("sessions.findLatest", { cwd: ASSISTANT_DIR });
    assert.equal(result.sessionId, null);
  } finally {
    await h.close();
  }
});

test("sessions.findLatest fails closed with unavailable when the catalog lacks the exact-cwd lookup", async () => {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
  const h = await harness(catalog);
  try {
    await assert.rejects(
      h.rpc.call("sessions.findLatest", { cwd: ASSISTANT_DIR }),
      (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        assert.equal(code, "unavailable");
        return true;
      },
    );
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// `sessions.listAssistant` — the assistant conversation HISTORY page
// ---------------------------------------------------------------------------

/** The server-derived canonical assistant directory for THIS machine. */
function derivedAssistantDir(): string {
  return resolveAssistantWorkspaceDir(homedir());
}

const ASSISTANT_PAGE = { sessions: [] as SessionHeader[], page: 1, pageSize: 20, total: 0, totalPages: 0, catalogRevision: 7 };

test("sessions.listAssistant derives the assistant workspace itself (no client cwd) and pages it", async () => {
  const seen: Array<{ cwd: string; page: number; pageSize: number }> = [];
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async listAssistantSessionPage(cwd, request) {
      seen.push({ cwd, page: request.page, pageSize: request.pageSize });
      return {
        ...ASSISTANT_PAGE,
        page: request.page,
        pageSize: request.pageSize,
        total: 1,
        totalPages: 1,
        sessions: [header("assistant-old", cwd, 1_000)],
      };
    },
  };
  const h = await harness(catalog);
  try {
    const result = await h.rpc.call("sessions.listAssistant", { page: 1, pageSize: 20 });
    // The catalog receives the SAME canonical directory the assistant identity
    // is derived from (realpath'd when it exists) — never a caller-supplied cwd.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.page, 1);
    assert.equal(seen[0]!.pageSize, 20);
    const expected = derivedAssistantDir();
    const canonical = await realpath(expected).catch(() => expected);
    assert.equal(seen[0]!.cwd, canonical);
    assert.deepEqual(result.sessions.map((session) => session.sessionId), ["assistant-old"]);
    assert.equal(result.total, 1);
    // Strict wire shape: the canonical SessionPage DTO, nothing bespoke.
    assert.equal(SessionsListAssistantResultSchema.safeParse(result).success, true);
    // Zero workers: paging the history is a pure catalog read.
    assert.deepEqual((await h.rpc.call("runtime.listRunning", {})).sessions, []);
  } finally {
    await h.close();
  }
});

test("sessions.listAssistant rejects a client-supplied cwd (strict params)", async () => {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async listAssistantSessionPage() { return ASSISTANT_PAGE; },
  };
  const h = await harness(catalog);
  try {
    await assert.rejects(
      // The strict wire schema forbids a cwd on this method: a client can never
      // widen the assistant page to another workspace.
      h.rpc.call("sessions.listAssistant", { page: 1, pageSize: 20, cwd: "/repo" } as never),
    );
  } finally {
    await h.close();
  }
});

test("sessions.listAssistant fails closed with unavailable when the catalog cannot page the assistant workspace", async () => {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async findLatestSessionByCwd() { return null; },
  };
  const h = await harness(catalog);
  try {
    await assert.rejects(
      h.rpc.call("sessions.listAssistant", { page: 1, pageSize: 20 }),
      (error: unknown) => (error as { code?: unknown }).code === "unavailable",
    );
  } finally {
    await h.close();
  }
});

test("sessions.listAssistant applies the service title overlay and durable pin/archive flags", async () => {
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession() { throw new Error("not used"); },
    async readSessionContext() { return { sessionId: "", entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree() { return { sessionId: "", roots: [], entryCount: 0 }; },
    async deleteSession() {},
    async listAssistantSessionPage(cwd) {
      return {
        ...ASSISTANT_PAGE,
        total: 2,
        totalPages: 1,
        sessions: [header("pinned-one", cwd, 2_000), header("archived-one", cwd, 1_000)],
      };
    },
  };
  const h = await harness(catalog);
  try {
    await h.rpc.call("workspace.setFlags", { kind: "session", key: "pinned-one", pinned: true });
    await h.rpc.call("workspace.setFlags", { kind: "session", key: "archived-one", archived: true });
    const result = await h.rpc.call("sessions.listAssistant", { page: 1, pageSize: 20 });
    const pinned = result.sessions.find((session) => session.sessionId === "pinned-one");
    const archived = result.sessions.find((session) => session.sessionId === "archived-one");
    assert.equal(pinned?.pinned, true);
    assert.equal(archived?.archived, true);
  } finally {
    await h.close();
  }
});
