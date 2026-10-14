import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bundledPluginRoots,
  createCuratedExtensionsOverride,
  filterCuratedExtensions,
  memoryEnabledPlugins,
} from "../src/internal/curated-plugins.js";
import { dropBundledMemorySearchTools } from "../src/internal/pi-memory-bridge.js";
import type { ExtensionLike } from "../src/internal/curated-plugins.js";

function extension(path: string, toolNames: readonly string[], commands: readonly string[] = []): ExtensionLike {
  return {
    path,
    resolvedPath: path,
    tools: new Map(toolNames.map((name) => [name, { definition: { name } }])),
    commands: new Map(commands.map((name) => [name, { name }])),
  };
}

const PI_MEMORY_TOOLS = ["memory_write", "scratchpad", "memory_read", "memory_forget", "memory_restore", "memory_search", "memory_status"];
const LORE_CORE_TOOLS = ["lore_status", "lore_boot", "lore_get_node", "lore_search", "lore_list_domains", "lore_create_node", "lore_update_node", "lore_delete_node", "lore_move_node"];
const LORE_SKILL_TOOLS = ["lore_skill_list", "lore_skill_search", "lore_skill_get", "lore_skill_create", "lore_skill_update", "lore_skill_delete", "lore_skill_status"];

describe("memory curated plugins", () => {
  it("bundled roots resolve the vendored pi-memory and lore packages", () => {
    const roots = bundledPluginRoots();
    const piMemory = roots.find((item) => item.id === "pi_memory");
    const lore = roots.find((item) => item.id === "lore");
    assert.ok(piMemory, "pi_memory root resolves");
    assert.ok(lore, "lore root resolves");
    assert.equal(piMemory!.packageName, "pi-memory");
    assert.equal(lore!.packageName, "@local/lore-pi-extension");
    assert.ok(piMemory!.entry.endsWith("index.ts"));
    assert.ok(lore!.entry.endsWith("index.ts"));
  });

  it("memoryEnabledPlugins maps provider → exactly one (or none) memory plugin", () => {
    assert.deepEqual([...memoryEnabledPlugins("local")], ["pi_memory"]);
    assert.deepEqual([...memoryEnabledPlugins("lore")], ["lore"]);
    assert.deepEqual([...memoryEnabledPlugins("off")], []);
  });

  it("provider local: loads only the bundled pi-memory; lore copies are dropped", () => {
    const roots = bundledPluginRoots();
    const piMemory = roots.find((item) => item.id === "pi_memory")!;
    const lore = roots.find((item) => item.id === "lore")!;
    const enabled = memoryEnabledPlugins("local");
    const filtered = filterCuratedExtensions({
      extensions: [
        extension(piMemory.entry, PI_MEMORY_TOOLS),
        extension("/home/u/.pi/agent/extensions/lore/index.ts", LORE_CORE_TOOLS),
        extension(lore.entry, [...LORE_CORE_TOOLS, ...LORE_SKILL_TOOLS]),
      ],
      errors: [],
      runtime: { marker: 1 },
    }, enabled);
    assert.equal(filtered.extensions.length, 1);
    assert.equal(filtered.extensions[0]!.path, piMemory.entry);
  });

  it("provider lore: loads only the bundled lore; the user's own installed copy (symlinked, skills variant surface) is dropped", () => {
    const roots = bundledPluginRoots();
    const piMemory = roots.find((item) => item.id === "pi_memory")!;
    const lore = roots.find((item) => item.id === "lore")!;
    const enabled = memoryEnabledPlugins("lore");
    const filtered = filterCuratedExtensions({
      extensions: [
        extension(piMemory.entry, PI_MEMORY_TOOLS),
        // User copy at a foreign path without skills tools (skills disabled).
        extension("/home/u/.lore/pi/index.ts", LORE_CORE_TOOLS),
        // Bundled copy with the full skills surface.
        extension(lore.entry, [...LORE_CORE_TOOLS, ...LORE_SKILL_TOOLS]),
      ],
      errors: [],
      runtime: { marker: 1 },
    }, enabled);
    assert.equal(filtered.extensions.length, 1);
    assert.equal(filtered.extensions[0]!.path, lore.entry);
  });

  it("provider off: neither memory plugin loads, from any path", () => {
    const roots = bundledPluginRoots();
    const piMemory = roots.find((item) => item.id === "pi_memory")!;
    const lore = roots.find((item) => item.id === "lore")!;
    const filtered = filterCuratedExtensions({
      extensions: [
        extension(piMemory.entry, PI_MEMORY_TOOLS),
        extension(lore.entry, LORE_CORE_TOOLS),
        extension("/home/u/.pi/agent/extensions/lore/index.ts", LORE_CORE_TOOLS),
        extension("/project/extensions/unrelated.ts", ["bash", "read"]),
      ],
      errors: [],
      runtime: null,
    }, memoryEnabledPlugins("off"));
    assert.equal(filtered.extensions.length, 1);
    assert.equal(filtered.extensions[0]!.path, "/project/extensions/unrelated.ts");
  });

  it("family matching stays precise: a partial overlap or a foreign tool never matches", () => {
    const enabled = memoryEnabledPlugins("lore");
    const filtered = filterCuratedExtensions({
      extensions: [
        // Only two lore tools — not the required signature.
        extension("/project/extensions/partial.ts", ["lore_search", "lore_get_node"]),
        // Signature tools present, but it also registers a foreign tool.
        extension("/project/extensions/mixed.ts", [...LORE_CORE_TOOLS, "bash"]),
        // A pi-memory-like surface while lore is selected.
        extension("/project/extensions/mem.ts", PI_MEMORY_TOOLS),
      ],
      errors: [],
      runtime: null,
    }, enabled);
    assert.equal(filtered.extensions.length, 3);
  });

  it("load errors of a disabled memory plugin are dropped; unrelated errors stay", () => {
    const piMemory = bundledPluginRoots().find((item) => item.id === "pi_memory")!;
    const filtered = filterCuratedExtensions({
      extensions: [],
      errors: [
        { path: piMemory.entry, error: "pi-memory failed to load" },
        { path: "/project/extensions/broken.ts", error: "boom" },
      ],
      runtime: null,
    }, memoryEnabledPlugins("off"));
    assert.deepEqual(filtered.errors, [{ path: "/project/extensions/broken.ts", error: "boom" }]);
  });

  it("dropBundledMemorySearchTools removes memory_search only from the exact bundled pi-memory registration", () => {
    const piMemory = bundledPluginRoots().find((item) => item.id === "pi_memory")!;
    const result = dropBundledMemorySearchTools({
      extensions: [
        extension(piMemory.entry, PI_MEMORY_TOOLS),
        extension("/project/extensions/other.ts", ["memory_read", "memory_search"]),
      ],
      errors: [],
      runtime: null,
    });
    const bundled = result.extensions.find((item) => item.path === piMemory.entry)!;
    assert.equal(bundled.tools!.has("memory_search"), false);
    assert.equal(bundled.tools!.has("memory_read"), true);
    assert.equal(bundled.tools!.size, PI_MEMORY_TOOLS.length - 1);
    const other = result.extensions.find((item) => item.path === "/project/extensions/other.ts")!;
    assert.equal(other.tools!.has("memory_search"), true);
  });
});

describe("curated override composition (memory provider wiring)", () => {
  async function withAgentDir(settings: Record<string, unknown> | null, run: (agentDir: string, loreHome: string) => Promise<void> | void): Promise<void> {
    const base = await mkdtemp(join(tmpdir(), "pix-curated-memory-"));
    const agentDir = join(base, "agent");
    const loreHome = join(base, "lore");
    await mkdir(agentDir, { recursive: true });
    await mkdir(loreHome, { recursive: true });
    if (settings !== null) {
      await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    }
    try {
      await run(agentDir, loreHome);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  it("reads the memory provider from settings.json per filter run (no pix-builtins file → built-ins all enabled)", async () => {
    const roots = bundledPluginRoots();
    const piMemory = roots.find((item) => item.id === "pi_memory")!;
    const lore = roots.find((item) => item.id === "lore")!;
    await withAgentDir({ pixMemoryProvider: "lore" }, (agentDir) => {
      const override = createCuratedExtensionsOverride(agentDir, { LORE_HOME: loreHome });
      const result = override({
        extensions: [
          extension(piMemory.entry, PI_MEMORY_TOOLS),
          extension(lore.entry, LORE_CORE_TOOLS),
        ],
        errors: [],
        runtime: null,
      });
      assert.equal(result.extensions.length, 1);
      assert.equal(result.extensions[0]!.path, lore.entry);
    });
    await withAgentDir({ pixMemoryProvider: "off" }, (agentDir) => {
      const override = createCuratedExtensionsOverride(agentDir, { LORE_HOME: loreHome });
      const result = override({
        extensions: [
          extension(piMemory.entry, PI_MEMORY_TOOLS),
          extension(lore.entry, LORE_CORE_TOOLS),
        ],
        errors: [],
        runtime: null,
      });
      assert.equal(result.extensions.length, 0);
    });
  });

  it("absent provider with no lore connection keeps the bundled pi-memory (default local) with memory_search trimmed", async () => {
    const piMemory = bundledPluginRoots().find((item) => item.id === "pi_memory")!;
    await withAgentDir(null, (agentDir) => {
      const override = createCuratedExtensionsOverride(agentDir, { LORE_HOME: loreHome });
      const result = override({
        extensions: [extension(piMemory.entry, PI_MEMORY_TOOLS)],
        errors: [],
        runtime: null,
      });
      assert.equal(result.extensions.length, 1);
      assert.equal(result.extensions[0]!.tools!.has("memory_search"), false);
    });
  });

  it("an absent provider with a configured lore connection (env) defaults to lore — existing Lore users are never switched to local memory", async () => {
    const roots = bundledPluginRoots();
    const piMemory = roots.find((item) => item.id === "pi_memory")!;
    const lore = roots.find((item) => item.id === "lore")!;
    await withAgentDir(null, (agentDir) => {
      const override = createCuratedExtensionsOverride(agentDir, {
        LORE_BASE_URL: "https://core.example",
        LORE_API_TOKEN: "lm_t",
      });
      const result = override({
        extensions: [
          extension(piMemory.entry, PI_MEMORY_TOOLS),
          extension(lore.entry, LORE_CORE_TOOLS),
        ],
        errors: [],
        runtime: null,
      });
      assert.equal(result.extensions.length, 1);
      assert.equal(result.extensions[0]!.path, lore.entry);
    });
  });
});
