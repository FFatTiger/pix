import { strict as assert } from "node:assert";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createPiSdkBuiltInCapabilityConfigStore } from "../src/internal/built-in-capability-store.js";
import { defaultBuiltInCapabilities } from "@fffattiger/pix-runtime-core";

const revision = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const ALL_ON = defaultBuiltInCapabilities();
const MIXED = [
  { id: "subagents" as const, enabled: false },
  { id: "todo" as const, enabled: true },
  { id: "ask_user_question" as const, enabled: false },
  { id: "side_chat" as const, enabled: true },
];

async function fixture(content?: string) {
  const agentDir = await mkdtemp(join(tmpdir(), "pix-builtins-config-"));
  await chmod(agentDir, 0o700);
  if (content !== undefined) {
    await writeFile(join(agentDir, "pix-builtins.json"), content, { mode: 0o600 });
  }
  return agentDir;
}

function assertSanitized(error: unknown, code: string) {
  assert.equal((error as { code?: string }).code, code);
  const message = String((error as Error).message ?? "");
  assert.equal(/ENOENT|EACCES|pix-builtins|\/tmp|private/i.test(message), false);
}

describe("writable pix-builtins.json store", () => {
  it("defaults missing file to all four enabled and a deterministic empty revision", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      const snapshot = await store.readConfig();
      assert.deepEqual(snapshot.capabilities, ALL_ON);
      assert.equal(snapshot.revision, revision(""));
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reads a valid schema v1 document into the semantic snapshot", async () => {
    const source = `${JSON.stringify({
      version: 1,
      subagents: false,
      todo: true,
      ask_user_question: false,
      side_chat: true,
    }, null, 2)}\n`;
    const agentDir = await fixture(source);
    try {
      const snapshot = await createPiSdkBuiltInCapabilityConfigStore({ agentDir }).readConfig();
      assert.deepEqual(snapshot.capabilities, MIXED);
      assert.equal(snapshot.revision, revision(source));
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("writes a CAS full replacement, fences stale revisions, and rejects invalid IDs without writing", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      const before = await store.readConfig();
      const saved = await store.writeConfig({ expectedRevision: before.revision, capabilities: MIXED });
      assert.deepEqual(saved.capabilities, MIXED);
      const persisted = await readFile(join(agentDir, "pix-builtins.json"), "utf8");
      assert.deepEqual(JSON.parse(persisted), {
        version: 1,
        subagents: false,
        todo: true,
        ask_user_question: false,
        side_chat: true,
      });
      assert.equal(saved.revision, revision(persisted));
      assert.equal((await lstat(join(agentDir, "pix-builtins.json"))).mode & 0o077, 0);

      await assert.rejects(
        store.writeConfig({ expectedRevision: before.revision, capabilities: ALL_ON }),
        (error: unknown) => {
          assertSanitized(error, "conflict");
          return true;
        },
      );
      assert.equal(await readFile(join(agentDir, "pix-builtins.json"), "utf8"), persisted);

      const current = await store.readConfig();
      for (const bad of [
        current.capabilities.slice(0, 3),
        [...current.capabilities.slice(0, 3), { id: "plugins", enabled: true }],
        [
          { id: "subagents", enabled: true },
          { id: "todo", enabled: true },
          { id: "ask_user_question", enabled: true },
          { id: "subagents", enabled: false },
        ],
      ]) {
        await assert.rejects(
          store.writeConfig({ expectedRevision: current.revision, capabilities: bad as never }),
          (error: unknown) => {
            assertSanitized(error, "invalid_input");
            return true;
          },
        );
      }
      assert.equal(await readFile(join(agentDir, "pix-builtins.json"), "utf8"), persisted);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes a permuted write list and rejects a stale CAS token fail-closed", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      const empty = await store.readConfig();
      const saved = await store.writeConfig({
        expectedRevision: empty.revision,
        capabilities: [
          { id: "side_chat", enabled: false },
          { id: "todo", enabled: false },
          { id: "subagents", enabled: true },
          { id: "ask_user_question", enabled: true },
        ],
      });
      assert.deepEqual(saved.capabilities, [
        { id: "subagents", enabled: true },
        { id: "todo", enabled: false },
        { id: "ask_user_question", enabled: true },
        { id: "side_chat", enabled: false },
      ]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("concurrent writers produce exactly one winner and the loser conflicts", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      const empty = await store.readConfig();
      const a = [
        { id: "subagents" as const, enabled: false },
        { id: "todo" as const, enabled: false },
        { id: "ask_user_question" as const, enabled: false },
        { id: "side_chat" as const, enabled: false },
      ];
      const b = ALL_ON;
      const results = await Promise.allSettled([
        store.writeConfig({ expectedRevision: empty.revision, capabilities: a }),
        store.writeConfig({ expectedRevision: empty.revision, capabilities: b }),
      ]);
      const codes = results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code));
      assert.equal(codes.filter((c) => c === "ok").length, 1);
      assert.equal(codes.filter((c) => c === "conflict").length, 1);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked document fail-closed without writing through it", async () => {
    const agentDir = await fixture();
    const target = join(agentDir, "planted.json");
    try {
      await writeFile(target, '{"keep":true}\n', { mode: 0o600 });
      await symlink(target, join(agentDir, "pix-builtins.json"));
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      await assert.rejects(store.readConfig(), (error: unknown) => {
        assertSanitized(error, "unavailable");
        return true;
      });
      await assert.rejects(
        store.writeConfig({ expectedRevision: revision(""), capabilities: MIXED }),
        (error: unknown) => {
          assertSanitized(error, "unavailable");
          return true;
        },
      );
      assert.equal(await readFile(target, "utf8"), '{"keep":true}\n');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a corrupt document: fixed error, bytes unchanged", async () => {
    const corrupt = '{"version":1,"subagents": tru\n';
    const agentDir = await fixture(corrupt);
    try {
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      await assert.rejects(store.readConfig(), (error: unknown) => {
        assertSanitized(error, "unavailable");
        return true;
      });
      await assert.rejects(
        store.writeConfig({ expectedRevision: revision(""), capabilities: MIXED }),
        (error: unknown) => {
          assert.ok((error as { code?: string }).code === "unavailable" || (error as { code?: string }).code === "conflict");
          assert.equal(/ENOENT|EACCES|pix-builtins|\/tmp/i.test(String((error as Error).message)), false);
          return true;
        },
      );
      assert.equal(await readFile(join(agentDir, "pix-builtins.json"), "utf8"), corrupt);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a group-readable document without rewriting it", async () => {
    const source = `${JSON.stringify({
      version: 1,
      subagents: true,
      todo: true,
      ask_user_question: true,
      side_chat: true,
    }, null, 2)}\n`;
    const agentDir = await fixture(source);
    try {
      const path = join(agentDir, "pix-builtins.json");
      await chmod(path, 0o644);
      const store = createPiSdkBuiltInCapabilityConfigStore({ agentDir });
      await assert.rejects(store.readConfig(), (error: unknown) => {
        assertSanitized(error, "unavailable");
        return true;
      });
      await assert.rejects(
        store.writeConfig({ expectedRevision: revision(source), capabilities: MIXED }),
        (error: unknown) => {
          assertSanitized(error, "unavailable");
          return true;
        },
      );
      assert.equal(await readFile(path, "utf8"), source);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
