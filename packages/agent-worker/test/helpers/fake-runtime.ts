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
  RuntimeSnapshot,
  RuntimeStartInput,
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
  onInterrupt?: (interrupt: RuntimeInterrupt, runtime: FakeAgentRuntime) => Promise<RuntimeInterruptResult>;
  onClose?: (reason: RuntimeCloseReason, runtime: FakeAgentRuntime) => void;
  closeError?: Error;
}

export class FakeAgentRuntime implements AgentRuntimePort {
  readonly emitted: RuntimeEvent[] = [];
  readonly executeCalls: RuntimeCommand[] = [];
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
