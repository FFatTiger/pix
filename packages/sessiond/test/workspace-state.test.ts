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
  WORKSPACE_STATE_SCHEMA_VERSION,
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

    it("assistantDelegations namespace: undefined until written, opaque round-trip, shared revision", async () => {
      const store = await make();
      assert.equal(store.readAssistantDelegations(), undefined, "empty store has no namespace value");
      const ledger = { version: 1, delegations: [{ id: "d1" }], chains: {}, queue: [] };
      store.writeAssistantDelegations(ledger);
      assert.deepEqual(store.readAssistantDelegations(), ledger);
      // Opaque: the store never rewrites or validates the owner's shape —
      // even a semantically-bogus value round-trips verbatim.
      const bogus = { nonsense: true };
      store.writeAssistantDelegations(bogus);
      assert.deepEqual(store.readAssistantDelegations(), bogus);
      // Flag mutations bump the same revision and NEVER drop the namespace.
      const before = store.snapshot().revision;
      store.setSessionFlags("s1", { pinned: true });
      assert.equal(store.snapshot().revision, before + 1);
      assert.deepEqual(store.readAssistantDelegations(), bogus, "a flags write must not drop the delegations namespace");
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
      assert.equal(parsed.schemaVersion, WORKSPACE_STATE_SCHEMA_VERSION);
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

  it("reads a schema-v1 document (pre-delegations): flags load, namespace reads empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-ws-state-v1-"));
    try {
      await writeFile(join(dir, WORKSPACE_STATE_FILE_NAME), JSON.stringify({
        kind: "pix.sessiond.workspace-state",
        schemaVersion: 1,
        revision: 7,
        sessions: { legacy: { pinned: true } },
        projects: {},
      }), "utf8");
      const store = new FileWorkspaceStateStore(dir);
      const snapshot = store.snapshot();
      assert.equal(snapshot.revision, 7, "a readable v1 document keeps its revision");
      assert.deepEqual(snapshot.sessions, { legacy: { pinned: true } });
      assert.equal(snapshot.assistantDelegations, undefined, "v1 has no delegations namespace ⇒ empty");
      assert.equal(store.readAssistantDelegations(), undefined);
      // Any write upgrades the document to the current schema version.
      store.writeAssistantDelegations({ version: 1, delegations: [], chains: {}, queue: [] });
      const raw = JSON.parse(await readFile(join(dir, WORKSPACE_STATE_FILE_NAME), "utf8")) as Record<string, unknown>;
      assert.equal(raw.schemaVersion, WORKSPACE_STATE_SCHEMA_VERSION);
      assert.deepEqual(raw.sessions, { legacy: { pinned: true } }, "upgrade keeps the flags");
      const reloaded = new FileWorkspaceStateStore(dir);
      assert.deepEqual(reloaded.readAssistantDelegations(), { version: 1, delegations: [], chains: {}, queue: [] });
      assert.deepEqual(reloaded.snapshot().sessions, { legacy: { pinned: true } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists the delegations namespace across instances and never drops it on flag writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-ws-state-ns-"));
    try {
      const store = new FileWorkspaceStateStore(dir);
      const ledger = { version: 1, delegations: [{ id: "d1", state: "notify" }], chains: { a: { lastUserTurnAt: 5, targets: {} } }, queue: [{ delegationId: "d1" }] };
      store.writeAssistantDelegations(ledger);
      store.setProjectFlags("/repos/pix", { archived: true });
      const reloaded = new FileWorkspaceStateStore(dir);
      assert.deepEqual(reloaded.readAssistantDelegations(), ledger);
      assert.deepEqual(reloaded.snapshot().projects, { "/repos/pix": { pinned: false, archived: true } });
      const raw = JSON.parse(await readFile(join(dir, WORKSPACE_STATE_FILE_NAME), "utf8")) as { assistantDelegations?: unknown };
      assert.ok(raw.assistantDelegations, "the namespace is on disk in the same document");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
