import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createCodingTools,
  createReadOnlyTools,
  type ExtensionContext,
  type ExtensionToolContext,
  type ModelRegistry,
  type ModelRuntime,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { FileActivityTracker } from "./file-activity-tracker.js";
import { forkSurgery } from "./fork-surgery.js";
import { wrapToolsWithOverlapDetection } from "./tool-wrapper.js";

const SIDE_CHAT_PROMPT = `
---
## Side Chat

You're in a SIDE CHAT parallel to the main agent. Main is working independently and can't see this.

Use \`peek_main\` to see main's activity when user asks about progress or you need context.
Use \`peek_main({ since_fork: true })\` for activity since side chat opened.

The copied main context is reference only. Do not continue its pending user request, tool call, reasoning, edits, or unfinished answer. Answer the latest user message in this side chat.

Be concise - this is for quick questions. If user wants something main is doing, suggest waiting.`;

const OVERLAP_TIMEOUT_MS = 30_000;
const DISPOSE_WAIT_MS = 1_000;

export type SideChatMode = "read_only" | "edit";
export type SideChatStatus = "idle" | "running" | "awaiting_overlap" | "disposed";

export interface SideChatForkContext {
  messages: AgentMessage[];
  model: Model<Api>;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  extensionTools: readonly RegisteredTool[];
}

export interface SideChatToolStatus {
  toolCallId: string;
  name: string;
  status: "running" | "completed" | "failed";
}

export interface SideChatOverlapRequest {
  requestId: string;
  runId: string;
  path: string;
}

export interface SideChatState {
  conversationId: string;
  generation: number;
  revision: number;
  parentSessionId: string;
  agentSessionId: string;
  mode: SideChatMode;
  status: SideChatStatus;
  runId?: string;
  messages: AgentMessage[];
  streamingAssistant: {
    text: string;
    thinking: string;
  };
  tools: SideChatToolStatus[];
  pendingOverlap?: SideChatOverlapRequest;
  error?: {
    code: "run_failed";
    message: string;
  };
}

export interface SideChatControllerEvent {
  type: "state_changed";
  conversationId: string;
  generation: number;
  revision: number;
  runId?: string;
  state: SideChatState;
}

export interface SideChatRunResult {
  conversationId: string;
  runId: string;
  status: "completed" | "aborted" | "failed";
}

export interface SideChatSubmission {
  conversationId: string;
  runId: string;
  completion: Promise<SideChatRunResult>;
}

export type SideChatModelRuntime = Pick<ModelRuntime, "streamSimple"> | Pick<ModelRegistry, "streamSimple">;

export interface CreateSideChatControllerOptions {
  forkContext: SideChatForkContext;
  modelRuntime: SideChatModelRuntime;
  sessionManager: ExtensionContext["sessionManager"];
  createExtensionContext: () => ExtensionContext;
  tracker: FileActivityTracker;
}

export type SideChatControllerErrorCode = "invalid_input" | "not_found" | "session_busy" | "unavailable";

export class SideChatControllerError extends Error {
  constructor(readonly code: SideChatControllerErrorCode, message: string) {
    super(message);
    this.name = "SideChatControllerError";
  }
}

interface ActiveRun {
  id: string;
  generation: number;
  aborted: boolean;
  completion: Promise<SideChatRunResult>;
  resolve: (result: SideChatRunResult) => void;
  settled: boolean;
}

interface PendingOverlap {
  request: SideChatOverlapRequest;
  generation: number;
  timer: NodeJS.Timeout;
  resolve: (proceed: boolean) => void;
}

export interface SideChatController {
  getState(): SideChatState;
  subscribe(listener: (event: SideChatControllerEvent) => void): () => void;
  submit(text: string): SideChatSubmission;
  setMode(mode: SideChatMode): void;
  resolveOverlap(requestId: string, proceed: boolean): void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export function createSideChatController(options: CreateSideChatControllerOptions): SideChatController {
  return new HeadlessSideChatController(options);
}

class HeadlessSideChatController implements SideChatController {
  private readonly agent: Agent;
  private readonly conversationId = randomUUID();
  private readonly agentSessionId = randomUUID();
  private readonly forkContext: SideChatForkContext;
  private readonly parentSessionId: string;
  private readonly forkLeafId: string | null;
  private readonly baselineMessageCount: number;
  private readonly listeners = new Set<(event: SideChatControllerEvent) => void>();
  private readonly unsubscribeAgent: () => void;
  private generation = 1;
  private revision = 0;
  private mode: SideChatMode = "read_only";
  private status: SideChatStatus = "idle";
  private activeRun: ActiveRun | undefined;
  private lastRunId: string | undefined;
  private pendingOverlap: PendingOverlap | undefined;
  private tools: SideChatToolStatus[] = [];
  private streamingText = "";
  private streamingThinking = "";
  private error: SideChatState["error"];
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: CreateSideChatControllerOptions) {
    const forkContext = {
      ...options.forkContext,
      messages: structuredClone(options.forkContext.messages),
      model: structuredClone(options.forkContext.model),
      extensionTools: [...options.forkContext.extensionTools],
    };
    // Agent replays every system message for prompt/tool authority. Copied parent
    // system entries must not participate in the fresh side-chat transcript.
    const forkedMessages = forkSurgery(
      forkContext.messages.filter((message) => message.role !== "system"),
    );
    const framingMessage: AgentMessage = {
      role: "user",
      content: "The preceding messages are copied main-session context for reference only. Answer the latest side-chat user message; do not resume the main lane's pending work.",
      timestamp: Date.now(),
    };

    this.forkContext = forkContext;
    this.parentSessionId = options.sessionManager.getSessionId();
    this.forkLeafId = options.sessionManager.getLeafId();
    this.agent = new Agent({
      initialState: {
        systemPrompt: forkContext.systemPrompt + SIDE_CHAT_PROMPT,
        model: forkContext.model,
        thinkingLevel: forkContext.thinkingLevel,
        tools: this.toolsForMode(this.mode, forkContext),
        messages: [...forkedMessages, framingMessage],
      },
      convertToLlm,
      streamFn: (model, context, streamOptions) => options.modelRuntime.streamSimple(model, context, streamOptions),
      sessionId: this.agentSessionId,
    });
    this.baselineMessageCount = this.agent.state.messages.length;
    this.unsubscribeAgent = this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  getState(): SideChatState {
    const runId = this.activeRun?.id ?? this.lastRunId;
    return {
      conversationId: this.conversationId,
      generation: this.generation,
      revision: this.revision,
      parentSessionId: this.parentSessionId,
      agentSessionId: this.agentSessionId,
      mode: this.mode,
      status: this.status,
      ...(runId === undefined ? {} : { runId }),
      messages: structuredClone(this.agent.state.messages.slice(this.baselineMessageCount)),
      streamingAssistant: { text: this.streamingText, thinking: this.streamingThinking },
      tools: this.tools.map((tool) => ({ ...tool })),
      ...(this.pendingOverlap === undefined ? {} : { pendingOverlap: { ...this.pendingOverlap.request } }),
      ...(this.error === undefined ? {} : { error: { ...this.error } }),
    };
  }

  subscribe(listener: (event: SideChatControllerEvent) => void): () => void {
    if (this.disposed) throw new SideChatControllerError("unavailable", "side chat is disposed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(text: string): SideChatSubmission {
    this.assertAvailable();
    const prompt = text.trim();
    if (!prompt) throw new SideChatControllerError("invalid_input", "side chat message is required");
    if (this.activeRun !== undefined || this.agent.state.isStreaming) {
      throw new SideChatControllerError("session_busy", "side chat is already running");
    }

    const runId = randomUUID();
    let resolveCompletion!: (result: SideChatRunResult) => void;
    const completion = new Promise<SideChatRunResult>((resolve) => { resolveCompletion = resolve; });
    const run: ActiveRun = {
      id: runId,
      generation: this.generation,
      aborted: false,
      completion,
      resolve: resolveCompletion,
      settled: false,
    };
    this.activeRun = run;
    this.lastRunId = runId;
    this.status = "running";
    this.streamingText = "";
    this.streamingThinking = "";
    this.tools = [];
    this.error = undefined;
    this.publish();
    void this.runPrompt(run, prompt);
    return { conversationId: this.conversationId, runId, completion };
  }

  setMode(mode: SideChatMode): void {
    this.assertAvailable();
    if (mode !== "read_only" && mode !== "edit") {
      throw new SideChatControllerError("invalid_input", "invalid side chat mode");
    }
    if (mode === this.mode) return;
    this.mode = mode;
    this.agent.state.tools = this.toolsForMode(mode, this.forkContext);
    this.publish();
  }

  resolveOverlap(requestId: string, proceed: boolean): void {
    this.assertAvailable();
    const pending = this.pendingOverlap;
    if (
      pending === undefined
      || pending.request.requestId !== requestId
      || pending.generation !== this.generation
      || pending.request.runId !== this.activeRun?.id
    ) {
      throw new SideChatControllerError("not_found", "overlap request not found");
    }
    this.settleOverlap(proceed);
  }

  async abort(): Promise<void> {
    if (this.disposed) return;
    const run = this.activeRun;
    if (run === undefined) return;
    run.aborted = true;
    this.settleOverlap(false);
    this.agent.abort();
    const settled = await boundedWait(run.completion, DISPOSE_WAIT_MS);
    if (!settled && this.accepts(run)) this.quarantineRun(run);
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const run = this.activeRun;
    if (run !== undefined) run.aborted = true;
    this.settleOverlap(false, false);
    this.agent.abort();
    this.unsubscribeAgent();
    this.generation++;
    this.status = "disposed";
    this.streamingText = "";
    this.streamingThinking = "";
    this.publish();
    this.listeners.clear();
    if (run !== undefined) {
      this.settleRun(run, "aborted");
      await boundedWait(run.completion, DISPOSE_WAIT_MS);
    }
    this.activeRun = undefined;
  }

  private quarantineRun(run: ActiveRun): void {
    this.disposed = true;
    this.settleOverlap(false, false);
    this.unsubscribeAgent();
    this.generation++;
    this.activeRun = undefined;
    this.status = "disposed";
    this.streamingText = "";
    this.streamingThinking = "";
    this.tools = this.tools.map((tool) => tool.status === "running" ? { ...tool, status: "failed" } : tool);
    this.error = { code: "run_failed", message: "Side chat request failed" };
    this.settleRun(run, "aborted");
    this.publish(run.id);
    this.listeners.clear();
  }

  private async runPrompt(run: ActiveRun, prompt: string): Promise<void> {
    let status: SideChatRunResult["status"] = "completed";
    try {
      await this.agent.prompt(prompt);
      if (run.aborted) {
        status = "aborted";
      } else if (this.agent.state.errorMessage !== undefined) {
        status = "failed";
        if (this.accepts(run)) this.error = { code: "run_failed", message: "Side chat request failed" };
      }
    } catch {
      status = run.aborted ? "aborted" : "failed";
      if (this.accepts(run)) {
        this.error = { code: "run_failed", message: "Side chat request failed" };
      }
    } finally {
      this.settleOverlap(false, false);
      if (this.accepts(run)) {
        this.activeRun = undefined;
        this.status = "idle";
        this.streamingText = "";
        this.streamingThinking = "";
        this.publish(run.id);
      }
      this.settleRun(run, status);
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    const run = this.activeRun;
    if (run === undefined || !this.accepts(run)) return;

    if (event.type === "message_start" && event.message.role === "assistant") {
      this.streamingText = "";
      this.streamingThinking = "";
    } else if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        this.streamingText += event.assistantMessageEvent.delta;
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        this.streamingThinking += event.assistantMessageEvent.delta;
      }
    } else if (event.type === "message_end") {
      this.streamingText = "";
      this.streamingThinking = "";
    } else if (event.type === "tool_execution_start") {
      this.tools = [
        ...this.tools.filter((tool) => tool.toolCallId !== event.toolCallId),
        { toolCallId: event.toolCallId, name: event.toolName, status: "running" },
      ];
    } else if (event.type === "tool_execution_end") {
      this.tools = this.tools.map((tool) =>
        tool.toolCallId === event.toolCallId
          ? { ...tool, status: event.isError ? "failed" : "completed" }
          : tool
      );
    }
    this.publish();
  }

  private toolsForMode(mode: SideChatMode, forkContext: SideChatForkContext): AgentTool[] {
    const builtIns = mode === "read_only"
      ? createReadOnlyTools(forkContext.cwd)
      : wrapToolsWithOverlapDetection(
        createCodingTools(forkContext.cwd),
        this.options.tracker,
        forkContext.cwd,
        (path) => this.confirmOverlap(path),
      );
    return [...builtIns, ...this.extensionTools(forkContext.extensionTools, mode), this.createPeekMainTool()];
  }

  /**
   * Copy the forked extension surface into standalone agent tools, failing
   * closed on Pi 1.0 exposure semantics: only `direct` (declared AND callable)
   * tools fit a standalone agent tool. Hidden/codemode/deferred tools are
   * never model-declared, model-only tools are never callable — neither may
   * be declared here. In read_only mode a namespaced (MCP) tool additionally
   * needs the trusted `readOnlyHint` annotation; unknown write capability is
   * NEVER treated as read-only. Ordinary (unnamespaced) extension tools keep
   * their existing side-chat availability. Nested calls (codemode scripts,
   * tool_search) are main-session-only: this controller hosts no nested
   * runner, so those tools are not part of the fork surface at all and
   * ctx.executeTool returns the explicit unsupported outcome.
   */
  private extensionTools(tools: readonly RegisteredTool[], mode: SideChatMode): AgentTool[] {
    return tools.flatMap(({ definition }): AgentTool[] => {
      if (definition.exposure !== undefined && definition.exposure !== "direct") return [];
      if (mode === "read_only" && definition.namespace !== undefined && definition.annotations?.readOnlyHint !== true) {
        return [];
      }
      return [{
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        ...(definition.constrainedSampling === undefined ? {} : { constrainedSampling: definition.constrainedSampling }),
        ...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
        ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
        execute: (toolCallId, params, signal, onUpdate) =>
          definition.execute(toolCallId, params, signal, onUpdate, this.createSideChatToolContext(toolCallId)),
      }];
    });
  }

  /**
   * SDK 1.0 tool context per the ExtensionToolContext contract: the extension
   * context plus `tools` (the side chat's current callable list) and
   * `executeTool`, which per the contract NEVER rejects — failures come back
   * as `isError: true` outcomes. The side chat runs its wrapped tools through
   * its own Agent loop, not an AgentSession tool pipeline, so there is no
   * nested-call host: executeTool returns the same explicit "not available in
   * this context" error outcome the SDK itself returns without a host — never
   * a fake success and never a thrown rejection.
   */
  private createSideChatToolContext(toolCallId: string): ExtensionToolContext {
    return Object.defineProperties(this.options.createExtensionContext(), {
      tools: {
        get: () => this.agent.state.tools,
      },
      executeTool: {
        value: async (_name: string, _args: unknown) => ({
          toolCall: { type: "toolCall" as const, id: `${toolCallId}/0`, name: _name, arguments: {} },
          result: {
            content: [{ type: "text" as const, text: "Nested tool calls are not available in this context" }],
            details: {},
          },
          isError: true,
        }),
      },
    }) as ExtensionToolContext;
  }

  private createPeekMainTool(): AgentTool {
    return {
      name: "peek_main",
      label: "peek_main",
      description: "View main agent's recent activity. Use when user asks about main's progress or status.",
      parameters: Type.Object({
        lines: Type.Optional(Type.Integer({ description: "Max items (default: 20)", minimum: 1, maximum: 50 })),
        since_fork: Type.Optional(Type.Boolean({ description: "Only show activity after side chat opened" })),
      }),
      execute: async (_id, args) => {
        const input = args as { lines?: number; since_fork?: boolean };
        const sessionManager = this.options.sessionManager;
        const context = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
        let messages = context.messages;

        if (input.since_fork && this.forkLeafId) {
          const forkContext = buildSessionContext(sessionManager.getEntries(), this.forkLeafId);
          messages = messages.slice(forkContext.messages.length);
        }

        const recent = messages.slice(-(input.lines ?? 20));
        if (!recent.length) {
          return {
            content: [{ type: "text", text: input.since_fork ? "No new activity since fork." : "No recent activity." }],
            details: undefined,
          };
        }

        const formatted = recent.map(formatMainMessage).filter(Boolean).join("\n\n");
        return {
          content: [{ type: "text", text: `Main agent activity (${recent.length} items):\n\n${formatted}` }],
          details: undefined,
        };
      },
    };
  }

  private confirmOverlap(path: string): Promise<boolean> {
    const run = this.activeRun;
    if (run === undefined || !this.accepts(run) || this.pendingOverlap !== undefined) return Promise.resolve(false);

    const request: SideChatOverlapRequest = { requestId: randomUUID(), runId: run.id, path };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingOverlap?.request.requestId === request.requestId) this.settleOverlap(false);
      }, OVERLAP_TIMEOUT_MS);
      timer.unref?.();
      this.pendingOverlap = { request, generation: run.generation, timer, resolve };
      this.status = "awaiting_overlap";
      this.publish();
    });
  }

  private settleOverlap(proceed: boolean, publish = true): void {
    const pending = this.pendingOverlap;
    if (pending === undefined) return;
    this.pendingOverlap = undefined;
    clearTimeout(pending.timer);
    if (!this.disposed && this.activeRun !== undefined) this.status = "running";
    pending.resolve(proceed);
    if (publish && !this.disposed) this.publish();
  }

  private accepts(run: ActiveRun): boolean {
    return !this.disposed && run.generation === this.generation && this.activeRun === run;
  }

  private settleRun(run: ActiveRun, status: SideChatRunResult["status"]): void {
    if (run.settled) return;
    run.settled = true;
    run.resolve({ conversationId: this.conversationId, runId: run.id, status });
  }

  private publish(runId = this.activeRun?.id ?? this.lastRunId): void {
    this.revision++;
    const state = this.getState();
    const event: SideChatControllerEvent = {
      type: "state_changed",
      conversationId: this.conversationId,
      generation: this.generation,
      revision: this.revision,
      ...(runId === undefined ? {} : { runId }),
      state,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A projection listener must not interrupt the independent agent run.
      }
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new SideChatControllerError("unavailable", "side chat is disposed");
  }
}

function formatMainMessage(message: AgentMessage): string {
  if (message.role === "user") {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "text" ? block.text : "[image]").join("");
    return `[User]: ${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`;
  }
  if (message.role === "assistant") {
    const fullText = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const text = fullText.slice(0, 500);
    const tools = message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
    const parts = [text && `${text}${fullText.length > 500 ? "..." : ""}`, tools.length && `[Calling: ${tools.join(", ")}]`].filter(Boolean);
    return parts.length ? `[Assistant]: ${parts.join("\n")}` : "";
  }
  if (message.role === "toolResult") {
    const fullText = message.content[0]?.type === "text" ? message.content[0].text : "";
    return `[${message.toolName}]: ${fullText.slice(0, 150)}${fullText.length > 150 ? "..." : ""}`;
  }
  return "";
}

async function boundedWait(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}
