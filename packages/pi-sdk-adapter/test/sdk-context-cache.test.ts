import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { SdkRuntimeDriverFactory, type SdkRuntimeComposition } from "../src/internal/sdk-runtime.js";

it("the real driver retains its cached numerator while the current model window changes, and honors in-memory navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-context-cache-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const manager = SessionManager.inMemory(cwd);
  const settings = SettingsManager.inMemory({}, { projectTrusted: true });
  let driver: Awaited<ReturnType<SdkRuntimeDriverFactory["create"]>> | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, authPath: join(agentDir, "auth.json"), modelsPath: null });
    let session: AgentSession | undefined;
    const composition: SdkRuntimeComposition = {
      openSession: async () => ({ manager, cwd }),
      initializeTheme: () => {},
      createServices: () => createAgentSessionServices({
        cwd, agentDir, settingsManager: settings, modelRuntime,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
      }),
      resolveProjectTrust: async () => true,
      prepareExtensionMode: async () => {},
      listVisibleModels: (services) => services.modelRuntime.getModels(),
      getDefaults: () => ({}),
      hasContinuation: () => false,
      createSession: async (options) => {
        const result = await createAgentSessionFromServices(options);
        session = result.session;
        return result;
      },
    };
    driver = await new SdkRuntimeDriverFactory(undefined, composition).create({ cwd, toolNames: [] }, {});
    assert.ok(session?.model);
    const model = session.model;
    const user = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "answer" }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 499_990, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 500_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 2,
    });
    const leaf = manager.getLeafId();
    const entryCount = manager.getEntries().length;
    const build = manager.buildSessionContext.bind(manager);
    let builds = 0;
    manager.buildSessionContext = () => { builds += 1; return build(); };
    // An offline registry refresh may change limits without appending a model
    // selection entry. Exercise the actual driver cache, not the pure helper.
    session.agent.state.model = { ...model, contextWindow: 1_000_000 };
    assert.equal(driver.getContextState?.().contextUsage?.percent, 50);
    session.agent.state.model = { ...model, contextWindow: 2_000_000 };
    const updated = driver.getContextState?.();
    assert.equal(updated?.contextUsage?.tokens, 500_000);
    assert.equal(updated?.contextUsage?.percent, 25);
    assert.equal(updated?.contextUsage?.contextWindow, 2_000_000);
    assert.equal(manager.getLeafId(), leaf);
    assert.equal(manager.getEntries().length, entryCount);
    assert.equal(builds, 1, "only the numerator is cached across model-window changes");
    manager.branch(user);
    const navigated = driver.getContextState?.();
    assert.equal(navigated?.leafId, user);
    assert.ok(navigated?.contextUsage && navigated.contextUsage.tokens! < 500_000);
    assert.equal(builds, 2, "a changed live leaf invalidates the numerator");
    assert.equal(manager.getEntries().length, entryCount, "the read never resets or writes the branch");
  } finally {
    await driver?.close("user");
    await rm(root, { recursive: true, force: true });
  }
});
