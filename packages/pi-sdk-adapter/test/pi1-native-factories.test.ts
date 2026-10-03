import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  hasSdkContinuation,
  nativeBuiltinExtensionFactories,
  SdkRuntimeDriverFactory,
  type SdkRuntimeComposition,
} from "../src/internal/sdk-runtime.js";
import type { RuntimeEvent } from "@fffattiger/pix-runtime-core";

/**
 * Deterministic real-SDK (no network) coverage of the Pi 1.0 native built-in
 * extension assembly: codemode/tool_search registration + defaultTools
 * activation, `-builtin:mcp` disable, replaceable single-MCP-authority,
 * `/mcp` handled disposition (no assistant turn, typed notification — never
 * an extension error), forced-empty tool policy surviving MCP startup,
 * trusted/untrusted project mcp.json reads, and reload idempotency.
 */

let priorAgentDir: string | undefined;

before(() => {
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
});

after(() => {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
});

interface Harness {
  driver: Awaited<ReturnType<SdkRuntimeDriverFactory["create"]>>;
  emitted: RuntimeEvent[];
  root: string;
  close(): Promise<void>;
}

async function buildHarness(options: {
  settings?: Record<string, unknown>;
  projectTrusted?: boolean;
  toolNames?: string[];
  cwdFiles?: Record<string, string>;
  agentDirFiles?: Record<string, string>;
  agentDirOverride?: string;
  extraFactories?: import("@earendil-works/pi-coding-agent").InlineExtension[];
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pix-pi1-factories-"));
  const cwd = join(root, "cwd");
  const agentDir = options.agentDirOverride ?? join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  for (const [path, content] of Object.entries(options.cwdFiles ?? {})) {
    const target = join(cwd, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  for (const [path, content] of Object.entries(options.agentDirFiles ?? {})) {
    await writeFile(join(agentDir, path), content, "utf8");
  }
  if (options.agentDirOverride === undefined) await mkdir(agentDir, { recursive: true, mode: 0o700 });
  // Isolate every getAgentDir() consumer (MCP config read included) from the
  // real user config on this machine.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const manager = SessionManager.inMemory(cwd);
  const settings = SettingsManager.inMemory(options.settings ?? {}, { projectTrusted: options.projectTrusted ?? false });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const composition: SdkRuntimeComposition = {
    async openSession(input) {
      assert.ok("cwd" in input);
      return { manager, cwd };
    },
    initializeTheme() {},
    createServices: (sessionCwd, _trusted, toolPolicy = { forcedEmpty: false }) => createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager: settings,
      modelRuntime,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          ...(options.extraFactories ?? []),
          ...nativeBuiltinExtensionFactories(),
          // Order matters only for the replaceable test: the tool policy
          // extension is not replaceable and never conflicts.
          (pi) => {
            pi.on("before_agent_start", () => toolPolicy.forcedEmpty ? { systemPrompt: "" } : undefined);
          },
        ],
      },
    }),
    resolveProjectTrust: async () => options.projectTrusted ?? false,
    prepareExtensionMode: async () => {},
    listVisibleModels: (services) => services.modelRuntime.getModels(),
    getDefaults: () => ({}),
    hasContinuation: (sessionManager) => hasSdkContinuation(sessionManager),
    createSession: (sessionOptions) => createAgentSessionFromServices(sessionOptions),
  };
  const factory = new SdkRuntimeDriverFactory(undefined, composition);
  const driver = await factory.create(
    {
      cwd,
      ...(options.toolNames === undefined ? {} : { toolNames: options.toolNames }),
      thinkingLevel: "off",
      thinkingLevelPinned: true,
    },
    {},
  );
  const emitted: RuntimeEvent[] = [];
  await driver.bindUi(() => {}, (event) => { emitted.push(event as RuntimeEvent); });
  return {
    driver,
    emitted,
    root,
    close: async () => {
      await driver.close("user");
      await rm(root, { recursive: true, force: true });
    },
  };
}

function toolState(h: Harness, name: string): { present: boolean; active: boolean } {
  const tool = h.driver.getState().tools.find((item) => item.name === name);
  return { present: tool !== undefined, active: tool?.active === true };
}

describe("Pi 1.0 native built-in extension assembly", () => {
  it("defaults to ALL tools (codemode/tool_search included) with no settings keys", async () => {
    const h = await buildHarness({});
    try {
      // User requirement: the Pix default selection is ALL selectable tools
      // (was: ordinary coding tools only). codemode/tool_search register with
      // defaultActive:false and only the selection turns them on.
      assert.equal(toolState(h, "codemode").active, true, "codemode active under the default all selection");
      assert.equal(toolState(h, "tool_search").active, true, "tool_search active under the default all selection");
      for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
        assert.equal(toolState(h, name).active, true, `${name} stays active`);
      }
      assert.equal(h.driver.getState().commands!.some((command) => command.name === "mcp"), true, "/mcp command registered");
    } finally {
      await h.close();
    }
  });

  it("activates codemode only through the defaultTools setting", async () => {
    const h = await buildHarness({ settings: { defaultTools: ["+codemode"] } });
    try {
      assert.equal(toolState(h, "codemode").active, true, "defaultTools +codemode activates codemode");
      assert.equal(toolState(h, "tool_search").active, false, "tool_search remains inactive");
    } finally {
      await h.close();
    }
  });

  it("honors a native defaultTools '-name' entry instead of force-re-enabling it", async () => {
    const h = await buildHarness({ settings: { defaultTools: ["-read"] } });
    try {
      assert.equal(toolState(h, "read").active, false, "native -read stays disabled (no builtin union overwrite)");
      assert.equal(toolState(h, "bash").active, true, "native default base tools stay active");
      assert.equal(toolState(h, "codemode").active, false, "native selection adds nothing on top");
    } finally {
      await h.close();
    }
  });

  it("respects the settings extensions '-builtin:mcp' disable without touching codemode", async () => {
    const h = await buildHarness({ settings: { extensions: ["-builtin:mcp"] } });
    try {
      assert.equal(h.driver.getState().commands!.some((command) => command.name === "mcp"), false, "/mcp command gone");
      assert.equal(toolState(h, "codemode").present, true, "codemode unaffected");
    } finally {
      await h.close();
    }
  });

  it("lets a user /mcp extension replace the builtin (single MCP authority)", async () => {
    const h = await buildHarness({
      extraFactories: [{
        name: "custom-mcp",
        factory: (pi) => {
          pi.registerCommand("mcp", {
            description: "custom MCP replacement",
            handler: async (_args, ctx) => {
              ctx.ui.notify("custom mcp authority active", "info");
            },
          });
        },
      }],
    });
    try {
      const mcpCommands = h.driver.getState().commands!.filter((command) => command.name === "mcp");
      assert.equal(mcpCommands.length, 1, "exactly one /mcp command");
      const receipt = await h.driver.prompt("/mcp");
      assert.equal(receipt.disposition, "handled");
      const notifications = h.emitted.filter((event) => event.type === "extension_notification");
      assert.equal(notifications.some((event) => event.type === "extension_notification" && event.message.includes("custom mcp authority active")), true, "custom handler ran and notified");
    } finally {
      await h.close();
    }
  });

  it("handles /mcp status as a typed notification without an assistant turn or a fake error", async () => {
    const h = await buildHarness({});
    const messagesBefore = h.driver.getState().messageCount;
    try {
      const receipt = await h.driver.prompt("/mcp");
      assert.equal(receipt.disposition, "handled", "/mcp consumed by the extension command");
      assert.equal(h.driver.getState().messageCount, messagesBefore, "no transcript entries appended");
      const notifications = h.emitted.filter((event) => event.type === "extension_notification");
      assert.equal(notifications.length > 0, true, "status text surfaced as a notification");
      assert.equal(
        notifications.some((event) => event.type === "extension_notification" && event.message.includes("No MCP servers configured")),
        true,
        "the /mcp status text is the visible payload",
      );
      assert.equal(notifications.every((event) => event.type !== "extension_notification" || event.level === "info"), true, "level info, not an error");
      assert.equal(h.emitted.some((event) => event.type === "extension_error"), false, "no fake extension_error for an informational status");
    } finally {
      await h.close();
    }
  });

  it("keeps the forced-empty tool policy strictly empty even with the MCP builtin active", async () => {
    const h = await buildHarness({ toolNames: [] });
    try {
      const active = h.driver.getState().tools.filter((tool) => tool.active);
      assert.equal(active.length, 0, "no tool is active under the strict empty policy");
      assert.equal(h.driver.getState().systemPrompt, "", "forced empty system prompt holds");
      const receipt = await h.driver.prompt("/mcp");
      assert.equal(receipt.disposition, "handled");
      assert.equal(h.driver.getState().tools.filter((tool) => tool.active).length, 0, "MCP startup/discovery re-enabled nothing");
    } finally {
      await h.close();
    }
  });

  it("reads the trusted project .pi/mcp.json and reports its config errors; untrusted projects are not read", async () => {
    const invalidProjectMcp = JSON.stringify({ mcpServers: { "bad name": { command: "echo" } } });
    const trusted = await buildHarness({
      projectTrusted: true,
      cwdFiles: { ".pi/mcp.json": invalidProjectMcp },
    });
    try {
      const receipt = await trusted.driver.prompt("/mcp");
      assert.equal(receipt.disposition, "handled");
      const notifications = trusted.emitted.filter((event) => event.type === "extension_notification");
      assert.equal(
        notifications.some((event) => event.type === "extension_notification" && event.message.includes("config error")),
        true,
        "invalid trusted project entry is reported as a real config error in the status",
      );
    } finally {
      await trusted.close();
    }
    const untrusted = await buildHarness({
      projectTrusted: false,
      cwdFiles: { ".pi/mcp.json": invalidProjectMcp },
    });
    try {
      const receipt = await untrusted.driver.prompt("/mcp");
      assert.equal(receipt.disposition, "handled");
      const statusText = untrusted.emitted
        .filter((event) => event.type === "extension_notification")
        .map((event) => event.type === "extension_notification" ? event.message : "")
        .join("\n");
      assert.equal(statusText.includes("No MCP servers configured"), true, "untrusted project file not read");
      assert.equal(statusText.includes("bad name"), false, "no project entry leaked into an untrusted session");
    } finally {
      await untrusted.close();
    }
  });

  it("reload is idempotent for the native activation semantics", async () => {
    const h = await buildHarness({});
    try {
      await h.driver.reload();
      // Default selection is all: codemode stays on after reload too.
      assert.equal(toolState(h, "codemode").active, true, "codemode stays active after reload (default all)");
      for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
        assert.equal(toolState(h, name).active, true, `${name} stays active after reload`);
      }
      const mcpCommands = h.driver.getState().commands!.filter((command) => command.name === "mcp");
      assert.equal(mcpCommands.length, 1, "still exactly one /mcp after reload");
      await h.driver.reload();
      assert.equal(h.driver.getState().commands!.filter((command) => command.name === "mcp").length, 1, "second reload stays single-authority");
    } finally {
      await h.close();
    }
  });
});

describe("Pi 1.0 global tool selection (pixDefaultTools)", () => {
  it("pixDefaultTools null keeps the default-all behavior", async () => {
    const h = await buildHarness({ agentDirFiles: { "settings.json": JSON.stringify({ pixDefaultTools: null }) } });
    try {
      assert.equal(toolState(h, "codemode").active, true, "explicit all enables codemode");
      assert.equal(toolState(h, "read").active, true);
    } finally {
      await h.close();
    }
  });

  it("pixDefaultTools [] disables everything but keeps the registry re-enableable", async () => {
    const h = await buildHarness({ agentDirFiles: { "settings.json": JSON.stringify({ pixDefaultTools: [] }) } });
    try {
      assert.equal(h.driver.getState().tools.filter((tool) => tool.active).length, 0, "no tool active under none");
      assert.equal(h.driver.getState().systemPrompt, "", "forced empty system prompt under none");
      assert.equal(h.driver.getState().tools.some((tool) => tool.name === "read"), true, "registry still lists tools");
      await h.driver.setTools(["read"], false);
      assert.equal(toolState(h, "read").active, true, "re-enabling works after none");
      assert.notEqual(h.driver.getState().systemPrompt, "", "system prompt restored on re-enable");
    } finally {
      await h.close();
    }
  });

  it("pixDefaultTools allowlist disables unlisted extension tools without touching the others", async () => {
    const h = await buildHarness({ agentDirFiles: { "settings.json": JSON.stringify({ pixDefaultTools: ["read", "bash"] }) } });
    try {
      assert.equal(toolState(h, "read").active, true);
      assert.equal(toolState(h, "bash").active, true);
      assert.equal(toolState(h, "edit").active, false, "unlisted builtin off");
      assert.equal(toolState(h, "codemode").active, false, "unlisted native factory off");
      assert.equal(toolState(h, "tool_search").active, false, "unlisted native factory off");
    } finally {
      await h.close();
    }
  });

  it("saved names that are currently unknown persist through apply and simply do not apply", async () => {
    const h = await buildHarness({
      agentDirFiles: { "settings.json": JSON.stringify({ pixDefaultTools: ["read", "totally-unknown-tool"] }) },
    });
    try {
      assert.equal(toolState(h, "read").active, true, "known saved name applies");
      assert.equal(h.driver.getState().tools.some((tool) => tool.name === "totally-unknown-tool"), false, "unknown name not fabricated");
      await h.driver.reload();
      assert.equal(toolState(h, "read").active, true, "unknown name survives a reload without breaking the rest");
    } finally {
      await h.close();
    }
  });

  it("saving a new selection and reloading applies it to the same runtime; a new runtime picks it up", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-pi1-tools-save-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const store = (await import("../src/internal/settings-config-store.js")).createPiSdkSettingsConfigStore({ agentDir });
      const before = await store.readToolsConfig();
      assert.deepEqual(before.selection, { mode: "all" }, "missing file means all");
      await store.writeToolsConfig({ expectedRevision: before.revision, toolNames: ["read"] });

      const h = await buildHarness({ agentDirOverride: agentDir });
      try {
        assert.equal(toolState(h, "read").active, true, "saved custom name active in a NEW runtime");
        assert.equal(toolState(h, "bash").active, false, "unsaved name inactive in a new runtime");
        const after = await store.readToolsConfig();
        assert.deepEqual(after.selection, { mode: "custom", toolNames: ["read"] });

        // Save a different selection and reload the SAME runtime: the fresh
        // preference is recomputed (prefs-following runtimes recalculate).
        await store.writeToolsConfig({ expectedRevision: after.revision, toolNames: ["bash"] });
        await h.driver.reload();
        assert.equal(toolState(h, "bash").active, true, "newly saved name active after reload");
        assert.equal(toolState(h, "read").active, false, "removed name inactive after reload");
      } finally {
        await h.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("an explicit runtime setTools override survives reload (no prefs recompute)", async () => {
    const h = await buildHarness({});
    try {
      await h.driver.setTools(["read"], false);
      await h.driver.reload();
      assert.equal(toolState(h, "read").active, true, "explicit override reapplied after reload");
      assert.equal(toolState(h, "bash").active, false, "override still excludes bash");
    } finally {
      await h.close();
    }
  });
});
