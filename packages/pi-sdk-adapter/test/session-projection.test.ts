// SCALE1 — disposable SQLite session-list projection index tests.
//
// Deterministic unit + adversarial tests for src/internal/session-projection.ts
// and its wiring in the session store (`projection: { enabled: true, dir }`).
// All tests use REAL temp JSONL session files + the real SDK surface so the
// projection's file-identity (mtime/size) validation is exercised honestly.
// The projection index is always pointed at a temp Pix-owned dir (hermetic).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import {
  PROJECTION_INDEX_FILENAME,
  SessionProjectionIndex,
  type ProjectedSession,
} from "../src/internal/session-projection.js";
import type { PiSdkSessionStore } from "../src/sessions/index.js";
import type { SessionHeader } from "@fffattiger/pix-runtime-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Corpus {
  root: string;
  sessionDir: string;
  cwd: string;
  managers: Map<string, SessionManager>;
}

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

/** Append a realistic user+assistant turn (the SDK defers writes until an assistant message exists). */
function appendTurn(manager: SessionManager, question: string, reply: string, ts: number): void {
  manager.appendMessage({ role: "user", content: question, timestamp: ts });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: `think-${reply}` }, { type: "text", text: reply }],
    api: "anthropic",
    provider: "anthropic",
    model: "claude-test",
    usage: usage(),
    stopReason: "toolUse",
    timestamp: ts + 1,
  });
}

/** Create a temp corpus with N sessions, each user+assistant (+ optional title). */
async function makeCorpus(sessionCount: number, options: { titles?: (string | undefined)[] } = {}): Promise<Corpus> {
  const root = await mkdtemp(join(tmpdir(), "pix-proj-test-"));
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const corpus: Corpus = { root, sessionDir, cwd, managers: new Map() };
  for (let i = 0; i < sessionCount; i += 1) {
    const ts = 1_700_000_000_000 + i * 1_000;
    const manager = SessionManager.create(cwd, sessionDir);
    appendTurn(manager, `q${i}`, `a${i}`, ts);
    const title = options.titles?.[i];
    if (title !== undefined) manager.appendSessionInfo(title);
    corpus.managers.set(manager.getSessionId(), manager);
  }
  return corpus;
}

function firstManager(corpus: Corpus): SessionManager {
  const first = [...corpus.managers.values()][0];
  assert.ok(first, "corpus must have at least one manager");
  return first;
}

/** A store over the corpus with the projection enabled at a temp Pix-owned dir. */
function projectedStore(corpus: Corpus, indexRoot?: string): { store: PiSdkSessionStore; indexDir: string } {
  const indexDir = indexRoot ?? join(corpus.root, ".pix");
  const store = createPiSdkSessionStore({
    sessionDir: corpus.sessionDir,
    projection: { enabled: true, dir: indexDir },
  });
  return { store, indexDir };
}

function indexPath(indexDir: string): string {
  return join(indexDir, PROJECTION_INDEX_FILENAME);
}

/** A store over the same corpus WITHOUT the projection (authoritative baseline). */
function rawStore(corpus: Corpus): PiSdkSessionStore {
  return createPiSdkSessionStore({ sessionDir: corpus.sessionDir });
}

async function headerOf(store: PiSdkSessionStore, sessionId: string): Promise<SessionHeader | undefined> {
  const headers = await store.listSessions();
  return headers.find((h) => h.sessionId === sessionId);
}

function cleanup(corpus: Corpus): Promise<void> {
  return rm(corpus.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Projection index module: load / replaceAll / applyDelta / checksum / parse
// ---------------------------------------------------------------------------

describe("SCALE1 session projection index module", () => {
  it("load returns null when the index is absent, and round-trips replaceAll → load", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-module-"));
    try {
      const index = new SessionProjectionIndex(join(root, "idx.sqlite"));
      assert.equal(index.load(), null, "missing index is unusable");
      const row: ProjectedSession = {
        id: "s1", path: "/x/s1.jsonl", cwd: "/workspace", createdMs: 100, modifiedMs: 200,
        messageCount: 3, firstMessage: "hi", mtimeMs: 11.5, size: 40,
      };
      index.replaceAll([row]);
      const loaded = index.load();
      assert.ok(loaded !== null);
      assert.equal(loaded.length, 1);
      assert.deepEqual(loaded[0], row);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applyDelta upserts changed rows and removes missing paths transactionally", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-module-"));
    try {
      const index = new SessionProjectionIndex(join(root, "idx.sqlite"));
      const a: ProjectedSession = { id: "a", path: "/x/a.jsonl", cwd: "/w", createdMs: 1, modifiedMs: 2, messageCount: 1, firstMessage: "a", mtimeMs: 1, size: 1 };
      const b: ProjectedSession = { id: "b", path: "/x/b.jsonl", cwd: "/w", createdMs: 3, modifiedMs: 4, messageCount: 2, firstMessage: "b", mtimeMs: 2, size: 2 };
      index.replaceAll([a, b]);
      const b2: ProjectedSession = { ...b, name: "renamed", messageCount: 5, modifiedMs: 9, mtimeMs: 5, size: 50 };
      index.applyDelta([b2], ["/x/a.jsonl"]);
      const loaded = index.load();
      assert.ok(loaded !== null);
      assert.equal(loaded.length, 1);
      assert.deepEqual(loaded[0], b2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a tampered title via the per-row checksum (load → null, never served)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-module-"));
    try {
      const indexPath = join(root, "idx.sqlite");
      const index = new SessionProjectionIndex(indexPath);
      const row: ProjectedSession = { id: "s1", path: "/x/s1.jsonl", cwd: "/w", name: "Real", createdMs: 1, modifiedMs: 2, messageCount: 1, firstMessage: "a", mtimeMs: 1, size: 1 };
      index.replaceAll([row]);
      // Naive tamper: edit the served title WITHOUT recomputing the checksum.
      const db = new DatabaseSync(indexPath);
      db.prepare("UPDATE session_projection SET name = ? WHERE path = ?").run("EVIL", "/x/s1.jsonl");
      db.close();
      assert.equal(index.load(), null, "checksum mismatch → unusable (rebuild path)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a tampered file mtime via the per-row checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-module-"));
    try {
      const indexPath = join(root, "idx.sqlite");
      const index = new SessionProjectionIndex(indexPath);
      const row: ProjectedSession = { id: "s1", path: "/x/s1.jsonl", cwd: "/w", createdMs: 1, modifiedMs: 2, messageCount: 1, firstMessage: "a", mtimeMs: 1, size: 1 };
      index.replaceAll([row]);
      const db = new DatabaseSync(indexPath);
      db.prepare("UPDATE session_projection SET file_mtime_ms = ? WHERE path = ?").run(999999, "/x/s1.jsonl");
      db.close();
      assert.equal(index.load(), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("load returns null for a corrupt/truncated index file (crash mid-rebuild never serves)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-module-"));
    try {
      const indexPath = join(root, "idx.sqlite");
      const index = new SessionProjectionIndex(indexPath);
      index.replaceAll([{ id: "s1", path: "/x/s1.jsonl", cwd: "/w", createdMs: 1, modifiedMs: 2, messageCount: 1, firstMessage: "a", mtimeMs: 1, size: 1 }]);
      const bytes = await readFile(indexPath);
      // Simulate a crash mid-write: keep only a fraction of the file.
      await writeFile(indexPath, bytes.subarray(0, Math.floor(bytes.length / 3)));
      assert.equal(index.load(), null, "partial index is never loadable/served");
      // replaceAll resets a corrupt file and writes a fresh valid index.
      index.replaceAll([{ id: "s1", path: "/x/s1.jsonl", cwd: "/w", createdMs: 1, modifiedMs: 2, messageCount: 1, firstMessage: "a", mtimeMs: 1, size: 1 }]);
      assert.ok(index.load() !== null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("load returns null for an incompatible schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-module-"));
    try {
      const indexPath = join(root, "idx.sqlite");
      const index = new SessionProjectionIndex(indexPath);
      index.replaceAll([{ id: "s1", path: "/x/s1.jsonl", cwd: "/w", createdMs: 1, modifiedMs: 2, messageCount: 1, firstMessage: "a", mtimeMs: 1, size: 1 }]);
      const db = new DatabaseSync(indexPath);
      db.prepare("UPDATE session_projection_meta SET value = ? WHERE key = 'schema_version'").run("999");
      db.close();
      assert.equal(index.load(), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Store integration: cold build / serve parity / disposability / staleness
// ---------------------------------------------------------------------------

describe("SCALE1 session projection store integration", () => {
  it("cold start builds the index and a later cold start serves identical parity headers", async () => {
    const corpus = await makeCorpus(5, { titles: ["Alpha", "Beta", undefined, "Delta", "Émoji 🌍"] });
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      const h1 = await s1.listSessions(); // build path (listAll → persist)
      assert.equal(h1.length, 5);
      const indexFile = await stat(indexPath(indexDir)).then(() => true, () => false);
      assert.ok(indexFile, "index file persisted");

      // Fresh store over the SAME corpus → served from the projection.
      const { store: s2 } = projectedStore(corpus, indexDir);
      const h2 = await s2.listSessions();
      assert.equal(h2.length, 5);
      assert.deepEqual(h2, h1, "projection serve must be byte-identical to the build result");

      // Authoritative baseline (projection off) parity.
      const raw = await rawStore(corpus).listSessions();
      assert.deepEqual(raw, h1, "projection must match the raw SDK listAll exactly");
    } finally {
      await cleanup(corpus);
    }
  });

  it("the index is disposable: deleting it and the store still lists correctly", async () => {
    const corpus = await makeCorpus(3);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions();
      await rm(indexDir, { recursive: true, force: true }); // delete the whole index dir
      const { store: s2 } = projectedStore(corpus, indexDir);
      const h = await s2.listSessions();
      assert.equal(h.length, 3, "deleting the index must not lose any session");
      // It rebuilds: a subsequent cold start serves from the recreated index.
      const { store: s3 } = projectedStore(corpus, indexDir);
      assert.deepEqual(await s3.listSessions(), h);
    } finally {
      await cleanup(corpus);
    }
  });

  it("append is detected via mtime/size and re-indexed on the next cold start", async () => {
    const corpus = await makeCorpus(2);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions(); // build
      const m0 = firstManager(corpus);
      const id = m0.getSessionId();
      const { store: sPre } = projectedStore(corpus, indexDir);
      const before = await headerOf(sPre, id);
      assert.equal(before?.messageCount, 2);
      // Append a new turn to the live session file.
      appendTurn(m0, "more", "more-reply", 1_700_000_100_000);
      const { store: s2 } = projectedStore(corpus, indexDir);
      const after = await headerOf(s2, id);
      assert.equal(after?.messageCount, 4, "append must be reflected on the next cold start");
    } finally {
      await cleanup(corpus);
    }
  });

  it("rename (via the store) is reflected on the next cold start without a stale title", async () => {
    const corpus = await makeCorpus(2);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions(); // build
      const m0 = firstManager(corpus);
      const id = m0.getSessionId();
      await s1.renameSession(id, "Renamed Title"); // appends session_info + invalidates s1's cache
      const { store: s2 } = projectedStore(corpus, indexDir);
      const after = await headerOf(s2, id);
      assert.equal(after?.title, "Renamed Title", "rename must be visible on the next cold start");
    } finally {
      await cleanup(corpus);
    }
  });

  it("delete (via the store) removes the session on the next cold start", async () => {
    const corpus = await makeCorpus(3);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions(); // build
      const m0 = firstManager(corpus);
      const id = m0.getSessionId();
      await s1.deleteSession(id);
      const { store: s2 } = projectedStore(corpus, indexDir);
      const after = await s2.listSessions();
      assert.equal(after.length, 2, "deleted session must be gone on the next cold start");
      assert.ok(!after.some((h) => h.sessionId === id));
    } finally {
      await cleanup(corpus);
    }
  });

  it("external file deletion (no store mutation) is reflected: stale row never served", async () => {
    const corpus = await makeCorpus(3);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions(); // build
      const m0 = firstManager(corpus);
      await rm(m0.getSessionFile()!); // external delete
      const { store: s2 } = projectedStore(corpus, indexDir);
      const after = await s2.listSessions();
      assert.equal(after.length, 2);
      assert.ok(!after.some((h) => h.sessionId === m0.getSessionId()));
    } finally {
      await cleanup(corpus);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: corruption / tamper injected into the persisted index
// ---------------------------------------------------------------------------

describe("SCALE1 projection adversarial (index tamper/corruption)", () => {
  it("index claims a WRONG TITLE → detected via checksum, never served (rebuild serves the real title)", async () => {
    const corpus = await makeCorpus(2, { titles: ["Real Title"] });
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions(); // build
      const m0 = firstManager(corpus);
      const db = new DatabaseSync(indexPath(indexDir));
      db.prepare("UPDATE session_projection SET name = ? WHERE path = ?").run("EVIL WRONG TITLE", m0.getSessionFile()!);
      db.close();
      const { store: s2 } = projectedStore(corpus, indexDir);
      const headers = await s2.listSessions();
      assert.ok(!headers.some((h) => h.title === "EVIL WRONG TITLE"), "wrong title must never be served");
      const after = await headerOf(s2, m0.getSessionId());
      assert.equal(after?.title, "Real Title", "rebuild serves the authoritative title");
    } finally {
      await cleanup(corpus);
    }
  });

  it("index claims a WRONG mtime → detected, re-indexed, correct mtime served", async () => {
    const corpus = await makeCorpus(2);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      const h1 = await s1.listSessions(); // build
      const m0 = firstManager(corpus);
      const db = new DatabaseSync(indexPath(indexDir));
      db.prepare("UPDATE session_projection SET file_mtime_ms = ?, modified_ms = ? WHERE path = ?")
        .run(1, 1, m0.getSessionFile()!);
      db.close();
      const { store: s2 } = projectedStore(corpus, indexDir);
      const h2 = await s2.listSessions();
      const a = h2.find((x) => x.sessionId === m0.getSessionId());
      const b = h1.find((x) => x.sessionId === m0.getSessionId());
      assert.equal(a?.updatedAt, b?.updatedAt, "wrong mtime must be re-derived, not served");
    } finally {
      await cleanup(corpus);
    }
  });

  it("corrupt index file → authoritative fallback + transactional rebuild (disposable partial never serves)", async () => {
    const corpus = await makeCorpus(3, { titles: ["T0", "T1", "T2"] });
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      const h1 = await s1.listSessions();
      const bytes = await readFile(indexPath(indexDir));
      await writeFile(indexPath(indexDir), bytes.subarray(0, 64)); // truncate → corrupt
      const { store: s2 } = projectedStore(corpus, indexDir);
      const h2 = await s2.listSessions();
      assert.deepEqual(h2, h1, "corrupt index must fall back to the authoritative list");
      // The rebuild left a valid index: a third cold start serves from it.
      const { store: s3 } = projectedStore(corpus, indexDir);
      assert.deepEqual(await s3.listSessions(), h1);
    } finally {
      await cleanup(corpus);
    }
  });

  it("a non-regular (symlinked) session file forces fail-closed fallback, never a wrong serve", async () => {
    const corpus = await makeCorpus(2);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      const h1 = await s1.listSessions();
      const m0 = firstManager(corpus);
      const file = m0.getSessionFile()!;
      const backup = join(corpus.root, "backup.jsonl");
      await rename(file, backup);
      await symlink(backup, file);
      const { store: s2 } = projectedStore(corpus, indexDir);
      const h2 = await s2.listSessions();
      assert.equal(h2.length, 2, "symlinked file → fall back to the authoritative path, session still served");
      assert.deepEqual(h2.map((x) => x.sessionId).sort(), h1.map((x) => x.sessionId).sort());
    } finally {
      await cleanup(corpus);
    }
  });

  it("concurrent append + list never serves a torn/inconsistent snapshot", async () => {
    const corpus = await makeCorpus(4);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      await s1.listSessions(); // build
      const { store: s2 } = projectedStore(corpus, indexDir);
      const pending = s2.listSessions();
      // Concurrently append to a session file while the cold list reconciles.
      const m0 = firstManager(corpus);
      for (let i = 0; i < 5; i += 1) {
        appendTurn(m0, `c${i}`, `r${i}`, 1_700_000_200_000 + i * 2);
      }
      const result = await pending;
      assert.equal(result.length, 4, "list must resolve with the full corpus");
      // A subsequent cold start reflects the final append deterministically.
      const { store: s3 } = projectedStore(corpus, indexDir);
      const finalHeaders = await s3.listSessions();
      assert.equal(finalHeaders.find((h) => h.sessionId === m0.getSessionId())?.messageCount, 12);
    } finally {
      await cleanup(corpus);
    }
  });

  it("many concurrent cold lists over changed files all return correct data (no DB corruption)", async () => {
    const corpus = await makeCorpus(6);
    try {
      const { store: s1, indexDir } = projectedStore(corpus);
      const h1 = await s1.listSessions();
      // Append to several files, then fire concurrent cold lists from fresh stores.
      for (const m of corpus.managers.values()) {
        appendTurn(m, "x", "y", 1_700_000_300_000);
      }
      const stores = Array.from({ length: 6 }, () => projectedStore(corpus, indexDir));
      const results = await Promise.all(stores.map(({ store }) => store.listSessions()));
      const sortById = (hs: readonly SessionHeader[]) => [...hs].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      for (const headers of results) {
        assert.equal(headers.length, 6);
        for (const m of corpus.managers.values()) {
          assert.equal(headers.find((h) => h.sessionId === m.getSessionId())?.messageCount, 4);
        }
      }
      // The persisted index is still valid after the concurrent scans. Order is
      // compared by id: all sessions here share one modified timestamp, and the
      // SDK listAll is itself nondeterministic for equal timestamps (its 10-way
      // concurrent loader), so order is not a parity guarantee in that case.
      const { store: sLast } = projectedStore(corpus, indexDir);
      const last = await sLast.listSessions();
      const firstResult = results[0];
      assert.ok(firstResult, "concurrent scan result missing");
      assert.deepEqual(sortById(last), sortById(firstResult));
    } finally {
      await cleanup(corpus);
    }
  });
});

// ---------------------------------------------------------------------------
// Parity on a mixed corpus (the projection must equal the raw SDK listAll)
// ---------------------------------------------------------------------------

describe("SCALE1 projection parity with the raw SDK on a mixed corpus", () => {
  it("serves identical SessionHeader[] to the raw SDK for varied session shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-proj-parity-"));
    const sessionDir = join(root, "sessions");
    const cwd = join(root, "project");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const indexDir = join(root, ".pix");
    const corpus: Corpus = { root, sessionDir, cwd, managers: new Map() };
    try {
      // Rich session: user/assistant/toolResult/custom + title.
      const rich = SessionManager.create(cwd, sessionDir);
      rich.appendMessage({ role: "user", content: "u", timestamp: 1_700_000_000_000 });
      rich.appendMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-test",
        usage: usage(),
        stopReason: "toolUse",
        timestamp: 1_700_000_000_001,
      });
      rich.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "x", content: [{ type: "text", text: "r" }], isError: false, timestamp: 1_700_000_000_002 });
      rich.appendCustomMessageEntry("ext", "injected", true, { k: 1 });
      rich.appendSessionInfo("Rich 🚀");
      corpus.managers.set(rich.getSessionId(), rich);

      // Compaction session.
      const comp = SessionManager.create(cwd, sessionDir);
      appendTurn(comp, "c1", "c2", 1_700_000_100_000);
      comp.appendCompaction("summary", comp.getLeafId()!, 100);
      corpus.managers.set(comp.getSessionId(), comp);

      // Header-only session (no messages): written manually as a valid JSONL.
      const manualId = "s-manual-0001";
      await writeFile(
        join(sessionDir, `2026-01-01T00-00-00-000Z_${manualId}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id: manualId, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
      );

      const projected = createPiSdkSessionStore({ sessionDir, projection: { enabled: true, dir: indexDir } });
      const raw = createPiSdkSessionStore({ sessionDir });
      const [hProj, hRaw] = await Promise.all([projected.listSessions(), raw.listSessions()]);
      assert.deepEqual(hProj, hRaw, "projection headers must equal the raw SDK listAll exactly");

      // Verify a few specifics on the projected list.
      const richHeader = hProj.find((h) => h.sessionId === rich.getSessionId());
      assert.equal(richHeader?.title, "Rich 🚀");
      assert.equal(richHeader?.messageCount, 3); // user + assistant + toolResult (custom_message not counted)
      const compHeader = hProj.find((h) => h.sessionId === comp.getSessionId());
      assert.equal(compHeader?.messageCount, 2); // compaction entry not counted
      const manualHeader = hProj.find((h) => h.sessionId === manualId);
      assert.equal(manualHeader?.messageCount, 0);
      assert.ok(manualHeader, "header-only session is listed");
    } finally {
      await cleanup(corpus);
    }
  });
});
