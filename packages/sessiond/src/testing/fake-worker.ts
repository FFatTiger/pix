import { RUNTIME_READ_RPC_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE, WORKER_BUILD_IDENTITY, type WorkerBuild } from "@fffattiger/pix-protocol";
import type {
  ProtocolError,
  RuntimeCommandOutcome,
  RuntimeEventData,
  RuntimeReadOutcome,
  RuntimeInterruptResult,
  RuntimeSnapshot,
  SessiondToWorkerMessage,
  WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import type { WorkerConnection, WorkerExit, WorkerProcessFactory, WorkerStartInput } from "../worker.js";

export interface FakeWorkerOptions {
  readyDelayMs?: number;
  commandDelayMs?: number;
  readDelayMs?: number;
  /** Phase 3: delay before the worker admits a submitTurn (0 = immediate). */
  submitAdmissionDelayMs?: number;
  failStart?: boolean;
  /** Worker build-contract features; defaults to the current read RPC seam. */
  readyFeatures?: readonly string[];
  /**
   * Build block emitted on `worker.ready` (Phase 7A fence). Defaults to the
   * canonical {@link WORKER_BUILD_IDENTITY}; `null` OMITS the block entirely
   * (pre-fence Worker dist); any other value is emitted VERBATIM (stale
   * contract generation, malformed shapes) so tests prove sessiond rejects
   * every non-exact build fail-closed.
   */
  readyBuild?: unknown;
  discoveredSessionId?: string;
  snapshot?: RuntimeSnapshot;
  /** Test-only malformed inner snapshot session id; outer payload remains correct. */
  snapshotSessionIdOverride?: string;
  /** Drop worker.getSnapshot requests during startup so sessiond fails closed. */
  ignoreSnapshot?: boolean;
  /**
   * Delay answering the FIRST worker.getSnapshot (the startup/prime response)
   * so the rekey binding (sessionDiscovered/ready) can be observed while the
   * activation is still in flight. Used to queue authoritative-id requests
   * behind a startup deterministically.
   */
  primeSnapshotDelayMs?: number;
  /**
   * Delay answering worker.getSnapshot after the first (startup/prime) response
   * has been delivered. Used to hold set_thinking_level authority finalization
   * open so concurrent same-id callers can join the singleflight.
   */
  postCommandSnapshotDelayMs?: number;
  /** Drop post-startup worker.getSnapshot responses (refresh never arrives). */
  dropPostCommandSnapshots?: boolean;
  /**
   * Hold post-startup worker.getSnapshot responses behind a deterministic gate
   * (release via {@link FakeWorkerConnection.releaseHeldSnapshots}; observe via
   * {@link FakeWorkerConnection.waitForHeldSnapshot}). Used to prove authority
   * refresh blocks command settlement deterministically instead of via
   * wall-clock delays.
   */
  holdPostCommandSnapshots?: boolean;
  /** After the first snapshot, answer subsequent getSnapshot with a mismatched session id. */
  postCommandSnapshotMismatch?: boolean;
  /**
   * Deterministic fork outcome overrides. When `forkError` is set the fork
   * command answers `{ok:false}` with that exact error (mirroring an adapter
   * that re-projected a hostile SDK failure onto a canonical fixed error);
   * otherwise the fork succeeds with `forkedSessionId`/`forkedSessionFile`
   * (defaults "forked" / "/sessions/forked.jsonl").
   */
  forkError?: { code: string; message: string; retryable?: boolean };
  forkedSessionId?: string;
  forkedSessionFile?: string;
  /** Deterministic generated title answered for generate_session_title. */
  autoTitle?: string;
  /** Phase 5B rotate response: success (default), reject without clearing, or drop for timeout/uncertain tests. */
  rotateEpochBehavior?: "success" | "reject" | "drop";
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
});

export class FakeWorkerConnection implements WorkerConnection {
  readonly pid: number;
  readonly sent: SessiondToWorkerMessage[] = [];
  private readonly messageListeners = new Set<(message: WorkerToSessiondMessage) => void>();
  private readonly exitListeners = new Set<(exit: WorkerExit) => void>();
  private closed = false;
  private runningPrompt: { id: string; commandId: string; sessionId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Last worker.init build block observed (Phase 7A fence assertions). */
  lastInitBuild: unknown = undefined;
  /** Mutable authoritative snapshot (mirrors real worker getSnapshot source). */
  private liveSnapshot: RuntimeSnapshot;
  /** Count of worker.getSnapshot responses already emitted (prime is first). */
  private snapshotResponses = 0;
  private readonly pendingSnapshotTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Post-command snapshots held behind the deterministic gate. */
  private readonly heldPostCommandSnapshots: Array<{ id: string | undefined; sessionId: string }> = [];
  private readonly heldSnapshotWaiters = new Set<() => void>();

  constructor(readonly input: WorkerStartInput, private readonly options: FakeWorkerOptions, pid: number) {
    this.pid = pid;
    this.lastInitBuild = undefined;
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
        this.lastInitBuild = message.payload.build;
        setTimeout(() => {
          const discovered = this.options.discoveredSessionId;
          if (discovered) this.emit({ type: "worker.sessionDiscovered", payload: { sessionId: discovered, sessionFile: `/sessions/${discovered}.jsonl`, cwd: message.payload.cwd } });
          // Test double: the ready build block may deliberately be an INVALID
          // value (or `null` = omit the field entirely) to exercise the
          // sessiond-side fence; the cast exists exactly so those bytes reach
          // the service untyped. Both the negotiated features and the build
          // identity are emitted (the fence checks each independently).
          const readyBuild: unknown = this.options.readyBuild === undefined ? WORKER_BUILD_IDENTITY : this.options.readyBuild;
          const readySessionId = discovered ?? message.payload.sessionId;
          const readyFrame = (
            readyBuild === null
              ? { type: "worker.ready", id: message.id, payload: { sessionId: readySessionId, workerStatus: "ready", features: [...(this.options.readyFeatures ?? [RUNTIME_READ_RPC_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE])] } }
              : { type: "worker.ready", id: message.id, payload: { sessionId: readySessionId, workerStatus: "ready", features: [...(this.options.readyFeatures ?? [RUNTIME_READ_RPC_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE])], build: readyBuild as WorkerBuild } }
          ) as WorkerToSessiondMessage;
          this.emit(readyFrame);
          if (this.options.snapshot) this.emit({ type: "worker.snapshot", payload: { sessionId: discovered ?? message.payload.sessionId, snapshot: this.liveSnapshot } });
        }, this.options.readyDelayMs ?? 0);
        return;
      case "worker.read": {
        const read = message.payload.read;
        const emitRead = () => {
          if (this.closed) return;
          this.emit({
            type: "worker.readResult",
            id: message.id,
            payload: {
              sessionId: message.payload.sessionId,
              epoch: message.payload.epoch,
              requestId: message.payload.requestId,
              result: fakeReadOutcome(read.type, this.liveSnapshot),
            },
          });
        };
        const delay = this.options.readDelayMs ?? 0;
        if (delay > 0) setTimeout(emitRead, delay);
        else queueMicrotask(emitRead);
        return;
      }
      case "worker.submitTurn": {
        const { sessionId, epoch, operationId, turnId, request } = message.payload;
        if (request.activationOverrides?.model !== undefined) {
          this.liveSnapshot = { ...this.liveSnapshot, state: { ...this.liveSnapshot.state, model: { provider: request.activationOverrides.model.provider, id: request.activationOverrides.model.modelId } } };
        }
        if (request.activationOverrides?.thinkingLevel !== undefined) {
          this.liveSnapshot = { ...this.liveSnapshot, state: { ...this.liveSnapshot.state, thinkingLevel: request.activationOverrides.thinkingLevel, thinkingLevelPinned: true } };
        }
        this.liveSnapshot = { ...this.liveSnapshot, state: { ...this.liveSnapshot.state, isPromptRunning: true } };
        const admissionSnapshot = structuredClone(this.liveSnapshot);
        const emitAdmission = () => {
          if (this.closed) return;
          this.emit({
            type: "worker.submitTurnResult",
            id: message.id,
            payload: {
              sessionId, epoch, operationId, dispatchId: message.id, fingerprint: message.payload.fingerprint,
              result: { status: "accepted", delivery: "accepted", sessionId, epoch, revision: 0, operationId, turnId, snapshot: admissionSnapshot, turnStatus: { sessionId, epoch, operationId, turnId, revision: 0, state: "admitted" } },
            },
          });
        };
        const admissionDelay = this.options.submitAdmissionDelayMs ?? 0;
        if (admissionDelay > 0) setTimeout(emitAdmission, admissionDelay);
        else queueMicrotask(emitAdmission);
        setTimeout(() => {
          if (this.closed) return;
          this.liveSnapshot = { ...this.liveSnapshot, state: { ...this.liveSnapshot.state, isPromptRunning: false, messageCount: this.liveSnapshot.state.messageCount + 1 } };
          this.emit({ type: "worker.turnStatus", payload: { sessionId, epoch, operationId, turnId, revision: 1, state: "completed", ...(this.liveSnapshot.state.leafId === undefined ? {} : { finalLeafId: this.liveSnapshot.state.leafId }) } });
        }, this.options.commandDelayMs ?? 0);
        return;
      }
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
          const keep = Math.max(0, (this.liveSnapshot.state.messageCount ?? 0) - 2);
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
          };
        }
        // D2 navigate: a successful navigate moves the authoritative leaf. The
        // target encodes the number of retained messages (`nav-<keep>`), so a
        // post-success worker.getSnapshot (sessiond authority refresh) converges
        // leafId/messages/messageCount deterministically — the wire carries only
        // a runtime_state_changed signal and NO leaf/history fields.
        if (command.type === "navigate_tree" && typeof command.targetId === "string") {
          const keepMatch = /^nav-(\d+)$/.exec(command.targetId.trim());
          const current = this.liveSnapshot.state.messageCount ?? 0;
          const keep = keepMatch ? Math.max(0, Math.min(current, Number(keepMatch[1]))) : 0;
          this.liveSnapshot = {
            ...this.liveSnapshot,
            state: {
              ...this.liveSnapshot.state,
              messageCount: keep,
              ...(keep === 0 ? {} : { leafId: command.targetId }),
            },
          };
        }
        setTimeout(() => this.emitResult(message.id, message.payload.sessionId, command.commandId, outcome(command.type, this.options, (command as { entryId?: string }).entryId)), this.options.commandDelayMs ?? 0);
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
      case "worker.rotateEpoch": {
        const { sessionId, fromEpoch, toEpoch } = message.payload;
        const behavior = this.options.rotateEpochBehavior ?? "success";
        if (behavior === "drop") return;
        queueMicrotask(() => this.emit(behavior === "success"
          ? { type: "worker.rotateEpochResult", id: message.id, payload: { sessionId, fromEpoch, toEpoch, ok: true } }
          : { type: "worker.rotateEpochResult", id: message.id, payload: { sessionId, fromEpoch, toEpoch, ok: false, error: { code: "session_busy", message: "worker is not idle", retryable: true } } }));
        return;
      }
      case "worker.shutdown": return;
      default: return;
    }
  }

  private scheduleSnapshotResponse(id: string | undefined, sessionId: string): void {
    const isPostCommand = this.snapshotResponses > 0;
    if (isPostCommand && this.options.dropPostCommandSnapshots) return;
    if (isPostCommand && this.options.holdPostCommandSnapshots) {
      // Hold the authoritative refresh behind the gate: the singleflight entry
      // is installed before this refresh is dispatched, so the caller is
      // provably blocked until the gate is released.
      this.heldPostCommandSnapshots.push({ id, sessionId });
      for (const waiter of [...this.heldSnapshotWaiters]) waiter();
      return;
    }

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

    const delayMs = isPostCommand ? (this.options.postCommandSnapshotDelayMs ?? 0) : (this.options.primeSnapshotDelayMs ?? 0);
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

  /**
   * Resolves as soon as at least one post-command snapshot is held behind the
   * deterministic gate (bounded). Never a fixed sleep.
   */
  waitForHeldSnapshot(timeoutMs = 2_000): Promise<void> {
    if (this.heldPostCommandSnapshots.length > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.heldSnapshotWaiters.delete(waiter);
        reject(new Error(`timed out waiting for a held post-command snapshot (${this.heldPostCommandSnapshots.length} held)`));
      }, timeoutMs);
      const waiter = (): void => {
        clearTimeout(timer);
        this.heldSnapshotWaiters.delete(waiter);
        resolve();
      };
      this.heldSnapshotWaiters.add(waiter);
    });
  }

  /** Release every held post-command snapshot, letting authority refresh converge. */
  releaseHeldSnapshots(): void {
    const held = this.heldPostCommandSnapshots.splice(0);
    for (const { id, sessionId } of held) this.answerSnapshot(id, sessionId, true);
  }

  private answerSnapshot(id: string | undefined, sessionId: string, isPostCommand: boolean): void {
    if (this.closed) return;
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

function fakeReadOutcome(type: RuntimeReadOutcome["type"], snapshot: RuntimeSnapshot): RuntimeReadOutcome {
  switch (type) {
    case "get_state": return { ok: true, type, state: structuredClone(snapshot.state) };
    case "get_tools": {
      const tools = snapshot.state.tools;
      return tools === undefined
        ? { ok: false, type, error: { code: "unavailable", message: "tools are not available", retryable: true } }
        : { ok: true, type, tools: structuredClone([...tools]) };
    }
    case "get_session_stats": return { ok: true, type, stats: { messageCount: snapshot.state.messageCount ?? 0 } };
    case "get_last_assistant_text": return { ok: true, type, text: "" };
    case "get_commands": return { ok: true, type, commands: [] };
  }
}

function outcome(type: RuntimeCommandOutcome["type"], options: FakeWorkerOptions, entryId?: string): RuntimeCommandOutcome {
  if (type === "fork" && options.forkError) {
    return {
      ok: false,
      type,
      error: {
        code: options.forkError.code as ProtocolError["code"],
        message: options.forkError.message,
        retryable: options.forkError.retryable ?? false,
      },
    };
  }
  switch (type) {
    case "get_state": return { ok: false, type, error: { code: "unsupported_capability", message: "not scripted", retryable: false } };
    case "get_tools": return { ok: true, type, tools: [] };
    case "get_commands": return { ok: true, type, commands: [] };
    case "get_session_stats": return { ok: true, type, stats: { messageCount: 0 } };
    case "get_last_assistant_text": return { ok: true, type, text: "" };
    case "fork": return { ok: true, type, forkedSessionId: options.forkedSessionId ?? "forked", forkPointEntryId: entryId ?? "entry" };
    case "generate_session_title": return { ok: true, type, title: options.autoTitle ?? "auto title" };
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
