import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRef } from "@fffattiger/pix-runtime-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SdkRuntimeDriverFactory, hasSdkContinuation, type SdkRuntimeComposition } from "../src/internal/sdk-runtime.js";

/**
 * Continuation model-identity regression (composer "historical model A becomes
 * actual B on send"). A resumed session whose branch carries model A must run
 * on A even when the global default is B: construct() must OMIT options.model
 * for a continuation without an explicit input.model so the SDK's native
 * persisted-session restore (→ configured/default fallback on restore failure)
 * owns the selection. An explicit model still wins; a FRESH session still gets
 * the default/visible-model selection. The createSession seam is asserted
 * directly (no hidden-default injection) against the REAL
 * createAgentSessionFromServices.
 */

const NOW = 1_000;

function pick(catalog: readonly { provider: string; id: string }[], provider: string) {
  const found = catalog.find((model) => model.provider === provider);
  assert.ok(found, `builtin catalog must expose a ${provider} model for the regression`);
  return found;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pix-model-continuation-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // Deterministic stored api-key credentials for both providers (a stored
  // credential owns the provider over ambient env; no network — nothing here
  // streams, the runtime is only constructed).
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    anthropic: { type: "api_key", key: "pix-test-key-anthropic" },
    openai: { type: "api_key", key: "pix-test-key-openai" },
  }), { encoding: "utf-8", mode: 0o600 });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const all = modelRuntime.getModels();
  const modelA = pick(all, "anthropic");
  const modelB = pick(all, "openai");
  const settings = SettingsManager.inMemory({}, { projectTrusted: true });
  settings.setDefaultModelAndProvider(modelB.provider, modelB.id);
  // The exact production defaultComposition getDefaults body: the nonempty
  // global default B must be VISIBLE to construct() during the test, so the
  // omission under test is the adapter's, not a missing default.
  const getDefaults: SdkRuntimeComposition["getDefaults"] = (services) => ({
    ...(services.settingsManager.getDefaultProvider() === undefined
      ? {}
      : { provider: services.settingsManager.getDefaultProvider()! }),
    ...(services.settingsManager.getDefaultModel() === undefined
      ? {}
      : { modelId: services.settingsManager.getDefaultModel()! }),
  });
  return { root, cwd, agentDir, modelRuntime, settings, modelA, modelB, getDefaults };
}

interface SeamObservation {
  modelPresent: boolean[];
  modelRefs: ({ provider: string; id: string } | undefined)[];
}

function compositionFor(input: {
  cwd: string;
  agentDir: string;
  manager?: SessionManager;
  settings: SettingsManager;
  modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
  getDefaults: SdkRuntimeComposition["getDefaults"];
  observed: SeamObservation;
}): SdkRuntimeComposition {
  return {
    async openSession(openInput) {
      assert.ok(!("sessionId" in openInput) || input.manager !== undefined, "continuation open needs a prepared manager");
      const manager = input.manager ?? SessionManager.inMemory(input.cwd);
      return { manager, cwd: input.cwd };
    },
    initializeTheme() { /* real initTheme is covered by the production composition import */ },
    createServices: () => createAgentSessionServices({
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager: input.settings,
      modelRuntime: input.modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    }),
    resolveProjectTrust: async () => true,
    prepareExtensionMode: async () => {},
    listVisibleModels: (services) => services.modelRuntime.getModels(),
    getDefaults: input.getDefaults,
    hasContinuation: (manager) => hasSdkContinuation(manager),
    createSession: (options: Parameters<typeof createAgentSessionFromServices>[0]) => {
      input.observed.modelPresent.push("model" in options && options.model !== undefined);
      input.observed.modelRefs.push(options.model === undefined
        ? undefined
        : { provider: options.model.provider, id: options.model.id });
      return createAgentSessionFromServices(options);
    },
  };
}

function makeContinuation(cwd: string, model: { provider: string; id: string }): SessionManager {
  const manager = SessionManager.inMemory(cwd);
  manager.appendModelChange(model.provider, model.id);
  manager.appendMessage({ role: "user", content: "prior turn", timestamp: NOW });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "prior answer" }],
    api: "anthropic",
    provider: model.provider,
    model: model.id,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: NOW + 1,
  });
  return manager;
}

/**
 * Continuation context with NO ordinary message entry: a model_change plus a
 * custom_message (which buildSessionContext converts into context messages —
 * the same shape branch summaries and compaction summaries produce). The SDK
 * classifies this as an existing session and restores its model; the adapter's
 * continuation predicate must agree or it re-injects the global default.
 */
function makeCustomMessageContinuation(cwd: string, model: { provider: string; id: string }): SessionManager {
  const manager = SessionManager.inMemory(cwd);
  manager.appendModelChange(model.provider, model.id);
  manager.appendCustomMessageEntry("pix-review", "prior custom turn", false);
  return manager;
}

describe("continuation model identity (omit hidden default, restore via SDK)", () => {
  it("continuation with nonempty global default B runs on the session's model A — options.model omitted at the seam", async (t) => {
    const f = await setup();
    t.after(async () => { await rm(f.root, { recursive: true, force: true }); });
    assert.notEqual(f.modelB.id, f.modelA.id);
    assert.equal(f.settings.getDefaultProvider(), f.modelB.provider, "global default B must be set and visible");
    const manager = makeContinuation(f.cwd, f.modelA);
    const observed: SeamObservation = { modelPresent: [], modelRefs: [] };
    const composition = compositionFor({
      cwd: f.cwd, agentDir: f.agentDir, manager, settings: f.settings,
      modelRuntime: f.modelRuntime, getDefaults: f.getDefaults, observed,
    });
    const factory = new SdkRuntimeDriverFactory(undefined, composition);
    const driver = await factory.open(manager.getSessionId(), f.cwd, undefined, {});
    try {
      assert.deepEqual(observed.modelPresent, [false], "continuation without an explicit model must NOT inject options.model (no hidden default)");
      assert.deepEqual(observed.modelRefs, [undefined]);
      const state = driver.getState();
      assert.ok(state.model, "restored model must be present");
      assert.equal(state.model!.provider, f.modelA.provider, "runtime must run on the session's persisted model A");
      assert.equal(state.model!.id, f.modelA.id);
    } finally {
      await driver.close("user");
    }
  });

  it("custom_message-only continuation (SDK context message, no ordinary message entry) restores model A — default B omitted", async (t) => {
    const f = await setup();
    t.after(async () => { await rm(f.root, { recursive: true, force: true }); });
    const manager = makeCustomMessageContinuation(f.cwd, f.modelA);
    const observed: SeamObservation = { modelPresent: [], modelRefs: [] };
    const composition = compositionFor({
      cwd: f.cwd, agentDir: f.agentDir, manager, settings: f.settings,
      modelRuntime: f.modelRuntime, getDefaults: f.getDefaults, observed,
    });
    const factory = new SdkRuntimeDriverFactory(undefined, composition);
    const driver = await factory.open(manager.getSessionId(), f.cwd, undefined, {});
    try {
      assert.deepEqual(observed.modelPresent, [false], "a custom_message continuation is SDK continuation context — options.model must be omitted");
      const state = driver.getState();
      assert.ok(state.model, "restored model must be present");
      assert.equal(state.model!.provider, f.modelA.provider, "runtime must run on the restored model A, not the global default B");
      assert.equal(state.model!.id, f.modelA.id);
    } finally {
      await driver.close("user");
    }
  });

  it("explicit model on continuation retains priority — options.model passed at the seam and wins", async (t) => {
    const f = await setup();
    t.after(async () => { await rm(f.root, { recursive: true, force: true }); });
    const manager = makeContinuation(f.cwd, f.modelA);
    const observed: SeamObservation = { modelPresent: [], modelRefs: [] };
    const composition = compositionFor({
      cwd: f.cwd, agentDir: f.agentDir, manager, settings: f.settings,
      modelRuntime: f.modelRuntime, getDefaults: f.getDefaults, observed,
    });
    const factory = new SdkRuntimeDriverFactory(undefined, composition);
    const driver = await factory.open(manager.getSessionId(), f.cwd, { provider: f.modelB.provider, id: f.modelB.id }, {});
    try {
      assert.deepEqual(observed.modelPresent, [true], "an explicit model must be forwarded at the seam");
      assert.deepEqual(observed.modelRefs, [{ provider: f.modelB.provider, id: f.modelB.id }]);
      const state = driver.getState();
      assert.equal(state.model!.provider, f.modelB.provider);
      assert.equal(state.model!.id, f.modelB.id);
    } finally {
      await driver.close("user");
    }
  });

  it("fresh creation keeps the existing default selection (default B applied, not omitted)", async (t) => {
    const f = await setup();
    t.after(async () => { await rm(f.root, { recursive: true, force: true }); });
    const observed: SeamObservation = { modelPresent: [], modelRefs: [] };
    const composition = compositionFor({
      cwd: f.cwd, agentDir: f.agentDir, settings: f.settings,
      modelRuntime: f.modelRuntime, getDefaults: f.getDefaults, observed,
    });
    const factory = new SdkRuntimeDriverFactory(undefined, composition);
    const driver = await factory.create({ cwd: f.cwd }, {});
    try {
      assert.deepEqual(observed.modelPresent, [true], "fresh sessions still pass the resolved default model");
      assert.deepEqual(observed.modelRefs, [{ provider: f.modelB.provider, id: f.modelB.id }]);
      const state = driver.getState();
      assert.equal(state.model!.provider, f.modelB.provider);
      assert.equal(state.model!.id, f.modelB.id);
    } finally {
      await driver.close("user");
    }
  });
});
