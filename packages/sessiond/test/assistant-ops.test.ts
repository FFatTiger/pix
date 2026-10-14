/**
 * Round 7: assistant write channel. The authority is tested against a fake
 * surface and a controllable clock — no worker, no sessiond service — so
 * routing, quota, chains, settlement and the ledger are deterministic.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX, type CorrelatedRuntimeCommandResult, type ProtocolError, type RuntimeCommand, type RuntimeCreateParams, type RuntimeCreateResult, type RuntimeSubmitTurnParams, type SubmitTurnAdmission } from "@fffattiger/pix-protocol";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";
import { AssistantOpsAuthority, type AssistantOpsRecordView, type AssistantOpsSurface } from "../src/assistant-ops.js";

const HOME = "/Users/proxy";
const ASSISTANT_CWD = resolveAssistantWorkspaceDir(HOME);
const PREFIX = ASSISTANT_SENT_MESSAGE_PREFIX;

interface FakeRecord {
  sessionId: string;
  cwd: string;
  epoch: string;
  status: string;
  running: boolean;
  pendingUi: number;
  lastEventId: number;
  capabilities: string[];
  operationId: string | null;
  writtenFiles: string[];
  sent: Array<{ type: string; id?: string; payload?: unknown }>;
}

interface SubmitCall { input: RuntimeSubmitTurnParams }
interface CommandCall { sessionId: string; command: { commandId: string; type: "steer" | "follow_up"; message: string }; epoch?: string }

class FakeSurface implements AssistantOpsSurface {
  records = new Map<string, FakeRecord>();
  exists = new Set<string>();
  submits: SubmitCall[] = [];
  commands: CommandCall[] = [];
  creates: Array<{ cwd: string; name?: string }> = [];
  stops: string[] = [];
  renames: Array<{ sessionId: string; name: string }> = [];
  headers = new Map<string, { title?: string; cwd?: string } | null>();
  contexts = new Map<string, Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }>; errorMessage?: string }>>();
  submitError: ProtocolError | undefined;
  commandOk = true;
  commandError: ProtocolError = { code: "session_busy", message: "busy", retryable: true };
  createSessionId = "created-1";
  stopResult = true;
  getRecord(sessionId: string): AssistantOpsRecordView | undefined {
    const record = this.records.get(sessionId);
    return record === undefined ? undefined : view(record);
  }
  async submitTurn(input: RuntimeSubmitTurnParams): Promise<SubmitTurnAdmission> {
    this.submits.push({ input: { sessionId: input.sessionId, prompt: input.prompt, operationId: input.operationId, ...(input.expectedEpoch === undefined ? {} : { expectedEpoch: input.expectedEpoch }), ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) } });
    if (this.submitError) {
      return { status: "rejected", delivery: "not_delivered", sessionId: input.sessionId, operationId: input.operationId, error: this.submitError };
    }
    return { status: "accepted" } as SubmitTurnAdmission;
  }
  async command(sessionId: string, command: RuntimeCommand, epoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    const kind = command.type === "steer" ? "steer" as const : "follow_up" as const;
    const message = "message" in command && typeof command.message === "string" ? command.message : "";
    this.commands.push({ sessionId, command: { commandId: command.commandId, type: kind, message }, ...(epoch === undefined ? {} : { epoch }) });
    if (!this.commandOk) {
      return { commandId: command.commandId, result: { ok: false, type: kind, error: this.commandError } };
    }
    return { commandId: command.commandId, result: { ok: true, type: kind } };
  }
  async create(input: RuntimeCreateParams) {
    this.creates.push({ cwd: input.cwd, ...(input.name === undefined ? {} : { name: input.name }) });
    const record = makeRecord(this.createSessionId, input.cwd);
    this.records.set(record.sessionId, record);
    this.exists.add(record.sessionId);
    return { sessionId: record.sessionId, epoch: record.epoch, created: true, cwd: input.cwd, projectRoot: input.cwd, workerStatus: "ready", lastEventId: 0 } satisfies RuntimeCreateResult;
  }
  async stop(sessionId: string) {
    this.stops.push(sessionId);
    if (this.stopResult) this.records.delete(sessionId);
    return this.stopResult;
  }
  async renameSession(sessionId: string, name: string) {
    this.renames.push({ sessionId, name });
    return { sessionId, name };
  }
  async locate(sessionId: string) { return { exists: this.exists.has(sessionId) || this.records.has(sessionId) }; }
  async readSessionHeader(sessionId: string) { return this.headers.has(sessionId) ? this.headers.get(sessionId)! : null; }
  async readSessionContext(sessionId: string) {
    const entries = this.contexts.get(sessionId);
    return entries === undefined ? null : { entries: entries.map((message) => ({ message })) };
  }
}

function makeRecord(sessionId: string, cwd: string, overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    sessionId, cwd, epoch: `epoch-${sessionId}`, status: "ready", running: false, pendingUi: 0,
    lastEventId: 0, capabilities: ["runtime.prompt", "runtime.steer", "runtime.follow_up"],
    operationId: null, writtenFiles: [], sent: [], ...overrides,
  };
}

function view(record: FakeRecord): AssistantOpsRecordView {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    epoch: record.epoch,
    status: record.status,
    isTurnRunning: () => record.running,
    pendingExtensionUi: () => record.pendingUi,
    get lastEventId() { return record.lastEventId; },
    capabilities: () => record.capabilities,
    runningOperationId: () => record.operationId,
    writtenFiles: () => record.writtenFiles,
    workerSend: async (message) => { record.sent.push(message as FakeRecord["sent"][number]); },
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-"));
  const surface = new FakeSurface();
  let clock = 1_000_000;
  const authority = new AssistantOpsAuthority({ surface, directory: dir, homedir: HOME, now: () => clock });
  const assistant = makeRecord("assistant", ASSISTANT_CWD, { operationId: "turn-1" });
  surface.records.set(assistant.sessionId, assistant);
  return {
    dir, surface, authority, assistant,
    set now(value: number) { clock = value; },
    get now() { return clock; },
    advance(ms: number) { clock += ms; },
  };
}

async function send(env: ReturnType<typeof harness>, id: string, op: Record<string, unknown>) {
  await env.authority.handleWorkerOp(view(env.assistant), id, { sessionId: "assistant", op: op as never });
  return env.assistant.sent.at(-1) as { type: string; id: string; payload: Record<string, unknown> } | undefined;
}

function payload(frame: { payload: Record<string, unknown> } | undefined): Record<string, unknown> {
  assert.ok(frame, "expected an op result frame");
  return frame.payload;
}

test("non-assistant requester is refused with no reply", async () => {
  const env = harness();
  const outsider = makeRecord("outsider", "/repos/app");
  await env.authority.handleWorkerOp(view(outsider), "op-1", {
    sessionId: "outsider",
    op: { kind: "send", targetSessionId: "missing", message: "hi", delivery: "follow_up", waitMinutes: 0 },
  });
  assert.equal(outsider.sent.length, 0);
  assert.equal(env.surface.submits.length, 0);
  env.authority.dispose();
});

test("self-target, assistant-workspace target and unknown target are rejected", async () => {
  const env = harness();
  const self = payload(await send(env, "s1", { kind: "send", targetSessionId: "assistant", message: "hi", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(self.ok, false);
  assert.equal((self.error as { code: string }).code, "invalid_input");

  const nested = makeRecord("nested", ASSISTANT_CWD);
  env.surface.records.set("nested", nested);
  env.surface.exists.add("nested");
  const chained = payload(await send(env, "s2", { kind: "send", targetSessionId: "nested", message: "hi", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(chained.ok, false);
  assert.match((chained.error as { message: string }).message, /助手工作区/);

  const missing = payload(await send(env, "s3", { kind: "send", targetSessionId: "ghost", message: "hi", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(missing.ok, false);
  assert.equal((missing.error as { code: string }).code, "not_found");
  assert.equal(env.surface.submits.length, 0);
  env.authority.dispose();
});

test("quota rejects the 6th send, 4th create and 6th stop", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app");
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  for (let index = 0; index < 5; index += 1) {
    const frame = payload(await send(env, `send-${index}`, { kind: "send", targetSessionId: "target", message: `m${index}`, delivery: "follow_up", waitMinutes: 0 }));
    assert.equal(frame.ok, true, `send ${index} admitted`);
  }
  const sixth = payload(await send(env, "send-5", { kind: "send", targetSessionId: "target", message: "over", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(sixth.ok, false);
  assert.match((sixth.error as { message: string }).message, /5 次/);

  env.assistant.operationId = "turn-create";
  for (let index = 0; index < 3; index += 1) {
    env.surface.createSessionId = `made-${index}`;
    const frame = payload(await send(env, `create-${index}`, { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
    assert.equal(frame.ok, true, `create ${index} admitted`);
  }
  const fourth = payload(await send(env, "create-3", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(fourth.ok, false);
  assert.match((fourth.error as { message: string }).message, /3 次/);

  env.assistant.operationId = "turn-stop";
  for (let index = 0; index < 5; index += 1) {
    env.surface.records.set("target", target);
    const frame = payload(await send(env, `stop-${index}`, { kind: "stop", targetSessionId: "target" }));
    assert.equal(frame.ok, true, `stop ${index} admitted`);
  }
  env.surface.records.set("target", target);
  const sixthStop = payload(await send(env, "stop-5", { kind: "stop", targetSessionId: "target" }));
  assert.equal(sixthStop.ok, false);
  assert.match((sixthStop.error as { message: string }).message, /5 次/);
  env.authority.dispose();
});

test("chain cap rejects the 4th auto op and a user turn resets it", async () => {
  const env = harness();
  // Stay busy so none of the sends settle into a notification (a delivered
  // notification would move lastNotifyAt and the user turn would reset early).
  const target = makeRecord("target", "/repos/app", { running: true });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  for (let index = 0; index < 3; index += 1) {
    env.assistant.operationId = `op-${index}`;
    const frame = payload(await send(env, `c-${index}`, { kind: "send", targetSessionId: "target", message: `m${index}`, delivery: "follow_up", waitMinutes: 0 }));
    assert.equal(frame.ok, true);
  }
  env.assistant.operationId = "op-3";
  const blocked = payload(await send(env, "c-3", { kind: "send", targetSessionId: "target", message: "nope", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(blocked.ok, false);
  assert.match((blocked.error as { message: string }).message, /3 次/);

  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
  env.assistant.operationId = "op-4";
  const allowed = payload(await send(env, "c-4", { kind: "send", targetSessionId: "target", message: "again", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(allowed.ok, true);
  env.authority.dispose();
});

test("routing: idle is fenced submit, busy is a command at the target epoch, missing record cold-opens, missing capability fails closed", async () => {
  const env = harness();
  const idle = makeRecord("idle", "/repos/app", { lastEventId: 7 });
  env.surface.records.set("idle", idle);
  env.surface.exists.add("idle");
  await send(env, "r1", { kind: "send", targetSessionId: "idle", message: "go", delivery: "steer", waitMinutes: 0 });
  assert.equal(env.surface.submits.at(-1)?.input.expectedEpoch, idle.epoch);
  assert.equal(env.surface.submits.at(-1)?.input.expectedRevision, 7);
  assert.equal(env.surface.commands.length, 0);

  const busy = makeRecord("busy", "/repos/app", { running: true, lastEventId: 3 });
  env.surface.records.set("busy", busy);
  env.surface.exists.add("busy");
  env.assistant.operationId = "op-busy";
  const steered = payload(await send(env, "r2", { kind: "send", targetSessionId: "busy", message: "steer me", delivery: "steer", waitMinutes: 0 }));
  assert.equal(steered.delivery, "steer");
  assert.equal(env.surface.commands.at(-1)?.epoch, busy.epoch);
  assert.equal(env.surface.commands.at(-1)?.command.type, "steer");

  env.assistant.operationId = "op-follow";
  const followed = payload(await send(env, "r3", { kind: "send", targetSessionId: "busy", message: "later", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(followed.delivery, "follow_up");

  env.surface.exists.add("cold");
  env.assistant.operationId = "op-cold";
  const cold = payload(await send(env, "r4", { kind: "send", targetSessionId: "cold", message: "open", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(cold.delivery, "new_turn");
  assert.equal(env.surface.submits.at(-1)?.input.sessionId, "cold");
  assert.equal(env.surface.submits.at(-1)?.input.expectedEpoch, undefined);

  busy.capabilities = ["runtime.prompt"];
  env.assistant.operationId = "op-cap";
  const unsupported = payload(await send(env, "r5", { kind: "send", targetSessionId: "busy", message: "no", delivery: "steer", waitMinutes: 0 }));
  assert.equal((unsupported.error as { code: string }).code, "unsupported_capability");
  env.authority.dispose();
});

test("delivered prompt is exactly the marker line plus the raw message", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app");
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  await send(env, "m1", { kind: "send", targetSessionId: "target", message: "do the thing", delivery: "follow_up", waitMinutes: 0 });
  assert.equal(env.surface.submits[0]?.input.prompt, `${PREFIX}\n\n${"do the thing"}`);
  env.authority.dispose();
});

test("settlement: completed, failed, stopped, waiting_user, crashed, and the idle-confirm grace", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 2 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  env.surface.headers.set("target", { title: "构建", cwd: "/repos/app" });
  env.surface.contexts.set("target", [{ role: "assistant", content: [{ type: "text", text: "done" }] }]);
  target.writtenFiles = ["/repos/app/src/main.ts"];

  const admitted = payload(await send(env, "w1", { kind: "send", targetSessionId: "target", message: "build", delivery: "steer", waitMinutes: 0 }));
  assert.equal(admitted.ok, true);

  // Still busy: nothing settles.
  env.authority.scheduleSettleCheck();
  await wait(80);
  assert.equal(env.assistant.sent.filter((frame) => frame.type === "worker.assistantCompletion").length, 0);

  // Busy → idle inside the grace: no settle yet.
  target.running = false;
  target.lastEventId = 5;
  env.authority.scheduleSettleCheck();
  await wait(80);
  assert.equal(notifyCount(env), 0, "grace holds the settlement");

  // Busy again before the grace elapses: the confirm is cleared.
  env.advance(1_000);
  target.running = true;
  env.authority.scheduleSettleCheck();
  await wait(80);
  env.advance(3_000);
  await wait(1_200);
  assert.equal(notifyCount(env), 0, "a resumed turn cancels the idle confirm");

  // Idle for the full grace: one completion notification.
  target.running = false;
  target.lastEventId = 6;
  env.authority.scheduleSettleCheck();
  await wait(80);
  env.advance(IDLE_GRACE);
  await wait(1_200);
  await wait(NOTIFY_MERGE);
  const completed = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(completed, new RegExp(`^${escapeRegExp(ASSISTANT_NOTIFY_MESSAGE_PREFIX)}`));
  assert.match(completed, /结果: 完成/);
  assert.match(completed, /最后回复: done/);
  assert.match(completed, /写过的文件: main\.ts/);

  // Failed tail.
  const failedTarget = makeRecord("failed", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("failed", failedTarget);
  env.surface.exists.add("failed");
  env.surface.contexts.set("failed", [{ role: "assistant", content: [{ type: "text", text: "boom" }], errorMessage: "模型报错" }]);
  env.assistant.operationId = "op-failed";
  await send(env, "w2", { kind: "send", targetSessionId: "failed", message: "try", delivery: "steer", waitMinutes: 0 });
  failedTarget.running = false;
  failedTarget.lastEventId = 4;
  env.authority.scheduleSettleCheck();
  await wait(80);
  env.advance(IDLE_GRACE);
  await wait(1_200);
  await wait(NOTIFY_MERGE);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /结果: 出错/);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /错误: 模型报错/);

  // Record deleted → stopped.
  const stoppedTarget = makeRecord("stopped", "/repos/app", { running: true });
  env.surface.records.set("stopped", stoppedTarget);
  env.surface.exists.add("stopped");
  env.assistant.operationId = "op-stopped";
  await send(env, "w3", { kind: "send", targetSessionId: "stopped", message: "run", delivery: "steer", waitMinutes: 0 });
  env.surface.records.delete("stopped");
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /结果: 已停止/);

  // pending extension UI settles immediately, even while the turn still looks busy.
  const waiting = makeRecord("waiting", "/repos/app", { running: true, pendingUi: 1, lastEventId: 1 });
  env.surface.records.set("waiting", waiting);
  env.surface.exists.add("waiting");
  env.assistant.operationId = "op-waiting";
  await send(env, "w4", { kind: "send", targetSessionId: "waiting", message: "ask", delivery: "steer", waitMinutes: 1 });
  env.authority.scheduleSettleCheck();
  await wait(80);
  const completion = [...env.assistant.sent].reverse().find((frame) => frame.type === "worker.assistantCompletion") as { payload: { outcome: string } } | undefined;
  assert.equal(completion?.payload.outcome, "waiting_user");

  // Crashed record.
  const crashed = makeRecord("crashed", "/repos/app", { running: true, status: "ready" });
  env.surface.records.set("crashed", crashed);
  env.surface.exists.add("crashed");
  env.assistant.operationId = "op-crashed";
  await send(env, "w5", { kind: "send", targetSessionId: "crashed", message: "go", delivery: "steer", waitMinutes: 0 });
  crashed.status = "crashed";
  crashed.running = false;
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /会话异常退出/);
  env.authority.dispose();
});

test("wait pushes a completion frame; waitCancel flips to a notification; a waited settlement sends no notification", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  env.surface.contexts.set("target", [{ role: "assistant", content: "all good" }]);
  const admitted = payload(await send(env, "wait-1", { kind: "send", targetSessionId: "target", message: "work", delivery: "steer", waitMinutes: 5 }));
  const delegationId = admitted.delegationId as string;
  assert.equal(typeof delegationId, "string");

  target.running = false;
  target.lastEventId = 3;
  env.authority.scheduleSettleCheck();
  await wait(80);
  env.advance(IDLE_GRACE);
  await wait(1_200);
  const completion = env.assistant.sent.find((frame) => frame.type === "worker.assistantCompletion") as { id: string; payload: { outcome: string; delegationId: string; lastText?: string } } | undefined;
  assert.equal(completion?.id, delegationId);
  assert.equal(completion?.payload.outcome, "completed");
  assert.equal(completion?.payload.lastText, "all good");
  const submitsBefore = env.surface.submits.length;
  await wait(NOTIFY_MERGE);
  assert.equal(env.surface.submits.length, submitsBefore, "a waited settlement must not also notify");

  const other = makeRecord("other", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("other", other);
  env.surface.exists.add("other");
  env.assistant.operationId = "op-cancel";
  const second = payload(await send(env, "wait-2", { kind: "send", targetSessionId: "other", message: "more", delivery: "steer", waitMinutes: 5 }));
  env.authority.handleWaitCancel({ sessionId: "assistant", delegationId: second.delegationId as string });
  other.running = false;
  other.lastEventId = 4;
  env.authority.scheduleSettleCheck();
  await wait(80);
  env.advance(IDLE_GRACE);
  await wait(1_200);
  await wait(NOTIFY_MERGE);
  const notified = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(notified, new RegExp(`^${escapeRegExp(ASSISTANT_NOTIFY_MESSAGE_PREFIX)}`));
  assert.equal(notified.includes(PREFIX), false);
  assert.equal(env.assistant.sent.filter((frame) => frame.type === "worker.assistantCompletion" && (frame as { id: string }).id === second.delegationId).length, 0);
  env.authority.dispose();
});

test("notifications merge, follow a busy assistant, cold-open a missing assistant, and fail closed after 3 attempts", async () => {
  const env = harness();
  const first = makeRecord("a", "/repos/one", { running: true });
  const second = makeRecord("b", "/repos/two", { running: true });
  env.surface.records.set("a", first);
  env.surface.records.set("b", second);
  env.surface.exists.add("a");
  env.surface.exists.add("b");
  env.surface.headers.set("a", { title: "甲", cwd: "/repos/one" });
  env.surface.headers.set("b", { title: "乙", cwd: "/repos/two" });
  await send(env, "n1", { kind: "send", targetSessionId: "a", message: "one", delivery: "steer", waitMinutes: 0 });
  env.assistant.operationId = "op-b";
  await send(env, "n2", { kind: "send", targetSessionId: "b", message: "two", delivery: "steer", waitMinutes: 0 });
  env.surface.records.delete("a");
  env.surface.records.delete("b");
  env.assistant.running = true;
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.equal(env.surface.commands.length, 1, "two items merge into one follow_up");
  const prompt = env.surface.commands[0]!.command.message;
  assert.equal(prompt.startsWith(`${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n`), true);
  assert.equal(prompt.split(ASSISTANT_NOTIFY_MESSAGE_PREFIX).length, 2);
  assert.match(prompt, /会话: 甲｜项目: one｜id: a/);
  assert.match(prompt, /会话: 乙｜项目: two｜id: b/);
  assert.equal(prompt.includes(PREFIX), false);
  assert.equal(env.surface.commands[0]!.command.type, "follow_up");
  assert.equal(env.surface.commands[0]!.epoch, env.assistant.epoch);

  // Assistant record gone → cold open, no fence.
  const third = makeRecord("c", "/repos/three", { running: true });
  env.surface.records.set("c", third);
  env.surface.exists.add("c");
  env.assistant.operationId = "op-c";
  env.assistant.running = false;
  await send(env, "n3", { kind: "send", targetSessionId: "c", message: "three", delivery: "steer", waitMinutes: 0 });
  env.surface.records.delete("assistant");
  env.surface.records.delete("c");
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  const cold = env.surface.submits.at(-1)?.input;
  assert.equal(cold?.sessionId, "assistant");
  assert.equal(cold?.expectedEpoch, undefined);

  // Three rejected deliveries mark the ledger entry delivery_failed.
  env.surface.records.set("assistant", env.assistant);
  env.assistant.running = false;
  const fourth = makeRecord("d", "/repos/four", { running: true });
  env.surface.records.set("d", fourth);
  env.surface.exists.add("d");
  env.assistant.operationId = "op-d";
  await send(env, "n4", { kind: "send", targetSessionId: "d", message: "four", delivery: "steer", waitMinutes: 0 });
  env.surface.records.delete("d");
  env.surface.submitError = { code: "unavailable", message: "down", retryable: true };
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  await wait(5_200);
  await wait(5_200);
  const ledger = JSON.parse(readFileSync(join(env.dir, "assistant-delegations.json"), "utf8")) as { delegations: Array<{ targetSessionId: string; state: string }> };
  assert.equal(ledger.delegations.find((row) => row.targetSessionId === "d")?.state, "delivery_failed");
  env.authority.dispose();
});

test("ledger round-trip re-enqueues a pending notification and degrades a wait to notify", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  await send(env, "p1", { kind: "send", targetSessionId: "target", message: "keep", delivery: "steer", waitMinutes: 5 });
  env.surface.records.delete("target");
  env.authority.scheduleSettleCheck();
  await wait(80);
  // Settled into the queue, not yet flushed.
  env.authority.dispose();

  const reloaded = new AssistantOpsAuthority({ surface: env.surface, directory: env.dir, homedir: HOME, now: () => env.now });
  env.surface.records.set("assistant", env.assistant);
  await wait(NOTIFY_MERGE + 200);
  const resumed = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(resumed, /id: target/);
  reloaded.dispose();

  const waiting = new FakeSurface();
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-"));
  const assistant = makeRecord("assistant", ASSISTANT_CWD);
  waiting.records.set("assistant", assistant);
  const target2 = makeRecord("target2", "/repos/app", { running: true });
  waiting.records.set("target2", target2);
  waiting.exists.add("target2");
  const first = new AssistantOpsAuthority({ surface: waiting, directory: dir, homedir: HOME, now: () => 1 });
  await first.handleWorkerOp(view(assistant), "p2", { sessionId: "assistant", op: { kind: "send", targetSessionId: "target2", message: "hold", delivery: "steer", waitMinutes: 5 } });
  first.dispose();
  const second = new AssistantOpsAuthority({ surface: waiting, directory: dir, homedir: HOME, now: () => 2 });
  waiting.records.delete("target2");
  second.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(waiting.submits.at(-1)?.input.prompt ?? "", /结果: 已停止/, "a restarted wait settles as a notification");
  assert.equal(assistant.sent.some((frame) => frame.type === "worker.assistantCompletion"), false);
  second.dispose();
});

const IDLE_GRACE = 2_500;
const NOTIFY_MERGE = 1_600;

function notifyCount(env: ReturnType<typeof harness>): number {
  return env.surface.submits.filter((call) => call.input.prompt.startsWith(ASSISTANT_NOTIFY_MESSAGE_PREFIX)).length
    + env.surface.commands.filter((call) => call.command.message.startsWith(ASSISTANT_NOTIFY_MESSAGE_PREFIX)).length;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
