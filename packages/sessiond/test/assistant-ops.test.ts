/**
 * Round 7: assistant write channel. The authority is tested against a fake
 * surface and a controllable clock — no worker, no sessiond service — so
 * routing, quota, chains, settlement and the ledger are deterministic.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX, type CorrelatedRuntimeCommandResult, type ProtocolError, type RuntimeCommand, type RuntimeCreateParams, type RuntimeCreateResult, type RuntimeSubmitTurnParams, type SubmitTurnAdmission } from "@fffattiger/pix-protocol";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";
import { AssistantOpsAuthority, type AssistantCreateGuardResult, type AssistantOpsRecordView, type AssistantOpsSurface, type PendingUiRef } from "../src/assistant-ops.js";
import { FileWorkspaceStateStore } from "../src/workspace-state.js";

const HOME = "/Users/proxy";
const ASSISTANT_CWD = resolveAssistantWorkspaceDir(HOME);
const PREFIX = ASSISTANT_SENT_MESSAGE_PREFIX;

interface FakeRecord {
  sessionId: string;
  cwd: string;
  epoch: string;
  status: string;
  running: boolean;
  pendingUi: PendingUiRef[];
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
  createError: unknown;
  /** When set, authorizeCreateCwd returns/throws it; default allows. */
  createGuard: AssistantCreateGuardResult | "throw" | undefined;
  /** When set, submitTurn waits for it before answering (dispose-race tests). */
  submitGate: Promise<void> | undefined;
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
    if (this.submitGate) await this.submitGate;
    if (this.submitError) {
      return { status: "rejected", delivery: "not_delivered", sessionId: input.sessionId, operationId: input.operationId, error: this.submitError };
    }
    return { status: "accepted" } as SubmitTurnAdmission;
  }
  uiResponses: Array<{ sessionId: string; command: RuntimeCommand }> = [];
  async command(sessionId: string, command: RuntimeCommand, epoch?: string): Promise<CorrelatedRuntimeCommandResult> {
    if (command.type === "extension_ui_response") {
      this.uiResponses.push({ sessionId, command });
      const record = this.records.get(sessionId);
      if (record !== undefined && "id" in command) record.pendingUi = record.pendingUi.filter((request) => request.id !== command.id);
      return { commandId: command.commandId, result: { ok: true, type: "extension_ui_response" } } as CorrelatedRuntimeCommandResult;
    }
    const kind = command.type === "steer" ? "steer" as const : "follow_up" as const;
    const message = "message" in command && typeof command.message === "string" ? command.message : "";
    this.commands.push({ sessionId, command: { commandId: command.commandId, type: kind, message }, ...(epoch === undefined ? {} : { epoch }) });
    if (!this.commandOk) {
      return { commandId: command.commandId, result: { ok: false, type: kind, error: this.commandError } };
    }
    return { commandId: command.commandId, result: { ok: true, type: kind } };
  }
  async create(input: RuntimeCreateParams) {
    if (this.createError !== undefined) throw this.createError;
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
  async authorizeCreateCwd(cwd: string): Promise<AssistantCreateGuardResult> {
    if (this.createGuard === "throw") throw new Error("guard exploded");
    return this.createGuard ?? { ok: true, cwd };
  }
  async readSessionContext(sessionId: string) {
    const entries = this.contexts.get(sessionId);
    return entries === undefined ? null : { entries: entries.map((message) => ({ message })) };
  }
}

function makeRecord(sessionId: string, cwd: string, overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    sessionId, cwd, epoch: `epoch-${sessionId}`, status: "ready", running: false, pendingUi: [],
    lastEventId: 0, capabilities: ["runtime.prompt", "runtime.steer", "runtime.follow_up"],
    operationId: null, writtenFiles: [], sent: [], ...overrides,
  };
}

/** A context entry with a turn-end stopReason (proves a completed turn). */
function completedEntry(text: string, stopReason = "stop"): { role: string; content: string; stopReason: string } {
  return { role: "assistant", content: text, stopReason };
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
  const authority = new AssistantOpsAuthority({
    surface,
    store: new FileWorkspaceStateStore(dir),
    legacyDirectory: dir,
    homedir: HOME,
    now: () => clock,
  });
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

test("parallel sends in one turn cannot bypass the per-turn quota (TOCTOU)", async () => {
  const env = harness();
  env.assistant.operationId = "turn-par";
  const target = makeRecord("target", "/repos/app", { running: true });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  const frames = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    send(env, `par-${index}`, { kind: "send", targetSessionId: "target", message: `m${index}`, delivery: "follow_up", waitMinutes: 0 })));
  const admitted = frames.filter((frame) => frame?.payload.ok === true);
  assert.equal(admitted.length, 5, "exactly the cap passes when sends overlap");
  const rejected = frames.filter((frame) => frame?.payload.ok === false);
  assert.equal(rejected.length, 1);
  assert.match((rejected[0]!.payload.error as { message: string }).message, /5 次/);
  assert.equal(env.surface.commands.length, 5, "only the admitted sends reach the target");
  env.authority.dispose();
});

test("a failed send gives its reserved quota slot back", async () => {
  const env = harness();
  env.assistant.operationId = "turn-fail";
  const target = makeRecord("target", "/repos/app");
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  env.surface.submitError = { code: "unavailable", message: "worker gone", retryable: true };
  const failed = payload(await send(env, "f1", { kind: "send", targetSessionId: "target", message: "nope", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(failed.ok, false);
  assert.equal((failed.error as { code: string }).code, "unavailable");
  env.surface.submitError = undefined;
  const retry = payload(await send(env, "f2", { kind: "send", targetSessionId: "target", message: "again", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(retry.ok, true, "a failed send did not consume the slot");
  env.authority.dispose();
});

test("a failed create gives its reserved quota slot back", async () => {
  const env = harness();
  env.assistant.operationId = "turn-cfail";
  env.surface.createError = Object.assign(new Error("boom"), { code: "unavailable", retryable: true });
  const failed = payload(await send(env, "c1", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(failed.ok, false);
  assert.equal((failed.error as { code: string }).code, "unavailable");
  env.surface.createError = undefined;
  env.surface.createSessionId = "made-1";
  const retry = payload(await send(env, "c2", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(retry.ok, true, "a failed create did not consume the slot");
  env.authority.dispose();
});

test("chain cap rejects the 4th auto continuation and a user turn resets it", async () => {
  const env = harness();
  // A user-originated send is not a continuation. The cap starts only AFTER a
  // completion notification for this target was delivered.
  const target = makeRecord("target", "/repos/app", { running: true });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  await send(env, "seed", { kind: "send", targetSessionId: "target", message: "seed", delivery: "follow_up", waitMinutes: 0 });
  env.surface.records.delete("target");
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /id: target/, "the seed settled into a notification");

  env.surface.records.set("target", target);
  for (let index = 0; index < 3; index += 1) {
    env.assistant.operationId = `op-${index}`;
    const frame = payload(await send(env, `c-${index}`, { kind: "send", targetSessionId: "target", message: `m${index}`, delivery: "follow_up", waitMinutes: 0 }));
    assert.equal(frame.ok, true, `continuation ${index} admitted`);
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

test("auto-action cap: at most 3 notification-triggered actions across ALL targets; a user turn resets it", async () => {
  const env = harness();
  // Deliver one completion notification so the assistant is in autonomous mode.
  const seed = makeRecord("seed", "/repos/seed", { running: true });
  env.surface.records.set("seed", seed);
  env.surface.exists.add("seed");
  await send(env, "seed-send", { kind: "send", targetSessionId: "seed", message: "seed", delivery: "follow_up", waitMinutes: 0 });
  env.surface.records.delete("seed");
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /id: seed/, "the seed settled into a notification");

  // Three auto actions across three DIFFERENT targets pass (each target's own
  // chain count is 1, so only the assistant-wide budget is being spent).
  for (const name of ["a", "b", "c"]) {
    env.surface.records.set(name, makeRecord(name, `/repos/${name}`));
    env.surface.exists.add(name);
    env.assistant.operationId = `auto-${name}`;
    const frame = payload(await send(env, `auto-${name}`, { kind: "send", targetSessionId: name, message: "go", delivery: "follow_up", waitMinutes: 0 }));
    assert.equal(frame.ok, true, `auto send to ${name} admitted`);
  }
  // The fourth notification-triggered action is blocked by the global cap,
  // even though target "d" itself never delivered a notification.
  env.surface.records.set("d", makeRecord("d", "/repos/d"));
  env.surface.exists.add("d");
  env.assistant.operationId = "auto-d";
  const blocked = payload(await send(env, "auto-d", { kind: "send", targetSessionId: "d", message: "nope", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(blocked.ok, false);
  assert.match((blocked.error as { message: string }).message, /自动动作/);

  // A user turn in the assistant resets the whole auto budget.
  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
  env.assistant.operationId = "auto-d2";
  const allowed = payload(await send(env, "auto-d2", { kind: "send", targetSessionId: "d", message: "again", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(allowed.ok, true);
  env.authority.dispose();
});

test("auto-action cap also bounds creates fired after a notification", async () => {
  const env = harness();
  const seed = makeRecord("seed", "/repos/seed", { running: true });
  env.surface.records.set("seed", seed);
  env.surface.exists.add("seed");
  await send(env, "seed-send", { kind: "send", targetSessionId: "seed", message: "seed", delivery: "follow_up", waitMinutes: 0 });
  env.surface.records.delete("seed");
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(env.surface.submits.at(-1)?.input.prompt ?? "", /id: seed/);

  for (let index = 0; index < 3; index += 1) {
    env.surface.createSessionId = `made-${index}`;
    env.assistant.operationId = `c-${index}`;
    const frame = payload(await send(env, `c-${index}`, { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
    assert.equal(frame.ok, true, `auto create ${index} admitted`);
  }
  env.surface.createSessionId = "made-3";
  env.assistant.operationId = "c-3";
  const blocked = payload(await send(env, "c-3", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(blocked.ok, false);
  assert.match((blocked.error as { message: string }).message, /自动动作/);

  // Without a delivered notification, creates are user-driven and not counted.
  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
  env.assistant.operationId = "c-4";
  const userDriven = payload(await send(env, "c-4", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(userDriven.ok, true);
  env.authority.dispose();
});

test("send to a cold assistant-workspace session is rejected via its header cwd", async () => {
  const env = harness();
  env.surface.exists.add("cold-assistant");
  env.surface.headers.set("cold-assistant", { title: "旧助手会话", cwd: ASSISTANT_CWD });
  const frame = payload(await send(env, "s-cold", { kind: "send", targetSessionId: "cold-assistant", message: "hi", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(frame.ok, false);
  assert.match((frame.error as { message: string }).message, /助手工作区/);
  assert.equal(env.surface.submits.length, 0, "nothing is sent to the cold assistant session");
  // A cold NON-assistant session with a recorded header still routes normally.
  env.surface.exists.add("cold-user");
  env.surface.headers.set("cold-user", { title: "用户会话", cwd: "/repos/app" });
  const okFrame = payload(await send(env, "s-cold-ok", { kind: "send", targetSessionId: "cold-user", message: "hi", delivery: "follow_up", waitMinutes: 0 }));
  assert.equal(okFrame.ok, true);
  env.authority.dispose();
});

test("stop and rename refuse self and assistant-workspace targets (live or cold)", async () => {
  const env = harness();
  const nested = makeRecord("nested", ASSISTANT_CWD);
  env.surface.records.set("nested", nested);
  env.surface.exists.add("nested");

  const stopSelf = payload(await send(env, "stop-self", { kind: "stop", targetSessionId: "assistant" }));
  assert.equal(stopSelf.ok, false);
  assert.equal((stopSelf.error as { code: string }).code, "invalid_input");

  const stopNested = payload(await send(env, "stop-nested", { kind: "stop", targetSessionId: "nested" }));
  assert.equal(stopNested.ok, false);
  assert.match((stopNested.error as { message: string }).message, /助手工作区/);

  env.surface.exists.add("cold-assistant");
  env.surface.headers.set("cold-assistant", { title: "旧助手会话", cwd: ASSISTANT_CWD });
  const stopCold = payload(await send(env, "stop-cold", { kind: "stop", targetSessionId: "cold-assistant" }));
  assert.equal(stopCold.ok, false);
  assert.match((stopCold.error as { message: string }).message, /助手工作区/);
  assert.equal(env.surface.stops.length, 0, "no stop reached the surface");

  const renameSelf = payload(await send(env, "rename-self", { kind: "rename", targetSessionId: "assistant", name: "新名字" }));
  assert.equal(renameSelf.ok, false);
  assert.equal((renameSelf.error as { code: string }).code, "invalid_input");
  const renameNested = payload(await send(env, "rename-nested", { kind: "rename", targetSessionId: "nested", name: "新名字" }));
  assert.equal(renameNested.ok, false);
  assert.match((renameNested.error as { message: string }).message, /助手工作区/);
  assert.equal(env.surface.renames.length, 0, "no rename reached the surface");
  env.authority.dispose();
});

test("create_session cwd is authorized sessiond-side before creating", async () => {
  const env = harness();
  env.assistant.operationId = "turn-guard";
  env.surface.createGuard = { ok: false, error: { code: "invalid_input", message: "路径不在 Pix 允许的根目录内，无法新建会话", retryable: false } };
  const rejected = payload(await send(env, "g1", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(rejected.ok, false);
  assert.match((rejected.error as { message: string }).message, /允许的根目录/);
  assert.equal(env.surface.creates.length, 0, "the create never reached the surface");

  env.surface.createGuard = "throw";
  const blew = payload(await send(env, "g2", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(blew.ok, false);
  assert.equal((blew.error as { code: string }).code, "unavailable");
  assert.equal(env.surface.creates.length, 0);

  env.surface.createGuard = { ok: true, cwd: env.dir };
  const allowed = payload(await send(env, "g3", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(allowed.ok, true);
  assert.equal(env.surface.creates.length, 1);
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

test("a send to a turn blocked on an ask queues the message, then cancels the ask", async () => {
  const env = harness();
  const blocked = makeRecord("blocked", "/repos/app", {
    running: true,
    pendingUi: [{ id: "ask-1", method: "questionnaire" }],
    capabilities: ["runtime.prompt", "runtime.steer", "runtime.follow_up", "runtime.extension_ui"],
  });
  env.surface.records.set("blocked", blocked);
  env.surface.exists.add("blocked");
  const steered = payload(await send(env, "a1", { kind: "send", targetSessionId: "blocked", message: "用方案 B", delivery: "steer", waitMinutes: 0 }));
  assert.equal(steered.ok, true);
  assert.equal(env.surface.commands.at(-1)?.command.type, "steer");
  assert.deepEqual(env.surface.uiResponses.map(({ command }) => command), [{
    commandId: (env.surface.uiResponses[0]!.command as { commandId: string }).commandId,
    type: "extension_ui_response", id: "ask-1", method: "questionnaire", responseKind: "cancelled", cancelled: true,
  }]);
  assert.deepEqual(blocked.pendingUi, []);

  // Without the extension UI capability nothing is cancelled.
  const legacy = makeRecord("legacy", "/repos/app", { running: true, pendingUi: [{ id: "ask-2", method: "confirm" }] });
  env.surface.records.set("legacy", legacy);
  env.surface.exists.add("legacy");
  env.assistant.operationId = "op-legacy";
  await send(env, "a2", { kind: "send", targetSessionId: "legacy", message: "go", delivery: "follow_up", waitMinutes: 0 });
  assert.equal(env.surface.uiResponses.length, 1);
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

  // Failed tail. (A user turn precedes each new delegation: after a delivered
  // notification the assistant is in autonomous mode and the global auto-action
  // cap would otherwise consume this scenario's budget.)
  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
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
  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
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
  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
  const waiting = makeRecord("waiting", "/repos/app", { running: true, pendingUi: [{ id: "ask-1", method: "questionnaire" }], lastEventId: 1 });
  env.surface.records.set("waiting", waiting);
  env.surface.exists.add("waiting");
  env.assistant.operationId = "op-waiting";
  await send(env, "w4", { kind: "send", targetSessionId: "waiting", message: "ask", delivery: "steer", waitMinutes: 1 });
  env.authority.scheduleSettleCheck();
  await wait(80);
  const completion = [...env.assistant.sent].reverse().find((frame) => frame.type === "worker.assistantCompletion") as { payload: { outcome: string } } | undefined;
  assert.equal(completion?.payload.outcome, "waiting_user");

  // Crashed record.
  env.authority.noteRpcSubmitTurn("assistant");
  await wait(20);
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
  env.authority.handleWaitCancel(view(env.assistant), { sessionId: "assistant", delegationId: second.delegationId as string });
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
  // Idle during the sends: a busy assistant would settle (and notify) the
  // moment the first target disappears, before the second send lands.
  env.assistant.running = false;
  await send(env, "n1", { kind: "send", targetSessionId: "a", message: "one", delivery: "steer", waitMinutes: 0 });
  env.assistant.operationId = "op-b";
  await send(env, "n2", { kind: "send", targetSessionId: "b", message: "two", delivery: "steer", waitMinutes: 0 });
  env.surface.records.delete("a");
  env.surface.records.delete("b");
  // Busy for the whole merge window: both settlements enqueue, and the single
  // flush delivers them together as one follow_up. Going idle mid-window would
  // deliver the first batch as a submitTurn and split the burst.
  env.assistant.running = true;
  const commandsBefore = env.surface.commands.length;
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  const merged = env.surface.commands.slice(commandsBefore);
  assert.equal(merged.length, 1, "two items merge into one follow_up");
  const prompt = merged[0]!.command.message;
  assert.equal(prompt.startsWith(`${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n`), true);
  assert.equal(prompt.split(ASSISTANT_NOTIFY_MESSAGE_PREFIX).length, 2);
  assert.match(prompt, /会话: 甲｜项目: one｜id: a/);
  assert.match(prompt, /会话: 乙｜项目: two｜id: b/);
  assert.equal(prompt.includes(PREFIX), false);
  assert.equal(merged[0]!.command.type, "follow_up");
  assert.equal(merged[0]!.epoch, env.assistant.epoch);

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
  const ledger = JSON.parse(readFileSync(join(env.dir, "workspace-state.json"), "utf8")).assistantDelegations as { delegations: Array<{ targetSessionId: string; state: string }> };
  assert.equal(ledger.delegations.find((row) => row.targetSessionId === "d")?.state, "delivery_failed");
  env.authority.dispose();
});

test("waitCancel is identity-bound: a foreign session id or non-assistant requester is a no-op", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  const admitted = payload(await send(env, "wc-1", { kind: "send", targetSessionId: "target", message: "work", delivery: "steer", waitMinutes: 5 }));
  const delegationId = admitted.delegationId as string;

  // Wrong session id in the payload: no state change.
  env.authority.handleWaitCancel(view(env.assistant), { sessionId: "someone-else", delegationId });
  target.running = false;
  target.lastEventId = 3;
  env.authority.scheduleSettleCheck();
  await wait(80);
  env.advance(IDLE_GRACE);
  await wait(1_200);
  assert.equal(env.assistant.sent.some((frame) => frame.type === "worker.assistantCompletion"), true,
    "the wait is still armed for the named assistant, so it settles as a completion frame");
  env.authority.dispose();

  // A non-assistant requester cannot cancel either.
  const env2 = harness();
  const target2 = makeRecord("target2", "/repos/app", { running: true, lastEventId: 1 });
  env2.surface.records.set("target2", target2);
  env2.surface.exists.add("target2");
  const outsider = makeRecord("outsider", "/repos/other");
  env2.surface.records.set("outsider", outsider);
  const admitted2 = payload(await send(env2, "wc-2", { kind: "send", targetSessionId: "target2", message: "work", delivery: "steer", waitMinutes: 5 }));
  env2.authority.handleWaitCancel(view(outsider), { sessionId: "assistant", delegationId: admitted2.delegationId as string });
  target2.running = false;
  target2.lastEventId = 3;
  env2.authority.scheduleSettleCheck();
  await wait(80);
  env2.advance(IDLE_GRACE);
  await wait(1_200);
  assert.equal(env2.assistant.sent.filter((frame) => frame.type === "worker.assistantCompletion").length, 1,
    "the forged cancel never flipped the wait to notify");
  env2.authority.dispose();
});

test("ledger round-trip re-enqueues a pending notification and degrades a wait to notify", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  await send(env, "p1", { kind: "send", targetSessionId: "target", message: "keep", delivery: "steer", waitMinutes: 5 });
  // Restart BEFORE settlement. The worker that was waiting on the completion
  // frame is gone, so the reloaded authority must degrade the wait to a
  // notification and deliver it once the target finishes.
  env.authority.dispose();

  const reloaded = new AssistantOpsAuthority({ surface: env.surface, store: new FileWorkspaceStateStore(env.dir), homedir: HOME, now: () => env.now });
  env.surface.records.delete("target");
  reloaded.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 200);
  const resumed = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(resumed, /id: target/);
  assert.equal(env.assistant.sent.some((frame) => frame.type === "worker.assistantCompletion"), false, "a restarted wait notifies instead of pushing a completion frame");
  reloaded.dispose();

  const waiting = new FakeSurface();
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-"));
  const assistant = makeRecord("assistant", ASSISTANT_CWD);
  waiting.records.set("assistant", assistant);
  const target2 = makeRecord("target2", "/repos/app", { running: true });
  waiting.records.set("target2", target2);
  waiting.exists.add("target2");
  const first = new AssistantOpsAuthority({ surface: waiting, store: new FileWorkspaceStateStore(dir), homedir: HOME, now: () => 1 });
  await first.handleWorkerOp(view(assistant), "p2", { sessionId: "assistant", op: { kind: "send", targetSessionId: "target2", message: "hold", delivery: "steer", waitMinutes: 5 } });
  first.dispose();
  const second = new AssistantOpsAuthority({ surface: waiting, store: new FileWorkspaceStateStore(dir), homedir: HOME, now: () => 2 });
  waiting.records.delete("target2");
  second.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(waiting.submits.at(-1)?.input.prompt ?? "", /结果: 已停止/, "a restarted wait settles as a notification");
  assert.equal(assistant.sent.some((frame) => frame.type === "worker.assistantCompletion"), false);
  second.dispose();
});

test("a dispose during a flush still persists the spliced queue (no duplicate after restart)", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  env.surface.contexts.set("target", [completedEntry("done")]);
  await send(env, "d1", { kind: "send", targetSessionId: "target", message: "work", delivery: "steer", waitMinutes: 0 });
  // Hold the delivery in flight, dispose the authority mid-flush, then let
  // the delivery succeed.
  let release!: () => void;
  env.surface.submitGate = new Promise<void>((resolve) => { release = resolve; });
  env.surface.records.delete("target");
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 50); // flush started; the batch is spliced and delivery is parked on the gate
  env.authority.dispose();
  release();
  await wait(100);
  const ledger = JSON.parse(readFileSync(join(env.dir, "workspace-state.json"), "utf8")).assistantDelegations as {
    delegations: Array<{ targetSessionId: string; state: string }>;
    queue: unknown[];
  };
  assert.equal(ledger.delegations.find((row) => row.targetSessionId === "target")?.state, "settled");
  assert.equal(ledger.queue.length, 0, "the delivered item must not remain queued on disk");
});

test("a delivery_failed notification gets exactly one more ride when the assistant (re)loads", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  env.surface.contexts.set("target", [completedEntry("all good")]);
  await send(env, "r1", { kind: "send", targetSessionId: "target", message: "work", delivery: "steer", waitMinutes: 0 });
  env.surface.records.delete("target");
  env.surface.submitError = { code: "unavailable", message: "down", retryable: true };
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  await wait(5_200);
  await wait(5_200);
  const ledgerPath = join(env.dir, "workspace-state.json");
  const parked = JSON.parse(readFileSync(ledgerPath, "utf8")).assistantDelegations as { delegations: Array<{ targetSessionId: string; state: string }>; queue: unknown[] };
  assert.equal(parked.delegations.find((row) => row.targetSessionId === "target")?.state, "delivery_failed");
  assert.equal(parked.queue.length, 0, "the exhausted item is parked, not retried on a timer");

  // Assistant still broken: the redelivery rides once and parks again.
  env.authority.noteAssistantReady("assistant");
  await wait(NOTIFY_MERGE + 100);
  await wait(5_200);
  const reparked = JSON.parse(readFileSync(ledgerPath, "utf8")).assistantDelegations as { delegations: Array<{ state: string }>; queue: unknown[] };
  assert.equal(reparked.delegations.find((row) => row.state === "delivery_failed") !== undefined, true, "one failed ride parks it again");
  assert.equal(reparked.queue.length, 0);

  // Assistant healthy: the redelivery lands with the retained render fields.
  env.surface.submitError = undefined;
  env.authority.noteAssistantReady("assistant");
  await wait(NOTIFY_MERGE + 100);
  const redelivered = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(redelivered, /id: target/);
  assert.match(redelivered, /结果: 完成/);
  assert.match(redelivered, /最后回复: all good/, "the retained lastText survives the redelivery");
  const delivered = JSON.parse(readFileSync(ledgerPath, "utf8")).assistantDelegations as { delegations: Array<{ state: string }>; queue: unknown[] };
  assert.equal(delivered.queue.length, 0);
  assert.equal(delivered.delegations.find((row) => row.state === "delivery_failed"), undefined);
  env.authority.dispose();
});

test("after a sessiond restart a cold target settles from its journal, not a blanket 已停止", async () => {
  const env = harness();
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 2 });
  env.surface.records.set("target", target);
  env.surface.exists.add("target");
  await send(env, "j1", { kind: "send", targetSessionId: "target", message: "work", delivery: "steer", waitMinutes: 0 });
  // The work finished and the journal proves it, but the daemon died before
  // the settle pass ran. After the restart there is no live record.
  env.surface.contexts.set("target", [completedEntry("finished the build")]);
  env.authority.dispose();

  const reloaded = new AssistantOpsAuthority({ surface: env.surface, store: new FileWorkspaceStateStore(env.dir), homedir: HOME, now: () => env.now });
  env.surface.records.delete("target"); // cold after restart; the session still exists
  reloaded.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  const completed = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(completed, /结果: 完成/, "a proven-finished journal reports completion");
  assert.match(completed, /最后回复: finished the build/);
  reloaded.dispose();

  // A journal without a turn-end stopReason stays an honest stop.
  const dir2 = mkdtempSync(join(tmpdir(), "pix-assistant-ops-cold-"));
  const surface = new FakeSurface();
  const assistant = makeRecord("assistant", ASSISTANT_CWD);
  surface.records.set("assistant", assistant);
  const t2 = makeRecord("t2", "/repos/app", { running: true, lastEventId: 2 });
  surface.records.set("t2", t2);
  surface.exists.add("t2");
  const first = new AssistantOpsAuthority({ surface, store: new FileWorkspaceStateStore(dir2), homedir: HOME, now: () => 1 });
  await first.handleWorkerOp(view(assistant), "j2", { sessionId: "assistant", op: { kind: "send", targetSessionId: "t2", message: "work", delivery: "steer", waitMinutes: 0 } });
  first.dispose();
  surface.contexts.set("t2", [{ role: "assistant", content: "partial work, no turn end" }]);
  const second = new AssistantOpsAuthority({ surface, store: new FileWorkspaceStateStore(dir2), homedir: HOME, now: () => 2 });
  surface.records.delete("t2"); // cold; session still exists
  second.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(surface.submits.at(-1)?.input.prompt ?? "", /结果: 已停止/, "no proof of completion ⇒ honest stop");
  second.dispose();

  // A deleted session is still a plain stop.
  const dir3 = mkdtempSync(join(tmpdir(), "pix-assistant-ops-cold2-"));
  const surface3 = new FakeSurface();
  surface3.records.set("assistant", makeRecord("assistant", ASSISTANT_CWD));
  const t3 = makeRecord("t3", "/repos/app", { running: true, lastEventId: 2 });
  surface3.records.set("t3", t3);
  surface3.exists.add("t3");
  const first3 = new AssistantOpsAuthority({ surface: surface3, store: new FileWorkspaceStateStore(dir3), homedir: HOME, now: () => 1 });
  await first3.handleWorkerOp(view(surface3.records.get("assistant")!), "j3", { sessionId: "assistant", op: { kind: "send", targetSessionId: "t3", message: "work", delivery: "steer", waitMinutes: 0 } });
  first3.dispose();
  const second3 = new AssistantOpsAuthority({ surface: surface3, store: new FileWorkspaceStateStore(dir3), homedir: HOME, now: () => 2 });
  surface3.records.delete("t3");
  surface3.exists.delete("t3"); // gone entirely
  second3.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  assert.match(surface3.submits.at(-1)?.input.prompt ?? "", /结果: 已停止/);
  second3.dispose();
});

test("legacy assistant-delegations.json is imported once and removed; an invalid one is left in place", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-legacy-"));
  const legacyPath = join(dir, "assistant-delegations.json");
  const legacy = {
    version: 1,
    delegations: [{
      id: "legacy-1",
      assistantSessionId: "assistant",
      targetSessionId: "target",
      targetTitle: "旧任务",
      targetCwd: "/repos/app",
      summary: "旧交办",
      createdAt: 1,
      createdEventId: 0,
      mode: "wait",
      state: "wait",
      waitMinutes: 5,
    }],
    chains: {},
    queue: [],
  };
  writeFileSync(legacyPath, JSON.stringify(legacy), "utf8");
  const surface = new FakeSurface();
  const assistant = makeRecord("assistant", ASSISTANT_CWD);
  surface.records.set("assistant", assistant);
  const store = new FileWorkspaceStateStore(dir);
  const authority = new AssistantOpsAuthority({ surface, store, legacyDirectory: dir, homedir: HOME, now: () => 1 });
  t.after(() => authority.dispose());
  // The namespace is now authoritative and the standalone file is gone.
  const stored = store.readAssistantDelegations() as { delegations: Array<{ id: string; state: string; mode: string }> };
  assert.equal(stored.delegations.length, 1);
  assert.equal(stored.delegations[0]?.id, "legacy-1");
  assert.equal(stored.delegations[0]?.state, "notify", "a legacy wait degrades to notify (its waiter is gone)");
  assert.equal(existsSync(legacyPath), false, "the standalone file is removed after a successful import");

  // An invalid legacy file is never destroyed and never adopted.
  const dir2 = mkdtempSync(join(tmpdir(), "pix-assistant-ops-legacy2-"));
  const badPath = join(dir2, "assistant-delegations.json");
  writeFileSync(badPath, "{ not json", "utf8");
  const surface2 = new FakeSurface();
  surface2.records.set("assistant", makeRecord("assistant", ASSISTANT_CWD));
  const store2 = new FileWorkspaceStateStore(dir2);
  const authority2 = new AssistantOpsAuthority({ surface: surface2, store: store2, legacyDirectory: dir2, homedir: HOME, now: () => 1 });
  t.after(() => authority2.dispose());
  assert.equal(store2.readAssistantDelegations(), undefined, "nothing was adopted from the invalid file");
  assert.equal(existsSync(badPath), true, "the invalid file is left in place for inspection");

  // A namespace value already present wins: no second import, no file touch.
  const dir3 = mkdtempSync(join(tmpdir(), "pix-assistant-ops-legacy3-"));
  writeFileSync(join(dir3, "assistant-delegations.json"), JSON.stringify(legacy), "utf8");
  const store3 = new FileWorkspaceStateStore(dir3);
  store3.writeAssistantDelegations({ version: 1, delegations: [], chains: {}, queue: [] });
  const authority3 = new AssistantOpsAuthority({ surface: new FakeSurface(), store: store3, legacyDirectory: dir3, homedir: HOME, now: () => 1 });
  t.after(() => authority3.dispose());
  assert.deepEqual((store3.readAssistantDelegations() as { delegations: unknown[] }).delegations, [], "the namespace value is authoritative");
  assert.equal(existsSync(join(dir3, "assistant-delegations.json")), true, "the legacy file is untouched when the namespace already has a value");
});

test("a semantically-broken namespace value degrades to empty without touching the flags in the same file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-badns-"));
  const store = new FileWorkspaceStateStore(dir);
  store.setSessionFlags("s1", { pinned: true });
  // Write a value that parses as JSON but fails the owner's ledger shape.
  store.writeAssistantDelegations({ version: 1, delegations: "not-an-array", chains: {}, queue: [] });
  const authority = new AssistantOpsAuthority({ surface: new FakeSurface(), store: new FileWorkspaceStateStore(dir), homedir: HOME, now: () => 1 });
  t.after(() => authority.dispose());
  // The authority still works (empty ledger) and the flags survive.
  const fresh = new FileWorkspaceStateStore(dir).snapshot();
  assert.deepEqual(fresh.sessions, { s1: { pinned: true } }, "flags in the same document are untouched by the bad namespace");
});

const IDLE_GRACE = 2_500;
const NOTIFY_MERGE = 1_600;

/**
 * Settle one target whose last assistant reply is `reply` and return the
 * delivered notification prompt. `stateDirectory`/`now` decide where the
 * full-reply file (if any) lands.
 */
async function settleWithReply(reply: string, options: { stateDirectory?: string; clock?: number; waitMinutes?: number } = {}): Promise<{ prompt: string; dir: string; completion: { payload: Record<string, unknown> } | undefined }> {
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-reply-"));
  const surface = new FakeSurface();
  const clock = options.clock ?? 1_000_000;
  const authority = new AssistantOpsAuthority({
    surface,
    store: new FileWorkspaceStateStore(dir),
    homedir: HOME,
    now: () => clock,
    ...(options.stateDirectory === undefined
      ? { stateDirectory: dir }
      : options.stateDirectory === "disk" ? {} : { stateDirectory: options.stateDirectory }),
  });
  const assistant = makeRecord("assistant", ASSISTANT_CWD);
  surface.records.set("assistant", assistant);
  const target = makeRecord("target", "/repos/app", { running: true, lastEventId: 1 });
  surface.records.set("target", target);
  surface.exists.add("target");
  surface.contexts.set("target", [completedEntry(reply)]);
  await authority.handleWorkerOp(view(assistant), "rep-1", { sessionId: "assistant", op: { kind: "send", targetSessionId: "target", message: "work", delivery: "steer", waitMinutes: options.waitMinutes ?? 0 } });
  surface.records.delete("target");
  authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  authority.dispose();
  return {
    prompt: surface.submits.at(-1)?.input.prompt ?? "",
    dir,
    completion: assistant.sent.find((frame) => frame.type === "worker.assistantCompletion") as { payload: Record<string, unknown> } | undefined,
  };
}

test("a reply under the inline cap rides the notification whole", async () => {
  const reply = "x".repeat(1_900) + "尾部标记";
  const { prompt, dir } = await settleWithReply(reply);
  assert.match(prompt, new RegExp(`最后回复: ${reply.slice(0, 40)}`));
  assert.equal(prompt.includes("尾部标记"), true, "nothing is truncated under the cap");
  assert.equal(prompt.includes("已保存到"), false, "no file line when the whole reply fits");
  assert.equal(existsSync(join(dir, "assistant-replies")), false, "no file is written for a short reply");
});

test("a reply over the inline cap is written to a file and only previewed", async () => {
  const reply = "头" + "y".repeat(2_500) + "末尾标记";
  const { prompt, dir } = await settleWithReply(reply, { clock: 1_700_000_000_000 });
  const path = join(dir, "assistant-replies", "target-1700000000000.md");
  assert.equal(existsSync(path), true, "the full reply lands in the sessiond state directory");
  assert.equal(readFileSync(path, "utf8"), reply, "the file holds the whole reply, not a preview");
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600, "the reply file is private"); // NTFS: no mode bits
    assert.equal(statSync(join(dir, "assistant-replies")).mode & 0o777, 0o700, "the reply directory is private");
  }
  assert.equal(prompt.includes(reply.slice(0, 600)), true, "the notification carries the 600-char preview");
  assert.equal(prompt.includes("末尾标记"), false, "the notification does not carry the full text");
  assert.match(prompt, new RegExp(`（全文 ${reply.length} 字已保存到 ${escapeRegExp(path)}，需要时用 read 读取）`));

  // The same fields ride the completion frame a waiting assistant receives.
  const waited = await settleWithReply(reply, { clock: 1_700_000_000_000, waitMinutes: 5 });
  assert.equal(waited.completion?.payload.lastTextPath, join(waited.dir, "assistant-replies", "target-1700000000000.md"), "the completion frame carries the path");
  assert.equal(waited.completion?.payload.lastTextChars, reply.length);
  assert.equal(waited.completion?.payload.lastText, reply.slice(0, 600));
});

test("reply files beyond the newest 100 are removed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-assistant-ops-replies-"));
  mkdirSync(join(directory, "assistant-replies"), { recursive: true, mode: 0o700 });
  for (let index = 0; index < 100; index += 1) {
    writeFileSync(join(directory, "assistant-replies", `old-${1000 + index}.md`), "old", "utf8");
  }
  const reply = "z".repeat(2_500);
  await settleWithReply(reply, { stateDirectory: directory, clock: 2_000_000_000_000 });
  const files = readdirSync(join(directory, "assistant-replies"));
  assert.equal(files.length, 100, "the directory is capped at 100 files");
  assert.equal(files.includes("old-1000.md"), false, "the oldest file is removed");
  assert.equal(files.includes("target-2000000000000.md"), true, "the new reply survives the prune");
});

test("a failed reply-file write degrades to the preview without a path", async () => {
  // A regular file where the reply directory must go makes mkdir fail.
  const blocked = mkdtempSync(join(tmpdir(), "pix-assistant-ops-blocked-"));
  writeFileSync(join(blocked, "assistant-replies"), "not a directory", "utf8");
  const reply = "w".repeat(2_500) + "尾部标记";
  const { prompt, completion } = await settleWithReply(reply, { stateDirectory: blocked });
  assert.match(prompt, /结果: 完成/, "the notification still delivers");
  assert.equal(prompt.includes(reply.slice(0, 600)), true, "the preview is still there");
  assert.equal(prompt.includes("已保存到"), false, "no path line when the write failed");
  assert.equal(completion?.payload.lastTextPath, undefined);
  assert.equal(completion?.payload.lastTextChars, undefined);
});

test("an untitled create is named by its first message, never by its raw id", async () => {
  const env = harness();
  env.surface.createSessionId = "01a14932-8a20-7000-8000-000000000000";
  // The catalog names an untitled session by its first message (sessiond's
  // readSessionHeader already does this from the header's firstMessage).
  env.surface.headers.set(env.surface.createSessionId, { title: "整理周报", cwd: env.dir });
  env.assistant.operationId = "turn-untitled";
  const admitted = payload(await send(env, "u1", { kind: "create", cwd: env.dir, message: "first", waitMinutes: 0 }));
  assert.equal(admitted.ok, true);
  // Settlement refreshes the name; the delivered text must carry it.
  env.surface.records.delete(env.surface.createSessionId);
  env.surface.contexts.set(env.surface.createSessionId, [completedEntry("done")]);
  env.authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  const prompt = env.surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(prompt, /会话: 整理周报｜项目: /);
  assert.equal(prompt.includes(env.surface.createSessionId), true, "the id stays in the line as the machine handle");
  assert.equal(prompt.includes(`会话: ${env.surface.createSessionId}｜`), false, "the title is never the raw id");
  env.authority.dispose();
});

test("a delegation whose title is still empty or the id is renamed from the catalog at delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-assistant-ops-untitled-"));
  const surface = new FakeSurface();
  const assistant = makeRecord("assistant", ASSISTANT_CWD);
  surface.records.set("assistant", assistant);
  // A ledger row written before the session had a name: targetTitle === id.
  const store = new FileWorkspaceStateStore(dir);
  store.writeAssistantDelegations({
    version: 1,
    delegations: [{
      id: "d-untitled",
      assistantSessionId: "assistant",
      targetSessionId: "target",
      targetTitle: "target",
      targetCwd: "/repos/app",
      summary: "旧交办",
      createdAt: 1,
      createdEventId: 0,
      mode: "notify",
      state: "notify",
      waitMinutes: 0,
    }],
    chains: {},
    queue: [{
      delegationId: "d-untitled",
      assistantSessionId: "assistant",
      targetSessionId: "target",
      targetTitle: "target",
      targetCwd: "/repos/app",
      outcome: "completed",
      attempts: 0,
    }],
  });
  // The catalog now knows the name the UI shows.
  surface.headers.set("target", { title: "整理周报", cwd: "/repos/app" });
  const authority = new AssistantOpsAuthority({ surface, store, homedir: HOME, now: () => 1 });
  authority.scheduleSettleCheck();
  await wait(80);
  await wait(NOTIFY_MERGE + 100);
  const prompt = surface.submits.at(-1)?.input.prompt ?? "";
  assert.match(prompt, /会话: 整理周报｜项目: app｜id: target/);
  authority.dispose();
});

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
