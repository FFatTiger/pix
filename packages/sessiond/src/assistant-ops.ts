/**
 * Assistant write-channel authority (round 7).
 *
 * Single owner of assistant-originated session mutations: the assistant
 * worker asks over the supervisor IPC pipe, and this module executes ONLY
 * through the same sessiond paths the UI uses (submitTurn / steer /
 * follow_up / create / stop / rename). It never reaches into worker
 * internals, never answers a non-assistant requester, and never reports a
 * delivery it did not actually complete.
 *
 * Persistence is one ledger file next to settings.json. Settlement and
 * notification delivery are driven by the service's running-state
 * transitions (scheduleSettleCheck) plus a bounded idle-confirm timer.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  ASSISTANT_NOTIFY_MESSAGE_PREFIX,
  ASSISTANT_SENT_MESSAGE_PREFIX,
  type AssistantDeliveryPath,
  type AssistantWorkOutcome,
  type CorrelatedRuntimeCommandResult,
  type ProtocolError,
  type RuntimeCommand,
  type RuntimeCreateParams,
  type RuntimeCreateResult,
  type RuntimeSubmitTurnParams,
  type SessiondToWorkerMessage,
  type SubmitTurnAdmission,
  type WorkerAssistantOpPayload,
} from "@fffattiger/pix-protocol";
import { isAssistantWorkspacePath } from "@fffattiger/pix-runtime-core";

const LEDGER_FILE = "assistant-delegations.json";
const LEDGER_VERSION = 1;
const LEDGER_CAP = 200;
const QUOTA = { send: 5, create: 3, stop: 5 } as const;
const CHAIN_CAP = 3;
const SUMMARY_CHARS = 120;
const LAST_TEXT_CHARS = 400;
const WRITTEN_FILE_CAP = 8;
const CONTEXT_TAIL = 24;
const SETTLE_DEBOUNCE_MS = 50;
const IDLE_CONFIRM_MS = 2_500;
const IDLE_RECHECK_MS = 1_000;
const NOTIFY_MERGE_MS = 1_500;
const NOTIFY_RETRY_MS = 5_000;
const NOTIFY_ATTEMPT_CAP = 3;
const NAME_MAX = 200;

/** Live record view the authority needs. The service owns the real record. */
export interface AssistantOpsRecordView {
  sessionId: string;
  cwd: string;
  epoch: string;
  status: string;
  isTurnRunning(): boolean;
  pendingExtensionUi(): number;
  lastEventId: number;
  capabilities(): readonly string[];
  /** Current assistant turn's operation id, or null when the assistant is idle. */
  runningOperationId(): string | null;
  writtenFiles(): readonly string[];
  workerSend(message: SessiondToWorkerMessage): Promise<void>;
}

export interface AssistantOpsSurface {
  getRecord(sessionId: string): AssistantOpsRecordView | undefined;
  submitTurn(input: RuntimeSubmitTurnParams): Promise<SubmitTurnAdmission>;
  command(sessionId: string, command: RuntimeCommand, epoch?: string): Promise<CorrelatedRuntimeCommandResult>;
  create(input: RuntimeCreateParams): Promise<RuntimeCreateResult>;
  stop(sessionId: string, reason?: string): Promise<boolean>;
  renameSession(sessionId: string, name: string): Promise<{ sessionId: string; name: string }>;
  locate(sessionId: string): Promise<{ exists: boolean }>;
  readSessionHeader?(sessionId: string): Promise<{ title?: string; cwd?: string } | null>;
  readSessionContext?(sessionId: string, opts: { limit: number }): Promise<{
    entries: Array<{ message?: { role?: string; content?: string | Array<{ type?: string; text?: string }>; errorMessage?: string; stopReason?: string } }>;
  } | null>;
}

export interface AssistantOpsOptions {
  surface: AssistantOpsSurface;
  /** sessiond private directory (ledger lives here, next to settings.json). */
  directory: string;
  /** Process home, for the assistant-workspace guard. */
  homedir: string;
  now?: () => number;
}

type DelegationMode = "wait" | "notify";
type DelegationState = "wait" | "notify" | "settled" | "delivery_failed";

interface Delegation {
  id: string;
  assistantSessionId: string;
  targetSessionId: string;
  targetTitle: string;
  targetCwd: string;
  summary: string;
  createdAt: number;
  createdEventId: number;
  mode: DelegationMode;
  state: DelegationState;
  outcome?: AssistantWorkOutcome;
  settledAt?: number;
  waitMinutes: number;
  /** Set once idle-confirm starts; cleared when the target goes busy again. */
  pendingSettleAt?: number;
  /** Journal cursor captured when idle-confirm opened. Persisted so a restart keeps the same grace. */
  confirmEventId?: number;
  /** True once the target was observed busy after this delegation was created. */
  busySeen?: boolean;
  /** Delivery attempts already spent on the notification (0..NOTIFY_ATTEMPT_CAP). */
  notifyAttempts?: number;
}

interface ChainTarget {
  autoCount: number;
  lastNotifyAt: number;
}

interface Chain {
  lastUserTurnAt: number;
  targets: Record<string, ChainTarget>;
}

interface NotifyItem {
  delegationId: string;
  assistantSessionId: string;
  targetSessionId: string;
  targetTitle: string;
  targetCwd: string;
  outcome: AssistantWorkOutcome;
  lastText?: string;
  writtenFiles?: string[];
  error?: string;
  attempts: number;
}

interface LedgerFile {
  version: 1;
  delegations: Delegation[];
  chains: Record<string, Chain>;
  queue: NotifyItem[];
}

interface QuotaBucket {
  send: number;
  create: number;
  stop: number;
}

interface OpError {
  code: ProtocolError["code"];
  message: string;
  retryable: boolean;
}

const QUOTA_MESSAGES: Record<"send" | "create" | "stop", string> = {
  send: "本回合 send_to_session 已达上限（5 次）",
  create: "本回合 create_session 已达上限（3 次）",
  stop: "本回合 stop_session 已达上限（5 次）",
};

const OUTCOME_LABEL: Record<AssistantWorkOutcome, string> = {
  completed: "完成",
  failed: "出错",
  waiting_user: "停下等用户",
  stopped: "已停止",
};

const SEND_NOTES: Record<AssistantDeliveryPath, (title: string) => string> = {
  steer: (title) => `已发送到「${title}」：以引导消息插入当前轮`,
  follow_up: (title) => `已发送到「${title}」：以后续消息排在当前轮之后`,
  new_turn: (title) => `已发送到「${title}」：目标空闲，已开始新一轮`,
};

export class AssistantOpsAuthority {
  private readonly surface: AssistantOpsSurface;
  private readonly directory: string;
  private readonly homedir: string;
  private readonly now: () => number;
  private readonly ledgerPath: string;
  private delegations: Delegation[] = [];
  private chains = new Map<string, Chain>();
  private queue: NotifyItem[] = [];
  private readonly quota = new Map<string, QuotaBucket>();
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;

  constructor(options: AssistantOpsOptions) {
    this.surface = options.surface;
    this.directory = options.directory;
    this.homedir = options.homedir;
    this.now = options.now ?? Date.now;
    this.ledgerPath = `${this.directory}/${LEDGER_FILE}`;
    this.load();
  }

  /** Correlated write channel. A non-assistant requester gets no reply. */
  async handleWorkerOp(
    record: AssistantOpsRecordView,
    id: string,
    payload: { sessionId: string; op: WorkerAssistantOpPayload },
  ): Promise<void> {
    if (!isAssistantWorkspacePath(record.cwd, this.homedir)) return;
    const op = payload.op;
    try {
      const result = await this.execute(record, op);
      await this.reply(record, id, { ...result, sessionId: record.sessionId });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "assistant op failed";
      await this.reply(record, id, {
        ok: false,
        sessionId: record.sessionId,
        kind: op.kind,
        error: { code: "internal", message, retryable: false },
      });
    }
  }

  /** A pending wait was cancelled. The work continues; settlement notifies. */
  handleWaitCancel(payload: { sessionId: string; delegationId: string }): void {
    const delegation = this.delegations.find((item) => item.id === payload.delegationId && item.assistantSessionId === payload.sessionId);
    if (!delegation || delegation.state !== "wait") return;
    delegation.mode = "notify";
    delegation.state = "notify";
    this.persist();
  }

  /**
   * A user-originated submitTurn landed. When the session is the assistant's,
   * the next auto-continuation to each target starts its chain count over.
   */
  noteRpcSubmitTurn(sessionId: string): void {
    void this.noteUserTurn(sessionId);
  }

  /** Coalesce running-state transitions into one settlement pass. */
  scheduleSettleCheck(): void {
    if (this.settleTimer !== undefined) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      void this.settlePass();
    }, SETTLE_DEBOUNCE_MS);
    this.settleTimer.unref?.();
  }

  /** Drop every armed timer. Tests and shutdown use this; nothing else leaks. */
  dispose(): void {
    for (const timer of [this.settleTimer, this.confirmTimer, this.notifyTimer, this.retryTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.settleTimer = undefined;
    this.confirmTimer = undefined;
    this.notifyTimer = undefined;
    this.retryTimer = undefined;
  }

  // ---------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------

  private async execute(record: AssistantOpsRecordView, op: WorkerAssistantOpPayload): Promise<OpResultBody> {
    if (op.kind === "send") return this.executeSend(record, op);
    if (op.kind === "create") return this.executeCreate(record, op);
    if (op.kind === "stop") return this.executeStop(record, op);
    return this.executeRename(record, op);
  }

  private async executeSend(record: AssistantOpsRecordView, op: Extract<WorkerAssistantOpPayload, { kind: "send" }>): Promise<OpResultBody> {
    const quota = this.peekQuota(record, "send");
    if (quota) return fail("send", quota);
    if (op.targetSessionId === record.sessionId) {
      return fail("send", { code: "invalid_input", message: "不能以助手会话自身为目标", retryable: false });
    }
    const target = this.surface.getRecord(op.targetSessionId);
    if (target && isAssistantWorkspacePath(target.cwd, this.homedir)) {
      return fail("send", { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false });
    }
    const located = await this.surface.locate(op.targetSessionId);
    if (!located.exists && !target) {
      return fail("send", { code: "not_found", message: "session not found", retryable: false });
    }
    if (!this.reserveChain(record.sessionId, op.targetSessionId)) return fail("send", chainLimitError());
    const message = marked(op.message);
    const routed = await this.routePrompt(target, op.targetSessionId, message, op.delivery);
    if (!routed.ok) {
      this.releaseChain(record.sessionId, op.targetSessionId);
      return fail("send", routed.error);
    }
    this.takeQuota(record, "send");
    const delegationId = this.registerDelegation(record, {
      targetSessionId: op.targetSessionId,
      targetTitle: await this.targetTitle(op.targetSessionId, target),
      targetCwd: target?.cwd ?? "",
      summary: summarize(op.message),
      createdEventId: target?.lastEventId ?? 0,
      mode: op.waitMinutes > 0 ? "wait" : "notify",
      waitMinutes: op.waitMinutes,
    });
    const title = await this.targetTitle(op.targetSessionId, target);
    return {
      ok: true,
      kind: "send",
      targetSessionId: op.targetSessionId,
      delivery: routed.delivery,
      ...(delegationId === undefined ? {} : { delegationId }),
      note: SEND_NOTES[routed.delivery](title),
    };
  }

  private async executeCreate(record: AssistantOpsRecordView, op: Extract<WorkerAssistantOpPayload, { kind: "create" }>): Promise<OpResultBody> {
    const quota = this.peekQuota(record, "create");
    if (quota) return fail("create", quota);
    if (!isDirectory(op.cwd)) {
      return fail("create", { code: "invalid_input", message: "cwd is not a directory", retryable: false });
    }
    let created: RuntimeCreateResult;
    try {
      created = await this.surface.create({
        createRequestId: `assistant-create:${randomUUID()}`,
        cwd: op.cwd,
        projectRoot: op.cwd,
        ...(op.title === undefined ? {} : { name: op.title }),
        ...(op.model === undefined ? {} : { model: op.model }),
        ...(op.thinkingLevel === undefined ? {} : { thinkingLevel: op.thinkingLevel }),
      });
    } catch (error) {
      return fail("create", mapThrown(error));
    }
    const target = this.surface.getRecord(created.sessionId);
    if (target && isAssistantWorkspacePath(target.cwd, this.homedir)) {
      return fail("create", { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false });
    }
    if (!this.reserveChain(record.sessionId, created.sessionId)) return fail("create", chainLimitError());
    const routed = await this.routePrompt(target, created.sessionId, marked(op.message), "follow_up");
    if (!routed.ok) {
      this.releaseChain(record.sessionId, created.sessionId);
      return fail("create", routed.error);
    }
    this.takeQuota(record, "create");
    const delegationId = this.registerDelegation(record, {
      targetSessionId: created.sessionId,
      targetTitle: op.title?.trim() || created.sessionId,
      targetCwd: op.cwd,
      summary: summarize(op.message),
      createdEventId: target?.lastEventId ?? 0,
      mode: op.waitMinutes > 0 ? "wait" : "notify",
      waitMinutes: op.waitMinutes,
    });
    return {
      ok: true,
      kind: "create",
      targetSessionId: created.sessionId,
      ...(delegationId === undefined ? {} : { delegationId }),
      note: `已在项目 ${projectLabel(op.cwd)} 新建会话并发送第一条消息`,
    };
  }

  private async executeStop(record: AssistantOpsRecordView, op: Extract<WorkerAssistantOpPayload, { kind: "stop" }>): Promise<OpResultBody> {
    const quota = this.peekQuota(record, "stop");
    if (quota) return fail("stop", quota);
    const located = await this.surface.locate(op.targetSessionId);
    if (!located.exists && !this.surface.getRecord(op.targetSessionId)) {
      return fail("stop", { code: "not_found", message: "session not found", retryable: false });
    }
    const stopped = await this.surface.stop(op.targetSessionId, "user");
    this.takeQuota(record, "stop");
    return {
      ok: true,
      kind: "stop",
      stopped,
      note: stopped ? "已停止该会话当前这一轮" : "该会话当前没有运行中的轮次",
    };
  }

  private async executeRename(record: AssistantOpsRecordView, op: Extract<WorkerAssistantOpPayload, { kind: "rename" }>): Promise<OpResultBody> {
    const located = await this.surface.locate(op.targetSessionId);
    if (!located.exists && !this.surface.getRecord(op.targetSessionId)) {
      return fail("rename", { code: "not_found", message: "session not found", retryable: false });
    }
    const name = op.name.trim();
    if (name.length < 1 || name.length > NAME_MAX) {
      return fail("rename", { code: "invalid_input", message: "session name must be 1..200 characters", retryable: false });
    }
    try {
      const renamed = await this.surface.renameSession(op.targetSessionId, name);
      return { ok: true, kind: "rename", targetSessionId: renamed.sessionId, note: `已改名为「${renamed.name}」` };
    } catch (error) {
      return fail("rename", mapThrown(error));
    }
  }

  /**
   * Deliver a prompt into a target the way the composer does: a busy live
   * record gets steer/follow_up, an idle live record gets a fenced
   * submitTurn, and a missing record cold-opens through an unfenced submit.
   */
  private async routePrompt(
    target: AssistantOpsRecordView | undefined,
    sessionId: string,
    message: string,
    busyDelivery: "steer" | "follow_up",
  ): Promise<{ ok: true; delivery: AssistantDeliveryPath } | { ok: false; error: OpError }> {
    const live = target !== undefined && !["crashed", "stopped", "stopping"].includes(target.status);
    if (live && target.isTurnRunning()) {
      const capability = busyDelivery === "steer" ? "runtime.steer" : "runtime.follow_up";
      if (!target.capabilities().includes(capability)) {
        return { ok: false, error: { code: "unsupported_capability", message: `capability not supported: ${capability}`, retryable: false } };
      }
      const command: RuntimeCommand = { commandId: `assistant-op:${randomUUID()}`, type: busyDelivery, message };
      const result = await this.surface.command(sessionId, command, target.epoch);
      if (!result.result.ok) return { ok: false, error: opError(result.result.error) };
      return { ok: true, delivery: busyDelivery };
    }
    if (live) {
      if (!target.capabilities().includes("runtime.prompt")) {
        return { ok: false, error: { code: "unsupported_capability", message: "capability not supported: runtime.prompt", retryable: false } };
      }
      const admission = await this.surface.submitTurn({
        sessionId,
        operationId: `assistant-op:${randomUUID()}`,
        prompt: message,
        expectedEpoch: target.epoch,
        expectedRevision: target.lastEventId,
      });
      if (admission.status === "rejected") return { ok: false, error: opError(admission.error) };
      return { ok: true, delivery: "new_turn" };
    }
    const admission = await this.surface.submitTurn({
      sessionId,
      operationId: `assistant-op:${randomUUID()}`,
      prompt: message,
    });
    if (admission.status === "rejected") return { ok: false, error: opError(admission.error) };
    return { ok: true, delivery: "new_turn" };
  }

  // ---------------------------------------------------------------------
  // Quota + chain
  // ---------------------------------------------------------------------

  private quotaKey(record: AssistantOpsRecordView): string {
    return `${record.sessionId}:${record.runningOperationId() ?? `epoch:${record.epoch}`}`;
  }

  /** Reject when this turn already spent its cap. Does not consume a slot. */
  private peekQuota(record: AssistantOpsRecordView, kind: "send" | "create" | "stop"): OpError | undefined {
    const bucket = this.quota.get(this.quotaKey(record));
    if ((bucket?.[kind] ?? 0) >= QUOTA[kind]) {
      return { code: "invalid_input", message: QUOTA_MESSAGES[kind], retryable: false };
    }
    return undefined;
  }

  /** Consume one slot. Only called after the op actually succeeded. */
  private takeQuota(record: AssistantOpsRecordView, kind: "send" | "create" | "stop"): void {
    const key = this.quotaKey(record);
    const bucket = this.quota.get(key) ?? { send: 0, create: 0, stop: 0 };
    bucket[kind] += 1;
    this.quota.set(key, bucket);
  }

  /**
   * Reserve one automatic continuation before the send, so overlapping ops
   * cannot both pass the cap. A user turn newer than the last notification
   * for this target starts the count over at 1. Returns false at the cap.
   */
  private reserveChain(assistantId: string, targetId: string): boolean {
    const chain = this.chainFor(assistantId);
    const prior = chain.targets[targetId] ?? { autoCount: 0, lastNotifyAt: 0 };
    const autoCount = chain.lastUserTurnAt > prior.lastNotifyAt ? 1 : prior.autoCount + 1;
    if (autoCount > CHAIN_CAP) return false;
    chain.targets[targetId] = { autoCount, lastNotifyAt: prior.lastNotifyAt };
    this.persist();
    return true;
  }

  /** Give a reservation back when the send it counted did not land. */
  private releaseChain(assistantId: string, targetId: string): void {
    const target = this.chains.get(assistantId)?.targets[targetId];
    if (!target || target.autoCount < 1) return;
    target.autoCount -= 1;
    this.persist();
  }

  private chainFor(assistantId: string): Chain {
    const existing = this.chains.get(assistantId);
    if (existing) return existing;
    const created: Chain = { lastUserTurnAt: 0, targets: {} };
    this.chains.set(assistantId, created);
    return created;
  }

  private async noteUserTurn(sessionId: string): Promise<void> {
    const live = this.surface.getRecord(sessionId);
    let assistant = live !== undefined && isAssistantWorkspacePath(live.cwd, this.homedir);
    if (!assistant && this.surface.readSessionHeader) {
      try {
        const header = await this.surface.readSessionHeader(sessionId);
        assistant = header?.cwd !== undefined && isAssistantWorkspacePath(header.cwd, this.homedir);
      } catch {
        assistant = false;
      }
    }
    if (!assistant) return;
    this.chainFor(sessionId).lastUserTurnAt = this.now();
    this.persist();
  }

  // ---------------------------------------------------------------------
  // Delegation ledger
  // ---------------------------------------------------------------------

  private registerDelegation(record: AssistantOpsRecordView, input: {
    targetSessionId: string;
    targetTitle: string;
    targetCwd: string;
    summary: string;
    createdEventId: number;
    mode: DelegationMode;
    waitMinutes: number;
  }): string {
    const delegation: Delegation = {
      id: randomUUID(),
      assistantSessionId: record.sessionId,
      targetSessionId: input.targetSessionId,
      targetTitle: input.targetTitle,
      targetCwd: input.targetCwd,
      summary: input.summary,
      createdAt: this.now(),
      createdEventId: input.createdEventId,
      mode: input.mode,
      state: input.mode,
      waitMinutes: input.waitMinutes,
    };
    this.delegations.unshift(delegation);
    if (this.delegations.length > LEDGER_CAP) this.delegations.length = LEDGER_CAP;
    this.persist();
    return delegation.id;
  }

  private async targetTitle(sessionId: string, live: AssistantOpsRecordView | undefined): Promise<string> {
    if (!this.surface.readSessionHeader) return sessionId;
    try {
      const header = await this.surface.readSessionHeader(sessionId);
      if (header?.title) return header.title;
    } catch { /* catalog degradation: the id is an honest label */ }
    return live?.sessionId ?? sessionId;
  }

  // ---------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------

  private async settlePass(): Promise<void> {
    const pending = this.delegations.filter((item) => item.state === "wait" || item.state === "notify");
    let needsConfirm = false;
    for (const delegation of pending) {
      const target = this.surface.getRecord(delegation.targetSessionId);
      if (!target || target.status === "stopped" || target.status === "stopping") {
        await this.settle(delegation, "stopped");
        continue;
      }
      if (target.status === "crashed") {
        await this.settle(delegation, "failed", "会话异常退出");
        continue;
      }
      if (target.pendingExtensionUi() > 0) {
        this.clearConfirm(delegation);
        await this.settle(delegation, "waiting_user");
        continue;
      }
      if (target.isTurnRunning()) {
        this.clearConfirm(delegation);
        delegation.busySeen = true;
        continue;
      }
      if (target.lastEventId <= delegation.createdEventId) continue;
      if (delegation.confirmEventId === undefined || delegation.confirmEventId !== target.lastEventId) {
        delegation.pendingSettleAt = this.now();
        delegation.confirmEventId = target.lastEventId;
        this.persist();
        needsConfirm = true;
        continue;
      }
      if (this.now() - (delegation.pendingSettleAt ?? this.now()) < IDLE_CONFIRM_MS) {
        needsConfirm = true;
        continue;
      }
      if (target.isTurnRunning() || target.pendingExtensionUi() > 0 || target.lastEventId !== delegation.confirmEventId) {
        this.clearConfirm(delegation);
        needsConfirm = true;
        continue;
      }
      // Idle after real work. A failed assistant tail is "failed"; idle
      // without ever having been busy is an honest stop — never a fabricated
      // completion. The catalog read degrades to "completed" when absent.
      const failed = delegation.busySeen === true ? await this.tailFailure(delegation.targetSessionId) : undefined;
      const outcome: AssistantWorkOutcome = delegation.busySeen !== true ? "stopped" : failed !== undefined ? "failed" : "completed";
      await this.settle(delegation, outcome, failed);
    }
    if (needsConfirm || this.delegations.some((item) => (item.state === "wait" || item.state === "notify") && item.pendingSettleAt !== undefined)) {
      this.armConfirm();
    }
  }

  private clearConfirm(delegation: Delegation): void {
    delete delegation.pendingSettleAt;
    delete delegation.confirmEventId;
  }

  private armConfirm(): void {
    if (this.confirmTimer !== undefined) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      void this.settlePass();
    }, IDLE_RECHECK_MS);
    this.confirmTimer.unref?.();
  }

  private async settle(delegation: Delegation, outcome: AssistantWorkOutcome, forcedError?: string): Promise<void> {
    if (delegation.state !== "wait" && delegation.state !== "notify") return;
    const wasWait = delegation.state === "wait";
    delegation.state = "settled";
    delegation.outcome = outcome;
    delegation.settledAt = this.now();
    this.clearConfirm(delegation);
    const summary = await this.buildSummary(delegation, outcome, forcedError);
    if (summary.targetTitle) delegation.targetTitle = summary.targetTitle;
    if (wasWait) {
      const assistant = this.surface.getRecord(delegation.assistantSessionId);
      if (assistant && !["crashed", "stopped", "stopping"].includes(assistant.status)) {
        try {
          await assistant.workerSend({
            type: "worker.assistantCompletion",
            id: delegation.id,
            payload: {
              sessionId: delegation.assistantSessionId,
              delegationId: delegation.id,
              targetSessionId: delegation.targetSessionId,
              ...(summary.targetTitle === undefined ? {} : { targetTitle: summary.targetTitle }),
              outcome,
              ...(summary.lastText === undefined ? {} : { lastText: summary.lastText }),
              ...(summary.writtenFiles === undefined ? {} : { writtenFiles: summary.writtenFiles }),
              ...(summary.error === undefined ? {} : { error: summary.error }),
            },
          });
          this.persist();
          return;
        } catch { /* worker gone: the receipt becomes a notification instead */ }
      }
    }
    this.enqueue({
      delegationId: delegation.id,
      assistantSessionId: delegation.assistantSessionId,
      targetSessionId: delegation.targetSessionId,
      targetTitle: summary.targetTitle ?? delegation.targetTitle,
      targetCwd: delegation.targetCwd,
      outcome,
      ...(summary.lastText === undefined ? {} : { lastText: summary.lastText }),
      ...(summary.writtenFiles === undefined ? {} : { writtenFiles: summary.writtenFiles }),
      ...(summary.error === undefined ? {} : { error: summary.error }),
      attempts: 0,
    });
  }

  /** Last assistant tail's error, when the catalog has one. Undefined means no failure was recorded. */
  private async tailFailure(sessionId: string): Promise<string | undefined> {
    if (!this.surface.readSessionContext) return undefined;
    try {
      const context = await this.surface.readSessionContext(sessionId, { limit: CONTEXT_TAIL });
      return lastAssistant(context?.entries ?? []).errorMessage;
    } catch {
      return undefined;
    }
  }

  private async buildSummary(delegation: Delegation, outcome: AssistantWorkOutcome, forcedError?: string): Promise<{
    targetTitle?: string;
    lastText?: string;
    writtenFiles?: string[];
    error?: string;
  }> {
    let targetTitle: string | undefined = delegation.targetTitle || undefined;
    if (this.surface.readSessionHeader) {
      try {
        const header = await this.surface.readSessionHeader(delegation.targetSessionId);
        if (header?.title) targetTitle = header.title;
      } catch { /* omit rather than fail the settlement */ }
    }
    let lastText: string | undefined;
    let error: string | undefined = forcedError;
    if (this.surface.readSessionContext) {
      try {
        const context = await this.surface.readSessionContext(delegation.targetSessionId, { limit: CONTEXT_TAIL });
        const tail = lastAssistant(context?.entries ?? []);
        if (tail.text) lastText = tail.text.slice(0, LAST_TEXT_CHARS);
        if (outcome === "failed" && error === undefined) error = tail.errorMessage || "（无错误信息）";
      } catch { /* catalog degradation omits the field */ }
    } else if (outcome === "failed" && error === undefined) {
      error = "（无错误信息）";
    }
    const live = this.surface.getRecord(delegation.targetSessionId);
    const written = live?.writtenFiles().slice(0, WRITTEN_FILE_CAP).map((file) => basename(file)).filter((file) => file.length > 0);
    return {
      ...(targetTitle === undefined ? {} : { targetTitle }),
      ...(lastText === undefined ? {} : { lastText }),
      ...(written === undefined || written.length === 0 ? {} : { writtenFiles: written }),
      ...(error === undefined ? {} : { error }),
    };
  }

  // ---------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------

  private enqueue(item: NotifyItem): void {
    this.queue.push(item);
    this.persist();
    this.armNotify();
  }

  private armNotify(): void {
    if (this.notifyTimer !== undefined || this.queue.length === 0) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      void this.flushNotify();
    }, NOTIFY_MERGE_MS);
    this.notifyTimer.unref?.();
  }

  private async flushNotify(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    const byAssistant = new Map<string, NotifyItem[]>();
    for (const item of batch) {
      const list = byAssistant.get(item.assistantSessionId) ?? [];
      list.push(item);
      byAssistant.set(item.assistantSessionId, list);
    }
    try {
      for (const [assistantId, items] of byAssistant) {
        const delivered = await this.deliverNotification(assistantId, items);
        if (delivered) {
          const chain = this.chainFor(assistantId);
          for (const item of items) {
            const prior = chain.targets[item.targetSessionId] ?? { autoCount: 0, lastNotifyAt: 0 };
            chain.targets[item.targetSessionId] = { autoCount: prior.autoCount, lastNotifyAt: this.now() };
          }
          continue;
        }
        for (const item of items) {
          item.attempts += 1;
          const delegation = this.delegations.find((row) => row.id === item.delegationId);
          if (delegation) delegation.notifyAttempts = item.attempts;
          if (item.attempts >= NOTIFY_ATTEMPT_CAP) {
            if (delegation && delegation.state === "settled") delegation.state = "delivery_failed";
            continue;
          }
          this.queue.push(item);
        }
      }
    } finally {
      this.flushing = false;
      this.persist();
      if (this.queue.length > 0) this.armRetry();
    }
  }

  private armRetry(): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flushNotify();
    }, NOTIFY_RETRY_MS);
    this.retryTimer.unref?.();
  }

  /** One merged prompt per assistant. The notify prefix is NOT the sent marker. */
  private async deliverNotification(assistantId: string, items: NotifyItem[]): Promise<boolean> {
    const prompt = renderNotification(items);
    const assistant = this.surface.getRecord(assistantId);
    const live = assistant !== undefined && !["crashed", "stopped", "stopping"].includes(assistant.status);
    try {
      if (live && assistant.isTurnRunning()) {
        const result = await this.surface.command(assistantId, {
          commandId: `assistant-notify:${randomUUID()}`,
          type: "follow_up",
          message: prompt,
        }, assistant.epoch);
        return result.result.ok;
      }
      const admission = await this.surface.submitTurn(live
        ? { sessionId: assistantId, operationId: `assistant-notify:${randomUUID()}`, prompt, expectedEpoch: assistant.epoch, expectedRevision: assistant.lastEventId }
        : { sessionId: assistantId, operationId: `assistant-notify:${randomUUID()}`, prompt });
      return admission.status !== "rejected";
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  private load(): void {
    let parsed: unknown;
    try {
      if (!existsSync(this.ledgerPath)) return;
      parsed = JSON.parse(readFileSync(this.ledgerPath, "utf8"));
    } catch {
      console.error("[assistant-ops] ledger unreadable; starting empty");
      return;
    }
    if (!isLedger(parsed) || !parsed.queue.every(isNotifyItem) || !parsed.delegations.every(isDelegation) || !chainsValid(parsed.chains)) {
      console.error("[assistant-ops] ledger corrupt; starting empty");
      return;
    }
    this.delegations = parsed.delegations.slice(0, LEDGER_CAP);
    this.chains = new Map(Object.entries(parsed.chains));
    for (const delegation of this.delegations) {
      if (delegation.state !== "wait") continue;
      // The worker that was waiting is gone across a restart. The work
      // itself is unchanged: settlement notifies instead of pushing a
      // completion frame nobody is waiting for.
      delegation.state = "notify";
      delegation.mode = "notify";
    }
    // Undelivered notifications live in the queue. A notify-mode delegation
    // with no queue item is still running and must not be announced.
    this.queue = parsed.queue.map((item) => ({
      ...item,
      attempts: this.delegations.find((row) => row.id === item.delegationId)?.notifyAttempts ?? item.attempts,
    }));
    if (this.queue.length > 0) this.armNotify();
  }

  private persist(): void {
    const file: LedgerFile = {
      version: LEDGER_VERSION,
      delegations: this.delegations.slice(0, LEDGER_CAP),
      chains: Object.fromEntries(this.chains),
      queue: this.queue,
    };
    const tmp = `${this.ledgerPath}.tmp`;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(file) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.ledgerPath);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* leftover tmp is best-effort */ }
      console.error(`[assistant-ops] ledger write failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  private async reply(record: AssistantOpsRecordView, id: string, payload: OpResult): Promise<void> {
    await record.workerSend({ type: "worker.assistantOpResult", id, payload });
  }
}

type OpResultBody =
  | { ok: true; kind: "send"; targetSessionId: string; delivery: AssistantDeliveryPath; delegationId?: string; note: string }
  | { ok: true; kind: "create"; targetSessionId: string; delegationId?: string; note: string }
  | { ok: true; kind: "stop"; stopped: boolean; note: string }
  | { ok: true; kind: "rename"; targetSessionId: string; note: string }
  | { ok: false; kind: WorkerAssistantOpPayload["kind"]; error: OpError };

type OpResult = OpResultBody & { sessionId: string };

function fail(kind: WorkerAssistantOpPayload["kind"], error: OpError): OpResultBody {
  return { ok: false, kind, error };
}

function chainLimitError(): OpError {
  return {
    code: "invalid_input",
    message: "对同一会话的自动接续已达上限（3 次）。请先把结果汇报给用户，等用户回复后再继续安排。",
    retryable: false,
  };
}

function marked(message: string): string {
  return `${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n${message}`;
}

function summarize(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_CHARS ? flat : flat.slice(0, SUMMARY_CHARS);
}

function projectLabel(cwd: string): string {
  const label = basename(cwd);
  return label.length > 0 ? label : cwd;
}

function isDirectory(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

const OP_ERROR_CODES = ["not_found", "invalid_input", "session_busy", "unsupported_capability", "unavailable", "internal"] as const;

/** The op-result frame only carries the assistant error vocabulary. Anything else becomes internal. */
function opError(error: ProtocolError): OpError {
  if ((OP_ERROR_CODES as readonly string[]).includes(error.code)) {
    return { code: error.code as OpError["code"], message: error.message, retryable: error.retryable };
  }
  return { code: "internal", message: error.message, retryable: error.retryable };
}

function mapThrown(error: unknown): OpError {
  if (error !== null && typeof error === "object" && "code" in error && "message" in error) {
    const code = (error as { code: unknown }).code;
    const message = (error as { message: unknown }).message;
    const retryable = (error as { retryable?: unknown }).retryable;
    if (typeof code === "string" && typeof message === "string" && (OP_ERROR_CODES as readonly string[]).includes(code)) {
      return { code: code as OpError["code"], message, retryable: retryable === true };
    }
  }
  return { code: "internal", message: error instanceof Error ? error.message : "assistant op failed", retryable: false };
}

function lastAssistant(entries: Array<{ message?: { role?: string; content?: string | Array<{ type?: string; text?: string }>; errorMessage?: string; stopReason?: string } }>): { text?: string; errorMessage?: string } {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (!message || message.role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : (message.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
    return { ...(text.length > 0 ? { text } : {}), ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}) };
  }
  return {};
}

function renderNotification(items: NotifyItem[]): string {
  const blocks = items.map((item) => {
    const lines = [
      `会话: ${item.targetTitle || item.targetSessionId}｜项目: ${projectLabel(item.targetCwd)}｜id: ${item.targetSessionId}`,
      `结果: ${OUTCOME_LABEL[item.outcome]}`,
    ];
    if (item.lastText) lines.push(`最后回复: ${item.lastText}`);
    if (item.writtenFiles && item.writtenFiles.length > 0) lines.push(`写过的文件: ${item.writtenFiles.join("、")}`);
    if (item.error) lines.push(`错误: ${item.error}`);
    return lines.join("\n");
  });
  return `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n${blocks.join("\n\n")}`;
}

function isLedger(value: unknown): value is LedgerFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { version?: unknown; delegations?: unknown; chains?: unknown; queue?: unknown };
  return record.version === LEDGER_VERSION && Array.isArray(record.delegations) && record.chains !== null
    && typeof record.chains === "object" && !Array.isArray(record.chains) && Array.isArray(record.queue);
}

function isDelegation(value: unknown): value is Delegation {
  if (value === null || typeof value !== "object") return false;
  const row = value as Partial<Delegation>;
  return typeof row.id === "string" && typeof row.assistantSessionId === "string" && typeof row.targetSessionId === "string"
    && typeof row.state === "string" && typeof row.mode === "string";
}

function chainsValid(chains: Record<string, Chain>): boolean {
  return Object.values(chains).every((chain) => {
    if (chain === null || typeof chain !== "object" || typeof chain.lastUserTurnAt !== "number" || chain.targets === null || typeof chain.targets !== "object") return false;
    return Object.values(chain.targets).every((target) => target !== null && typeof target === "object" && typeof target.autoCount === "number" && typeof target.lastNotifyAt === "number");
  });
}

function isNotifyItem(value: unknown): value is NotifyItem {
  if (value === null || typeof value !== "object") return false;
  const row = value as Partial<NotifyItem>;
  return typeof row.delegationId === "string" && typeof row.assistantSessionId === "string"
    && typeof row.targetSessionId === "string" && typeof row.outcome === "string" && typeof row.attempts === "number";
}
