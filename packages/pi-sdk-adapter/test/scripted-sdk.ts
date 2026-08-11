import type {
  AgentMessage,
  AuthInput,
  AuthProviderInfo,
  AuthProviderStatus,
  AuthResult,
  ImageAttachment,
  ModelInfo,
  ModelRef,
  PluginInfo,
  RuntimeCapability,
  RuntimeCloseReason,
  RuntimeEvent,
  RuntimeStartInput,
  SessionContext,
  SessionDetail,
  SessionEntry,
  SessionHeader,
  SessionLocation,
  SkillInfo,
  SlashCommandInfo,
  ThinkingLevel,
  ToolInfo,
  TrustLevel,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError, RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import type {
  DriverEventListener,
  DriverFactoryOptions,
  DriverState,
  DriverUiRequest,
  PiRuntimeDriver,
  PiRuntimeDriverFactory,
} from "../src/internal/types.js";
import type { PiSdkDataBackend } from "./ports-helper.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Stored {
  id: string; file: string; cwd: string; title?: string; parent?: string; forkPoint?: string;
  entries: SessionEntry[]; model: ModelRef; createdAt: number; leaf?: string; written: string[];
}

let globalScriptedSession = 0;

export class ScriptedSdkStore implements PiSdkDataBackend {
  sessions = new Map<string, Stored>();
  credentials = new Map<string, string>();
  trust = new Map<string, TrustLevel>();
  skills: SkillInfo[] = [{ name: "frontend", description: "Frontend codebase guidance", enabled: true }, { name: "rust", enabled: false }];
  plugins: PluginInfo[] = [{ name: "pix-side-chat", version: "0.1.0", enabled: true }];
  commands: SlashCommandInfo[] = [{ name: "compact", description: "Compact", source: "prompt" }, { name: "clear", source: "prompt" }, { name: "frontend-review", source: "skill" }];
  nextSession = 1; nextEntry = 1;
  models: ModelInfo[] = [
    { id: "claude-sonnet-4", provider: "anthropic", displayName: "Claude Sonnet 4", thinking: true, contextWindow: 200000 },
    { id: "claude-opus-4", provider: "anthropic", displayName: "Claude Opus 4", thinking: true, contextWindow: 200000 },
    { id: "gpt-5", provider: "openai", displayName: "GPT-5", thinking: true, contextWindow: 128000 },
    { id: "gpt-5-mini", provider: "openai", displayName: "GPT-5 mini", thinking: false, contextWindow: 128000 },
  ];
  providers: AuthProviderInfo[] = [{ id: "anthropic", name: "Anthropic", methods: ["apiKey"] }, { id: "openai", name: "OpenAI", methods: ["apiKey", "oauth"] }, { id: "github", name: "GitHub", methods: ["oauth", "deviceCode"] }];

  create(input: RuntimeStartInput): Stored {
    globalScriptedSession += 1;
    const id = `sdk-session-${globalScriptedSession}`;
    const stored: Stored = { id, file: `/tmp/pi-sdk/${id}.jsonl`, cwd: input.cwd, ...(input.name === undefined ? {} : { title: input.name }), entries: [], model: input.model ? { provider: input.model.provider, id: input.model.modelId } : { provider: "anthropic", id: "claude-sonnet-4" }, createdAt: Date.now(), written: [] };
    this.sessions.set(id, stored); return stored;
  }
  append(session: Stored, message: AgentMessage): SessionEntry {
    const entry: SessionEntry = { entryId: `entry-${this.nextEntry++}`, ...(session.entries.at(-1) ? { parentEntryId: session.entries.at(-1)!.entryId } : {}), message };
    session.entries.push(entry); session.leaf = entry.entryId; return entry;
  }
  header(session: Stored): SessionHeader { return { sessionId: session.id, sessionFile: session.file, cwd: session.cwd, projectRoot: session.cwd, ...(session.title === undefined ? {} : { title: session.title }), createdAt: session.createdAt, updatedAt: session.createdAt + session.entries.length, messageCount: session.entries.length, ...(session.parent === undefined ? {} : { parentSessionId: session.parent }), ...(session.forkPoint === undefined ? {} : { forkPointEntryId: session.forkPoint }) }; }
  async listSessions() { return [...this.sessions.values()].map((s) => this.header(s)); }
  async readSession(id: string): Promise<SessionDetail> { const s = this.need(id); return { ...this.header(s), entries: structuredClone(s.entries) }; }
  async readSessionContext(id: string, leaf?: string): Promise<SessionContext> { const s = this.need(id); return { sessionId: id, ...(leaf ?? s.leaf ? { leafId: leaf ?? s.leaf! } : {}), entries: structuredClone(s.entries) }; }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async locate(id: string): Promise<SessionLocation> { const s = this.sessions.get(id); return { sessionId: id, sessionFile: s?.file ?? `/tmp/pi-sdk/${id}.jsonl`, exists: Boolean(s) }; }
  async resolveLeafId(id: string, target?: string) { const s = this.need(id); if (target && !s.entries.some((e) => e.entryId === target)) throw makeRuntimeError("not_found", "entry not found"); return target ?? s.leaf ?? id; }
  async listModels() { return this.models; }
  async getDefaultModel() { return { provider: "anthropic", id: "claude-sonnet-4" }; }
  async resolveModel(provider: string, id: string) { const model = this.models.find((m) => m.provider === provider && m.id === id); if (!model) throw makeRuntimeError("not_found", `unknown model: ${provider}/${id}`); return model; }
  async listProviders() { return this.providers; }
  async providerStatus(id: string): Promise<AuthProviderStatus> { return { providerId: id, authorized: this.credentials.has(id), ...(this.credentials.has(id) ? { accountName: "sdk-account" } : {}) }; }
  async authorize(id: string, input: AuthInput): Promise<AuthResult> { if (input.type === "apiKey" && input.apiKey) { this.credentials.set(id, "configured"); return { providerId: id, authorized: true, accountName: "sdk-account" }; } if (input.type === "start") return { providerId: id, authorized: false, pending: { verificationUrl: `https://example.test/${id}`, userCode: "SDK-CODE", expiresAt: Date.now() + 60000 } }; return { providerId: id, authorized: false }; }
  async logout(id: string) { this.credentials.delete(id); }
  async listSkills() { return structuredClone(this.skills); }
  async listPlugins() { return structuredClone(this.plugins); }
  async listCommands() { return structuredClone(this.commands); }
  async writePlugin(name: string, content: string, enabled: boolean) { if (!name || !content) throw makeRuntimeError("invalid_input", "plugin name/content required"); const p = { name, version: "local", enabled }; this.plugins = [...this.plugins.filter((x) => x.name !== name), p]; return p; }
  async setPluginEnabled(name: string, enabled: boolean) { const p = this.plugins.find((x) => x.name === name); if (!p) throw makeRuntimeError("not_found", "plugin not found"); p.enabled = enabled; return { ...p }; }
  async installSkill(source: string, name?: string) { const skill = { name: name ?? source.split("/").at(-1) ?? "skill", enabled: true, version: "1.0.0", updateAvailable: false }; this.skills = [...this.skills.filter((x) => x.name !== skill.name), skill]; return skill; }
  async updateSkill(name: string) { const s = this.skills.find((x) => x.name === name); if (!s) throw makeRuntimeError("not_found", "skill not found"); s.version = "updated"; s.updateAvailable = false; return { ...s }; }
  async setSkillEnabled(name: string, enabled: boolean) { const s = this.skills.find((x) => x.name === name); if (!s) throw makeRuntimeError("not_found", "skill not found"); s.enabled = enabled; return { ...s }; }
  async reloadResources() {}
  async getTrust(cwd: string) { const level = this.trust.get(cwd) ?? "untrusted"; return { level, ...(level === "trusted" ? {} : { reason: "project is not trusted" }) }; }
  async setTrust(cwd: string, level: TrustLevel) { this.trust.set(cwd, level); }
  need(id: string): Stored { const s = this.sessions.get(id); if (!s) throw makeRuntimeError("not_found", `session not found: ${id}`); return s; }
}

export class ScriptedSdkDriverFactory implements PiRuntimeDriverFactory {
  constructor(
    readonly store: ScriptedSdkStore,
    private readonly defaults?: { cwd?: string; model?: { provider: string; modelId: string } },
  ) {}
  async create(input: RuntimeStartInput, options: DriverFactoryOptions) {
    return new ScriptedSdkDriver(
      this.store,
      this.store.create({
        ...input,
        cwd: this.defaults?.cwd ?? input.cwd,
        ...(this.defaults?.model === undefined ? {} : { model: this.defaults.model }),
      }),
      {
        ...input,
        cwd: this.defaults?.cwd ?? input.cwd,
        ...(this.defaults?.model === undefined ? {} : { model: this.defaults.model }),
      },
      options,
    );
  }
  async open(id: string, _cwd: string | undefined, model: ModelRef | undefined, options: DriverFactoryOptions) { const s = this.store.need(id); if (model) s.model = model; return new ScriptedSdkDriver(this.store, s, { cwd: s.cwd }, options); }
}

class ScriptedSdkDriver implements PiRuntimeDriver {
  readonly identity; readonly capabilities: readonly RuntimeCapability[];
  private listeners = new Set<DriverEventListener>(); private ui?: (request: DriverUiRequest) => void;
  private status: "idle" | "prompt" | "bash" | "compact" = "idle"; private abortPrompt = false; private abortBashFlag = false; private abortCompact = false;
  private model: ModelRef; private thinking: ThinkingLevel; private systemPrompt = "You are a coding agent."; private tools = new Map([["read", true], ["write", true], ["failing_tool", true]]);
  private steering: { message: string; images?: readonly ImageAttachment[] }[] = []; private follow: { message: string; images?: readonly ImageAttachment[] }[] = [];
  private autoCompact = false; private autoRetry = false; private last = ""; private pendingUi: DriverUiRequest | undefined; private turn = 0;
  private rawMessages: unknown[];
  constructor(private store: ScriptedSdkStore, private session: Stored, input: RuntimeStartInput, private opts: DriverFactoryOptions) {
    this.identity = { sessionId: session.id, sessionFile: session.file, createdAt: session.createdAt, cwd: session.cwd };
    this.capabilities = opts.capabilities ?? RUNTIME_CAPABILITIES; this.model = session.model; this.thinking = input.thinkingLevel ?? "off";
    this.rawMessages = session.entries.map((entry) => this.toSdkRaw(entry.message));
    if (input.toolNames !== undefined) { for (const key of this.tools.keys()) this.tools.set(key, input.toolNames.includes(key)); if (!input.toolNames.length) this.systemPrompt = ""; }
  }
  getState(): DriverState { return { model: this.model, thinkingLevel: this.thinking, systemPrompt: this.systemPrompt, isStreaming: this.status === "prompt", isCompacting: this.status === "compact", isBashRunning: this.status === "bash", autoCompactionEnabled: this.autoCompact, autoRetryEnabled: this.autoRetry, pendingMessageCount: this.steering.length + this.follow.length, messages: structuredClone(this.rawMessages), tools: [...this.tools].map(([name, active]) => ({ name, active })), contextUsage: { percent: this.session.entries.length ? Math.min(100, this.session.entries.length * 10) : 0, tokens: this.session.entries.length * 1000, contextWindow: 200000 }, steering: structuredClone(this.steering), followUp: structuredClone(this.follow), sessionStats: { messageCount: this.session.entries.length, pendingMessageCount: this.steering.length + this.follow.length, tokenCount: this.session.entries.length * 100, contextUsage: { percent: this.session.entries.length * 10, tokens: this.session.entries.length * 1000, contextWindow: 200000 } }, lastAssistantText: this.last, commands: this.store.commands, ...(this.session.title === undefined ? {} : { sessionName: this.session.title }) }; }
  subscribe(listener: DriverEventListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: unknown) { for (const listener of [...this.listeners]) listener(event); }
  async bindUi(ui: (request: DriverUiRequest) => void, emit: (event: RuntimeEvent) => void) { this.ui = ui; void emit; }
  async prompt(message: string, images?: readonly ImageAttachment[], streaming?: "steer" | "followUp") { if (this.status === "prompt") { if (!streaming) throw new Error("runtime busy"); return streaming === "steer" ? this.steer(message, images) : this.followUp(message, images); } await this.runTurn(message, images, true); }
  async steer(message: string, images?: readonly ImageAttachment[]) { if (this.status === "prompt") { this.steering.push({ message, ...(images === undefined ? {} : { images }) }); this.emit({ type: "queue_update" }); return; } await this.runTurn(message, images, true); }
  async followUp(message: string, images?: readonly ImageAttachment[]) { if (this.status === "prompt") { this.follow.push({ message, ...(images === undefined ? {} : { images }) }); this.emit({ type: "queue_update" }); return; } await this.runTurn(message, images, true); }
  async abort() { this.abortPrompt = true; this.pendingUi?.cancel(); this.pendingUi = undefined; }
  async setModel(model: ModelRef) { await this.store.resolveModel(model.provider, model.id); this.model = model; this.session.model = model; this.thinking = "off"; }
  setThinkingLevel(level: ThinkingLevel) { this.thinking = level; }
  async compact(custom?: string) { if (this.status !== "idle") throw new Error("runtime busy"); this.status = "compact"; this.abortCompact = false; this.emit({ type: "compaction_start", reason: "manual", customInstructions: custom }); await wait(20); const aborted = this.abortCompact; if (!aborted) { this.session.entries = this.session.entries.slice(-2); this.rawMessages = this.rawMessages.slice(-2); } this.status = "idle"; this.emit({ type: "compaction_end", reason: "manual", aborted, result: { customInstructions: custom } }); }
  abortCompaction() { this.abortCompact = true; }
  setSessionName(name: string) { this.session.title = name; }
  setAutoCompaction(value: boolean) { this.autoCompact = value; }
  setAutoRetry(value: boolean) { this.autoRetry = value; }
  clearQueue() { this.steering = []; this.follow = []; this.emit({ type: "queue_update" }); }
  setTools(names: readonly string[]) { for (const key of this.tools.keys()) this.tools.set(key, names.includes(key)); this.systemPrompt = names.length ? "You are a coding agent." : ""; }
  async reload() { this.thinking = "off"; return this.opts.reloadCapabilities ?? this.capabilities; }
  async bash(command: string, exclude: boolean, onChunk: (chunk: string) => void) { if (this.status !== "idle") throw new Error("runtime busy"); this.status = "bash"; this.abortBashFlag = false; let output = ""; for (const chunk of ["line 1\n", "line 2\n"]) { await wait(18); output += chunk; onChunk(chunk); if (this.abortBashFlag) break; } await wait(20); const cancelled = this.abortBashFlag; this.status = "idle"; const rawMessage = { role: "bashExecution", command, output, ...(cancelled ? { cancelled: true } : { exitCode: 0 }), truncated: false, excludeFromContext: exclude }; this.rawMessages.push(rawMessage); const message: AgentMessage = { role: "bashExecution", command, output, ...(cancelled ? { cancelled: true } : { exitCode: 0 }), truncated: false, excludeFromContext: exclude }; this.store.append(this.session, message); return { output, ...(cancelled ? {} : { exitCode: 0 }), cancelled, truncated: false }; }
  abortBash() { this.abortBashFlag = true; }
  async navigate(target: string) {
    if (!target.trim()) throw new Error("entry not found");
    this.session.leaf = target;
  }
  async fork(entry: string) { const index = this.session.entries.findIndex((e) => e.entryId === entry); if (index < 0) throw new Error("entry not found"); const fork = this.store.create({ cwd: this.session.cwd }); fork.parent = this.session.id; fork.forkPoint = entry; fork.entries = structuredClone(this.session.entries.slice(0, index + 1)); fork.leaf = entry; fork.written = [...this.session.written]; return { sessionId: fork.id, sessionFile: fork.file }; }
  async generateSessionTitle() { const title = `Title for ${this.session.id}`; this.session.title = title; return title; }
  async close(_reason: RuntimeCloseReason) { this.listeners.clear(); }

  private async runTurn(message: string, attached: readonly ImageAttachment[] | undefined, promptDone: boolean) {
    if (message.includes("boom")) { const error = Object.assign(new Error("upstream secret-token-abc123"), { cause: { detail: "sk-nested-secret" }, details: { token: "secret-token-nested456" } }); throw error; }
    this.status = "prompt"; this.abortPrompt = false; this.turn += 1; this.emit({ type: "agent_start" });
    const rawUser = {
      role: "user",
      content: attached?.length
        ? [{ type: "text", text: message }, ...attached.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))]
        : message,
      timestamp: Date.now(),
    };
    const user: AgentMessage = { role: "user", content: attached?.length ? [{ type: "text", text: message }, ...attached.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mimeType, data: i.data } }))] : message, timestamp: rawUser.timestamp };
    this.rawMessages.push(rawUser);
    this.emit({ type: "message_start", message: rawUser }); this.store.append(this.session, user);
    if (message.includes("widget")) {
      this.emit({ type: "extension_statuses", statuses: [{ key: "model", text: this.model.id }, { key: "branch", text: "main" }] });
      this.emit({ type: "extension_widgets", widgets: [{ key: "summary", lines: ["line1", "line2"], placement: "belowEditor" }] });
    }
    if (this.autoCompact && message.includes("auto-compact")) { this.emit({ type: "auto_compaction_start" }); await wait(10); this.emit({ type: "auto_compaction_end", aborted: false, result: { entriesRemoved: 0 } }); }
    if (this.autoRetry && message.includes("retry")) { this.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: "transient" }); await wait(5); this.emit({ type: "auto_retry_end", success: true }); }
    if (message.includes("confirm")) { await this.requestUi("confirm"); if (this.abortPrompt) return this.aborted(); }
    let input = ""; if (message.includes("input-request")) { const value = await this.requestUi("input"); input = value.value ?? ""; if (this.abortPrompt) return this.aborted(); }
    const blocks: Record<string, unknown>[] = []; const raw = () => ({ role: "assistant", provider: this.model.provider, model: this.model.id, content: structuredClone(blocks) }); this.emit({ type: "message_start", message: raw() }); await wait(10); if (this.abortPrompt) return this.aborted();
    if (this.thinking !== "off") { blocks.push({ type: "thinking", thinking: `Reasoning about ${message}` }); this.emit({ type: "message_update", message: raw() }); await wait(10); }
    blocks.push({ type: "text", text: `Hello ${message}` }); this.emit({ type: "message_update", message: raw() }); await wait(10);
    if (message.includes("long")) for (let i = 0; i < 6; i++) { blocks.push({ type: "text", text: `step ${i}` }); this.emit({ type: "message_update", message: raw() }); await wait(10); if (this.abortPrompt) return this.aborted(); }
    const fail = message.includes("fail-tool") && this.tools.get("failing_tool") === true; const toolName = fail ? "failing_tool" : "write"; const call = `sdk-call-${this.turn}`;
    if ((fail || this.tools.get("write")) && !message.includes("no-write")) { const path = `${this.session.cwd}/notes-${this.turn}.md`; const args = fail ? { reason: "failure" } : { path, content: "hello" }; blocks.push({ type: "toolCall", id: call, name: toolName, arguments: args }); this.emit({ type: "message_update", message: raw() }); this.emit({ type: "tool_execution_start", toolCallId: call, toolName, args }); await wait(8); this.emit({ type: "tool_execution_update", toolCallId: call, toolName, partialResult: { running: true } }); await wait(8); if (!fail) this.session.written.push(path); this.emit({ type: "tool_execution_end", toolCallId: call, toolName, isError: fail, result: fail ? { error: "failed" } : { content: [{ type: "text", text: `Successfully wrote to ${path}` }], details: undefined } }); const rawTool = { role: "toolResult", toolCallId: call, toolName, content: [{ type: "text", text: fail ? "tool failed" : `Wrote ${path}` }], isError: fail, timestamp: Date.now() }; this.rawMessages.push(rawTool); const tool: AgentMessage = { ...rawTool } as AgentMessage; this.emit({ type: "message_start", message: { role: "toolResult", toolCallId: call, toolName } }); this.emit({ type: "message_end", message: rawTool }); this.store.append(this.session, tool); }
    const final = `Done processing "${message}".${input ? ` input=${input}` : ""}`; blocks.push({ type: "text", text: final }); this.emit({ type: "message_update", message: raw() }); await wait(8); if (this.abortPrompt) return this.aborted(); const zero = message.includes("zero-usage"); const assistantRaw = { ...raw(), stopReason: "stop", timestamp: Date.now(), usage: { input: zero ? 0 : 10, output: zero ? 0 : 20, cacheRead: zero ? 0 : 5, cacheWrite: zero ? 0 : 2, totalTokens: zero ? 0 : 37, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; this.rawMessages.push(assistantRaw); this.emit({ type: "message_end", message: assistantRaw }); this.store.append(this.session, { role: "assistant", content: blocks as never, provider: this.model.provider, model: this.model.id, stopReason: "stop", timestamp: Date.now(), usage: assistantRaw.usage }); this.last = final; this.emit({ type: "agent_end" }); this.emit({ type: "agent_settled" }); if (promptDone) this.emit({ type: "driver_prompt_settled" }); this.status = "idle"; void this.drain();
  }
  private toSdkRaw(message: AgentMessage): unknown {
    if (message.role === "assistant") {
      return {
        ...message,
        content: message.content.map((block) => block.type === "toolCall"
          ? { type: "toolCall", id: block.toolCallId, name: block.toolName, arguments: block.input }
          : block.type === "image"
            ? { type: "image", data: block.source.data ?? "", mimeType: block.source.media_type ?? "image/png" }
            : block),
        ...(message.usage === undefined ? {} : { usage: { ...message.usage, totalTokens: message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite } }),
      };
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      return { ...message, content: message.content.map((block) => block.type === "image" ? { type: "image", data: block.source.data ?? "", mimeType: block.source.media_type ?? "image/png" } : block) };
    }
    return message;
  }

  private aborted() { this.pendingUi = undefined; this.status = "idle"; this.emit({ type: "agent_end" }); this.emit({ type: "agent_settled" }); throw new Error("prompt aborted"); }
  private requestUi(method: "confirm" | "input"): Promise<{ value?: string; cancelled?: true }> { return new Promise((resolve) => { const settled = new Set<() => void>(); const done = (result: { value?: string; cancelled?: true }) => { this.pendingUi = undefined; for (const listener of settled) listener(); settled.clear(); resolve(result); }; const request: DriverUiRequest = { id: `sdk-ui-${this.turn}-${method}`, method, title: method === "confirm" ? "Confirm" : "Input", ...(method === "confirm" ? { message: "Continue?" } : { placeholder: "value" }), settle: (result) => done({ ...(result.value === undefined ? {} : { value: result.value }), ...(result.cancelled ? { cancelled: true } : {}) }), input: (data) => done({ value: data }), cancel: () => done({ cancelled: true }), onSettled: (listener) => settled.add(listener) }; this.pendingUi = request; this.ui?.(request); }); }
  private async drain() { if (this.status !== "idle") return; const next = this.steering.shift() ?? this.follow.shift(); if (!next) return; this.emit({ type: "queue_update" }); await this.runTurn(next.message, next.images, false); }
}
