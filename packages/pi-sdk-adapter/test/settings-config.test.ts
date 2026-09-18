import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createPiSdkSettingsConfigStore } from "../src/internal/settings-config-store.js";

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
