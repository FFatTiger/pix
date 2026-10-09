import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { createPiSdkSettingsConfigStore, readGlobalToolsPreference } from "../src/internal/settings-config-store.js";

const revision = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

async function fixture(content?: string) {
  const agentDir = await mkdtemp(join(tmpdir(), "pix-settings-config-"));
  if (content !== undefined) {
    await writeFile(join(agentDir, "settings.json"), content, { mode: 0o600 });
  }
  return agentDir;
}

describe("writable global settings.json store", () => {
  it("returns raw text verbatim (comments preserved) and empty for a missing file", async () => {
    const source = `{\n  // shared with the pi CLI\n  "defaultProvider": "acme-gpt",\n  "enabledModels": ["gpt-5.6-sol"],\n}\n`;
    const agentDir = await fixture(source);
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const snapshot = await store.readConfig();
      assert.equal(snapshot.content, source);
      assert.equal(snapshot.revision, revision(source));

      const emptyDir = await fixture();
      try {
        const empty = await createPiSdkSettingsConfigStore({ agentDir: emptyDir }).readConfig();
        assert.equal(empty.content, "");
        assert.equal(empty.revision, revision(""));
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("saves verbatim text under CAS, fences stale revisions, and rejects invalid candidates without writing", async () => {
    const agentDir = await fixture(`{\n  "defaultProvider": "acme-gpt",\n}\n`);
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const before = await store.readConfig();
      const next = `{\n  // renamed provider\n  "defaultProvider": "acme-grok",\n}\n`;
      const saved = await store.writeConfig({ expectedRevision: before.revision, content: next });
      assert.equal(saved.content, next);
      assert.equal(saved.revision, revision(next));
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), next);

      await assert.rejects(
        store.writeConfig({ expectedRevision: before.revision, content: next }),
        (error: unknown) => (error as { code?: string }).code === "conflict",
      );

      const bytes = await readFile(join(agentDir, "settings.json"), "utf8");
      for (const bad of ["", "   ", "not json", "[1,2]", "42", '{"defaultProvider": 5}', '{"enabledModels": "x"}']) {
        await assert.rejects(
          store.writeConfig({ expectedRevision: revision(bytes), content: bad }),
          (error: unknown) => (error as { code?: string }).code === "invalid_input",
        );
      }
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), bytes);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("concurrent writers produce exactly one winner and the loser conflicts", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const empty = await store.readConfig();
      const results = await Promise.allSettled([
        store.writeConfig({ expectedRevision: empty.revision, content: '{"defaultProvider": "a"}' }),
        store.writeConfig({ expectedRevision: empty.revision, content: '{"defaultProvider": "b"}' }),
      ]);
      const codes = results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code));
      assert.equal(codes.filter((c) => c === "ok").length, 1);
      assert.equal(codes.filter((c) => c === "conflict").length, 1);
      const persisted = await readFile(join(agentDir, "settings.json"), "utf8");
      assert.ok(persisted === '{"defaultProvider": "a"}' || persisted === '{"defaultProvider": "b"}');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("structured global tool selection (pixDefaultTools)", () => {
  it("missing file and absent keys mean all; null means all; arrays mean custom", async () => {
    const emptyDir = await fixture();
    try {
      const empty = await createPiSdkSettingsConfigStore({ agentDir: emptyDir }).readToolsConfig();
      assert.deepEqual(empty.selection, { mode: "all" });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }

    const agentDir = await fixture(JSON.stringify({ defaultProvider: "acme-gpt" }));
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const absent = await store.readToolsConfig();
      assert.deepEqual(absent.selection, { mode: "all" }, "no pixDefaultTools and no defaultTools => all");

      const savedNull = await store.writeToolsConfig({ expectedRevision: absent.revision, toolNames: null });
      assert.deepEqual(savedNull.selection, { mode: "all" }, "explicit null persists as all");
      const persistedNull = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.equal(persistedNull.pixDefaultTools, null);
      assert.equal(persistedNull.defaultProvider, "acme-gpt", "unknown/consumed values preserved");

      const savedEmpty = await store.writeToolsConfig({ expectedRevision: savedNull.revision, toolNames: [] });
      assert.deepEqual(savedEmpty.selection, { mode: "custom", toolNames: [] }, "empty array = all off");

      const savedList = await store.writeToolsConfig({ expectedRevision: savedEmpty.revision, toolNames: ["read", "bash", "read"] });
      assert.deepEqual(savedList.selection, { mode: "custom", toolNames: ["read", "bash"] }, "deduped allowlist");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("absent pixDefaultTools honors the native defaultTools (+/- resolved by the SDK)", async () => {
    const agentDir = await fixture(JSON.stringify({ defaultTools: ["-read", "+codemode"] }));
    try {
      const snapshot = await createPiSdkSettingsConfigStore({ agentDir }).readToolsConfig();
      assert.equal(snapshot.selection.mode, "native");
      assert.deepEqual(
        [...(snapshot.selection as { toolNames: readonly string[] }).toolNames].sort(),
        ["bash", "codemode", "edit", "write"],
        "SDK resolution: base four, -read removed, +codemode added",
      );
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("structured writes touch only pixDefaultTools and keep unknown values plus the native defaultTools", async () => {
    const source = `{\n  // shared with the pi CLI\n  "defaultTools": ["+codemode"],\n  "customSecret": { "nested": true },\n}\n`;
    const agentDir = await fixture(source);
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const before = await store.readToolsConfig();
      assert.equal(before.selection.mode, "native");
      const saved = await store.writeToolsConfig({ expectedRevision: before.revision, toolNames: ["read", "future-tool"] });
      assert.deepEqual(saved.selection, { mode: "custom", toolNames: ["read", "future-tool"] }, "unknown names persist");
      const persisted = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.deepEqual(persisted.defaultTools, ["+codemode"], "native key untouched");
      assert.deepEqual(persisted.customSecret, { nested: true }, "unknown values preserved");
      assert.deepEqual(persisted.pixDefaultTools, ["read", "future-tool"]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("a corrupt settings.json is an explicit read error, never a silent all", async () => {
    const agentDir = await fixture("not json at all");
    try {
      await assert.rejects(
        createPiSdkSettingsConfigStore({ agentDir }).readToolsConfig(),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("malformed pixDefaultTools fails closed on read and on the raw writer", async () => {
    const agentDir = await fixture(JSON.stringify({ pixDefaultTools: [42] }));
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      await assert.rejects(
        store.readToolsConfig(),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
      const raw = await store.readConfig();
      await assert.rejects(
        store.writeConfig({ expectedRevision: raw.revision, content: JSON.stringify({ pixDefaultTools: "read" }) }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
      await assert.rejects(
        store.writeConfig({ expectedRevision: raw.revision, content: JSON.stringify({ defaultTools: "read" }) }),
        (error: unknown) => (error as { code?: string }).code === "invalid_input",
      );
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("runtime and structured reads reject corrupt preferences without enabling or rewriting tools", async () => {
    for (const content of ["", "not json", "null", "[]", '{"pixDefaultTools":true}', '{"pixDefaultTools":[42]}', '{"defaultTools":"read"}']) {
      const agentDir = await fixture(content);
      try {
        const store = createPiSdkSettingsConfigStore({ agentDir });
        const invalid = (error: unknown) => (error as { code?: string }).code === "invalid_input";
        await assert.rejects(readGlobalToolsPreference(agentDir), invalid, content);
        await assert.rejects(store.readToolsConfig(), invalid, content);
        await assert.rejects(store.writeToolsConfig({ expectedRevision: revision(content), toolNames: null }), invalid, content);
        assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), content);
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    }
  });

  it("runtime inherits only absent preferences and preserves explicit all/none/custom", async () => {
    const agentDir = await fixture();
    try {
      assert.deepEqual(await readGlobalToolsPreference(agentDir), { mode: "unset" });
      for (const [settings, expected] of [
        [{ defaultTools: ["-read"] }, { mode: "unset" }],
        [{ pixDefaultTools: null }, { mode: "all" }],
        [{ pixDefaultTools: [] }, { mode: "custom", toolNames: [] }],
        [{ pixDefaultTools: ["future-tool", "read", "read"] }, { mode: "custom", toolNames: ["future-tool", "read"] }],
      ] as const) {
        await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
        assert.deepEqual(await readGlobalToolsPreference(agentDir), expected);
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("unreadable runtime preferences fail unavailable instead of selecting all", async () => {
    const agentDir = await fixture();
    try {
      await mkdir(join(agentDir, "settings.json"));
      const unavailable = (error: unknown) => (error as { code?: string }).code === "unavailable";
      await assert.rejects(readGlobalToolsPreference(agentDir), unavailable);
      await assert.rejects(createPiSdkSettingsConfigStore({ agentDir }).readToolsConfig(), unavailable);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("raw and structured writes share one CAS fence: concurrent writers have exactly one winner", async () => {
    const agentDir = await fixture(JSON.stringify({ defaultProvider: "acme-gpt" }));
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const before = await store.readConfig();
      const results = await Promise.allSettled([
        store.writeConfig({ expectedRevision: before.revision, content: '{"defaultProvider": "raw"}' }),
        store.writeToolsConfig({ expectedRevision: before.revision, toolNames: ["read"] }),
      ]);
      const codes = results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code));
      assert.equal(codes.filter((c) => c === "ok").length, 1);
      assert.equal(codes.filter((c) => c === "conflict").length, 1);
      const persisted = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.ok(persisted.defaultProvider === "raw" || persisted.pixDefaultTools !== undefined);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed structured mutations without writing", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const before = await store.readToolsConfig();
      for (const bad of [
        { expectedRevision: "nothex", toolNames: null },
        { expectedRevision: before.revision, toolNames: "read" as unknown as string[] },
        { expectedRevision: before.revision, toolNames: [""] },
        { expectedRevision: before.revision, toolNames: ["read\n"] },
      ]) {
        await assert.rejects(
          store.writeToolsConfig(bad),
          (error: unknown) => (error as { code?: string }).code === "invalid_input",
        );
      }
      await assert.rejects(
        readFile(join(agentDir, "settings.json"), "utf8"),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        "nothing written: the missing settings.json stays missing",
      );
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

const inheritedSubagents = { defaultModel: null, fallbackModel: null, agentOverrides: [] };
const roleOverride = (name: string) => ({ name, model: null, fallbackModel: null, thinking: null });
const invalidSettings = (error: unknown) => (error as { code?: string }).code === "invalid_input";

describe("structured global subagent settings", () => {
  it("reads missing and native configuration without writing or inventing roles", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      assert.deepEqual(await store.readSubagentConfig(), { revision: revision(""), settings: inheritedSubagents });
      await assert.rejects(readFile(join(agentDir, "settings.json")), { code: "ENOENT" });
      const content = '{\n// native metadata\n"subagents":{"defaultModel":"  future/model  ","agentOverrides":{" Custom Role ":{"description":"keep"}}}}';
      await writeFile(join(agentDir, "settings.json"), content);
      assert.deepEqual(await store.readSubagentConfig(), {
        revision: revision(content),
        settings: { ...inheritedSubagents, defaultModel: "future/model", agentOverrides: [roleOverride(" Custom Role ")] },
      });
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), content);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("merges owned fields, clears native keys, and preserves metadata, omitted roles and prototype names", async () => {
    const content = '{"__proto__":{"root":true},"subagents":{"metadata":{"keep":true},"defaultModel":"old","fallbackModel":"old-fallback","agentOverrides":{"__proto__":{"model":"old","description":"proto"},"constructor":{"thinking":"high","extra":[1]}," Custom ":{"fallbackModel":"keep"},"metadata":{"description":"keep"}}}}';
    const agentDir = await fixture(content);
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const saved = await store.writeSubagentConfig({ expectedRevision: revision(content), settings: {
        defaultModel: "  provider/future model  ", fallbackModel: null,
        agentOverrides: [
          { ...roleOverride("__proto__"), fallbackModel: "  fuzzy future  " },
          roleOverride("constructor"), roleOverride("nonexistent-default"),
          { ...roleOverride("new"), model: "  new-model  ", thinking: "medium" },
        ],
      } });
      const bytes = await readFile(join(agentDir, "settings.json"), "utf8");
      const native = JSON.parse(bytes);
      assert.equal(saved.revision, revision(bytes));
      assert.deepEqual(saved, await store.readSubagentConfig());
      assert.deepEqual(native.__proto__, { root: true });
      assert.deepEqual(native.subagents, {
        metadata: { keep: true }, defaultModel: "provider/future model",
        agentOverrides: {
          ["__proto__"]: { description: "proto", fallbackModel: "fuzzy future" },
          constructor: { extra: [1] }, " Custom ": { fallbackModel: "keep" }, metadata: { description: "keep" },
          new: { model: "new-model", thinking: "medium" },
        },
      });
      assert.ok(!Object.hasOwn(native.subagents, "fallbackModel"));
      assert.ok(!Object.hasOwn(native.subagents.agentOverrides, "nonexistent-default"));
      assert.ok(!Object.hasOwn(Object.prototype, "model"));
      assert.deepEqual(saved.settings.agentOverrides.find((row) => row.name === "metadata"), roleOverride("metadata"));
      // A native JSON consumer sees optional strings and existing thinking levels, never wire nulls.
      for (const row of Object.values(native.subagents.agentOverrides) as Record<string, unknown>[]) {
        for (const key of ["model", "fallbackModel", "thinking"]) {
          if (Object.hasOwn(row, key)) assert.equal(typeof row[key], "string");
        }
      }
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("handles new prototype-named roles without inherited properties or empty native defaults", async () => {
    const agentDir = await fixture();
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const cleared = await store.writeSubagentConfig({ expectedRevision: revision(""), settings: {
        ...inheritedSubagents, agentOverrides: [roleOverride("constructor"), roleOverride("__proto__")],
      } });
      assert.deepEqual(cleared.settings, inheritedSubagents);
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {});
      const saved = await store.writeSubagentConfig({ expectedRevision: cleared.revision, settings: {
        ...inheritedSubagents, agentOverrides: [
          { ...roleOverride("__proto__"), model: "p/m" },
          { ...roleOverride("constructor"), fallbackModel: "fallback" },
          { ...roleOverride("Role"), model: "upper" }, { ...roleOverride("role"), model: "lower" },
        ],
      } });
      assert.deepEqual(saved.settings.agentOverrides.map((row) => row.name), ["__proto__", "constructor", "Role", "role"]);
      assert.deepEqual(saved, await store.readSubagentConfig());
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("raw, tools and subagent writers on separate stores share a single stale-CAS winner", async () => {
    for (const first of [0, 1, 2]) {
      const agentDir = await fixture('{}');
      try {
        const stores = Array.from({ length: 3 }, () => createPiSdkSettingsConfigStore({ agentDir }));
        const expectedRevision = revision('{}');
        const writes = [
          () => stores[0]!.writeConfig({ expectedRevision, content: '{"raw":true}' }),
          () => stores[1]!.writeToolsConfig({ expectedRevision, toolNames: [] }),
          () => stores[2]!.writeSubagentConfig({ expectedRevision, settings: { ...inheritedSubagents, defaultModel: "future" } }),
        ];
        const ordered = [...writes.slice(first), ...writes.slice(0, first)];
        const results = await Promise.allSettled(ordered.map((write) => write()));
        assert.equal(results[0]!.status, "fulfilled");
        assert.deepEqual(results.slice(1).map((result) => result.status === "rejected" && result.reason.code), ["conflict", "conflict"]);
        const bytes = await readFile(join(agentDir, "settings.json"), "utf8");
        assert.equal(results[0]!.status === "fulfilled" && results[0]!.value.revision, revision(bytes));
        for (const store of stores) assert.equal((await store.readSubagentConfig()).revision, revision(bytes));
      } finally { await rm(agentDir, { recursive: true, force: true }); }
    }
  });

  it("returns its committed snapshot even if another writer publishes immediately after unlock", async (t) => {
    const agentDir = await fixture('{}');
    const externalContent = '{"subagents":{"defaultModel":"external"}}';
    const originalLock = lockfile.lock;
    t.mock.method(lockfile, "lock", async (file: string, options: lockfile.LockOptions) => {
      const release = await originalLock(file, options);
      return async () => {
        await release();
        await writeFile(join(agentDir, "settings.json"), externalContent);
      };
    });
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      const settings = { ...inheritedSubagents, defaultModel: "this-commit" };
      const saved = await store.writeSubagentConfig({ expectedRevision: revision('{}'), settings });
      const committedContent = `${JSON.stringify({ subagents: { defaultModel: "this-commit" } }, null, 2)}\n`;
      assert.deepEqual(saved, { revision: revision(committedContent), settings });
      assert.equal((await store.readSubagentConfig()).settings.defaultModel, "external");
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), externalContent);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("rejects corrupt native known fields across structured/runtime readers and raw publishing, while raw repair stays available", async () => {
    const invalidNative = [
      null, [], true, "bad", { defaultModel: null }, { defaultModel: " " }, { defaultModel: 42 },
      { fallbackModel: null }, { fallbackModel: "" }, { agentOverrides: null }, { agentOverrides: [] },
      { agentOverrides: { role: null } }, { agentOverrides: { role: [] } }, { agentOverrides: { role: "model" } },
      { agentOverrides: { role: { model: null } } }, { agentOverrides: { role: { model: " " } } },
      { agentOverrides: { role: { fallbackModel: false } } }, { agentOverrides: { role: { fallbackModel: null } } },
      { agentOverrides: { role: { thinking: null } } }, { agentOverrides: { role: { thinking: "invalid" } } },
      { agentOverrides: { " ": {} } },
    ];
    const agentDir = await fixture();
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      for (const content of ["", "bad JSON", "null", ...invalidNative.map((subagents) => JSON.stringify({ subagents }))]) {
        await writeFile(join(agentDir, "settings.json"), content);
        const raw = await store.readConfig();
        assert.equal(raw.content, content);
        await assert.rejects(store.readSubagentConfig(), invalidSettings, content);
        await assert.rejects(store.readToolsConfig(), invalidSettings, content);
        await assert.rejects(readGlobalToolsPreference(agentDir), invalidSettings, content);
        await assert.rejects(store.writeSubagentConfig({ expectedRevision: raw.revision, settings: inheritedSubagents }), invalidSettings, content);
        await assert.rejects(store.writeToolsConfig({ expectedRevision: raw.revision, toolNames: null }), invalidSettings, content);
        await assert.rejects(store.writeConfig({ expectedRevision: raw.revision, content }), invalidSettings, content);
        assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), content);
        assert.equal((await store.writeConfig({ expectedRevision: raw.revision, content: '{}' })).content, '{}');
      }
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("rejects malformed DTOs and oversized serializations without changing persisted bytes", async () => {
    const agentDir = await fixture('{}');
    try {
      const store = createPiSdkSettingsConfigStore({ agentDir });
      for (const settings of [
        null, {}, { ...inheritedSubagents, defaultModel: " " },
        { ...inheritedSubagents, extra: true }, { ...inheritedSubagents, fallbackModel: 1 },
        { ...inheritedSubagents, agentOverrides: [roleOverride("same"), roleOverride("same")] },
        { ...inheritedSubagents, agentOverrides: [{ ...roleOverride("role"), thinking: "unknown" }] },
        { ...inheritedSubagents, defaultModel: "x".repeat(256 * 1024) },
      ]) {
        await assert.rejects(store.writeSubagentConfig({ expectedRevision: revision('{}'), settings } as never), invalidSettings);
        assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), '{}');
      }
      await assert.rejects(store.writeSubagentConfig({ expectedRevision: "bad", settings: inheritedSubagents }), invalidSettings);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("reports IO failures as unavailable, never inherited settings", async () => {
    const agentDir = await fixture();
    try {
      await mkdir(join(agentDir, "settings.json"));
      const store = createPiSdkSettingsConfigStore({ agentDir });
      await assert.rejects(store.readSubagentConfig(), { code: "unavailable" });
      await assert.rejects(store.writeSubagentConfig({ expectedRevision: revision(""), settings: inheritedSubagents }), { code: "unavailable" });
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });
});
