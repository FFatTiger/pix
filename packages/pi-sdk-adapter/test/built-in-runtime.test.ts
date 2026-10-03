import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import { readSubagentProjection } from "../src/internal/subagent-projection.js";
import { SdkRuntimeDriverFactory, type SdkRuntimeComposition } from "../src/internal/sdk-runtime.js";
import type { DriverEventListener, DriverState, PiRuntimeDriver } from "../src/internal/types.js";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";

function driverState(patch: Partial<DriverState> = {}): DriverState {
  return {
    model: null,
    thinkingLevel: "off",
    systemPrompt: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    pendingMessageCount: 0,
    messageCount: 0,
    tools: [],
    steering: [],
    followUp: [],
    ...patch,
  };
}

function makeDriver(initial: DriverState, reloadCaps?: readonly string[]) {
  let state = initial;
  const listeners = new Set<DriverEventListener>();
  const driver: PiRuntimeDriver = {
    identity: { sessionId: "built-ins", sessionFile: "/tmp/built-ins.jsonl", cwd: "/workspace" },
    capabilities: RUNTIME_CAPABILITIES.filter((token) => token !== "runtime.side_chat" && token !== "runtime.subagents"),
    getState: () => structuredClone(state),
    getTools: () => state.tools,
    getCommands: () => state.commands ?? [],
    getSessionStats: () => state.sessionStats,
    getLastAssistantText: () => state.lastAssistantText ?? "",
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prompt: async () => ({ disposition: "started" as const }),
    steer: async () => "queued" as const,
    followUp: async () => "queued" as const,
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    compact: async () => {},
    abortCompaction: () => {},
    setSessionName: () => {},
    setAutoCompaction: () => {},
    setAutoRetry: () => {},
    clearQueue: () => {},
    setTools: () => {},
    reload: async () => {
      state = {
        ...state,
        builtIns: {
          configRevision: "b".repeat(64),
          loaded: ["todo"],
          failures: [{ id: "side_chat", code: "incompatible" }],
        },
        todo: { revision: 1, items: [{ id: 1, subject: "after reload", blockedBy: [], status: "pending" }] },
        subagents: { revision: 0, tasks: [] },
      };
      return (reloadCaps ?? ["runtime.prompt", "runtime.reload", "runtime.todo"]) as typeof RUNTIME_CAPABILITIES[number][];
    },
    resolveLeafEntry: () => undefined,
    bash: async () => ({ output: "" }),
    abortBash: () => {},
    navigate: async () => {},
    fork: async () => ({ sessionId: "x", sessionFile: "y" }),
    generateSessionTitle: async () => "t",
    bindUi: async () => {},
    close: async () => {},
  };
  return {
    driver,
    emit(event: unknown) { for (const listener of listeners) listener(event); },
    setState(next: DriverState) { state = next; },
  };
}

describe("adapter built-in snapshot and synthetic events", () => {
  it("clones snapshot projections and forwards full-replacement events", async () => {
    const builtIns = { configRevision: "a".repeat(64), loaded: ["todo"] as const, failures: [{ id: "side_chat" as const, code: "incompatible" as const }] };
    const todo = { revision: 1, items: [{ id: 1, subject: "ship", blockedBy: [] as number[], status: "pending" as const }] };
    const { driver, emit } = makeDriver(driverState({ builtIns, todo }));
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const events: unknown[] = [];
    adapter.subscribe((event) => events.push(event));
    const snap = await adapter.getSnapshot();
    assert.deepEqual(snap.state.builtIns, builtIns);
    assert.notEqual(snap.state.builtIns, builtIns);
    assert.notEqual(snap.state.todo, todo);
    emit({ type: "todo_changed", todo: { revision: 2, items: [{ id: 1, subject: "ship", blockedBy: [], status: "completed" }] } });
    emit({ type: "subagents_changed", subagents: { revision: 1, tasks: [{ taskId: "t1", description: "scan", agentType: "explore", status: "running" }] } });
    emit({ type: "built_ins_changed", builtIns: { configRevision: "c".repeat(64), loaded: ["todo"], failures: [] } });
    const types = events.map((event) => (event as { type: string }).type);
    assert.ok(types.includes("todo_changed"));
    assert.ok(types.includes("subagents_changed"));
    assert.ok(types.includes("built_ins_changed"));
    const todoEvent = events.find((event) => (event as { type: string }).type === "todo_changed") as { todo: { items: { status: string }[] } };
    assert.equal(todoEvent.todo.items[0]?.status, "completed");
    await adapter.close("user");
  });

  it("reload returns the recomputed capability set and builtIns snapshot", async () => {
    const { driver } = makeDriver(driverState({
      builtIns: { configRevision: "a".repeat(64), loaded: [], failures: [{ id: "side_chat", code: "incompatible" }] },
    }));
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const before = adapter.getCapabilities().version;
    const reload = await adapter.execute({ type: "reload" });
    assert.equal(reload.ok, true);
    assert.ok(adapter.getCapabilities().version > before);
    assert.deepEqual([...adapter.getCapabilities().capabilities], ["runtime.prompt", "runtime.reload", "runtime.todo"]);
    const snap = await adapter.getSnapshot();
    assert.deepEqual(snap.state.builtIns?.loaded, ["todo"]);
    assert.equal(snap.state.todo?.items[0]?.subject, "after reload");
    await adapter.close("user");
  });
});

describe("real SDK curated load vs disable", () => {
  it("disabled config leaves no curated tools/commands; a duplicate path still yields one curated tool set", async () => {
    const { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { resourceLoaderOptionsForBuiltIns } = await import("../src/internal/curated-plugins.js");
    const root = await mkdtemp(join(tmpdir(), "pix-curated-sdk-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeFile(join(agentDir, "pix-builtins.json"), `${JSON.stringify({
      version: 1,
      subagents: false,
      todo: false,
      ask_user_question: false,
      side_chat: true,
    }, null, 2)}\n`, { mode: 0o600 });
    try {
      const settings = SettingsManager.inMemory({}, { projectTrusted: true });
      const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
      });
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: settings,
        modelRuntime,
        resourceLoaderOptions: {
          ...resourceLoaderOptionsForBuiltIns(agentDir),
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
      });
      const names = created.session.getAllTools().map((tool) => tool.name);
      const commands = created.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName);
      assert.equal(names.includes("Agent"), false);
      assert.equal(names.includes("todo"), false);
      assert.equal(names.includes("ask_user_question"), false);
      assert.equal(commands.includes("agents"), false);
      assert.equal(commands.includes("todos"), false);
      created.session.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a configured duplicate of a bundled plugin still yields one curated tool set", async () => {
    const { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { bundledPluginRoots, resourceLoaderOptionsForBuiltIns } = await import("../src/internal/curated-plugins.js");
    const root = await mkdtemp(join(tmpdir(), "pix-curated-dup-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    try {
      const settings = SettingsManager.inMemory({}, { projectTrusted: true });
      const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
      });
      const todoRoot = bundledPluginRoots().find((item) => item.id === "todo")!.root;
      const loader = resourceLoaderOptionsForBuiltIns(agentDir);
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: settings,
        modelRuntime,
        resourceLoaderOptions: {
          ...loader,
          additionalExtensionPaths: [...loader.additionalExtensionPaths, todoRoot, todoRoot],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
      });
      const names = created.session.getAllTools().map((tool) => tool.name).filter((name) => name === "todo");
      assert.deepEqual(names, ["todo"]);
      created.session.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("real driver listener ordering", { concurrency: false }, () => {
  it("uses one SDK subscription and fans the causal raw event to every listener before subagent projection", async () => {
    const {
      createAgentSessionFromServices,
      createAgentSessionServices,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { bundledPluginRoots } = await import("../src/internal/curated-plugins.js");
    const root = await mkdtemp(join(tmpdir(), "pix-driver-listeners-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    let driver: Awaited<ReturnType<SdkRuntimeDriverFactory["create"]>> | undefined;
    try {
      const sessionsDir = join(agentDir, "sessions", "project");
      const manager = SessionManager.create(cwd, sessionsDir, { id: "listener-parent" });
      manager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
      manager.appendMessage(fauxAssistantMessage("parent ready"));
      const parentSessionFile = manager.getSessionFile();
      assert.ok(parentSessionFile);
      const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, authPath: join(agentDir, "auth.json"), modelsPath: null });
      const sdkListeners = new Set<(event: unknown) => void>();
      let sdkSubscriptions = 0;
      const composition: SdkRuntimeComposition = {
        openSession: async () => ({ manager, cwd }),
        initializeTheme: () => {},
        createServices: () => createAgentSessionServices({
          cwd,
          agentDir,
          settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
          modelRuntime,
          resourceLoaderOptions: {
            additionalExtensionPaths: [bundledPluginRoots().find((item) => item.id === "subagents")!.root],
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
        hasContinuation: () => false,
        createSession: async (options) => {
          const result = await createAgentSessionFromServices(options);
          result.session.subscribe = ((listener: (event: never, signal: AbortSignal) => void) => {
            sdkSubscriptions += 1;
            const invoke = (event: unknown) => listener(event as never, new AbortController().signal);
            sdkListeners.add(invoke);
            return () => { sdkListeners.delete(invoke); };
          }) as typeof result.session.subscribe;
          return result;
        },
      };
      driver = await new SdkRuntimeDriverFactory(undefined, composition).create({ cwd }, {});
      const taskDir = join(agentDir, "pi-claude-subagents", "listener-parent", "task-1");
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, "task.json"), JSON.stringify({
        id: "task-1",
        parentSessionId: "listener-parent",
        description: "causal ordering",
        agent: "explore",
        status: "running",
      }));

      const order: string[] = [];
      const projections: Array<{ revision: number; tasks: Array<{ childSessionId?: string; status: string }> }> = [];
      driver.subscribe((event) => {
        const typed = event as { type: string; subagents?: { revision: number; tasks: Array<{ childSessionId?: string; status: string }> } };
        order.push(`A:${typed.type}`);
        // Snapshot reads are allowed from a subscriber, including inside raw
        // fanout and projection delivery; neither may reorder B's events.
        driver!.getState();
        if (typed.type === "subagents_changed" && typed.subagents !== undefined) projections.push(structuredClone(typed.subagents));
      });
      driver.subscribe((event) => order.push(`B:${(event as { type: string }).type}`));
      assert.equal(sdkSubscriptions, 1, "driver owns exactly one SDK subscription");
      const emitRaw = (event: unknown): void => {
        for (const listener of [...sdkListeners]) listener(event);
      };
      const raw = { type: "tool_execution_start", toolCallId: "call-1", toolName: "Agent", args: {} };
      emitRaw(raw);
      assert.deepEqual(order, [
        "A:tool_execution_start",
        "B:tool_execution_start",
        "A:subagents_changed",
        "B:subagents_changed",
      ]);

      // Existing real-plugin tests prove the native running row is persisted
      // before a background Agent tool returns. From that post-return point,
      // use a controlled filesystem producer to isolate driver/observer delivery
      // of child identity and committed child transcript revisions.
      emitRaw({ type: "tool_execution_end", toolCallId: "call-1", toolName: "Agent", result: {}, isError: false });
      const childFile = join(sessionsDir, "child.jsonl");
      await writeFile(childFile, `${JSON.stringify({
        type: "session",
        version: 3,
        id: "child-session",
        timestamp: new Date().toISOString(),
        cwd,
        parentSession: parentSessionFile,
      })}\n`);
      await writeFile(join(taskDir, "task.json"), JSON.stringify({
        id: "task-1",
        parentSessionId: "listener-parent",
        description: "causal ordering",
        agent: "explore",
        status: "running",
        sessionFile: childFile,
      }));
      await waitUntil(() => projections.at(-1)?.tasks[0]?.childSessionId === "child-session", "filesystem-only child identity");
      const identityProjection = projections.at(-1);
      assert.equal(identityProjection?.tasks[0]?.status, "running");
      assert.equal(identityProjection?.tasks[0]?.childSessionId, "child-session");

      await appendFile(childFile, `${JSON.stringify({
        type: "message",
        id: "child-entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "committed child work", timestamp: Date.now() },
      })}\n`);
      await waitUntil(() => (projections.at(-1)?.revision ?? 0) > (identityProjection?.revision ?? 0), "filesystem-only committed child revision");
      assert.equal(order.some((entry) => entry.endsWith(":tool_execution_update")), false);
      assert.ok((projections.at(-1)?.revision ?? 0) > (identityProjection?.revision ?? 0));
    } finally {
      await driver?.close("user");
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("real subagent running-start delivery", { concurrency: false }, () => {
  async function harness(options: { background: boolean; persistenceFailure?: boolean }) {
    const {
      createAgentSessionFromServices,
      createAgentSessionServices,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { bundledPluginRoots } = await import("../src/internal/curated-plugins.js");
    const root = await mkdtemp(join(tmpdir(), "pix-subagent-running-"));
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    const bin = join(root, "bin");
    const gateReached = join(root, "gate-reached");
    const releaseGate = join(root, "release-gate");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), [
      "#!/bin/sh",
      `printf reached > '${gateReached}'`,
      `while [ ! -f '${releaseGate}' ]; do [ -d '${root}' ] || exit 1; sleep 0.01; done`,
      "echo gated-startup-failure >&2",
      "exit 1",
      "",
    ].join("\n"), { mode: 0o755 });
    if (options.persistenceFailure) {
      await writeFile(join(agentDir, "pi-claude-subagents"), "not a directory");
    }

    const faux = fauxProvider({ provider: "pix-faux", models: [{ id: "test" }], tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Agent", {
        description: "held child",
        prompt: "wait at the explicit startup gate",
        subagent_type: "general-purpose",
        run_in_background: options.background,
        isolation: options.persistenceFailure ? "none" : "worktree",
        warning_turns: 40,
        warning_interval_turns: 25,
      })),
      fauxAssistantMessage("parent complete"),
    ]);

    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    const oldPath = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
        modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [bundledPluginRoots().find((item) => item.id === "subagents")!.root],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const model = modelRuntime.getModel("pix-faux", "test");
      assert.ok(model);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        model,
      });
      session = created.session;
      await session.bindExtensions({ mode: "rpc" });
      const events: Array<Record<string, unknown>> = [];
      const projections: ReturnType<typeof readSubagentProjection>[] = [];
      const gateStateAtUpdate: boolean[] = [];
      session.subscribe((event) => {
        if (!event.type.startsWith("tool_execution_")) return;
        events.push(event as unknown as Record<string, unknown>);
        if (event.type === "tool_execution_update" && event.toolName === "Agent") {
          gateStateAtUpdate.push(existsSync(gateReached));
          projections.push(readSubagentProjection({
            agentDir,
            parentSessionId: session!.sessionId,
            parentSessionFile: session!.sessionFile ?? join(root, "parent.jsonl"),
          }));
        }
      });
      return {
        root,
        agentDir,
        gateReached,
        releaseGate,
        session,
        events,
        projections,
        gateStateAtUpdate,
        restore: async () => {
          await writeFile(releaseGate, "go").catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 25));
          session?.dispose();
          if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
          if (oldPath === undefined) delete process.env.PATH;
          else process.env.PATH = oldPath;
          await rm(root, { recursive: true, force: true });
        },
      };
    } catch (error) {
      session?.dispose();
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  it("publishes a readable running row before foreground completion and before background return", async () => {
    for (const background of [false, true]) {
      const test = await harness({ background });
      try {
        let settled = false;
        const prompt = test.session.prompt("launch", { expandPromptTemplates: false }).finally(() => { settled = true; });
        await waitUntil(() => test.projections.length === 1, "Agent running update");
        assert.deepEqual(test.gateStateAtUpdate, [false]);
        await waitUntil(async () => access(test.gateReached).then(() => true, () => false), "child startup gate");
        assert.equal(test.projections[0]?.length, 1);
        assert.equal(test.projections[0]?.[0]?.status, "running");
        const taskFile = join(
          test.agentDir,
          "pi-claude-subagents",
          test.session.sessionId,
          test.projections[0]![0]!.taskId,
          "task.json",
        );
        assert.equal(JSON.parse(await readFile(taskFile, "utf8")).status, "running");
        if (background) {
          await waitUntil(
            () => test.events.some((event) => event.type === "tool_execution_end" && event.toolName === "Agent"),
            "background Agent tool return",
          );
          const agentEvents = test.events.filter((event) => event.toolName === "Agent");
          assert.ok(agentEvents.findIndex((event) => event.type === "tool_execution_update")
            < agentEvents.findIndex((event) => event.type === "tool_execution_end"));
          await access(test.gateReached);
          assert.equal(existsSync(test.releaseGate), false);
          assert.equal(JSON.parse(await readFile(taskFile, "utf8")).status, "running");
        } else {
          assert.equal(settled, false);
        }
        await writeFile(test.releaseGate, "go");
        await prompt;
        const taskRoot = join(test.agentDir, "pi-claude-subagents", test.session.sessionId);
        await waitUntil(async () => (await readdir(taskRoot)).length === 0, "startup-failure cleanup");
        assert.deepEqual(
          test.events.filter((event) => event.toolName === "Agent").map((event) => event.type),
          ["tool_execution_start", "tool_execution_update", "tool_execution_end"],
        );
      } finally {
        await test.restore();
      }
    }
  });

  it("emits no running update when initial persistence fails", async () => {
    const test = await harness({ background: false, persistenceFailure: true });
    try {
      await test.session.prompt("launch", { expandPromptTemplates: false });
      assert.equal(test.projections.length, 0);
      assert.equal(test.events.some((event) => event.type === "tool_execution_update" && event.toolName === "Agent"), false);
    } finally {
      await test.restore();
    }
  });
});
