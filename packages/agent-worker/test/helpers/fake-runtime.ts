// Test-only fake AgentRuntimeFactory / AgentRuntimePort.
//
// Drives the WorkerController without any Pi SDK or network. The script
// surface lets tests deterministically emit Core events (cumulative partials,
// bash deltas, etc.) and settle execute/interrupt with canonical results.
import type {
  AgentRuntimeFactory,
  AgentRuntimePort,
  RuntimeCapabilitySet,
  RuntimeCloseReason,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeEvent,
  RuntimeIdentity,
  RuntimeInterrupt,
  RuntimeInterruptResult,
  RuntimeOpenInput,
  RuntimeReadRequest,
  RuntimeReadResult,
  RuntimeSnapshot,
  RuntimeStartInput,
  RuntimeTurnHandle,
  RuntimeTurnStart,
} from "@fffattiger/pix-runtime-core";
import { createCapabilitySet } from "@fffattiger/pix-runtime-core";

export interface FakeRuntimeConfig {
  sessionId: string;
  sessionFile?: string;
  capabilities?: RuntimeCapabilitySet["capabilities"];
  snapshot?: RuntimeSnapshot;
  /** Events emitted synchronously when subscribe() is called. */
  eventsOnSubscribe?: readonly RuntimeEvent[];
  onExecute?: (command: RuntimeCommand, runtime: FakeAgentRuntime) => Promise<RuntimeCommandResult>;
  onRead?: (request: RuntimeReadRequest, runtime: FakeAgentRuntime) => Promise<RuntimeReadResult>;
  onSubmitTurn?: (input: RuntimeTurnStart, runtime: FakeAgentRuntime) => Promise<RuntimeTurnHandle>;
  onInterrupt?: (interrupt: RuntimeInterrupt, runtime: FakeAgentRuntime) => Promise<RuntimeInterruptResult>;
  onClose?: (reason: RuntimeCloseReason, runtime: FakeAgentRuntime) => void;
  closeError?: Error;
}

export class FakeAgentRuntime implements AgentRuntimePort {
  readonly emitted: RuntimeEvent[] = [];
  readonly executeCalls: RuntimeCommand[] = [];
  readonly readCalls: RuntimeReadRequest[] = [];
  readonly submitTurnCalls: RuntimeTurnStart[] = [];
  readonly interruptCalls: RuntimeInterrupt[] = [];
  readonly closeReasons: RuntimeCloseReason[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private closed = false;

  constructor(private readonly config: FakeRuntimeConfig) {}

  get identity(): RuntimeIdentity {
    return {
      sessionId: this.config.sessionId,
      sessionFile: this.config.sessionFile ?? `/sessions/${this.config.sessionId}.jsonl`,
    };
  }

  getCapabilities(): RuntimeCapabilitySet {
    return createCapabilitySet(this.config.capabilities ?? []);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    return structuredClone(this.config.snapshot ?? defaultCoreSnapshot(this.config.sessionId));
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.config.eventsOnSubscribe ?? []) this.emit(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    if (this.closed) return;
    this.emitted.push(event);
    for (const listener of [...this.listeners]) listener(structuredClone(event));
  }

  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    this.executeCalls.push(command);
    if (this.config.onExecute === undefined) {
      return { ok: true, type: command.type } as RuntimeCommandResult;
    }
    return this.config.onExecute(command, this);
  }

  async submitTurn(input: RuntimeTurnStart): Promise<RuntimeTurnHandle> {
    this.submitTurnCalls.push(input);
    if (this.config.onSubmitTurn !== undefined) return this.config.onSubmitTurn(input, this);
    const snapshot = await this.getSnapshot();
    return { admission: { ok: true, snapshot }, completion: Promise.resolve({ ok: true, snapshot }) };
  }

  async read(request: RuntimeReadRequest): Promise<RuntimeReadResult> {
    this.readCalls.push(request);
    if (this.config.onRead !== undefined) {
      return this.config.onRead(request, this);
    }
    // Deterministic default: read settles from the configured snapshot state.
    if (request.type === "get_state") {
      return { ok: true, type: "get_state", state: structuredClone(this.config.snapshot?.state ?? defaultCoreSnapshot(this.config.sessionId).state) };
    }
    if (request.type === "get_session_stats") {
      return { ok: true, type: "get_session_stats", stats: { messageCount: this.config.snapshot?.state.messageCount ?? 0 } };
    }
    if (request.type === "get_last_assistant_text") {
      return { ok: true, type: "get_last_assistant_text", text: "" };
    }
    if (request.type === "get_tools") {
      return { ok: true, type: "get_tools", tools: this.config.snapshot?.state.tools ?? [] };
    }
    return { ok: true, type: "get_commands", commands: [] };
  }

  async interrupt(interrupt: RuntimeInterrupt): Promise<RuntimeInterruptResult> {
    this.interruptCalls.push(interrupt);
    if (this.config.onInterrupt === undefined) {
      return { ok: true, type: interrupt.type };
    }
    return this.config.onInterrupt(interrupt, this);
  }

  async close(reason: RuntimeCloseReason): Promise<void> {
    this.closeReasons.push(reason);
    this.closed = true;
    if (this.config.closeError !== undefined) throw this.config.closeError;
    await this.config.onClose?.(reason, this);
  }
}

export function defaultCoreSnapshot(sessionId: string): RuntimeSnapshot {
  return {
    sessionId,
    state: {
      sessionId,
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      model: null,
      messageCount: 0,
    },
    capabilities: createCapabilitySet([]),
  };
}

export class FakeAgentRuntimeFactory implements AgentRuntimeFactory {
  readonly createCalls: RuntimeStartInput[] = [];
  readonly openCalls: RuntimeOpenInput[] = [];
  readonly created: FakeAgentRuntime[] = [];
  /** Script used for every runtime the factory returns. */
  script: (mode: "create" | "open") => FakeRuntimeConfig = () => ({ sessionId: "sess-real" });
  createError: Error | undefined;
  openError: Error | undefined;

  async create(input: RuntimeStartInput): Promise<AgentRuntimePort> {
    if (this.createError !== undefined) throw this.createError;
    this.createCalls.push(input);
    const runtime = new FakeAgentRuntime(this.script("create"));
    this.created.push(runtime);
    return runtime;
  }

  async open(input: RuntimeOpenInput): Promise<AgentRuntimePort> {
    if (this.openError !== undefined) throw this.openError;
    this.openCalls.push(input);
    const runtime = new FakeAgentRuntime(this.script("open"));
    this.created.push(runtime);
    return runtime;
  }
}
