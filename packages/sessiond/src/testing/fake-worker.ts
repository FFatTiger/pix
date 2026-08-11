import type {
  RuntimeCommandOutcome,
  RuntimeEventData,
  RuntimeInterruptResult,
  RuntimeSnapshot,
  SessiondToWorkerMessage,
  WorkerToSessiondMessage,
} from "@fffattiger/pi-web-protocol";
import type { WorkerConnection, WorkerExit, WorkerProcessFactory, WorkerStartInput } from "../worker.js";

export interface FakeWorkerOptions {
  readyDelayMs?: number;
  commandDelayMs?: number;
  failStart?: boolean;
  discoveredSessionId?: string;
  snapshot?: RuntimeSnapshot;
}

export class FakeWorkerConnection implements WorkerConnection {
  readonly pid: number;
  readonly sent: SessiondToWorkerMessage[] = [];
  private readonly messageListeners = new Set<(message: WorkerToSessiondMessage) => void>();
  private readonly exitListeners = new Set<(exit: WorkerExit) => void>();
  private closed = false;
  private runningPrompt: { id: string; commandId: string; sessionId: string; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(readonly input: WorkerStartInput, private readonly options: FakeWorkerOptions, pid: number) { this.pid = pid; }

  async send(message: SessiondToWorkerMessage): Promise<void> {
    if (this.closed) throw new Error("worker closed");
    this.sent.push(structuredClone(message));
    switch (message.type) {
      case "worker.init":
        if (this.options.failStart) throw new Error("start failed");
        setTimeout(() => {
          const discovered = this.options.discoveredSessionId;
          if (discovered) this.emit({ type: "worker.sessionDiscovered", payload: { sessionId: discovered, sessionFile: `/sessions/${discovered}.jsonl`, cwd: message.payload.cwd } });
          this.emit({ type: "worker.ready", id: message.id, payload: { sessionId: discovered ?? message.payload.sessionId, epoch: "worker-epoch", workerStatus: "ready" } });
          if (this.options.snapshot) this.emit({ type: "worker.snapshot", payload: { sessionId: discovered ?? message.payload.sessionId, snapshot: this.options.snapshot } });
        }, this.options.readyDelayMs ?? 0);
        return;
      case "worker.command": {
        const command = message.payload.command;
        if (command.type === "prompt" && (this.options.commandDelayMs ?? 0) > 0) {
          this.emitEvent({ type: "agent_start", sessionId: message.payload.sessionId });
          const timer = setTimeout(() => {
            this.runningPrompt = undefined;
            this.emitResult(message.id, message.payload.sessionId, command.commandId, { ok: true, type: "prompt" });
            this.emitEvent({ type: "prompt_done", sessionId: message.payload.sessionId });
          }, this.options.commandDelayMs);
          this.runningPrompt = { id: message.id, commandId: command.commandId, sessionId: message.payload.sessionId, timer };
          return;
        }
        setTimeout(() => this.emitResult(message.id, message.payload.sessionId, command.commandId, outcome(command.type)), this.options.commandDelayMs ?? 0);
        return;
      }
      case "worker.interrupt": {
        const result: RuntimeInterruptResult = { ok: true, type: message.payload.interrupt.type };
        if (message.payload.interrupt.type === "abort" && this.runningPrompt) {
          const running = this.runningPrompt;
          clearTimeout(running.timer);
          this.runningPrompt = undefined;
          this.emitResult(running.id, running.sessionId, running.commandId, { ok: false, type: "prompt", error: { code: "interrupted", message: "interrupted", retryable: false } });
          this.emitEvent({ type: "prompt_error", sessionId: running.sessionId, errorMessage: "interrupted", error: { code: "interrupted", message: "interrupted", retryable: false } });
        }
        queueMicrotask(() => this.emit({ type: "worker.interruptResult", id: message.id, payload: { sessionId: message.payload.sessionId, result } }));
        return;
      }
      case "worker.getSnapshot":
        if (this.options.snapshot) queueMicrotask(() => this.emit({ type: "worker.snapshot", id: message.id, payload: { sessionId: message.payload.sessionId, snapshot: this.options.snapshot! } }));
        return;
      case "worker.shutdown": return;
      default: return;
    }
  }

  subscribe(listener: (message: WorkerToSessiondMessage) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onExit(listener: (exit: WorkerExit) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; if (this.runningPrompt) clearTimeout(this.runningPrompt.timer); }
  emit(message: WorkerToSessiondMessage): void { if (!this.closed) for (const listener of [...this.messageListeners]) listener(structuredClone(message)); }
  emitEvent(event: RuntimeEventData): void { this.emit({ type: "worker.event", payload: { sessionId: event.sessionId, event } }); }
  crash(error = { code: "worker_unavailable" as const, message: "fake crash", retryable: true }): void { if (this.closed) return; for (const listener of [...this.exitListeners]) listener({ code: 1, error }); }

  private emitResult(id: string, sessionId: string, commandId: string, result: RuntimeCommandOutcome): void {
    this.emit({ type: "worker.commandResult", id, payload: { sessionId, result: { commandId, result } } });
  }
}

function outcome(type: RuntimeCommandOutcome["type"]): RuntimeCommandOutcome {
  switch (type) {
    case "get_state": return { ok: false, type, error: { code: "unsupported_capability", message: "not scripted", retryable: false } };
    case "get_tools": return { ok: true, type, tools: [] };
    case "get_commands": return { ok: true, type, commands: [] };
    case "get_session_stats": return { ok: true, type, stats: { messageCount: 0 } };
    case "get_last_assistant_text": return { ok: true, type, text: "" };
    case "fork": return { ok: true, type, forkedSessionId: "forked", forkPointEntryId: "entry" };
    default: return { ok: true, type };
  }
}

export class FakeWorkerFactory implements WorkerProcessFactory {
  readonly workers: FakeWorkerConnection[] = [];
  starts = 0;
  private nextPid = 10_000;
  constructor(private readonly options: FakeWorkerOptions | ((input: WorkerStartInput, index: number) => FakeWorkerOptions) = {}) {}
  async start(input: WorkerStartInput): Promise<FakeWorkerConnection> {
    const index = this.starts;
    const options = typeof this.options === "function" ? this.options(input, index) : this.options;
    this.starts += 1;
    const worker = new FakeWorkerConnection(input, options, this.nextPid++);
    this.workers.push(worker);
    return worker;
  }
}
