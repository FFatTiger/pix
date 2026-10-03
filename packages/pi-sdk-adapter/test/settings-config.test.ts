import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
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
