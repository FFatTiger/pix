import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RUNTIME_CAPABILITIES, type RuntimeState } from "@fffattiger/pix-runtime-core";
import {
  Type,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { CanonicalAgentRuntimeAdapter } from "../src/internal/adapter.js";
import type { PiRuntimeDriver } from "../src/internal/types.js";
import {
  FileActivityTracker,
  SideChatControllerError,
  createSideChatController,
  extractWritePaths,
  forkSurgery,
  type SideChatController,
  type SideChatForkContext,
  type SideChatModelRuntime,
  type SideChatState,
} from "../src/internal/vendor/pi-side-chat/index.js";

const MODEL: Model<Api> = {
  id: "side-chat-fake",
  name: "Side Chat Fake",
  api: "openai-completions",
  provider: "side-chat-test",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
};

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type StreamScript = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

class ScriptedModelRuntime {
  readonly calls: { model: Model<Api>; context: TranscriptContext; options?: SimpleStreamOptions }[] = [];

  constructor(private readonly scripts: StreamScript[]) {}

  streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
    this.calls.push({ model, context, ...(options === undefined ? {} : { options }) });
    const script = this.scripts.shift();
    assert.ok(script, "unexpected provider request");
    return script(model, context, options);
  }
}

class Gate {
  readonly promise: Promise<void>;
  private open!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => { this.open = resolve; });
  }

  release(): void {
    this.open();
  }
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function textStream(text: string, options: { thinking?: string; gate?: Gate; ignoreAbort?: boolean } = {}): StreamScript {
  return (_model, _context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const partial = assistant([], "pending");
      stream.push({ type: "start", partial });
      if (options.thinking !== undefined) {
        const block = { type: "thinking" as const, thinking: "" };
        partial.content.push(block);
        stream.push({ type: "thinking_start", contentIndex: partial.content.length - 1, partial });
        block.thinking = options.thinking;
        stream.push({ type: "thinking_delta", contentIndex: partial.content.length - 1, delta: options.thinking, partial });
        stream.push({ type: "thinking_end", contentIndex: partial.content.length - 1, content: block.thinking, partial });
      }
      const block = { type: "text" as const, text: "" };
      partial.content.push(block);
      const contentIndex = partial.content.length - 1;
      stream.push({ type: "text_start", contentIndex, partial });
      block.text = text;
      stream.push({ type: "text_delta", contentIndex, delta: text, partial });
      if (options.gate !== undefined) await options.gate.promise;
      if (streamOptions?.signal?.aborted && options.ignoreAbort !== true) {
        const aborted = { ...partial, stopReason: "aborted" as const, errorMessage: "aborted" };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        return;
      }
      stream.push({ type: "text_end", contentIndex, content: block.text, partial });
      const done = { ...partial, stopReason: "stop" as const };
      stream.push({ type: "done", reason: "stop", message: done });
    })();
    return stream;
  };
}

function errorStream(errorMessage: string): StreamScript {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const failed = { ...assistant([], "error"), errorMessage };
      stream.push({ type: "error", reason: "error", error: failed });
    });
    return stream;
  };
}

function toolCallStream(name: string, args: Record<string, string | boolean | number>, id = `call-${name}`): StreamScript {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const call = { type: "toolCall" as const, id, name, arguments: args };
      const partial = assistant([call], "pending");
      stream.push({ type: "start", partial });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
      stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
    });
    return stream;
  };
}

function extensionTool(name: string, execute: RegisteredTool["definition"]["execute"]): RegisteredTool {
  return {
    definition: {
      name,
      label: name,
      description: `${name} test tool`,
      parameters: Type.Object({ value: Type.String() }),
      execute,
    },
    sourceInfo: { path: `/test/${name}.ts`, source: name, scope: "temporary", origin: "top-level" },
  };
}

function forkContext(
  manager: SessionManager,
  extensionTools: readonly RegisteredTool[] = [],
): SideChatForkContext {
  return {
    messages: manager.buildSessionContext().messages,
    model: MODEL,
    systemPrompt: "captured system prompt",
    thinkingLevel: "medium",
    cwd: manager.getCwd(),
    extensionTools,
  };
}

function controller(
  manager: SessionManager,
  runtime: SideChatModelRuntime,
  context: SideChatForkContext = forkContext(manager),
  tracker = new FileActivityTracker(),
): SideChatController {
  return createSideChatController({
    forkContext: context,
    modelRuntime: runtime,
    sessionManager: manager,
    createExtensionContext: () => ({ cwd: manager.getCwd(), sessionManager: manager } as unknown as ExtensionContext),
    tracker,
  });
}

async function waitForState(
  target: SideChatController,
  predicate: (state: SideChatState) => boolean,
): Promise<SideChatState> {
  const current = target.getState();
  if (predicate(current)) return current;
  return new Promise<SideChatState>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for side-chat state"));
    }, 2_000);
    const unsubscribe = target.subscribe((event) => {
      if (!predicate(event.state)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event.state);
    });
  });
}

function textOf(messages: readonly AgentMessage[]): string {
  return messages.map((message) => {
    if (message.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    if (message.role === "assistant") {
      return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    if (message.role === "toolResult") {
      return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    }
    return "";
  }).join("\n");
}

function activeToolNames(context: TranscriptContext): string[] {
  const active = new Map<string, boolean>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) active.set(tool.name, true);
    for (const tool of message.toolsRemoved ?? []) active.delete(tool.name);
  }
  return [...active.keys()];
}

function errorCode(error: unknown): string | undefined {
  return error instanceof SideChatControllerError ? error.code : undefined;
}

function adapterDriver(
  manager: SessionManager,
  runtimes: SideChatModelRuntime[],
): PiRuntimeDriver {
  return {
    identity: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() ?? "", cwd: manager.getCwd() },
    capabilities: RUNTIME_CAPABILITIES,
    getState: () => ({
      model: { provider: MODEL.provider, id: MODEL.id },
      thinkingLevel: "medium",
      systemPrompt: "captured system prompt",
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
    }),
    getTools: () => [],
    getCommands: () => [],
    getSessionStats: () => ({ messageCount: 0 }),
    getLastAssistantText: () => "",
    subscribe: () => () => {},
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
    reload: async () => RUNTIME_CAPABILITIES,
    resolveLeafEntry: () => undefined,
    bash: async () => ({ output: "" }),
    abortBash: () => {},
    navigate: async () => {},
    fork: async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl" }),
    generateSessionTitle: async () => "title",
    bindUi: async () => {},
    createSideChatController: (tracker) => {
      const runtime = runtimes.shift();
      assert.ok(runtime, "unexpected side-chat controller creation");
      return controller(manager, runtime, forkContext(manager), tracker);
    },
    close: async () => {},
  };
}

async function waitForAdapterState(
  adapter: CanonicalAgentRuntimeAdapter,
  predicate: (state: NonNullable<RuntimeState["sideChat"]>) => boolean,
): Promise<NonNullable<RuntimeState["sideChat"]>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const sideChat = (await adapter.getSnapshot()).state.sideChat;
    if (sideChat !== null && sideChat !== undefined && predicate(sideChat)) return sideChat;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for canonical side-chat state");
}

describe("vendored pi-side-chat characterization", () => {
  it("repairs a fork cut through a tool sequence and characterizes path tracking", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "parent request", timestamp: 1 },
      assistant([{ type: "toolCall", id: "pending-call", name: "write", arguments: { path: "a.txt", content: "x" } }], "toolUse"),
      { role: "user", content: "queued but not processed", timestamp: 3 },
    ];
    const repaired = forkSurgery(structuredClone(messages), 10);
    assert.deepEqual(repaired.map((message) => message.role), ["assistant", "toolResult"]);
    const result = repaired[1];
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      assert.equal(result.toolCallId, "pending-call");
      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /forked mid-execution/);
    }

    const tracker = new FileActivityTracker();
    tracker.trackWrite("src/../src/a.ts", "/work");
    assert.equal(tracker.hasWritten("src/a.ts", "/work"), true);
    assert.equal(tracker.writeCount, 1);
    assert.deepEqual(
      extractWritePaths("bash", { command: "cat x > 'out one.txt' && cp -- source.txt copy.txt; echo no >/dev/null" }),
      ["out one.txt", "copy.txt"],
    );
  });

  it("makes the captured prompt and fresh side tools authoritative over every copied system message", async () => {
    const manager = SessionManager.inMemory("/workspace", { id: "compacted-parent" });
    const parentTool = {
      name: "main_only",
      description: "must not leak into side chat",
      parameters: Type.Object({}),
    };
    const messages: AgentMessage[] = [
      { role: "system", content: "MAIN LEADING SYSTEM", toolsAdded: [parentTool], timestamp: 1 },
      { role: "compactionSummary", summary: "COMPACTED HISTORY SUMMARY", tokensBefore: 1_000, timestamp: 2 },
      { role: "user", content: "retained parent context", timestamp: 3 },
      { role: "system", content: "MAIN LATER SYSTEM", toolsAdded: [parentTool], timestamp: 4 },
      { role: "branchSummary", summary: "RETURNED BRANCH SUMMARY", fromId: "branch-1", timestamp: 5 },
    ];
    const runtime = new ScriptedModelRuntime([textStream("framed")]);
    const context = forkContext(manager);
    context.messages = messages;
    context.systemPrompt = "CAPTURED EFFECTIVE PROMPT";
    const side = controller(manager, runtime, context);

    const run = side.submit("inspect framing");
    assert.equal((await run.completion).status, "completed");
    const providerContext = runtime.calls[0]!.context;
    const systems = providerContext.messages.filter((message) => message.role === "system");
    assert.equal(systems.length, 1, "copied parent system messages must all be removed");
    const systemText = systems[0]?.role === "system" ? String(systems[0].content) : "";
    assert.match(systemText, /CAPTURED EFFECTIVE PROMPT/);
    assert.match(systemText, /## Side Chat/);
    assert.doesNotMatch(systemText, /MAIN LEADING SYSTEM|MAIN LATER SYSTEM/);
    const toolNames = activeToolNames(providerContext);
    assert.ok(toolNames.includes("read"));
    assert.ok(toolNames.includes("peek_main"));
    assert.equal(toolNames.includes("write"), false, "discussion mode owns a fresh read-only built-in set");
    assert.equal(toolNames.includes("main_only"), false, "main tool declarations must not leak");
    const providerText = textOf(providerContext.messages);
    assert.match(providerText, /COMPACTED HISTORY SUMMARY/);
    assert.match(providerText, /RETURNED BRANCH SUMMARY/);
    assert.match(providerText, /retained parent context/);
    await side.dispose();
  });

  it("streams through the injected runtime with independent IDs, captured context, side-only display, and no parent JSONL writes", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pix-side-chat-context-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manager = SessionManager.create(root, join(root, "sessions"), { id: "parent-session" });
    manager.appendMessage({ role: "user", content: "parent context", timestamp: 1 });
    manager.appendMessage(assistant([{ type: "text", text: "parent answer" }], "stop"));
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const bytesBefore = await readFile(sessionFile);

    const gateA = new Gate();
    const runtimeA = new ScriptedModelRuntime([textStream("side A answer", { thinking: "side A thought", gate: gateA })]);
    const contextA = forkContext(manager);
    contextA.model = { ...MODEL };
    const sideA = controller(manager, runtimeA, contextA);

    contextA.messages.push({ role: "user", content: "late caller mutation", timestamp: 5 });
    contextA.model.id = "changed-after-fork";
    contextA.thinkingLevel = "off";
    contextA.systemPrompt = "late system mutation";
    contextA.cwd = join(root, "changed");

    const admissionA = sideA.submit("side A question");
    assert.equal(sideA.getState().runId, admissionA.runId, "submit admission is synchronous");
    const streaming = await waitForState(sideA, (state) =>
      state.streamingAssistant.text === "side A answer" && state.streamingAssistant.thinking === "side A thought"
    );
    assert.equal(streaming.conversationId, admissionA.conversationId);
    assert.equal(streaming.messages.some((message) => textOf([message]).includes("parent context")), false);
    assert.equal(streaming.messages.some((message) => textOf([message]).includes("side A question")), true);
    gateA.release();
    assert.equal((await admissionA.completion).status, "completed");
    assert.equal(sideA.getState().runId, admissionA.runId, "terminal state retains run identity");

    const runtimeB = new ScriptedModelRuntime([textStream("side B answer")]);
    const sideB = controller(manager, runtimeB);
    const admissionB = sideB.submit("side B question");
    assert.equal((await admissionB.completion).status, "completed");

    assert.notEqual(sideA.getState().conversationId, sideB.getState().conversationId);
    assert.notEqual(sideA.getState().agentSessionId, sideB.getState().agentSessionId);
    assert.notEqual(runtimeA.calls[0]?.options?.sessionId, runtimeB.calls[0]?.options?.sessionId);
    assert.equal(runtimeA.calls[0]?.model.id, MODEL.id, "model is captured at construction");
    assert.equal(runtimeA.calls[0]?.options?.reasoning, "medium", "thinking level is captured at construction");
    assert.match(textOf(runtimeA.calls[0]?.context.messages ?? []), /parent context/);
    assert.doesNotMatch(textOf(runtimeA.calls[0]?.context.messages ?? []), /late caller mutation/);
    const system = runtimeA.calls[0]?.context.messages.find((message) => message.role === "system");
    assert.equal(system?.role, "system");
    if (system?.role === "system") {
      assert.match(typeof system.content === "string" ? system.content : JSON.stringify(system.content), /captured system prompt/);
      assert.doesNotMatch(typeof system.content === "string" ? system.content : JSON.stringify(system.content), /late system mutation/);
    }
    assert.match(textOf(sideA.getState().messages), /side A answer/);
    assert.doesNotMatch(textOf(sideA.getState().messages), /side B/);
    assert.deepEqual(await readFile(sessionFile), bytesBefore, "side conversation must not append parent JSONL");

    await sideA.dispose();
    await sideB.dispose();
  });

  it("round-trips extension and real built-in tools while discussion mode keeps extension permissions", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pix-side-chat-tools-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manager = SessionManager.inMemory(root, { id: "tool-parent" });
    const extensionCalls: { value: string; cwd: string }[] = [];
    const ext = extensionTool("ext_write_like", async (_id, args, _signal, _update, ctx) => {
      const input = args as { value: string };
      extensionCalls.push({ value: input.value, cwd: ctx.cwd });
      return { content: [{ type: "text", text: `extension:${input.value}` }], details: { allowed: true } };
    });
    const runtime = new ScriptedModelRuntime([
      toolCallStream("ext_write_like", { value: "discussion" }),
      textStream("extension done"),
      toolCallStream("write", { path: "built-in.txt", content: "written in edit mode" }),
      textStream("write done"),
    ]);
    const side = controller(manager, runtime, forkContext(manager, [ext]));

    const readOnlyRun = side.submit("use extension");
    assert.equal((await readOnlyRun.completion).status, "completed");
    const readOnlyTools = activeToolNames(runtime.calls[0]!.context);
    assert.ok(readOnlyTools.includes("read"));
    assert.ok(readOnlyTools.includes("ext_write_like"), "extension permission is retained in discussion mode");
    assert.ok(readOnlyTools.includes("peek_main"));
    assert.equal(readOnlyTools.includes("bash"), false);
    assert.equal(readOnlyTools.includes("edit"), false);
    assert.equal(readOnlyTools.includes("write"), false);
    assert.deepEqual(extensionCalls, [{ value: "discussion", cwd: root }]);
    assert.match(textOf(runtime.calls[1]!.context.messages), /extension:discussion/);

    side.setMode("edit");
    const editRun = side.submit("write file");
    assert.equal((await editRun.completion).status, "completed");
    const editTools = activeToolNames(runtime.calls[2]!.context);
    assert.ok(editTools.includes("bash"));
    assert.ok(editTools.includes("edit"));
    assert.ok(editTools.includes("write"));
    assert.ok(editTools.includes("ext_write_like"));
    assert.equal(await readFile(join(root, "built-in.txt"), "utf8"), "written in edit mode");
    assert.equal(side.getState().tools.find((tool) => tool.name === "write")?.status, "completed");
    await side.dispose();
  });

  it("honors Pi 1.0 exposure and MCP read-only declarations in the actual side-chat tool list", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const result = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
    const tools = (["hidden", "codemode", "deferred", "model-only"] as const).map((exposure) => {
      const tool = extensionTool(`exposure_${exposure}`, result);
      tool.definition.exposure = exposure;
      return tool;
    });
    const unknown = extensionTool("mcp_unknown", result);
    unknown.definition.namespace = { name: "mcp__test" };
    const safe = extensionTool("mcp_read", result);
    safe.definition.namespace = { name: "mcp__test" };
    safe.definition.annotations = { readOnlyHint: true };
    const runtime = new ScriptedModelRuntime([textStream("read mode"), textStream("edit mode")]);
    const side = controller(manager, runtime, forkContext(manager, [...tools, unknown, safe]));
    try {
      await side.submit("inspect").completion;
      const readTools = activeToolNames(runtime.calls[0]!.context);
      assert.ok(readTools.includes("mcp_read"));
      assert.equal(readTools.includes("mcp_unknown"), false);
      assert.ok(tools.every((tool) => !readTools.includes(tool.definition.name)));
      side.setMode("edit");
      await side.submit("edit").completion;
      const editTools = activeToolNames(runtime.calls[1]!.context);
      assert.ok(editTools.includes("mcp_unknown"));
      assert.ok(tools.every((tool) => !editTools.includes(tool.definition.name)));
    } finally {
      await side.dispose();
    }
  });

  it("confirms or denies overlap by exact request ID and clears pending confirmation on abort", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pix-side-chat-overlap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const manager = SessionManager.inMemory(root, { id: "overlap-parent" });
    const tracker = new FileActivityTracker();
    tracker.trackWrite("shared.txt", root);
    const runtime = new ScriptedModelRuntime([
      toolCallStream("write", { path: "shared.txt", content: "denied" }, "deny-call"),
      textStream("denied handled"),
      toolCallStream("write", { path: "shared.txt", content: "approved" }, "approve-call"),
      textStream("approved handled"),
      toolCallStream("write", { path: "shared.txt", content: "aborted" }, "abort-call"),
    ]);
    const side = controller(manager, runtime, forkContext(manager), tracker);
    side.setMode("edit");

    const deniedRun = side.submit("deny overlap");
    const deniedState = await waitForState(side, (state) => state.pendingOverlap !== undefined);
    const deniedId = deniedState.pendingOverlap!.requestId;
    assert.throws(() => side.resolveOverlap("stale-request", true), (error) => errorCode(error) === "not_found");
    side.resolveOverlap(deniedId, false);
    assert.equal((await deniedRun.completion).status, "completed");
    await assert.rejects(readFile(join(root, "shared.txt")), { code: "ENOENT" });
    assert.throws(() => side.resolveOverlap(deniedId, true), (error) => errorCode(error) === "not_found");

    const approvedRun = side.submit("approve overlap");
    const approvedState = await waitForState(side, (state) => state.pendingOverlap !== undefined);
    const approvedId = approvedState.pendingOverlap!.requestId;
    assert.notEqual(approvedId, deniedId);
    side.resolveOverlap(approvedId, true);
    assert.equal((await approvedRun.completion).status, "completed");
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "approved");

    const abortedRun = side.submit("abort overlap");
    const abortedState = await waitForState(side, (state) => state.pendingOverlap !== undefined);
    const abortedId = abortedState.pendingOverlap!.requestId;
    await side.abort();
    assert.equal((await abortedRun.completion).status, "aborted");
    assert.equal(side.getState().pendingOverlap, undefined);
    assert.throws(() => side.resolveOverlap(abortedId, true), (error) => errorCode(error) === "not_found");
    assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "approved");
    await Promise.all([side.dispose(), side.dispose()]);
  });

  it("peek_main reads the live main snapshot while the forked conversation stays stable", async () => {
    const manager = SessionManager.inMemory("/workspace", { id: "peek-parent" });
    manager.appendMessage({ role: "user", content: "before fork", timestamp: 1 });
    const runtime = new ScriptedModelRuntime([
      toolCallStream("peek_main", { since_fork: true }, "peek-call"),

      textStream("peek done"),
    ]);
    const side = controller(manager, runtime);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "main after fork" }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE, stopReason: "stop", timestamp: 2 });

    const run = side.submit("what changed?");
    assert.equal((await run.completion).status, "completed");
    const secondRequest = textOf(runtime.calls[1]!.context.messages);
    assert.match(secondRequest, /main after fork/);
    assert.doesNotMatch(secondRequest, /\[User\]: before fork/);
    assert.doesNotMatch(textOf(side.getState().messages), /before fork/);
    await side.dispose();
  });

  it("reports provider failure honestly without exposing its raw error in controller status", async () => {
    const manager = SessionManager.inMemory("/workspace", { id: "failure-parent" });
    const side = controller(manager, new ScriptedModelRuntime([errorStream("secret provider detail")]));
    const run = side.submit("fail");
    assert.equal((await run.completion).status, "failed");
    assert.deepEqual(side.getState().error, { code: "run_failed", message: "Side chat request failed" });
    await side.dispose();
  });

  it("abort quarantines an abort-ignoring provider and settles completion within the bound", async (t) => {
    const manager = SessionManager.inMemory("/workspace", { id: "abort-timeout-parent" });
    const late = new Gate();
    const side = controller(manager, new ScriptedModelRuntime([textStream("late abort text", { gate: late, ignoreAbort: true })]));
    t.after(async () => {
      late.release();
      await side.dispose();
    });
    const revisions: number[] = [];
    side.subscribe((event) => revisions.push(event.revision));
    const run = side.submit("ignore abort");
    await waitForState(side, (state) => state.streamingAssistant.text === "late abort text");

    await side.abort();
    const completion = await Promise.race([
      run.completion,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    assert.notEqual(completion, "pending", "abort must settle the engine-owned completion");
    if (completion !== "pending") assert.equal(completion.status, "aborted");
    assert.equal(side.getState().status, "disposed", "timed-out abort quarantines the controller");
    assert.throws(() => side.submit("must reset first"), (error) => errorCode(error) === "unavailable");

    const count = revisions.length;
    late.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(revisions.length, count, "late provider callbacks are generation-fenced");
  });

  it("serializes reload with side lifecycle commands and withdraws side capability without a live controller", async (t) => {
    const manager = SessionManager.inMemory("/workspace", { id: "adapter-reload-parent" });
    const streamGate = new Gate();
    const reloadGate = new Gate();
    const reloadEntered = new Gate();
    const runtimes = [
      new ScriptedModelRuntime([textStream("old stream", { gate: streamGate })]),
      new ScriptedModelRuntime([textStream("must not start during reload")]),
    ];
    const driver = adapterDriver(manager, runtimes);
    driver.reload = async () => {
      reloadEntered.release();
      await reloadGate.promise;
      return RUNTIME_CAPABILITIES.filter((capability) => capability !== "runtime.side_chat");
    };
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    t.after(async () => {
      streamGate.release();
      reloadGate.release();
      await adapter.close("user");
    });
    await adapter.ready();
    const started = await adapter.execute({ type: "side_chat_start" });
    if (!started.ok || started.type !== "side_chat_start") throw new Error("side chat did not start");
    const conversationId = started.conversationId;
    const sent = await adapter.execute({ type: "side_chat_send", conversationId, message: "hold old controller" });
    assert.equal(sent.ok, true);
    await waitForAdapterState(adapter, (state) => state.status === "running" && state.stream.text === "old stream");

    const reloading = adapter.execute({ type: "reload" });
    for (const command of [
      { type: "side_chat_start" as const },
      { type: "side_chat_send" as const, conversationId, message: "blocked" },
      { type: "side_chat_reset" as const, conversationId, mode: "refork" as const },
      { type: "side_chat_set_mode" as const, conversationId, mode: "edit" as const },
      { type: "side_chat_overlap_response" as const, conversationId, requestId: "overlap", proceed: false },
    ]) {
      const result = await adapter.execute(command);
      assert.equal(result.ok, false, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.code, "session_busy");
    }
    const interrupt = await adapter.interrupt({ type: "abort_side_chat", conversationId });
    assert.equal(interrupt.ok, false, "interrupt bypasses the lifecycle guard and observes disposed authority");
    if (!interrupt.ok) assert.equal(interrupt.error.code, "not_found");

    streamGate.release();
    await reloadEntered.promise;
    assert.equal(runtimes.length, 1, "no controller was created in the reload gap");
    reloadGate.release();
    const reloaded = await reloading;
    assert.deepEqual(reloaded, { ok: true, type: "reload" });
    const snapshot = await adapter.getSnapshot();
    assert.equal(snapshot.capabilities.capabilities.includes("runtime.side_chat"), false);
    assert.equal(snapshot.state.sideChat, null);
    const unavailable = await adapter.execute({ type: "side_chat_start" });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error.code, "unsupported_capability");
    assert.equal(runtimes.length, 1);
  });

  it("allows close to settle during a gated reload and returns a structured reload failure", async () => {
    const manager = SessionManager.inMemory("/workspace", { id: "adapter-reload-close-parent" });
    const reloadGate = new Gate();
    const reloadEntered = new Gate();
    const driver = adapterDriver(manager, [new ScriptedModelRuntime([])]);
    driver.reload = async () => {
      reloadEntered.release();
      await reloadGate.promise;
      return RUNTIME_CAPABILITIES;
    };
    const adapter = new CanonicalAgentRuntimeAdapter(driver);
    await adapter.ready();
    const started = await adapter.execute({ type: "side_chat_start" });
    assert.equal(started.ok, true);
    const reloading = adapter.execute({ type: "reload" });
    await reloadEntered.promise;
    await adapter.close("user");
    reloadGate.release();
    const result = await reloading;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.type, "reload");
      assert.equal(result.error.code, "unavailable");
    }
  });

  it("adapter exposes forced-abort failure honestly and reset restores a usable new conversation", async (t) => {
    const manager = SessionManager.inMemory("/workspace", { id: "adapter-abort-parent" });
    const late = new Gate();
    const adapter = new CanonicalAgentRuntimeAdapter(adapterDriver(manager, [
      new ScriptedModelRuntime([
        textStream("committed answer"),
        textStream("stuck partial", { gate: late, ignoreAbort: true }),
      ]),
      new ScriptedModelRuntime([textStream("recovered answer")]),
    ]));
    t.after(async () => {
      late.release();
      await adapter.close("user");
    });
    await adapter.ready();
    const started = await adapter.execute({ type: "side_chat_start" });
    assert.equal(started.ok, true);
    if (!started.ok || started.type !== "side_chat_start") throw new Error("side chat did not start");
    const oldConversationId = started.conversationId;
    const committed = await adapter.execute({ type: "side_chat_send", conversationId: oldConversationId, message: "committed question" });
    assert.equal(committed.ok, true);
    await waitForAdapterState(adapter, (state) => state.status === "idle" && state.messages.some((message) => message.text.includes("committed answer")));
    const sent = await adapter.execute({ type: "side_chat_send", conversationId: oldConversationId, message: "stuck question" });
    assert.equal(sent.ok, true);
    await waitForAdapterState(adapter, (state) => state.stream.text === "stuck partial");

    const aborted = await adapter.interrupt({ type: "abort_side_chat", conversationId: oldConversationId });
    assert.equal(aborted.ok, true, "logical abort succeeds by quarantining the failed controller");
    const quarantined = await waitForAdapterState(adapter, (state) => state.status === "idle" && state.error !== undefined);
    assert.equal(quarantined.conversationId, oldConversationId);
    assert.deepEqual(quarantined.error, { code: "run_failed", message: "Side chat request failed" });
    const retainedText = quarantined.messages.map((message) => message.text).join("\n");
    assert.match(retainedText, /committed question/);
    assert.match(retainedText, /committed answer/);
    assert.match(retainedText, /stuck question/, "committed side history is retained");

    const reused = await adapter.execute({ type: "side_chat_send", conversationId: oldConversationId, message: "must fail" });
    assert.equal(reused.ok, false);
    if (!reused.ok) assert.equal(reused.error.code, "unavailable");

    const reset = await adapter.execute({ type: "side_chat_reset", conversationId: oldConversationId, mode: "refork" });
    assert.equal(reset.ok, true);
    if (!reset.ok || reset.type !== "side_chat_reset") throw new Error("side chat did not reset");
    assert.notEqual(reset.conversationId, oldConversationId);
    const stale = await adapter.execute({ type: "side_chat_send", conversationId: oldConversationId, message: "stale" });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "not_found");
    const recovered = await adapter.execute({ type: "side_chat_send", conversationId: reset.conversationId, message: "fresh question" });
    assert.equal(recovered.ok, true);
    const recoveredState = await waitForAdapterState(adapter, (state) => state.conversationId === reset.conversationId && state.status === "idle" && state.messages.some((message) => message.text.includes("recovered answer")));
    assert.equal(recoveredState.error, undefined);

    late.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await adapter.getSnapshot()).state.sideChat?.conversationId, reset.conversationId, "late old-run callbacks cannot replace reset authority");
  });

  it("dispose is bounded/idempotent, settles the run, and drops late provider callbacks by generation", async () => {
    const manager = SessionManager.inMemory("/workspace", { id: "dispose-parent" });
    const late = new Gate();
    const runtime = new ScriptedModelRuntime([textStream("late text", { gate: late, ignoreAbort: true })]);
    const side = controller(manager, runtime);
    const events: number[] = [];
    side.subscribe((event) => events.push(event.revision));
    const run = side.submit("wait forever");
    await waitForState(side, (state) => state.streamingAssistant.text === "late text");

    const disposing = side.dispose();
    assert.strictEqual(side.dispose(), disposing, "dispose returns the same bounded promise");
    await disposing;
    assert.equal((await run.completion).status, "aborted");
    const disposedState = side.getState();
    assert.equal(disposedState.status, "disposed");
    assert.equal(disposedState.generation, 2);
    const eventCount = events.length;
    late.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.length, eventCount, "late stream callbacks are dropped");
    assert.equal(side.getState().revision, disposedState.revision);
    assert.throws(() => side.submit("too late"), (error) => errorCode(error) === "unavailable");
    assert.throws(() => side.setMode("edit"), (error) => errorCode(error) === "unavailable");
  });
});
