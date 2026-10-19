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
 * Persistence is the `assistantDelegations` namespace of the sessiond-owned
 * workspace-state store (single file, single writer, shared revision — see
 * workspace-state.ts). Settlement and notification delivery are driven by
 * the service's running-state transitions (scheduleSettleCheck) plus a
 * bounded idle-confirm timer. The never-shipped standalone
 * assistant-delegations.json, if present, is imported once and removed.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ASSISTANT_NOTIFY_MESSAGE_PREFIX,
  ASSISTANT_SENT_MESSAGE_PREFIX,
  assistantSentMessageBody,
  type AssistantDeliveryPath,
  type AssistantWorkOutcome,
  type CorrelatedRuntimeCommandResult,
  type ExtensionUiInteractiveMethod,
  type ProtocolError,
  type RuntimeCommand,
  type RuntimeCreateParams,
  type RuntimeCreateResult,
  type RuntimeSubmitTurnParams,
  type SessiondToWorkerMessage,
  type SubmitTurnAdmission,
  type WorkerAssistantOpPayload,
} from "@fffattiger/pix-protocol";
import type { WorkspaceStateStore } from "./workspace-state.js";
import { isAssistantWorkspacePath } from "@fffattiger/pix-runtime-core";

const LEDGER_FILE = "assistant-delegations.json";
const LEDGER_VERSION = 1;
const LEDGER_CAP = 200;
const QUOTA = { send: 5, create: 3, stop: 5 } as const;
const CHAIN_CAP = 3;
/** Auto actions (send/create) per assistant since its last USER turn. */
const AUTO_ACTION_CAP = 3;
const SUMMARY_CHARS = 120;
/** Replies up to this length ride inline in the notification, whole. */
const LAST_TEXT_INLINE_MAX_CHARS = 2_000;
/** Inline preview length when the whole reply goes to a file instead. */
const LAST_TEXT_PREVIEW_CHARS = 600;
/** Preview cap for a user-stop drop note (one queued message, first line). */
const DROPPED_PREVIEW_CHARS = 60;
/** Reply files kept in the sessiond state directory; older ones are removed. */
const REPLY_FILE_KEEP = 100;
/** Subdirectory of the sessiond state directory holding long replies. */
const REPLY_DIR = "assistant-replies";
const WRITTEN_FILE_CAP = 8;
const CONTEXT_TAIL = 24;
const SETTLE_DEBOUNCE_MS = 50;
const IDLE_CONFIRM_MS = 2_500;
const IDLE_RECHECK_MS = 1_000;
const NOTIFY_MERGE_MS = 1_500;
const NOTIFY_RETRY_MS = 5_000;
const NOTIFY_ATTEMPT_CAP = 3;
const NAME_MAX = 200;
/** How long a send waits for cancelled extension UI to leave the projection. */
const UI_RELEASE_WAIT_MS = 2_000;
const UI_RELEASE_POLL_MS = 50;

export interface PendingUiRef { id: string; method: ExtensionUiInteractiveMethod }

/** Live record view the authority needs. The service owns the real record. */
export interface AssistantOpsRecordView {
  sessionId: string;
  cwd: string;
  epoch: string;
  status: string;
  isTurnRunning(): boolean;
  /** Unanswered interactive extension UI (ask/confirm/select/...) the turn is blocked on. */
  pendingExtensionUi(): readonly PendingUiRef[];
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
  /**
   * Sessiond-side authorization for an assistant create_session cwd: the same
   * allowed-roots + project-trust rules the UI create path enforces, so the
   * check does not depend on the worker-side tool filter alone. Absent in
   * test harnesses; the production daemon composition always wires it.
   */
  authorizeCreateCwd?(cwd: string): Promise<AssistantCreateGuardResult>;
}

/** Result of the sessiond-side assistant-create cwd authorization. */
export type AssistantCreateGuardResult =
  | { ok: true; cwd: string }
  | { ok: false; error: { code: "invalid_input" | "unavailable"; message: string; retryable: boolean } };

export interface AssistantOpsOptions {
  surface: AssistantOpsSurface;
  /** Unified sessiond organization-state store (single file, writer, revision).
   * The ledger lives in its `assistantDelegations` namespace. */
  store: WorkspaceStateStore;
  /** Directory that may still hold the never-shipped standalone ledger file
   * (round-7 dev builds only). Imported once on construction, then removed. */
  legacyDirectory?: string;
  /** Sessiond state directory for long-reply files (`assistant-replies/`).
   * Defaults to {@link legacyDirectory}, which the daemon derives from the
   * same runtime directory the other state files live in. Absent → long
   * replies degrade to a preview with no file. */
  stateDirectory?: string;
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
  /**
   * Delivery attempts already spent on the notification (0..NOTIFY_ATTEMPT_CAP).
   * When the state is delivery_failed this also parks the redelivery until
   * the assistant worker is (re)loaded.
   */
  notifyAttempts?: number;
  /** Rendered notification fields retained for a redelivery after the queue
   * item was dropped (set when the settlement first enqueued). */
  notifyLastText?: string;
  /** Absolute path of the full reply file (only for replies over the inline cap). */
  notifyLastTextPath?: string;
  notifyLastTextChars?: number;
  notifyWrittenFiles?: string[];
  notifyError?: string;
  /** Set when a user stop dropped this delegation's still-queued message before
   * it was ever delivered: the settlement reports `stopped` with this preview
   * instead of a fabricated completion. */
  userStopDropped?: string;
}

interface ChainTarget {
  autoCount: number;
  lastNotifyAt: number;
}

interface Chain {
  lastUserTurnAt: number;
  /** Notification-triggered actions (send + create) since the last user turn. */
  autoTotal: number;
  /** Last time ANY completion notification was delivered to this assistant. */
  lastNotifyAt: number;
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
  lastTextPath?: string;
  lastTextChars?: number;
  writtenFiles?: string[];
  error?: string;
  /** Preview of the assistant's own message dropped from the target's runtime
   * queue by a user stop (present only on such `stopped` settlements). */
  droppedPreview?: string;
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
  private readonly store: WorkspaceStateStore;
  private readonly legacyLedgerPath: string | undefined;
  private readonly stateDirectory: string | undefined;
  private readonly homedir: string;
  private readonly now: () => number;
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
    this.store = options.store;
    this.legacyLedgerPath = options.legacyDirectory === undefined ? undefined : join(options.legacyDirectory, LEDGER_FILE);
    this.stateDirectory = options.stateDirectory ?? options.legacyDirectory;
    this.homedir = options.homedir;
    this.now = options.now ?? Date.now;
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

  /**
   * A pending wait was cancelled. The work continues; settlement notifies.
   * Identity-bound: the cancel only lands when the requesting worker IS the
   * assistant-workspace session the payload names — a different worker that
   * guesses ids gets a silent no-op, never a state change.
   */
  handleWaitCancel(record: AssistantOpsRecordView, payload: { sessionId: string; delegationId: string }): void {
    if (payload.sessionId !== record.sessionId) return;
    if (!isAssistantWorkspacePath(record.cwd, this.homedir)) return;
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

  /**
   * The user stopped a session's running turn (abort) and the service dropped
   * the assistant's still-queued messages from that session's runtime queue —
   * the SDK keeps them across an abort and they would otherwise be delivered
   * as the next turn, reviving a session the user explicitly stopped. Mark the
   * matching pending delegations so their settlement is an honest `stopped`
   * carrying what never arrived (preview-capped), instead of a fabricated
   * completion from whatever the aborted turn's tail looks like. Matching is
   * one-to-one on the delegation summary (the exact body the assistant sent);
   * a drop with no matching pending delegation is a no-op.
   */
  noteUserStopDroppedMessages(targetSessionId: string, droppedTexts: readonly string[]): void {
    if (this.disposed || droppedTexts.length === 0) return;
    const candidates = this.delegations.filter((row) => row.targetSessionId === targetSessionId
      && (row.state === "wait" || row.state === "notify") && row.userStopDropped === undefined);
    if (candidates.length === 0) return;
    let changed = false;
    for (const text of droppedTexts) {
      const body = assistantSentMessageBody(text);
      if (body.trim().length === 0) continue;
      const match = candidates.find((row) => row.summary === summarize(body));
      if (match === undefined) continue;
      match.userStopDropped = droppedPreviewOf(body);
      candidates.splice(candidates.indexOf(match), 1);
      changed = true;
    }
    if (!changed) return;
    this.persist();
    this.scheduleSettleCheck();
  }

  /**
   * The assistant worker became (re)available. A delegation whose
   * notification exhausted its delivery attempts gets exactly ONE more ride
   * per load: success delivers it, failure parks it again until the next
   * load. Never fabricates a notification for a healthy queue — only
   * delivery_failed rows are considered.
   */
  noteAssistantReady(sessionId: string): void {
    if (this.disposed) return;
    const parked = this.delegations.filter((row) => row.state === "delivery_failed" && row.assistantSessionId === sessionId);
    if (parked.length === 0) return;
    for (const delegation of parked) {
      delegation.state = "settled";
      delegation.notifyAttempts = NOTIFY_ATTEMPT_CAP - 1;
      this.queue.push({
        delegationId: delegation.id,
        assistantSessionId: delegation.assistantSessionId,
        targetSessionId: delegation.targetSessionId,
        targetTitle: delegation.targetTitle,
        targetCwd: delegation.targetCwd,
        outcome: delegation.outcome ?? "completed",
        ...(delegation.notifyLastText === undefined ? {} : { lastText: delegation.notifyLastText }),
        ...(delegation.notifyLastTextPath === undefined ? {} : { lastTextPath: delegation.notifyLastTextPath }),
        ...(delegation.notifyLastTextChars === undefined ? {} : { lastTextChars: delegation.notifyLastTextChars }),
        ...(delegation.notifyWrittenFiles === undefined || delegation.notifyWrittenFiles.length === 0 ? {} : { writtenFiles: delegation.notifyWrittenFiles }),
        ...(delegation.notifyError === undefined ? {} : { error: delegation.notifyError }),
        ...(delegation.userStopDropped === undefined ? {} : { droppedPreview: delegation.userStopDropped }),
        attempts: NOTIFY_ATTEMPT_CAP - 1,
      });
    }
    this.persist();
    this.armNotify();
  }

  /** Coalesce running-state transitions into one settlement pass. */
  scheduleSettleCheck(): void {
    if (this.settleTimer !== undefined) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      void this.settlePass().catch((error) => {
        console.error(`[assistant-ops] settle pass failed: ${error instanceof Error ? error.stack : String(error)}`);
      });
    }, SETTLE_DEBOUNCE_MS);
    this.settleTimer.unref?.();
  }

  /** Drop every armed timer. Tests and shutdown use this; nothing else leaks. */
  private disposed = false;

  dispose(): void {
    this.disposed = true;
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
    if (op.targetSessionId === record.sessionId) {
      return fail("send", { code: "invalid_input", message: "不能以助手会话自身为目标", retryable: false });
    }
    const target = this.surface.getRecord(op.targetSessionId);
    if (target && isAssistantWorkspacePath(target.cwd, this.homedir)) {
      return fail("send", { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false });
    }
    // Reserve the slot BEFORE any await: parallel tool calls inside one turn
    // must not both pass an after-the-fact peek. Failure paths give it back.
    const quota = this.reserveQuota(record, "send");
    if (quota) return fail("send", quota);
    const located = await this.surface.locate(op.targetSessionId);
    if (!located.exists && !target) {
      this.releaseQuota(record, "send");
      return fail("send", { code: "not_found", message: "session not found", retryable: false });
    }
    // Cold target (no live record): the session header still names its cwd —
    // an assistant-workspace conversation is never a valid target, cold or not.
    const coldGuard = target === undefined ? await this.assistantWorkspaceHeader(op.targetSessionId) : false;
    if (coldGuard) {
      this.releaseQuota(record, "send");
      return fail("send", { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false });
    }
    // Only a send that CONTINUES a just-delivered notification spends the
    // auto-continuation cap. A user-originated send (no notification since the
    // last user turn) is not a continuation and is not counted here.
    const continuing = this.pendingContinuation(record.sessionId, op.targetSessionId);
    if (continuing && !this.reserveChain(record.sessionId, op.targetSessionId)) {
      this.releaseQuota(record, "send");
      return fail("send", chainLimitError());
    }
    // Any action after a delivered notification also spends the assistant-wide
    // auto-action budget, so a burst of notifications cannot fan out into an
    // unbounded autonomous chain across many targets.
    const auto = this.autoPending(record.sessionId);
    if (auto) {
      const autoError = this.reserveAutoAction(record.sessionId);
      if (autoError) {
        this.releaseQuota(record, "send");
        if (continuing) this.releaseChain(record.sessionId, op.targetSessionId);
        return fail("send", autoError);
      }
    }
    const message = marked(op.message);
    const routed = await this.routePrompt(target, op.targetSessionId, message, op.delivery);
    if (!routed.ok) {
      this.releaseQuota(record, "send");
      if (continuing) this.releaseChain(record.sessionId, op.targetSessionId);
      if (auto) this.releaseAutoAction(record.sessionId);
      return fail("send", routed.error);
    }
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
    if (!isDirectory(op.cwd)) {
      return fail("create", { code: "invalid_input", message: "cwd is not a directory", retryable: false });
    }
    // Sessiond-side authorization BEFORE creating anything: allowed roots +
    // project trust, the same rules the UI create path enforces. Never rely
    // on the worker-side tool filter alone.
    if (this.surface.authorizeCreateCwd) {
      let guard: AssistantCreateGuardResult;
      try {
        guard = await this.surface.authorizeCreateCwd(op.cwd);
      } catch {
        return fail("create", { code: "unavailable", message: "无法校验新建会话的项目路径", retryable: true });
      }
      if (!guard.ok) return fail("create", guard.error);
    }
    // Reserve first (parallel create_session calls in one turn must not both
    // pass the cap); every failure path below gives the slot back.
    const quota = this.reserveQuota(record, "create");
    if (quota) return fail("create", quota);
    // A create fired off the back of a delivered notification spends the same
    // assistant-wide auto-action budget as a continuation send.
    const auto = this.autoPending(record.sessionId);
    if (auto) {
      const autoError = this.reserveAutoAction(record.sessionId);
      if (autoError) {
        this.releaseQuota(record, "create");
        return fail("create", autoError);
      }
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
      this.releaseQuota(record, "create");
      if (auto) this.releaseAutoAction(record.sessionId);
      return fail("create", mapThrown(error));
    }
    const target = this.surface.getRecord(created.sessionId);
    if (target && isAssistantWorkspacePath(target.cwd, this.homedir)) {
      this.releaseQuota(record, "create");
      if (auto) this.releaseAutoAction(record.sessionId);
      return fail("create", { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false });
    }
    const routed = await this.routePrompt(target, created.sessionId, marked(op.message), "follow_up");
    if (!routed.ok) {
      this.releaseQuota(record, "create");
      if (auto) this.releaseAutoAction(record.sessionId);
      return fail("create", routed.error);
    }
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
    const guard = await this.guardManagedTarget(record, op.targetSessionId);
    if (guard) return fail("stop", guard);
    const located = await this.surface.locate(op.targetSessionId);
    if (!located.exists && !this.surface.getRecord(op.targetSessionId)) {
      return fail("stop", { code: "not_found", message: "session not found", retryable: false });
    }
    const quota = this.reserveQuota(record, "stop");
    if (quota) return fail("stop", quota);
    const stopped = await this.surface.stop(op.targetSessionId, "user");
    return {
      ok: true,
      kind: "stop",
      stopped,
      note: stopped ? "已停止该会话当前这一轮" : "该会话当前没有运行中的轮次",
    };
  }

  private async executeRename(record: AssistantOpsRecordView, op: Extract<WorkerAssistantOpPayload, { kind: "rename" }>): Promise<OpResultBody> {
    const guard = await this.guardManagedTarget(record, op.targetSessionId);
    if (guard) return fail("rename", guard);
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
   * Shared managed-target guard for stop/rename (and the send cold path):
   * the assistant may never target ITSELF or any assistant-workspace
   * conversation, whether the record is live or cold (header cwd).
   */
  private async guardManagedTarget(record: AssistantOpsRecordView, targetSessionId: string): Promise<OpError | undefined> {
    if (targetSessionId === record.sessionId) {
      return { code: "invalid_input", message: "不能以助手会话自身为目标", retryable: false };
    }
    const target = this.surface.getRecord(targetSessionId);
    if (target !== undefined) {
      return isAssistantWorkspacePath(target.cwd, this.homedir)
        ? { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false }
        : undefined;
    }
    return (await this.assistantWorkspaceHeader(targetSessionId))
      ? { code: "invalid_input", message: "不能以助手工作区中的会话为目标", retryable: false }
      : undefined;
  }

  /** True when a COLD session's recorded cwd is the assistant workspace. */
  private async assistantWorkspaceHeader(sessionId: string): Promise<boolean> {
    if (!this.surface.readSessionHeader) return false;
    try {
      const header = await this.surface.readSessionHeader(sessionId);
      return header?.cwd !== undefined && isAssistantWorkspacePath(header.cwd, this.homedir);
    } catch {
      return false;
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
      await this.releasePendingUi(target, sessionId);
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

  /**
   * A turn blocked on an unanswered ask/confirm never reaches its queued
   * steer/follow-up: the agent loop only drains the queue after the tool
   * returns. The assistant speaks for the user here, so cancel that UI the
   * way the user's Cancel button does (after queueing the message, so the
   * agent reads it as soon as the tool returns), then wait for the
   * projection to drop it so settlement does not mistake the cancelled
   * prompt for a fresh waiting_user.
   */
  private async releasePendingUi(target: AssistantOpsRecordView, sessionId: string): Promise<void> {
    const pending = target.pendingExtensionUi();
    if (pending.length === 0 || !target.capabilities().includes("runtime.extension_ui")) return;
    for (const request of pending) {
      await this.surface.command(sessionId, {
        commandId: `assistant-op:${randomUUID()}`,
        type: "extension_ui_response",
        id: request.id,
        method: request.method,
        responseKind: "cancelled",
        cancelled: true,
      }, target.epoch);
    }
    const ids = new Set(pending.map((request) => request.id));
    const deadline = Date.now() + UI_RELEASE_WAIT_MS;
    while (Date.now() < deadline && target.pendingExtensionUi().some((request) => ids.has(request.id))) {
      await new Promise((resolve) => setTimeout(resolve, UI_RELEASE_POLL_MS));
    }
  }

  // ---------------------------------------------------------------------
  // Quota + chain
  // ---------------------------------------------------------------------

  private quotaKey(record: AssistantOpsRecordView): string {
    return `${record.sessionId}:${record.runningOperationId() ?? `epoch:${record.epoch}`}`;
  }

  /**
   * Reserve one slot BEFORE the op executes, so parallel ops in the same turn
   * cannot both pass the cap (TOCTOU). Returns the rejection error when the
   * cap is already spent; failure paths must call {@link releaseQuota}.
   */
  private reserveQuota(record: AssistantOpsRecordView, kind: "send" | "create" | "stop"): OpError | undefined {
    const key = this.quotaKey(record);
    const bucket = this.quota.get(key) ?? { send: 0, create: 0, stop: 0 };
    if (bucket[kind] >= QUOTA[kind]) {
      return { code: "invalid_input", message: QUOTA_MESSAGES[kind], retryable: false };
    }
    bucket[kind] += 1;
    this.quota.set(key, bucket);
    return undefined;
  }

  /** Give a reserved slot back when the op it was held for did not land. */
  private releaseQuota(record: AssistantOpsRecordView, kind: "send" | "create" | "stop"): void {
    const bucket = this.quota.get(this.quotaKey(record));
    if (bucket === undefined || bucket[kind] <= 0) return;
    bucket[kind] -= 1;
  }

  /** True when a notification for this target was delivered after the assistant's last user turn. */
  private pendingContinuation(assistantId: string, targetId: string): boolean {
    const chain = this.chains.get(assistantId);
    const prior = chain?.targets[targetId];
    return prior !== undefined && prior.lastNotifyAt > (chain?.lastUserTurnAt ?? 0);
  }

  /**
   * True when ANY completion notification was delivered after the assistant's
   * last user turn: actions now are notification-triggered (autonomous), not
   * direct answers to the user.
   */
  private autoPending(assistantId: string): boolean {
    const chain = this.chains.get(assistantId);
    return chain !== undefined && chain.lastNotifyAt > chain.lastUserTurnAt;
  }

  /**
   * Reserve one assistant-wide auto action before it executes, so overlapping
   * ops cannot both pass the cap. Returns the rejection error at the cap.
   */
  private reserveAutoAction(assistantId: string): OpError | undefined {
    const chain = this.chainFor(assistantId);
    if (chain.autoTotal >= AUTO_ACTION_CAP) return autoActionLimitError();
    chain.autoTotal += 1;
    this.persist();
    return undefined;
  }

  /** Give an auto-action reservation back when the op it counted did not land. */
  private releaseAutoAction(assistantId: string): void {
    const chain = this.chains.get(assistantId);
    if (!chain || chain.autoTotal < 1) return;
    chain.autoTotal -= 1;
    this.persist();
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
    const created: Chain = { lastUserTurnAt: 0, autoTotal: 0, lastNotifyAt: 0, targets: {} };
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
    const chain = this.chainFor(sessionId);
    chain.lastUserTurnAt = this.now();
    chain.autoTotal = 0;
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
      // The target may already be mid-turn when the op lands. A later settle
      // pass that only sees it idle would otherwise report a stop.
      ...(this.surface.getRecord(input.targetSessionId)?.isTurnRunning() === true ? { busySeen: true } : {}),
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
      if (!target) {
        // No live record — after a sessiond restart every record is cold.
        // A deleted session is an honest stop; a session that still exists
        // gets its outcome from the journal (the settle pass that should have
        // reported it may have died with the daemon), never a blanket "stopped".
        const located = await this.surface.locate(delegation.targetSessionId);
        if (!located.exists) {
          await this.settle(delegation, "stopped");
          continue;
        }
        const failed = delegation.busySeen === true ? await this.tailFailure(delegation.targetSessionId) : undefined;
        const outcome: AssistantWorkOutcome = delegation.userStopDropped !== undefined ? "stopped"
          : delegation.busySeen !== true
            ? "stopped"
            : failed !== undefined
              ? "failed"
              : (await this.tailCompleted(delegation.targetSessionId)) ? "completed" : "stopped";
        await this.settle(delegation, outcome, failed);
        continue;
      }
      if (target.status === "stopped" || target.status === "stopping") {
        await this.settle(delegation, "stopped");
        continue;
      }
      if (target.status === "crashed") {
        await this.settle(delegation, delegation.userStopDropped !== undefined ? "stopped" : "failed", "会话异常退出");
        continue;
      }
      if (target.pendingExtensionUi().length > 0) {
        this.clearConfirm(delegation);
        // A user stop already dropped this delegation's queued message: the ask
        // belongs to an earlier turn, so the honest outcome is the stop, not
        // waiting_user (which would claim the target is waiting for input).
        await this.settle(delegation, delegation.userStopDropped === undefined ? "waiting_user" : "stopped");
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
      if (target.isTurnRunning() || target.pendingExtensionUi().length > 0 || target.lastEventId !== delegation.confirmEventId) {
        this.clearConfirm(delegation);
        needsConfirm = true;
        continue;
      }
      // Idle after real work. A failed assistant tail is "failed"; idle
      // without ever having been busy is an honest stop — never a fabricated
      // completion. The catalog read degrades to "completed" when absent.
      // A user-stop drop is always "stopped": the delegated message never
      // ran, whatever the aborted turn's tail looks like.
      const failed = delegation.busySeen === true ? await this.tailFailure(delegation.targetSessionId) : undefined;
      const outcome: AssistantWorkOutcome = delegation.userStopDropped !== undefined ? "stopped"
        : delegation.busySeen !== true ? "stopped" : failed !== undefined ? "failed" : "completed";
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
    // The user-stop drop note (if any) travels on every settlement channel:
    // the wait receipt frame and the queued notification alike.
    const droppedPreview = delegation.userStopDropped;
    // Retain the rendered fields so a redelivery (noteAssistantReady) can
    // rebuild the queue item exactly.
    if (summary.lastText !== undefined) delegation.notifyLastText = summary.lastText;
    if (summary.lastTextPath !== undefined) delegation.notifyLastTextPath = summary.lastTextPath;
    if (summary.lastTextChars !== undefined) delegation.notifyLastTextChars = summary.lastTextChars;
    if (summary.writtenFiles !== undefined) delegation.notifyWrittenFiles = summary.writtenFiles;
    if (summary.error !== undefined) delegation.notifyError = summary.error;
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
              ...(summary.lastTextPath === undefined ? {} : { lastTextPath: summary.lastTextPath }),
              ...(summary.lastTextChars === undefined ? {} : { lastTextChars: summary.lastTextChars }),
              ...(summary.writtenFiles === undefined ? {} : { writtenFiles: summary.writtenFiles }),
              ...(summary.error === undefined ? {} : { error: summary.error }),
              ...(droppedPreview === undefined ? {} : { droppedPreview }),
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
      ...(summary.lastTextPath === undefined ? {} : { lastTextPath: summary.lastTextPath }),
      ...(summary.lastTextChars === undefined ? {} : { lastTextChars: summary.lastTextChars }),
      ...(summary.writtenFiles === undefined ? {} : { writtenFiles: summary.writtenFiles }),
      ...(summary.error === undefined ? {} : { error: summary.error }),
      ...(droppedPreview === undefined ? {} : { droppedPreview }),
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

  /**
   * True when the session's last assistant entry PROVES a finished turn (a
   * normal stopReason, not aborted/error). Used only for cold targets whose
   * live record is gone: absent proof the settlement stays an honest "stopped".
   */
  private async tailCompleted(sessionId: string): Promise<boolean> {
    if (!this.surface.readSessionContext) return false;
    try {
      const context = await this.surface.readSessionContext(sessionId, { limit: CONTEXT_TAIL });
      const stopReason = lastAssistant(context?.entries ?? []).stopReason;
      return stopReason !== undefined && stopReason !== "aborted" && stopReason !== "error";
    } catch {
      return false;
    }
  }

  private async buildSummary(delegation: Delegation, outcome: AssistantWorkOutcome, forcedError?: string): Promise<{
    targetTitle?: string;
    lastText?: string;
    lastTextPath?: string;
    lastTextChars?: number;
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
    let lastTextPath: string | undefined;
    let lastTextChars: number | undefined;
    let error: string | undefined = forcedError;
    if (this.surface.readSessionContext) {
      try {
        const context = await this.surface.readSessionContext(delegation.targetSessionId, { limit: CONTEXT_TAIL });
        const tail = lastAssistant(context?.entries ?? []);
        if (tail.text) {
          // Short replies ride inline whole; long ones become a readable file
          // so Pixie can `read` the rest instead of silently losing it.
          const reply = this.persistAssistantReply(delegation.targetSessionId, tail.text);
          lastText = reply.lastText;
          if (reply.lastTextPath !== undefined) lastTextPath = reply.lastTextPath;
          if (reply.lastTextChars !== undefined) lastTextChars = reply.lastTextChars;
        }
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
      ...(lastTextPath === undefined ? {} : { lastTextPath }),
      ...(lastTextChars === undefined ? {} : { lastTextChars }),
      ...(written === undefined || written.length === 0 ? {} : { writtenFiles: written }),
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Decide how much of the reply the notification carries. Under the inline
   * cap it is the whole text. Over it, the full text is written to
   * `<stateDirectory>/assistant-replies/<sessionId>-<epoch-ms>.md` (0600, dir
   * 0700, atomic rename) and only a preview + the absolute path travel. A
   * failed write degrades to the preview with no path — never a failed
   * notification.
   */
  private persistAssistantReply(sessionId: string, text: string): { lastText: string; lastTextPath?: string; lastTextChars?: number } {
    if (text.length <= LAST_TEXT_INLINE_MAX_CHARS) return { lastText: text };
    const preview = text.slice(0, LAST_TEXT_PREVIEW_CHARS);
    const path = this.writeReplyFile(sessionId, text);
    return path === undefined ? { lastText: preview } : { lastText: preview, lastTextPath: path, lastTextChars: text.length };
  }

  /** Write the full reply, prune old ones, and return the absolute path (or undefined on failure). */
  private writeReplyFile(sessionId: string, text: string): string | undefined {
    if (this.stateDirectory === undefined) return undefined;
    const directory = join(this.stateDirectory, REPLY_DIR);
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    const target = join(directory, `${safeSessionId}-${this.now()}.md`);
    const tmp = `${target}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const handle = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(handle, text, "utf8");
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(tmp, target);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* staging file may not exist */ }
      console.error(`[assistant-ops] reply file write failed: ${error instanceof Error ? error.message : "unknown"}`);
      return undefined;
    }
    this.pruneReplyFiles(directory);
    return target;
  }

  /** Keep only the newest {@link REPLY_FILE_KEEP} reply files; pruning is best-effort. */
  private pruneReplyFiles(directory: string): void {
    try {
      const files = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => {
          try {
            return { name: entry.name, mtime: statSync(join(directory, entry.name)).mtimeMs };
          } catch {
            return { name: entry.name, mtime: 0 };
          }
        })
        .sort((left, right) => right.mtime - left.mtime);
      for (const file of files.slice(REPLY_FILE_KEEP)) {
        try { unlinkSync(join(directory, file.name)); } catch { /* already gone */ }
      }
    } catch (error) {
      console.error(`[assistant-ops] reply prune failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  // ---------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------

  private enqueue(item: NotifyItem): void {
    this.queue.push(item);
    this.persist();
    // Arm once per quiet period. Items that arrive while the window is open
    // join the same batch; re-arming here would split one burst into one
    // notification per item.
    if (this.notifyTimer === undefined && !this.flushing) this.armNotify();
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
    if (this.disposed || this.flushing || this.queue.length === 0) return;
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
          chain.lastNotifyAt = this.now();
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
      // Persist even while disposed: the batch was already spliced out of the
      // in-memory queue, so skipping the write would leave the on-disk ledger
      // claiming those notifications are still pending — a restart would
      // deliver them a second time.
      this.persist();
      if (!this.disposed && this.queue.length > 0) this.armRetry();
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
    const stored = this.store.readAssistantDelegations();
    if (stored !== undefined) {
      // Namespace semantics belong HERE (the owner), never to the store: a
      // semantically-broken value degrades to empty without touching the
      // user's pin/archive flags in the same file.
      if (!this.applyLedger(stored)) console.error("[assistant-ops] delegation namespace invalid; starting empty");
      return;
    }
    this.importLegacyLedger();
  }

  /** One-time import of the never-shipped standalone ledger (round-7 dev
   * trees only). On success the namespace becomes authoritative and the old
   * file is removed; an unreadable/invalid file is LEFT IN PLACE (never
   * destroyed — the operator can inspect it) and the ledger starts empty. */
  private importLegacyLedger(): void {
    if (this.legacyLedgerPath === undefined) return;
    let parsed: unknown;
    try {
      if (!existsSync(this.legacyLedgerPath)) return;
      parsed = JSON.parse(readFileSync(this.legacyLedgerPath, "utf8"));
    } catch {
      console.error("[assistant-ops] legacy ledger unreadable; leaving the file in place");
      return;
    }
    if (!this.applyLedger(parsed)) {
      console.error("[assistant-ops] legacy ledger invalid; leaving the file in place");
      return;
    }
    this.persist();
    try {
      unlinkSync(this.legacyLedgerPath);
    } catch {
      // Removal is best-effort: the namespace is now authoritative and the
      // next construction sees it populated, so the stale file is inert.
    }
  }

  /** Validate and adopt a ledger value (shared by the namespace and the
   * legacy import). Returns false without mutating anything on a bad shape. */
  private applyLedger(parsed: unknown): boolean {
    if (!isLedger(parsed) || !parsed.queue.every(isNotifyItem) || !parsed.delegations.every(isDelegation) || !chainsValid(parsed.chains)) {
      return false;
    }
    this.delegations = parsed.delegations.slice(0, LEDGER_CAP);
    // Additive chain counters (autoTotal / chain-level lastNotifyAt) default to
    // zero on ledgers persisted before they existed — never a rejection.
    this.chains = new Map(Object.entries(parsed.chains).map(([assistantId, chain]) => [assistantId, {
      lastUserTurnAt: chain.lastUserTurnAt,
      autoTotal: nonNegativeNumber(chain.autoTotal),
      lastNotifyAt: nonNegativeNumber(chain.lastNotifyAt),
      targets: chain.targets,
    }]));
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
    return true;
  }

  private persist(): void {
    try {
      this.store.writeAssistantDelegations({
        version: LEDGER_VERSION,
        delegations: this.delegations.slice(0, LEDGER_CAP),
        chains: Object.fromEntries(this.chains),
        queue: this.queue,
      });
    } catch (error) {
      // Store write failed (unavailable): the in-memory ledger stays intact
      // and the next mutation retries — never a fake success, never a crash.
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

function autoActionLimitError(): OpError {
  return {
    code: "invalid_input",
    message: "自上次用户发言以来，由完成通知触发的自动动作（send/create）已达上限（3 次）。请先把当前结果汇报给用户，等用户回复后再继续。",
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

/** Preview of a user-stop-dropped message: flattened, capped at 60 chars. */
function droppedPreviewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= DROPPED_PREVIEW_CHARS ? flat : `${flat.slice(0, DROPPED_PREVIEW_CHARS)}…`;
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

function lastAssistant(entries: Array<{ message?: { role?: string; content?: string | Array<{ type?: string; text?: string }>; errorMessage?: string; stopReason?: string } }>): { text?: string; errorMessage?: string; stopReason?: string } {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (!message || message.role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : (message.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
    return {
      ...(text.length > 0 ? { text } : {}),
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
    };
  }
  return {};
}

function renderNotification(items: NotifyItem[]): string {
  const blocks = items.map((item) => {
    const lines = [
      `会话: ${item.targetTitle || item.targetSessionId}｜项目: ${projectLabel(item.targetCwd)}｜id: ${item.targetSessionId}`,
      `结果: ${OUTCOME_LABEL[item.outcome]}`,
    ];
    if (item.droppedPreview !== undefined && item.droppedPreview.length > 0) {
      lines.push(`你发的这条消息当时还在队列里，因会话被用户停止而未送达：「${item.droppedPreview}」（需要时可重新发送）`);
    }
    if (item.lastText) lines.push(`最后回复: ${item.lastText}`);
    if (item.lastTextPath) {
      const count = item.lastTextChars === undefined ? "全文" : `全文 ${item.lastTextChars} 字`;
      lines.push(`（${count}已保存到 ${item.lastTextPath}，需要时用 read 读取）`);
    }
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
    && typeof row.targetSessionId === "string" && typeof row.targetTitle === "string" && typeof row.targetCwd === "string"
    && typeof row.outcome === "string" && typeof row.attempts === "number";
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
