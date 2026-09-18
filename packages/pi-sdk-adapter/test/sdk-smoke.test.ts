import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SdkRuntimeDriverFactory, hasSdkContinuation, type SdkRuntimeComposition } from "../src/internal/sdk-runtime.js";

const EXPECTED = [
  "session_manager", "cwd", "theme", "trust_gate", "extension_mode", "services",
  "visible_models", "default_model", "continuation", "initial_scope", "agent_session",
  "startup_preferences", "active_tools", "empty_system_prompt", "bind_extensions", "ready",
] as const;

describe("real Pi SDK composition smoke", () => {
  it("constructs through installed SDK 0.84 APIs and preserves initialization order", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-pi-sdk-adapter-smoke-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    const manager = SessionManager.inMemory(cwd);
    const settings = SettingsManager.inMemory({}, { projectTrusted: true });
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const trace: string[] = [];
    const composition: SdkRuntimeComposition = {
      async openSession(input) {
        assert.ok("cwd" in input);
        return { manager, cwd };
      },
      initializeTheme() { /* real initTheme is covered by production composition import/typecheck */ },
      createServices: (sessionCwd) => createAgentSessionServices({
        cwd: sessionCwd,
        agentDir,
        settingsManager: settings,
        modelRuntime,
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
      getDefaults: () => ({}),
      hasContinuation: (sessionManager) => hasSdkContinuation(sessionManager),
      createSession: (options) => createAgentSessionFromServices(options),
    };
    const factory = new SdkRuntimeDriverFactory({ record: (step) => trace.push(step) }, composition);
    const driver = await factory.create(
      { cwd, toolNames: [], thinkingLevel: "off", thinkingLevelPinned: true },
      {},
    );
    assert.deepEqual(trace, EXPECTED.slice(0, -2));
    assert.equal(driver.identity.cwd, cwd);
    assert.equal(driver.getState().tools.every((tool) => !tool.active), true);
    assert.equal(driver.getState().systemPrompt, "");
    assert.ok(driver.getState().model, "real SDK selected an installed model without network");
    await driver.bindUi(() => {}, () => {});
    assert.deepEqual(trace, EXPECTED);
    await driver.close("user");
    await rm(root, { recursive: true, force: true });
  });
});
