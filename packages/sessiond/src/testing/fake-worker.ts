import type {
  RuntimeCommandOutcome,
  RuntimeEventData,
  RuntimeInterruptResult,
  RuntimeSnapshot,
  SessiondToWorkerMessage,
  WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import type { WorkerConnection, WorkerExit, WorkerProcessFactory, WorkerStartInput } from "../worker.js";

export interface FakeWorkerOptions {
  readyDelayMs?: number;
  commandDelayMs?: number;
  failStart?: boolean;
  discoveredSessionId?: string;
  snapshot?: RuntimeSnapshot;
  /** Test-only malformed inner snapshot session id; outer payload remains correct. */
  snapshotSessionIdOverride?: string;
  /** Drop worker.getSnapshot requests during startup so sessiond fails closed. */
  ignoreSnapshot?: boolean;
  /**
   * Delay answering worker.getSnapshot after the first (startup/prime) response
   * has been delivered. Used to hold set_thinking_level authority finalization
   * open so concurrent same-id callers can join the singleflight.
   */
  postCommandSnapshotDelayMs?: number;
  /** Drop post-startup worker.getSnapshot responses (refresh never arrives). */
  dropPostCommandSnapshots?: boolean;
  /** After the first snapshot, answer subsequent getSnapshot with a mismatched session id. */
  postCommandSnapshotMismatch?: boolean;
}

/**
 * Default authoritative snapshot a real worker always returns. Empty
 * capabilities mirror the previous default projection so existing tests that
 * do not assert capabilities keep their behavior; tests that care pass an
 * explicit `snapshot` option (with real capabilities).
 */
const fakeDefaultSnapshot = (sessionId: string, cwd: string, projectRoot: string): RuntimeSnapshot => ({
  sessionId,
  cwd,
  projectRoot,
  state: { sessionId, isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 0, queuedMessages: { steering: [], followUp: [] }, pendingMessageCount: 0, writtenFiles: [] },
  capabilities: { capabilities: [], version: 0 },
  streaming: { active: false, phase: "idle" },
  messages: [],
});

export class FakeWorkerConnection implements WorkerConnection {
  readonly pid: number;
  readonly sent: SessiondToWorkerMessage[] = [];
  private readonly messageListeners = new Set<(message: WorkerToSessiondMessage) => void>();
  private readonly exitListeners = new Set<(exit: WorkerExit) => void>();
  private closed = false;
  private runningPrompt: { id: string; commandId: string; sessionId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Mutable authoritative snapshot (mirrors real worker getSnapshot source). */
  private liveSnapshot: RuntimeSnapshot;
  /** Count of worker.getSnapshot responses already emitted (prime is first). */
  private snapshotResponses = 0;
  private readonly pendingSnapshotTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(readonly input: WorkerStartInput, private readonly options: FakeWorkerOptions, pid: number) {
    this.pid = pid;
    this.liveSnapshot = options.snapshot
      ? structuredClone(options.snapshot)
      : fakeDefaultSnapshot(input.sessionId, input.cwd, input.projectRoot);
  }

  async send(message: SessiondToWorkerMessage): Promise<void> {
    if (this.closed) throw new Error("worker closed");
    this.sent.push(structuredClone(message));
    switch (message.type) {
      case "worker.init":
        if (this.options.failStart) throw new Error("start failed");
        setTimeout(() => {
          const discovered = this.options.discoveredSessionId;
          if (discovered) this.emit({ type: "worker.sessionDiscovered", payload: { sessionId: discovered, sessionFile: `/sessions/${discovered}.jsonl`, cwd: message.payload.cwd } });
          this.emit({ type: "worker.ready", id: message.id, payload: { sessionId: discovered ?? message.payload.sessionId, workerStatus: "ready" } });
          if (this.options.snapshot) this.emit({ type: "worker.snapshot", payload: { sessionId: discovered ?? message.payload.sessionId, snapshot: this.liveSnapshot } });
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
        // D2-P2/P3/P4/P6: set_thinking_level / set_model / set_auto_retry /
        // set_tools / reload mutate the authoritative snapshot so a subsequent
        // worker.getSnapshot (sessiond post-success refresh) sees the pin / new
        // model / auto-retry flag / tool selection + systemPrompt / new
        // capability set.
        if (command.type === "set_thinking_level" && typeof command.level === "string") {
          this.liveSnapshot = {
            ...this.liveSnapshot,
            state: {
              ...this.liveSnapshot.state,
              thinkingLevel: command.level as RuntimeSnapshot["state"]["thinkingLevel"],
              thinkingLevelPinned: true,
            },
          };
        }
        if (
          command.type === "set_model" &&
          typeof command.provider === "string" &&
          typeof command.modelId === "string"
        ) {
          this.liveSnapshot = {
            ...this.liveSnapshot,
            state: {
              ...this.liveSnapshot.state,
              model: { provider: command.provider, id: command.modelId },
            },
          };
        }
        if (command.type === "set_auto_retry" && typeof command.enabled === "boolean") {
          this.liveSnapshot = {
            ...this.liveSnapshot,
            state: {
              ...this.liveSnapshot.state,
              autoRetryEnabled: command.enabled,
            },
          };
        }
        if (command.type === "set_tools" && Array.isArray(command.toolNames)) {
          const names = [...new Set(command.toolNames.filter((name): name is string => typeof name === "string" && /[^\s]/.test(name)))];
          const all = (this.liveSnapshot.state.tools ?? []).map((tool) => ({
            ...tool,
            active: names.length === 0 ? false : names.includes(tool.name),
          }));
          this.liveSnapshot = {
            ...this.liveSnapshot,
            state: {
              ...this.liveSnapshot.state,
              tools: all,
              ...(names.length === 0 ? { systemPrompt: "" } : {}),
            },
          };
        }
        if (command.type === "reload") {
          this.liveSnapshot = {
            ...this.liveSnapshot,
            capabilities: {
              capabilities: ["runtime.prompt", "runtime.abort", "runtime.tools.read", "runtime.tools.write", "runtime.reload"],
              version: (this.liveSnapshot.capabilities.version ?? 0) + 1,
            },
          };
        }
        // D2-P7: a successful manual compact trims the authoritative snapshot
        // deterministically so the post-success worker.getSnapshot refresh
        // converges messages/messageCount/contextUsage (the wire compaction_end
        // event only clears activity and does NOT carry these fields).
        if (command.type === "compact") {
          const messages = Array.isArray(this.liveSnapshot.messages) ? this.liveSnapshot.messages : [];
          const keep = Math.max(0, messages.length - 2);
          const trimmed = messages.slice(-keep);
          const usage = this.liveSnapshot.state.contextUsage;
          this.liveSnapshot = {
            ...this.liveSnapshot,
            state: {
              ...this.liveSnapshot.state,
              messageCount: keep,
              isCompacting: false,
              ...(usage === undefined || usage === null
                ? {}
                : {
                    contextUsage: {
                      percent: Math.max(0, (usage.percent ?? 0) - 40),
                      ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
                      ...(usage.tokens === undefined ? {} : { tokens: Math.max(0, (usage.tokens ?? 0) - 400) }),
                    },
                  }),
            },
            messages: trimmed,
          };
        }
        setTimeout(() => this.emitResult(message.id, message.payload.sessionId, command.commandId, outcome(command.type)), this.options.commandDelayMs ?? 0);
        return;
      }
      case "worker.interrupt": {
        const commandId = message.payload.commandId;
        const result: RuntimeInterruptResult = { ok: true, type: message.payload.interrupt.type };
        if (message.payload.interrupt.type === "abort" && this.runningPrompt) {
          const running = this.runningPrompt;
          clearTimeout(running.timer);
          this.runningPrompt = undefined;
          this.emitResult(running.id, running.sessionId, running.commandId, { ok: false, type: "prompt", error: { code: "interrupted", message: "interrupted", retryable: false } });
          this.emitEvent({ type: "prompt_error", sessionId: running.sessionId, errorMessage: "interrupted", error: { code: "interrupted", message: "interrupted", retryable: false } });
        }
        queueMicrotask(() => this.emit({ type: "worker.interruptResult", id: message.id, payload: { sessionId: message.payload.sessionId, result: { commandId, result } } }));
        return;
      }
      case "worker.getSnapshot":
        if (this.options.ignoreSnapshot) return;
        this.scheduleSnapshotResponse(message.id, message.payload.sessionId);
        return;
      case "worker.shutdown": return;
      default: return;
    }
  }

  private scheduleSnapshotResponse(id: string | undefined, sessionId: string): void {
    const isPostCommand = this.snapshotResponses > 0;
    if (isPostCommand && this.options.dropPostCommandSnapshots) return;

    const emit = (): void => {
      if (this.closed) return;
      // A real worker always answers getSnapshot with its authoritative
      // snapshot (capabilities + state). Normalize the snapshot session id
      // to the requested one so sessiond rekey/projection stays consistent.
      const snap = structuredClone(this.liveSnapshot);
      if (isPostCommand && this.options.postCommandSnapshotMismatch) {
        snap.sessionId = `mismatch:${sessionId}`;
        snap.state.sessionId = snap.sessionId;
      } else {
        snap.sessionId = this.options.snapshotSessionIdOverride ?? sessionId;
        snap.state.sessionId = snap.sessionId;
      }
      this.snapshotResponses += 1;
      this.emit({ type: "worker.snapshot", id, payload: { sessionId, snapshot: snap } });
    };

    const delayMs = isPostCommand ? (this.options.postCommandSnapshotDelayMs ?? 0) : 0;
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.pendingSnapshotTimers.delete(timer);
        emit();
      }, delayMs);
      this.pendingSnapshotTimers.add(timer);
      return;
    }
    queueMicrotask(emit);
  }

  subscribe(listener: (message: WorkerToSessiondMessage) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onExit(listener: (exit: WorkerExit) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.runningPrompt) clearTimeout(this.runningPrompt.timer);
    for (const timer of this.pendingSnapshotTimers) clearTimeout(timer);
    this.pendingSnapshotTimers.clear();
  }
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
