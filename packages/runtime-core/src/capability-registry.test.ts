import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_CAPABILITY_REGISTRY,
  CAPABILITY_REGISTRY,
  findCapabilityRegistryEntry,
  memoryCapabilityRegistryEntry,
  validateCapabilityRegistry,
} from "./capability-registry.js";
import { BUILT_IN_CAPABILITY_IDS, defaultBuiltInCapabilities } from "./built-in-capabilities.js";
import { MEMORY_PROVIDERS } from "./settings-config.js";
import { RUNTIME_CAPABILITIES } from "./capabilities.js";

describe("capability registry shape", () => {
  it("is structurally valid", () => {
    assert.deepEqual(validateCapabilityRegistry(), []);
  });

  it("derives the persisted built-in vocabulary unchanged (store schema v1)", () => {
    // Inserting or reordering a builtin registry entry changes the
    // pix-builtins.json document vocabulary — pinned here on purpose.
    assert.deepEqual([...BUILT_IN_CAPABILITY_IDS], ["subagents", "todo", "ask_user_question", "side_chat", "smart_compact"]);
    assert.deepEqual(
      BUILTIN_CAPABILITY_REGISTRY.map((entry) => entry.id),
      [...BUILT_IN_CAPABILITY_IDS],
    );
    assert.deepEqual(
      defaultBuiltInCapabilities().map((row) => row.id),
      [...BUILT_IN_CAPABILITY_IDS],
    );
  });

  it("registers every builtin entry exactly once and one memory provider entry", () => {
    assert.equal(CAPABILITY_REGISTRY.filter((entry) => entry.control === "builtin").length, BUILT_IN_CAPABILITY_IDS.length);
    assert.equal(CAPABILITY_REGISTRY.filter((entry) => entry.control === "memory_provider").length, 1);
    assert.equal(memoryCapabilityRegistryEntry().id, "memory");
  });

  it("every dynamic runtime token is a real runtime capability token (or null)", () => {
    for (const entry of CAPABILITY_REGISTRY) {
      if (entry.runtimeToken === null) continue;
      assert.ok(
        (RUNTIME_CAPABILITIES as readonly string[]).includes(entry.runtimeToken),
        `${entry.id} advertises an unknown runtime token: ${entry.runtimeToken}`,
      );
    }
  });

  it("detail pages, labels and descriptions are declared for every entry", () => {
    for (const entry of CAPABILITY_REGISTRY) {
      assert.match(entry.labelKey, /^desktop\./, `${entry.id} labelKey`);
      assert.match(entry.descriptionKey, /^desktop\./, `${entry.id} descriptionKey`);
      if (entry.detailPage !== null) assert.match(entry.detailPage, /^[a-z_]+$/, `${entry.id} detailPage`);
    }
    // Capabilities with a detail page are exactly the registry-driven
    // settings entries.
    assert.deepEqual(
      CAPABILITY_REGISTRY.filter((entry) => entry.detailPage !== null).map((entry) => entry.id),
      ["subagents", "smart_compact", "memory"],
    );
  });

  it("smart compaction hides exactly its own memory tools and contributes the rest", () => {
    const entry = findCapabilityRegistryEntry("smart_compact");
    assert.ok(entry);
    assert.deepEqual(entry.hiddenTools, ["smart_recall", "smart_save_memory"]);
    assert.deepEqual(entry.tools, ["smart_compact", "smart_context", "smart_navigation", "smart_tools"]);
  });

  it("memory prompt sections cover the on providers and omit off", () => {
    const sections = memoryCapabilityRegistryEntry().assistantPromptSections;
    for (const provider of MEMORY_PROVIDERS) {
      if (provider === "off") assert.equal(sections[provider], undefined);
      else assert.equal(typeof sections[provider], "string", `missing prompt section for ${provider}`);
    }
  });

  it("memory registers no static tool list (provider-dependent families)", () => {
    assert.deepEqual(memoryCapabilityRegistryEntry().tools, []);
    assert.deepEqual(memoryCapabilityRegistryEntry().commands, []);
  });

  it("no tool name is contributed by two capabilities and hidden tools never overlap tools", () => {
    const owners = new Map<string, string>();
    for (const entry of CAPABILITY_REGISTRY) {
      for (const name of entry.tools) {
        const existing = owners.get(name);
        assert.equal(existing, undefined, `${name} contributed by ${existing} and ${entry.id}`);
        owners.set(name, entry.id);
      }
      for (const name of entry.hiddenTools) {
        assert.equal(entry.tools.includes(name), false, `${entry.id} lists ${name} as both tool and hiddenTool`);
      }
    }
  });
});
