/**
 * Round 5 redo: sessiond-owned durable workspace state.
 *
 * File-store durability (atomic write, revision, schema gate, corrupt
 * quarantine), merge semantics, and the in-memory test double's contract
 * parity. NOT run in this commit (user-deferred validation).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FileWorkspaceStateStore,
  InMemoryWorkspaceStateStore,
  WORKSPACE_STATE_FILE_NAME,
  normalizeProjectKey,
  type WorkspaceStateStore,
} from "../src/workspace-state.js";

function behaveLikeStore(make: () => WorkspaceStateStore | Promise<WorkspaceStateStore>, label: string) {
  describe(label, () => {
    it("starts empty (revision 0) and merges per-field with read-back", async () => {
      const store = await make();
      assert.deepEqual(store.snapshot(), { revision: 0, sessions: {}, projects: {} });
      const first = store.setSessionFlags("s1", { pinned: true });
      assert.deepEqual(first, { pinned: true, archived: false });
      // Absent field keeps its value (partial update).
      const second = store.setSessionFlags("s1", { archived: true });
      assert.deepEqual(second, { pinned: true, archived: true });
      const third = store.setSessionFlags("s1", { pinned: false });
      assert.deepEqual(third, { pinned: false, archived: true });
      // Project namespace is independent; keys normalize to absolute paths.
      const project = store.setProjectFlags("/repos/pix/", { pinned: true });
      assert.equal(project.pinned, true);
      assert.deepEqual(Object.keys(store.snapshot().projects), [normalizeProjectKey("/repos/pix/")]);
      assert.equal(store.snapshot().revision, 4);
    });

    it("rejects no-flag input and invalid keys fail closed", async () => {
      const store = await make();
      assert.throws(() => store.setSessionFlags("s1", {}), /at least one flag/i);
      assert.throws(() => store.setProjectFlags("relative/path", { pinned: true }), /project root/i);
      assert.throws(() => store.setProjectFlags("", { pinned: true }), /project root/i);
      assert.equal(store.snapshot().revision, 0, "rejected writes never bump revision");
    });
  });
}

behaveLikeStore(() => new InMemoryWorkspaceStateStore(), "InMemoryWorkspaceStateStore");
behaveLikeStore(async () => {
  const dir = await mkdtemp(join(tmpdir(), "pix-ws-state-"));
  return new FileWorkspaceStateStore(dir);
}, "FileWorkspaceStateStore (durability)");

describe("FileWorkspaceStateStore durability", () => {
  it("persists atomically (0600) and reloads exactly after a fresh store instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-ws-state-persist-"));
    try {
      const store = new FileWorkspaceStateStore(dir);
      store.setSessionFlags("s1", { pinned: true, archived: true });
      store.setProjectFlags("/repos/pix", { pinned: true });
      const file = join(dir, WORKSPACE_STATE_FILE_NAME);
      const info = await stat(file);
      assert.equal(info.mode & 0o777, 0o600);
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { kind: string; schemaVersion: number; revision: number };
      assert.equal(parsed.kind, "pix.sessiond.workspace-state");
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.revision, 2);
      // Fresh instance over the same directory sees the same state.
      const reloaded = new FileWorkspaceStateStore(dir);
      const snapshot = reloaded.snapshot();
      assert.equal(snapshot.revision, 2);
      assert.deepEqual(snapshot.sessions, { s1: { pinned: true, archived: true } });
      assert.deepEqual(snapshot.projects, { "/repos/pix": { pinned: true } });
      // No leftover temp file after the atomic rename.
      await assert.rejects(stat(join(dir, `${WORKSPACE_STATE_FILE_NAME}.tmp`)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt file and restarts empty (never bricks sessiond)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-ws-state-corrupt-"));
    try {
      await writeFile(join(dir, WORKSPACE_STATE_FILE_NAME), "{ not json", "utf8");
      const store = new FileWorkspaceStateStore(dir);
      assert.deepEqual(store.snapshot(), { revision: 0, sessions: {}, projects: {} });
      // The corrupt original was quarantined aside; a fresh write succeeds.
      store.setSessionFlags("s1", { pinned: true });
      const reloaded = new FileWorkspaceStateStore(dir).snapshot();
      assert.deepEqual(reloaded.sessions, { s1: { pinned: true } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown schema versions as corrupt (forward fail-closed → quarantine+empty)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-ws-state-version-"));
    try {
      await writeFile(join(dir, WORKSPACE_STATE_FILE_NAME), JSON.stringify({
        kind: "pix.sessiond.workspace-state",
        schemaVersion: 99,
        revision: 5,
        sessions: {},
        projects: {},
      }), "utf8");
      const store = new FileWorkspaceStateStore(dir);
      assert.equal(store.snapshot().revision, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
