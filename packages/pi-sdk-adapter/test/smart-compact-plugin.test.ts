/**
 * Real-SDK load test for the BUNDLED pi-smart-compact curated plugin.
 *
 * Proves through the real composition seam (createAgentSessionServices +
 * resourceLoaderOptionsForBuiltIns) that the vendored 10.3.0 tarball:
 *  - loads in plain Node WITHOUT the optional peers (@oh-my-pi/pi-mnemopi,
 *    @resvg/resvg-js, bun are absent from this repo);
 *  - registers its exact tool/command surface (smart_compact +
 *    smart-compact command);
 *  - is detected as the loaded `smart_compact` built-in;
 *  - is fully removed when the capability is disabled in pix-builtins.json.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resourceLoaderOptionsForBuiltIns } from "../src/internal/curated-plugins.js";
import { detectLoadedBuiltIns } from "../src/internal/built-in-detection.js";

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "pix-smart-compact-load-"));
  await chmod(agentDir, 0o700);
  // Deterministic memory provider: a machine with an existing Lore connection
  // must not default these loads to the networked Lore extension.
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ pixMemoryProvider: "local" }, null, 2)}\n`);
  try {
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function loadExtensions(agentDir: string) {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const services = await (await import("@earendil-works/pi-coding-agent")).createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
    modelRuntime,
    resourceLoaderOptions: resourceLoaderOptionsForBuiltIns(agentDir),
  });
  const result = services.resourceLoader.getExtensions();
  const extensions = result.extensions;
  const tools = new Set<string>();
  const commands = new Set<string>();
  for (const extension of extensions) {
    for (const name of extension.tools.keys()) tools.add(name);
    for (const name of extension.commands.keys()) commands.add(name);
  }
  return { extensions, tools, commands };
}

describe("bundled pi-smart-compact plugin (real SDK load)", () => {
  it("loads without the optional peers and registers the smart_compact surface", async () => {
    await withTempAgentDir(async (agentDir) => {
      // No optional peers are installed in this repo; the import itself is
      // the proof that none are required at load time.
      const { extensions, tools, commands } = await loadExtensions(agentDir);
      assert.ok(tools.has("smart_compact"), `smart_compact tool must register; tools=[${[...tools].join(",")}]`);
      assert.ok(commands.has("smart-compact"), "smart-compact command must register");
      assert.ok(detectLoadedBuiltIns({
        tools: [...tools].map((name) => ({ name })),
        commands: [...commands].map((name) => ({ name })),
      }).has("smart_compact"));
      // Sanity: the other curated plugins still load alongside it.
      assert.ok(tools.has("todo"));
      assert.ok(extensions.length >= 3, `expected the curated set to load, got ${extensions.length}`);
    });
  });

  it("disabling the smart_compact capability removes the plugin entirely", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeFile(join(agentDir, "pix-builtins.json"), `${JSON.stringify({
        version: 1,
        subagents: true,
        todo: true,
        ask_user_question: true,
        side_chat: true,
        smart_compact: false,
      }, null, 2)}\n`, { mode: 0o600 });
      const { tools, commands } = await loadExtensions(agentDir);
      assert.equal(tools.has("smart_compact"), false);
      assert.equal(tools.has("smart_recall"), false);
      assert.equal(commands.has("smart-compact"), false);
      // The rest of the curated set is untouched.
      assert.ok(tools.has("todo"));
    });
  });
});
