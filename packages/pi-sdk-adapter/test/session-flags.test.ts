/**
 * Round 5: server-side session flags (pinned/archived).
 * Durable truth = pix-session-flags custom entry in the session JSONL; the
 * projection (schema v8) materializes them onto SessionHeader. setSessionFlags
 * appends, refreshes the shared catalog, and READS BACK the merged effective
 * state (last entry wins), never guessing from the input.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import { createPiSdkSessionCatalog } from "../src/sessions/index.js";

const NOW = 1_700_000_000_000;

type Fixture = {
  root: string;
  sessionDir: string;
  store?: ReturnType<typeof createPiSdkSessionStore>;
  catalog?: ReturnType<typeof createPiSdkSessionCatalog>;
};

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pix-session-flags-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir, { recursive: true });
  return { root, sessionDir };
}

/** Store is created AFTER seeding: the projection builds over real files. */
async function preparedStore(sessionDir: string) {
  const store = createPiSdkSessionStore({ sessionDir, projection: { enabled: true } });
  const catalog = createPiSdkSessionCatalog(store);
  await store.prepare?.();
  return { store, catalog };
}

function seed(sessionDir: string, cwd: string): string {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: "user", content: "hi", timestamp: NOW });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "ok" }],
    api: "anthropic", provider: "anthropic", model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    stopReason: "stop", timestamp: NOW + 1,
  });
  return manager.getSessionId();
}

describe("server-side session flags (round 5)", () => {
  it("setSessionFlags appends, exposes immediately, merges last-entry-wins, and reads back effective state", async () => {
    const f = await setup();
    try {
      const sessionId = seed(f.sessionDir, "/repos/alpha");
      const { store, catalog } = await preparedStore(f.sessionDir) as { store: ReturnType<typeof createPiSdkSessionStore>; catalog: ReturnType<typeof createPiSdkSessionCatalog> };
      (f as Record<string, unknown>).store = store; (f as Record<string, unknown>).catalog = catalog;
      assert.equal((await f.catalog!.listSessionPage!({ page: 1, pageSize: 10 })).sessions[0]?.pinned, undefined);

      const first = await f.store!.setSessionFlags(sessionId, { pinned: true });
      assert.deepEqual(first, { pinned: true, archived: false });

      // Immediate projection through the shared catalog.
      const page = await f.catalog!.listSessionPage!({ page: 1, pageSize: 10 });
      assert.equal(page.sessions[0]?.pinned, true);
      assert.equal(page.sessions[0]?.archived, undefined);

      // Absent flag left unchanged; archive merges over the same entry stream.
      const second = await f.store!.setSessionFlags(sessionId, { archived: true });
      assert.deepEqual(second, { pinned: true, archived: true });
      const after = (await f.catalog!.listSessionPage!({ page: 1, pageSize: 10 })).sessions[0]!;
      assert.equal(after.pinned, true);
      assert.equal(after.archived, true);

      // Unpin records false (explicit), not a deletion.
      const third = await f.store!.setSessionFlags(sessionId, { pinned: false });
      assert.deepEqual(third, { pinned: false, archived: true });
      const afterUnpin = (await f.catalog!.listSessionPage!({ page: 1, pageSize: 10 })).sessions[0]!;
      assert.equal(afterUnpin.pinned, false);
      assert.equal(afterUnpin.archived, true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("flags survive a FRESH store (JSONL truth) and a projection schema-v8 rebuild", async () => {
    const f = await setup();
    try {
      const sessionId = seed(f.sessionDir, "/repos/beta");
      const { store } = await preparedStore(f.sessionDir);
      await store.setSessionFlags(sessionId, { pinned: true, archived: true });
      // Fresh store = fresh in-memory cache reading the same JSONLs.
      const freshStore = createPiSdkSessionStore({ sessionDir: f.sessionDir, projection: { enabled: true } });
      await freshStore.prepare?.();
      const freshCatalog = createPiSdkSessionCatalog(freshStore);
      const headers = (await freshCatalog.listSessionPage!({ page: 1, pageSize: 10 })).sessions;
      assert.equal(headers[0]?.pinned, true);
      assert.equal(headers[0]?.archived, true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("setSessionFlags rejects no-flag input and unknown sessions fail closed", async () => {
    const f = await setup();
    try {
      seed(f.sessionDir, "/repos/gamma");
      const { store } = await preparedStore(f.sessionDir);
      await assert.rejects(store.setSessionFlags("nope", { pinned: true }), (error: { code?: string }) => error.code === "not_found");
      await assert.rejects(store.setSessionFlags("nope", {} as never), (error: { code?: string }) => error.code === "invalid_input");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
