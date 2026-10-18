import { strict as assert } from "node:assert";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { defaultBuiltInCapabilities } from "@fffattiger/pix-runtime-core";
import {
  applyToolsSelection,
  capabilityOwnedToolNames,
  type RuntimeToolsSelection,
} from "../src/internal/sdk-runtime.js";
import { memoryCapabilityToolNames } from "../src/internal/curated-plugins.js";
import { SMART_COMPACT_MEMORY_TOOL_NAMES } from "../src/internal/built-in-detection.js";

/** Minimal AgentSession surface used by the tool-selection helpers. */
interface FakeSession {
  tools: Array<{ name: string; exposure?: string }>;
  active: string[];
}

function fakeSession(toolNames: string[]): AgentSession & { active: string[] } {
  const session: FakeSession = {
    tools: toolNames.map((name) => ({ name, exposure: "direct" })),
    active: [],
  };
  return {
    getAllTools: () => session.tools,
    getActiveToolNames: () => session.active,
    setActiveToolsByName: (names: readonly string[]) => {
      session.active = [...names];
    },
    // Test-only accessors so assertions can read/mutate the fake's state
    // directly (the real AgentSession exposes methods, not fields).
    get active(): string[] {
      return session.active;
    },
    set active(value: string[]) {
      session.active = value;
    },
  } as unknown as AgentSession & { active: string[] };
}

const policy = () => ({ forcedEmpty: false });

function selection(mode: "all" | "custom" | "native", toolNames: string[] = []): RuntimeToolsSelection {
  if (mode === "custom") return { mode: "custom", toolNames };
  if (mode === "native") return { mode: "native" };
  return { mode: "all" };
}

const REGISTRY_TOOLS = ["Agent", "SendMessage", "TaskOutput", "TaskStop", "todo", "ask_user_question"];

async function agentDirFixture(options: {
  builtIns?: string;
  settings?: string;
} = {}): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "pix-capability-tools-"));
  await chmod(agentDir, 0o700);
  if (options.builtIns !== undefined) {
    await writeFile(join(agentDir, "pix-builtins.json"), options.builtIns, { mode: 0o600 });
  }
  if (options.settings !== undefined) {
    await writeFile(join(agentDir, "settings.json"), options.settings, { mode: 0o600 });
  }
  return agentDir;
}

const allOnBuiltIns = () => `${JSON.stringify({ version: 1, ...Object.fromEntries(defaultBuiltInCapabilities().map((row) => [row.id, row.enabled])) }, null, 2)}\n`;

describe("registry-derived hidden smart-compact memory tools", () => {
  it("is exactly the registry hiddenTools list", () => {
    assert.deepEqual(SMART_COMPACT_MEMORY_TOOL_NAMES, ["smart_recall", "smart_save_memory"]);
  });
});

describe("capabilityOwnedToolNames (tools follow their capability)", () => {
  it("forces builtin capability tools in for every enabled capability", async () => {
    const agentDir = await agentDirFixture({ builtIns: allOnBuiltIns() });
    try {
      const session = fakeSession(["read", "bash", ...REGISTRY_TOOLS, "smart_compact", "smart_context", "smart_navigation", "smart_tools", "smart_recall"]);
      const owned = capabilityOwnedToolNames(session, agentDir, {});
      assert.deepEqual([...owned].sort(), [...REGISTRY_TOOLS, "smart_compact", "smart_context", "smart_navigation", "smart_tools"].sort());
      // Hidden smart tools never qualify, and memory defaults to local.
      assert.equal(owned.has("smart_recall"), false);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("drops the tools of disabled capabilities (subagents off)", async () => {
    const builtIns = `${JSON.stringify({
      version: 1,
      subagents: false,
      todo: true,
      ask_user_question: true,
      side_chat: true,
      smart_compact: false,
    }, null, 2)}\n`;
    const agentDir = await agentDirFixture({ builtIns, settings: `${JSON.stringify({ pixMemoryProvider: "off" })}\n` });
    try {
      const session = fakeSession(["read", ...REGISTRY_TOOLS, "smart_compact", "smart_tools"]);
      const owned = capabilityOwnedToolNames(session, agentDir, {});
      assert.deepEqual([...owned], ["todo", "ask_user_question"]);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("resolves the memory contribution from the provider family", async () => {
    // Explicit provider selection in BOTH fixtures: the absent-settings
    // migration default (Lore when a machine has an existing ~/.lore) is
    // environment-dependent and must not leak into this assertion.
    const local = await agentDirFixture({ builtIns: allOnBuiltIns(), settings: `${JSON.stringify({ pixMemoryProvider: "local" })}\n` });
    const lore = await agentDirFixture({ builtIns: allOnBuiltIns(), settings: `${JSON.stringify({ pixMemoryProvider: "lore" })}\n` });
    try {
      const names = ["memory_read", "memory_write", "memory_forget", "memory_restore", "memory_status", "scratchpad", "memory_search", "lore_search", "lore_get_node", "read"];
      const localOwned = capabilityOwnedToolNames(fakeSession(names), local, {});
      assert.deepEqual([...localOwned].sort(), ["memory_read", "memory_write", "memory_forget", "memory_restore", "memory_status", "scratchpad", "memory_search"].sort());
      const loreOwned = capabilityOwnedToolNames(fakeSession(names), lore, {});
      assert.deepEqual([...loreOwned].sort(), ["lore_search", "lore_get_node"].sort());
    } finally {
      await rm(local, { recursive: true, force: true });
      await rm(lore, { recursive: true, force: true });
    }
  });

  it("exposes the family helper for off with no tools", () => {
    assert.deepEqual(memoryCapabilityToolNames("off", ["memory_read", "lore_search"]), []);
  });

  it("covers every tool the pinned lore extension registers, including lore_skill_import", () => {
    const loreTools = [
      "lore_status", "lore_boot", "lore_get_node", "lore_search", "lore_list_domains",
      "lore_create_node", "lore_update_node", "lore_delete_node", "lore_move_node",
      "lore_skill_list", "lore_skill_search", "lore_skill_get", "lore_skill_create",
      "lore_skill_update", "lore_skill_delete", "lore_skill_import", "lore_skill_status",
    ];
    assert.deepEqual(memoryCapabilityToolNames("lore", [...loreTools, "read"]), loreTools);
  });
});

describe("applyToolsSelection unions capability-owned tools into custom allowlists", () => {
  it("a custom allowlist that omits capability tools still activates them", () => {
    const session = fakeSession(["read", "bash", ...REGISTRY_TOOLS, "smart_compact", "smart_tools"]);
    const forcedIn = new Set(REGISTRY_TOOLS);
    applyToolsSelection(session, selection("custom", ["read"]), policy(), forcedIn);
    assert.deepEqual(
      [...session.active].sort(),
      ["read", ...REGISTRY_TOOLS].sort(),
    );
  });

  it("an empty allowlist with capabilities on keeps the capability tools active (never a fake empty)", () => {
    const session = fakeSession(["read", "todo", "ask_user_question"]);
    const state = policy();
    applyToolsSelection(session, selection("custom", []), state, new Set(["todo"]));
    assert.deepEqual([...session.active], ["todo"]);
    assert.equal(state.forcedEmpty, false);
  });

  it("without forced tools the empty allowlist keeps the honest all-off contract", () => {
    const session = fakeSession(["read", "bash"]);
    const state = policy();
    applyToolsSelection(session, selection("custom", []), state);
    assert.deepEqual(session.active, []);
    assert.equal(state.forcedEmpty, true);
  });

  it("native mode stays authoritative and ignores forced tools", () => {
    const session = fakeSession(["read", "todo"]);
    session.active = ["read"];
    const state = policy();
    applyToolsSelection(session, selection("native"), state, new Set(["todo"]));
    assert.deepEqual(session.active, ["read"]);
    assert.equal(state.forcedEmpty, false);
  });

  it("hidden smart memory tools never survive any selection", () => {
    const session = fakeSession(["read", "smart_recall", "smart_save_memory", "smart_compact"]);
    applyToolsSelection(session, selection("custom", ["read", "smart_recall", "smart_save_memory"]), policy(), new Set(["smart_compact"]));
    assert.deepEqual([...session.active].sort(), ["read", "smart_compact"]);
  });
});
