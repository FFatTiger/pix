/**
 * `sessions.findLatest` RPC (assistant conversation lookup).
 *
 * The Host's GET /v1/assistant resolves "the latest session in the fixed
 * assistant directory" through this RPC. The handler is read-only (zero
 * workers), returns the exact session id or null, and fails closed with
 * `unavailable` when the mounted catalog does not implement the exact-cwd
 * lookup — it must never fall back to `sessions.list`, which cannot see the
 * hidden assistant workspace.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionsFindLatestResultSchema } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionHeader, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
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
