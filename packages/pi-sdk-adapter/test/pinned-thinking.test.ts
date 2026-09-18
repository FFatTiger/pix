import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { PiSdkAgentRuntimeFactory } from "../src/agent/factory.js";
import { tagFactoryOptions } from "../src/internal/factory-options.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

describe("pinned thinking semantics", () => {
  it("reapplies the pinned level after model changes and reload", async () => {
    const options = { capabilities: RUNTIME_CAPABILITIES };
    tagFactoryOptions(options, { driverFactory: new ScriptedSdkDriverFactory(new ScriptedSdkStore()) });
    const port = await new PiSdkAgentRuntimeFactory(options).create({
      cwd: "/workspace",
      thinkingLevel: "high",
      thinkingLevelPinned: true,
    });
    await port.execute({ type: "set_model", provider: "openai", modelId: "gpt-5" });
    assert.equal((await port.getSnapshot()).state.thinkingLevel, "high");
    await port.execute({ type: "reload" });
    assert.equal((await port.getSnapshot()).state.thinkingLevel, "high");
    await port.close("user");
  });
});
