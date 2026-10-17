import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSettingsReadableForHygiene,
  readModelVisibilitySnapshot,
  readPickerVisibility,
  syncEnabledModelsWithModelsConfig,
  writeModelVisibility,
} from "../src/internal/model-visibility.js";

let base: string;
let agentDir: string;

interface SeedOptions {
  models?: Record<string, { id: string }[]>;
  settings?: Record<string, unknown> | null;
}

/** Two configured providers by default: acme(one,two) + beta(three). */
function seedModels(): Record<string, { id: string }[]> {
  return {
    acme: [{ id: "one" }, { id: "two" }],
    beta: [{ id: "three" }],
  };
}

async function writeModels(models: Record<string, { id: string }[]>): Promise<void> {
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: Object.fromEntries(Object.entries(models).map(([id, models]) => [id, {
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: "sk-test-not-a-secret",
      models,
    }])),
  }, null, 2)}\n`);
}

async function writeSettings(settings: Record<string, unknown> | null): Promise<void> {
  const path = join(agentDir, "settings.json");
  if (settings === null) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
}

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

async function revision(): Promise<string> {
  return (await readModelVisibilitySnapshot(agentDir)).revision;
}

function errorWithCode(error: unknown): { code?: string; message?: string } {
  return error as { code?: string; message?: string };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pix-model-visibility-"));
  agentDir = join(base, "agent");
  await mkdir(agentDir, { recursive: true });
  await chmod(agentDir, 0o700);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("model visibility reads", () => {
  it("no settings.json => no whitelist, every configured model visible, no default", async () => {
    await writeModels(seedModels());
    await writeSettings(null);
    const snapshot = await readModelVisibilitySnapshot(agentDir);
    assert.equal(snapshot.patterns, null);
    assert.deepEqual(
      [...snapshot.visible].map((entry) => `${entry.provider}/${entry.id}`).sort(),
      ["acme/one", "acme/two", "beta/three"],
    );
    assert.equal(snapshot.defaultModel, null);
  });

  it("empty enabledModels array reads as no whitelist (Pi semantics: all visible)", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: [] });
    const snapshot = await readModelVisibilitySnapshot(agentDir);
    assert.equal(snapshot.patterns, null);
    assert.equal(snapshot.visible.length, 3);
  });

  it("glob patterns resolve to the configured subset and expose the raw default pair", async () => {
    await writeModels(seedModels());
    await writeSettings({
      enabledModels: ["acme/*"],
      defaultProvider: "acme",
      defaultModel: "two",
    });
    const snapshot = await readModelVisibilitySnapshot(agentDir);
    assert.deepEqual(snapshot.patterns, ["acme/*"]);
    assert.deepEqual(
      [...snapshot.visible].map((entry) => `${entry.provider}/${entry.id}`).sort(),
      ["acme/one", "acme/two"],
    );
    assert.deepEqual(snapshot.defaultModel, { provider: "acme", id: "two" });
  });

  it("readPickerVisibility mirrors the same matching for the models config snapshot", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["beta/three"] });
    const visibility = await readPickerVisibility(agentDir);
    assert.equal(visibility.allVisible, false);
    assert.equal(visibility.visibleKeys.has("acme\0one"), false);
    assert.equal(visibility.visibleKeys.has("beta\0three"), true);
  });

  it("malformed settings.json fails the read (invalid_input), never a fake all-visible", async () => {
    await writeModels(seedModels());
    await writeFile(join(agentDir, "settings.json"), "{ oops", "utf8");
    await assert.rejects(
      () => readModelVisibilitySnapshot(agentDir),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
    await assert.rejects(
      () => assertSettingsReadableForHygiene(agentDir),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
  });

  it("wrong-typed enabledModels/default fields fail closed", async () => {
    await writeModels(seedModels());
    for (const payload of [{ enabledModels: "acme/*" }, { enabledModels: [42] }, { defaultProvider: 7 }]) {
      await writeSettings(payload);
      await assert.rejects(
        () => readModelVisibilitySnapshot(agentDir),
        (error: unknown) => errorWithCode(error).code === "invalid_input",
      );
    }
  });
});

describe("model visibility writes (intents)", () => {
  it("first hide generates the whitelist from every configured model minus the hidden one", async () => {
    await writeModels(seedModels());
    await writeSettings({ defaultProvider: "acme", defaultModel: "one", keepMe: { nested: [1, 2] } });
    const before = await revision();
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: before,
      changes: [{ provider: "acme", id: "one", visible: false }],
    });
    assert.deepEqual([...snapshot.patterns ?? []].sort(), ["acme/two", "beta/three"]);
    const raw = await readSettings();
    assert.deepEqual([...(raw.enabledModels as string[])].sort(), ["acme/two", "beta/three"]);
    // Sibling keys round-trip untouched.
    assert.equal(raw.defaultProvider, "acme");
    assert.equal(raw.defaultModel, "one");
    assert.deepEqual(raw.keepMe, { nested: [1, 2] });
  });

  it("show appends the exact provider/id to an existing whitelist", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/one"] });
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: await revision(),
      changes: [{ provider: "beta", id: "three", visible: true }],
    });
    assert.deepEqual(snapshot.patterns, ["acme/one", "beta/three"]);
    assert.equal(snapshot.visible.length, 2);
  });

  it("hide removes an exact entry", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/one", "beta/three"] });
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: await revision(),
      changes: [{ provider: "acme", id: "one", visible: false }],
    });
    assert.deepEqual(snapshot.patterns, ["beta/three"]);
  });

  it("hide expands a covering glob into the exact survivors, preserving a thinking suffix", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/*:high"] });
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: await revision(),
      changes: [{ provider: "acme", id: "one", visible: false }],
    });
    assert.deepEqual(snapshot.patterns, ["acme/two:high"]);
  });

  it("hide on a pattern covering several providers expands only the configured survivors", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["*"] });
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: await revision(),
      changes: [{ provider: "beta", id: "three", visible: false }],
    });
    assert.deepEqual([...snapshot.patterns ?? []].sort(), ["acme/one", "acme/two"]);
    // Everything stays visible except beta/three.
    assert.deepEqual(
      [...snapshot.visible].map((entry) => `${entry.provider}/${entry.id}`).sort(),
      ["acme/one", "acme/two"],
    );
  });

  it("a non-glob entry that only covers the hidden model is dropped entirely", async () => {
    await writeModels(seedModels());
    // "one" fuzzy-resolves to acme/one only.
    await writeSettings({ enabledModels: ["one", "beta/three"] });
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: await revision(),
      changes: [{ provider: "acme", id: "one", visible: false }],
    });
    assert.deepEqual(snapshot.patterns, ["beta/three"]);
  });

  it("sequential intents compose (glob off two models => both exact rows removed)", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/*", "beta/three"] });
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: await revision(),
      changes: [
        { provider: "acme", id: "one", visible: false },
        { provider: "acme", id: "two", visible: false },
      ],
    });
    // acme/* first expands to acme/two, then that exact row is removed.
    assert.deepEqual(snapshot.patterns, ["beta/three"]);
  });

  it("show on a no-whitelist scope is a no-op (already visible, file untouched)", async () => {
    await writeModels(seedModels());
    await writeSettings(null);
    const before = await revision();
    const snapshot = await writeModelVisibility(agentDir, {
      expectedRevision: before,
      changes: [{ provider: "acme", id: "one", visible: true }],
    });
    assert.equal(snapshot.patterns, null);
    assert.equal(snapshot.revision, before);
    // No settings.json was created by a no-op write.
    await assert.rejects(() => readFile(join(agentDir, "settings.json"), "utf8"));
  });

  it("hiding every visible model fails closed (at least one must stay)", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/one"] });
    const before = await revision();
    await assert.rejects(
      () => writeModelVisibility(agentDir, {
        expectedRevision: before,
        changes: [{ provider: "acme", id: "one", visible: false }],
      }),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
    // File unchanged.
    assert.deepEqual((await readSettings()).enabledModels, ["acme/one"]);
  });

  it("hiding the single configured model without a whitelist also fails", async () => {
    await writeModels({ solo: [{ id: "only" }] });
    await writeSettings(null);
    const before = await revision();
    await assert.rejects(
      () => writeModelVisibility(agentDir, {
        expectedRevision: before,
        changes: [{ provider: "solo", id: "only", visible: false }],
      }),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
    await assert.rejects(() => readFile(join(agentDir, "settings.json"), "utf8"));
  });

  it("unknown model identities and duplicate intents fail with invalid_input", async () => {
    await writeModels(seedModels());
    await writeSettings(null);
    const before = await revision();
    await assert.rejects(
      () => writeModelVisibility(agentDir, {
        expectedRevision: before,
        changes: [{ provider: "acme", id: "nope", visible: false }],
      }),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
    await assert.rejects(
      () => writeModelVisibility(agentDir, {
        expectedRevision: before,
        changes: [
          { provider: "acme", id: "one", visible: false },
          { provider: "acme", id: "one", visible: true },
        ],
      }),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
    await assert.rejects(
      () => writeModelVisibility(agentDir, {
        expectedRevision: "nothex",
        changes: [],
      }),
      (error: unknown) => errorWithCode(error).code === "invalid_input",
    );
  });

  it("stale expectedRevision conflicts and leaves settings.json untouched", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/one"] });
    const stale = (await readModelVisibilitySnapshot(agentDir)).revision;
    await writeSettings({ enabledModels: ["acme/one"], extra: 1 });
    await assert.rejects(
      () => writeModelVisibility(agentDir, {
        expectedRevision: stale,
        changes: [{ provider: "acme", id: "one", visible: false }],
      }),
      (error: unknown) => errorWithCode(error).code === "conflict",
    );
    assert.deepEqual((await readSettings()).enabledModels, ["acme/one"]);
  });
});

describe("enabledModels hygiene after models.json writes", () => {
  it("appends newly configured models, drops dead exact rows, keeps glob patterns", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/one", "acme/two", "zzz/*"] });
    // models.json changes: "two" removed, "four" added, beta untouched.
    await writeModels({ acme: [{ id: "one" }, { id: "four" }], beta: [{ id: "three" }] });
    await syncEnabledModelsWithModelsConfig(agentDir);
    assert.deepEqual(
      [...((await readSettings()).enabledModels as string[])].sort(),
      ["acme/four", "acme/one", "beta/three", "zzz/*"],
    );
  });

  it("provider deletion removes its exact entries (patterns survive)", async () => {
    await writeModels(seedModels());
    await writeSettings({ enabledModels: ["acme/one", "acme/*", "beta/three"] });
    await writeModels({ beta: [{ id: "three" }] });
    await syncEnabledModelsWithModelsConfig(agentDir);
    assert.deepEqual(
      [...((await readSettings()).enabledModels as string[])].sort(),
      ["acme/*", "beta/three"],
    );
  });

  it("no whitelist => hygiene is a no-op (all-visible scope is never materialized)", async () => {
    await writeModels(seedModels());
    await writeSettings(null);
    await writeModels({ acme: [{ id: "one" }], beta: [{ id: "three" }] });
    await syncEnabledModelsWithModelsConfig(agentDir);
    await assert.rejects(() => readFile(join(agentDir, "settings.json"), "utf8"));
  });

  it("unchanged catalog leaves the whitelist bytes untouched", async () => {
    await writeModels(seedModels());
    // A whitelist that already covers every configured model is stable.
    await writeSettings({ enabledModels: ["acme/*", "beta/three"] });
    const before = await readFile(join(agentDir, "settings.json"), "utf8");
    await syncEnabledModelsWithModelsConfig(agentDir);
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), before);
  });
});
