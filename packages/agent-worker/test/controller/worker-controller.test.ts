import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerToSessiondPushSchema } from "@fffattiger/pix-protocol";
import type { SessiondToWorkerMessage, WorkerToSessiondMessage } from "@fffattiger/pix-protocol";
import type { RuntimeCommand as ProtocolRuntimeCommand } from "@fffattiger/pix-protocol";
import type { RuntimeCommandResult as CoreRuntimeCommandResult } from "@fffattiger/pix-runtime-core";
import { SESSIOND_BUILD_IDENTITY } from "@fffattiger/pix-protocol";
import { WorkerController, type WorkerOutbound } from "../../src/controller/worker-controller.js";
import { FakeAgentRuntimeFactory, defaultCoreSnapshot } from "../helpers/fake-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class OutboundRecorder implements WorkerOutbound {
  readonly messages: WorkerToSessiondMessage[] = [];
  async send(message: WorkerToSessiondMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

interface Harness {
  controller: WorkerController;
  recorder: OutboundRecorder;
  factory: FakeAgentRuntimeFactory;
  exitCodes: number[];
}

function createHarness(factory: FakeAgentRuntimeFactory): Harness {
  const recorder = new OutboundRecorder();
  const exitCodes: number[] = [];
  const controller = new WorkerController({
    factory,
    outbound: recorder,
    requestExit: (code) => exitCodes.push(code),
    logger: () => {},
    shutdownTimeoutMs: 60,
  });
  return { controller, recorder, factory, exitCodes };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function initMessage(
  overrides: Partial<Extract<SessiondToWorkerMessage, { type: "worker.init" }>["payload"]> & { mode: "create" | "open" },
): SessiondToWorkerMessage {
  return {
    type: "worker.init",
    id: "init-1",
    protocolVersion: 2,
    payload: {
      sessionId: "provisional-session",
      // Phase 5B: the worker adopts this as its authorityEpoch; command/read/
      // interrupt/submitTurn test frames below carry the SAME epoch.
      epoch: "e1",
      cwd: "/workspace",
      projectRoot: "/workspace",
      // Phase 7A build fence: default to the canonical compiled build identity;
      // tests may override `build` to prove the Worker rejects mismatched
      // sessiond builds before creating any runtime.
      build: SESSIOND_BUILD_IDENTITY,
      ...overrides,
    },
  };
}

function commandMessage(command: DistributiveOmit<ProtocolRuntimeCommand, "commandId">, sessionId = "sess-real", id = "wire-1", commandId = "cmd-1"): SessiondToWorkerMessage {
  return {
    type: "worker.command",
    id,
    protocolVersion: 2,
    payload: { sessionId, epoch: "e1", command: { ...command, commandId } },
  };
}

function rotateEpochMessage(fromEpoch = "e1", toEpoch = "e2", id = "rotate-1"): SessiondToWorkerMessage {
  return {
    type: "worker.rotateEpoch",
    id,
    protocolVersion: 2,
    payload: { sessionId: "sess-real", fromEpoch, toEpoch },
  };
}

function interruptMessage(sessionId = "sess-real", id = "wire-i"): SessiondToWorkerMessage {
  return {
    type: "worker.interrupt",
    id,
    protocolVersion: 2,
    payload: { sessionId, epoch: "e1", commandId: "cmd-1", interrupt: { type: "abort" } },
  };
}

function submitTurnMessage(
  sessionId = "sess-real",
  overrides: Partial<{ id: string; operationId: string; turnId: string; fingerprint: string; prompt: string }> = {},
): SessiondToWorkerMessage {
  return {
    type: "worker.submitTurn",
    id: overrides.id ?? "wire-submit",
    protocolVersion: 2,
    payload: {
      sessionId,
      epoch: "e1",
      operationId: overrides.operationId ?? "op-1",
      turnId: overrides.turnId ?? "turn-1",
      fingerprint: overrides.fingerprint ?? "fp-1",
      request: { sessionId, prompt: overrides.prompt ?? "hello", operationId: overrides.operationId ?? "op-1" },
    },
  };
}

function isSubmitTurnResult(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.submitTurnResult" }> {
  return m.type === "worker.submitTurnResult";
}
function isTurnStatus(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.turnStatus" }> {
  return m.type === "worker.turnStatus";
}

function isCommandResult(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.commandResult" }> {
  return m.type === "worker.commandResult";
}
function isInterruptResult(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.interruptResult" }> {
  return m.type === "worker.interruptResult";
}
function isEvent(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.event" }> {
  return m.type === "worker.event";
}
function isReady(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.ready" }> {
  return m.type === "worker.ready";
}
function isDiscovered(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.sessionDiscovered" }> {
  return m.type === "worker.sessionDiscovered";
}
function isSnapshot(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.snapshot" }> {
  return m.type === "worker.snapshot";
}
function isFatal(m: WorkerToSessiondMessage): m is Extract<WorkerToSessiondMessage, { type: "worker.fatal" }> {
  return m.type === "worker.fatal";
}

const promptResult: CoreRuntimeCommandResult = { ok: true, type: "prompt" };

describe("WorkerController", () => {
  it("create init boots the runtime, rekeys to the real session id, and emits ready last", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real", sessionFile: "/sessions/sess-real.jsonl" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));

    assert.equal(controller.phase, "ready");
    assert.equal(controller.sessionId, "sess-real");
    assert.deepEqual(factory.createCalls.map((call) => call.cwd), ["/workspace"]);
    const discovered = recorder.messages.filter(isDiscovered);
    const ready = recorder.messages.filter(isReady);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.payload.sessionId, "sess-real");
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.payload.sessionId, "sess-real");
    assert.equal(ready[0]?.payload.workerStatus, "ready");
    assert.deepEqual(ready[0]?.payload.features, ["runtime.read-rpc.v1", "runtime.submit-turn.v1"]);
    // ready must come after sessionDiscovered
    assert.ok(recorder.messages.indexOf(discovered[0]!) < recorder.messages.indexOf(ready[0]!));
    for (const message of recorder.messages) {
      assert.equal(WorkerToSessiondPushSchema.safeParse(message).success, true);
    }
  });

  it("open init emits ready without a rekey when the id already matches", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-existing" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "open", sessionId: "sess-existing" }));

    assert.equal(controller.phase, "ready");
    assert.equal(recorder.messages.filter(isDiscovered).length, 0);
    assert.equal(recorder.messages.filter(isReady).length, 1);
    assert.deepEqual(factory.openCalls.map((call) => call.sessionId), ["sess-existing"]);
  });

  it("submitTurn: wrong session identity rejects conflict with zero port calls; matching identity admits once", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    const runtime = factory.created[0]!;

    // Wrong session id → rejected conflict, the adapter's submitTurn is never called.
    await controller.handleMessage(submitTurnMessage("sess-WRONG", { id: "wire-wrong" }));
    const wrong = recorder.messages.filter(isSubmitTurnResult).at(-1)!;
    assert.equal(wrong.payload.result.status, "rejected");
    if (wrong.payload.result.status === "rejected") assert.equal(wrong.payload.result.error.code, "conflict");
    assert.equal(runtime.submitTurnCalls.length, 0, "wrong identity must never reach the adapter");

    // Matching identity → the adapter's submitTurn is called once, admission accepted.
    await controller.handleMessage(submitTurnMessage("sess-real", { id: "wire-ok", operationId: "op-1" }));
    const ok = recorder.messages.filter(isSubmitTurnResult).at(-1)!;
    assert.equal(ok.payload.result.status, "accepted", JSON.stringify(ok.payload.result));
    assert.equal(runtime.submitTurnCalls.length, 1);
    assert.equal(runtime.submitTurnCalls[0]?.prompt, "hello");
  });

  it("submitTurn deduplicates same epoch+operation+fingerprint and emits one terminal status", async () => {
    const admissionGate = deferred<import("@fffattiger/pix-runtime-core").RuntimeTurnHandle>();
    const terminalGate = deferred<import("@fffattiger/pix-runtime-core").RuntimeTurnTerminal>();
    const snapshot = defaultCoreSnapshot("sess-real");
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onSubmitTurn: async () => admissionGate.promise,
    });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    const runtime = factory.created[0]!;

    const first = controller.handleMessage(submitTurnMessage("sess-real", { id: "wire-first", operationId: "op-same", turnId: "turn-same", fingerprint: "fp-same" }));
    const second = controller.handleMessage(submitTurnMessage("sess-real", { id: "wire-retry", operationId: "op-same", turnId: "turn-same", fingerprint: "fp-same" }));
    assert.equal(runtime.submitTurnCalls.length, 1, "same operation retry must join one port.submitTurn call");

    admissionGate.resolve({ admission: { ok: true, snapshot }, completion: terminalGate.promise });
    await Promise.all([first, second]);
    const admissions = recorder.messages.filter(isSubmitTurnResult).filter((message) => message.payload.operationId === "op-same");
    assert.equal(admissions.length, 2, "both transport attempts receive the one cached admission");
    assert.deepEqual(admissions.map((message) => message.id).sort(), ["wire-first", "wire-retry"]);
    assert.ok(admissions.every((message) => message.payload.result.status === "accepted"));

    terminalGate.resolve({ ok: true, snapshot, userEntryId: "entry-user" });
    await Promise.resolve();
    await Promise.resolve();
    const terminal = recorder.messages.filter(isTurnStatus).filter((message) => message.payload.operationId === "op-same" && message.payload.state === "completed");
    assert.equal(terminal.length, 1, "one authority operation emits exactly one terminal status");
    assert.deepEqual(terminal[0]?.payload, {
      sessionId: "sess-real",
      epoch: "e1",
      operationId: "op-same",
      turnId: "turn-same",
      revision: 1,
      state: "completed",
      userEntryId: "entry-user",
    });
  });

  it("submitTurn never labels the pre-turn admission leaf final", async () => {
    const terminalGate = deferred<import("@fffattiger/pix-runtime-core").RuntimeTurnTerminal>();
    const preTurnSnapshot = defaultCoreSnapshot("sess-real");
    preTurnSnapshot.state.leafId = "pre-turn-leaf";
    const finalSnapshot = defaultCoreSnapshot("sess-real");
    finalSnapshot.state.leafId = "assistant-final";
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onSubmitTurn: async () => ({ admission: { ok: true, snapshot: preTurnSnapshot }, completion: terminalGate.promise }),
    });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));

    await controller.handleMessage(submitTurnMessage("sess-real", { id: "wire-identity", operationId: "op-identity", turnId: "turn-identity" }));
    const admission = recorder.messages.filter(isSubmitTurnResult).at(-1)!;
    assert.equal(admission.payload.result.status, "accepted");
    if (admission.payload.result.status === "accepted") {
      assert.equal(admission.payload.result.turnStatus.finalLeafId, undefined, "admission snapshot leaf predates the turn and is never final");
    }

    terminalGate.resolve({ ok: true, snapshot: finalSnapshot, userEntryId: "entry-user" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const terminal = recorder.messages.filter(isTurnStatus).find((message) => message.payload.operationId === "op-identity" && message.payload.state === "completed");
    assert.deepEqual(terminal?.payload, {
      sessionId: "sess-real",
      epoch: "e1",
      operationId: "op-identity",
      turnId: "turn-identity",
      revision: 1,
      state: "completed",
      userEntryId: "entry-user",
      finalLeafId: "assistant-final",
    });
  });

  it("submitTurn rejects same operation with a different fingerprint without a second port call", async () => {
    const admissionGate = deferred<import("@fffattiger/pix-runtime-core").RuntimeTurnHandle>();
    const snapshot = defaultCoreSnapshot("sess-real");
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onSubmitTurn: async () => admissionGate.promise,
    });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    const runtime = factory.created[0]!;

    const first = controller.handleMessage(submitTurnMessage("sess-real", { id: "wire-first", operationId: "op-conflict", fingerprint: "fp-a" }));
    await controller.handleMessage(submitTurnMessage("sess-real", { id: "wire-conflict", operationId: "op-conflict", fingerprint: "fp-b" }));
    assert.equal(runtime.submitTurnCalls.length, 1);
    const conflict = recorder.messages.filter(isSubmitTurnResult).find((message) => message.id === "wire-conflict")!;
    assert.equal(conflict.payload.result.status, "rejected");
    if (conflict.payload.result.status === "rejected") assert.equal(conflict.payload.result.error.code, "conflict");

    admissionGate.resolve({ admission: { ok: false, error: { code: "unavailable", message: "test rejection", retryable: false }, snapshot }, completion: Promise.resolve({ ok: false, error: { code: "unavailable", message: "test rejection", retryable: false }, snapshot }) });
    await first;
    assert.equal(runtime.submitTurnCalls.length, 1, "fingerprint conflict must never dispatch a second submitTurn");
  });

  it("prompt command streams events and resolves exactly one correlated commandResult", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onExecute: async (command, runtime) => {
        if (command.type === "prompt") {
          runtime.emit({ type: "agent_start", sessionId: "sess-real" });
          runtime.emit({ type: "message_update", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } });
          runtime.emit({ type: "message_update", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
          runtime.emit({ type: "message_end", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], model: "m", provider: "p" }, entryId: "entry-1" });
          runtime.emit({ type: "prompt_done", sessionId: "sess-real" });
          return { ok: true, type: "prompt" };
        }
        return { ok: true, type: command.type } as CoreRuntimeCommandResult;
      },
    });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage(commandMessage({ type: "prompt", message: "hi" }));

    const events = recorder.messages.filter(isEvent);
    const types = events.map((event) => event.payload.event.type);
    assert.ok(types.includes("agent_start"));
    assert.ok(types.includes("message_start"));
    assert.ok(types.includes("message_update"));
    assert.ok(types.includes("message_end"));
    assert.ok(types.includes("prompt_done"));
    // The delta for Hel -> Hello must be the suffix only.
    const update = events.find((event) => event.payload.event.type === "message_update");
    assert.deepEqual((update?.payload.event as { delta: unknown }).delta, { role: "assistant", delta: { type: "text", text: "lo" } });

    const results = recorder.messages.filter(isCommandResult);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "wire-1");
    assert.equal(results[0]?.payload.sessionId, "sess-real");
    assert.equal(results[0]?.payload.result.commandId, "cmd-1");
    assert.deepEqual(results[0]?.payload.result.result, { ok: true, type: "prompt" });
  });

  it("abort interrupt resolves exactly one correlated interruptResult", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onInterrupt: async (interrupt) => ({ ok: true, type: interrupt.type }),
    });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage(interruptMessage());

    const results = recorder.messages.filter(isInterruptResult);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "wire-i");
    assert.equal(results[0]?.payload.result.commandId, "cmd-1");
    assert.deepEqual(results[0]?.payload.result.result, { ok: true, type: "abort" });
  });

  it("getSnapshot maps and echoes the wire id", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage({ type: "worker.getSnapshot", id: "snap-1", protocolVersion: 2, payload: { sessionId: "sess-real" } });

    const snapshots = recorder.messages.filter(isSnapshot);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.id, "snap-1");
    assert.equal(snapshots[0]?.payload.snapshot.sessionId, "sess-real");
    assert.equal(snapshots[0]?.payload.snapshot.cwd, "/workspace");
  });

  it("duplicate commandId fails closed with a correlated command_duplicate error", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real", onExecute: async () => promptResult });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage(commandMessage({ type: "prompt", message: "a" }, "sess-real", "wire-1"));
    await controller.handleMessage(commandMessage({ type: "prompt", message: "b" }, "sess-real", "wire-2"));

    const results = recorder.messages.filter(isCommandResult);
    assert.equal(results.length, 2);
    const duplicateOutcome = results[1]!.payload.result.result;
    if (duplicateOutcome.ok === false) {
      assert.equal(duplicateOutcome.error.code, "command_duplicate");
    } else {
      assert.fail("expected duplicate command to fail closed");
    }
  });

  it("read-only command ids may repeat after sessiond result-cache eviction", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onRead: async (request) => {
        if (request.type !== "get_last_assistant_text") throw new Error("unexpected read");
        return { ok: true, type: "get_last_assistant_text", text: "" };
      },
    });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage(commandMessage({ type: "get_last_assistant_text" }, "sess-real", "wire-read-1"));
    await controller.handleMessage(commandMessage({ type: "get_last_assistant_text" }, "sess-real", "wire-read-2"));

    const results = recorder.messages.filter(isCommandResult);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.payload.result.result.ok, true);
    assert.equal(results[1]?.payload.result.result.ok, true);
    // Phase 2B: legacy worker.command(read) translates to port.read() — the
    // mutation execute path is never used for read-only commands.
    assert.equal(factory.created[0]?.executeCalls.length, 0);
    assert.equal(factory.created[0]?.readCalls.length, 2);
  });

  it("a read-only command settles while a long-running prompt is still in flight, then the prompt result follows", async () => {
    // Deterministic deferred gate: the prompt's runtime execute stays pending
    // until the test releases it — no sleeps, no timing assertions.
    const promptGate = deferred<CoreRuntimeCommandResult>();
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onExecute: async (command) => {
        if (command.type === "prompt") return promptGate.promise;
        throw new Error(`unexpected command: ${command.type}`);
      },
      onRead: async (request) => {
        if (request.type !== "get_state") throw new Error(`unexpected read: ${request.type}`);
        return { ok: true, type: "get_state", state: defaultCoreSnapshot("sess-real").state };
      },
    });
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));

    // 1. Start a prompt whose runtime call remains pending.
    const promptHandle = controller.handleMessage(
      commandMessage({ type: "prompt", message: "long-running" }, "sess-real", "wire-prompt", "cmd-prompt"),
    );
    // The prompt execute must actually have reached the port before the read
    // is admitted (proves the read runs concurrently, not after the prompt).
    assert.deepEqual(factory.created[0]?.executeCalls.map((call) => call.type), ["prompt"]);

    // 2. While the prompt is still pending, run a read-only command to settle.
    await controller.handleMessage(
      commandMessage({ type: "get_state" }, "sess-real", "wire-read", "cmd-read"),
    );

    // 3. The read result is already emitted with its own wire id / commandId /
    //    type, and the prompt result must NOT be emitted yet.
    const before = recorder.messages.filter(isCommandResult);
    assert.equal(before.length, 1);
    const readResult = before[0]!;
    assert.equal(readResult.id, "wire-read");
    assert.equal(readResult.payload.result.commandId, "cmd-read");
    const readOutcome = readResult.payload.result.result;
    if (readOutcome.ok) {
      assert.equal(readOutcome.type, "get_state");
      assert.equal(readOutcome.state.sessionId, "sess-real");
    } else {
      assert.fail("expected read to succeed");
    }
    assert.ok(
      !before.some((message) => message.payload.result.commandId === "cmd-prompt"),
      "prompt result must not settle before the read does",
    );

    // 4. Resolve the prompt; its correlated result must then emit.
    promptGate.resolve({ ok: true, type: "prompt" });
    await promptHandle;

    const after = recorder.messages.filter(isCommandResult);
    assert.equal(after.length, 2);
    const promptResult = after[1]!;
    assert.equal(promptResult.id, "wire-prompt");
    assert.equal(promptResult.payload.result.commandId, "cmd-prompt");
    assert.deepEqual(promptResult.payload.result.result, { ok: true, type: "prompt" });

    // 5. No duplicate / malformed correlation and no leakage: the prompt ran
    //    via execute, the read via port.read() (Phase 2B dispatch split); each
    //    settled exactly once, no fatal path, no stray exit.
    assert.equal(factory.created[0]?.executeCalls.length, 1);
    assert.deepEqual(factory.created[0]?.executeCalls.map((call) => call.type), ["prompt"]);
    assert.deepEqual(factory.created[0]?.readCalls.map((call) => call.type), ["get_state"]);
    assert.equal(recorder.messages.filter(isFatal).length, 0);
    assert.deepEqual(exitCodes, []);
  });

  it("safe idle rotate clears the whole Worker epoch ledger; stale frames stay inert and the new epoch admits", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    const runtime = factory.created[0]!;

    await controller.handleMessage(commandMessage({ type: "set_auto_retry", enabled: true }, "sess-real", "wire-old", "same-id"));
    assert.equal(runtime.executeCalls.length, 1);
    await controller.handleMessage(rotateEpochMessage());
    const rotated = recorder.messages.find((message) => message.type === "worker.rotateEpochResult" && message.id === "rotate-1");
    assert.ok(rotated?.type === "worker.rotateEpochResult" && rotated.payload.ok);

    await controller.handleMessage({
      type: "worker.command", id: "wire-stale", protocolVersion: 2,
      payload: { sessionId: "sess-real", epoch: "e1", command: { type: "set_auto_retry", commandId: "stale-id", enabled: false } },
    });
    assert.equal(runtime.executeCalls.length, 1, "stale old-epoch frame must not reach the port");
    const stale = recorder.messages.find((message) => message.type === "worker.commandResult" && message.id === "wire-stale");
    assert.ok(stale?.type === "worker.commandResult" && !stale.payload.result.result.ok);
    if (stale?.type === "worker.commandResult" && !stale.payload.result.result.ok) assert.equal(stale.payload.result.result.error.code, "epoch_changed");

    await controller.handleMessage({
      type: "worker.command", id: "wire-new", protocolVersion: 2,
      payload: { sessionId: "sess-real", epoch: "e2", command: { type: "set_auto_retry", commandId: "same-id", enabled: false } },
    });
    assert.equal(runtime.executeCalls.length, 2, "same business id is reusable only in the new exact epoch");
  });

  it("non-idle rotate rejects session_busy and clears no Worker ledger", async () => {
    const snapshot = defaultCoreSnapshot("sess-real");
    snapshot.state.isPromptRunning = true;
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real", snapshot });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    const runtime = factory.created[0]!;
    await controller.handleMessage(commandMessage({ type: "set_auto_retry", enabled: true }, "sess-real", "wire-first", "held-id"));
    await controller.handleMessage(rotateEpochMessage());
    const rejected = recorder.messages.find((message) => message.type === "worker.rotateEpochResult" && message.id === "rotate-1");
    assert.ok(rejected?.type === "worker.rotateEpochResult" && !rejected.payload.ok);
    if (rejected?.type === "worker.rotateEpochResult" && !rejected.payload.ok) assert.equal(rejected.payload.error.code, "session_busy");
    await controller.handleMessage(commandMessage({ type: "set_auto_retry", enabled: false }, "sess-real", "wire-dup", "held-id"));
    assert.equal(runtime.executeCalls.length, 1, "failed rotate must preserve the old dedup ledger");
  });

  it("command before init fails closed with worker_unavailable", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(commandMessage({ type: "get_state" }, "sess-real"));

    const results = recorder.messages.filter(isCommandResult);
    assert.equal(results.length, 1);
    const outcome = results[0]!.payload.result.result;
    if (outcome.ok === false) {
      assert.equal(outcome.error.code, "worker_unavailable");
    } else {
      assert.fail("expected pre-init command to fail closed");
    }
  });

  it("session id mismatch fails closed with a conflict result", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage(commandMessage({ type: "get_state" }, "other-session"));

    const results = recorder.messages.filter(isCommandResult);
    const outcome = results[0]!.payload.result.result;
    if (outcome.ok === false) {
      assert.equal(outcome.error.code, "conflict");
    } else {
      assert.fail("expected session mismatch to fail closed");
    }
  });

  it("worker.hostResponse (unexpected) fails closed with worker.fatal and exit(1)", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage({ type: "worker.hostResponse", id: "h1", protocolVersion: 2, payload: { requestId: "r1", ok: true, data: {} } });

    const fatal = recorder.messages.filter(isFatal);
    assert.equal(fatal.length, 1);
    assert.equal(fatal[0]?.payload.error.code, "invalid_request");
    assert.deepEqual(exitCodes, [1]);
  });

  it("duplicate init fails closed", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage(initMessage({ mode: "create" }));

    const fatal = recorder.messages.filter(isFatal);
    assert.equal(fatal.length, 1);
    assert.equal(fatal[0]?.payload.error.code, "conflict");
    assert.deepEqual(exitCodes, [1]);
  });

  it("init failure emits worker.fatal and exits 1", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.createError = new Error("backend unavailable");
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));

    assert.equal(controller.phase, "failed");
    const fatal = recorder.messages.filter(isFatal);
    assert.equal(fatal.length, 1);
    assert.equal(fatal[0]?.payload.error.code, "external");
    assert.deepEqual(exitCodes, [1]);
  });

  it("shutdown closes the runtime and requests exit(0)", async () => {
    const factory = new FakeAgentRuntimeFactory();
    let closeReason: string | undefined;
    factory.script = () => ({
      sessionId: "sess-real",
      onClose: (reason) => { closeReason = reason; },
    });
    const { controller, exitCodes, factory: f } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage({ type: "worker.shutdown", id: "sh-1", protocolVersion: 2, payload: { sessionId: "sess-real", reason: "user" } });

    assert.equal(closeReason, "shutdown");
    assert.equal(f.created[0]?.closeReasons.length, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.equal(controller.phase, "stopped");
  });

  it("shutdown timeout fails the exit with 1", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onClose: () => new Promise<void>(() => { /* never resolves */ }),
    });
    const { controller, exitCodes } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.handleMessage({ type: "worker.shutdown", id: "sh-1", protocolVersion: 2, payload: { reason: "user" } });

    assert.deepEqual(exitCodes, [1]);
    assert.equal(controller.phase, "stopped");
  });

  it("onInputClosed performs the same ordered shutdown and clean exit", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, exitCodes, factory: f } = createHarness(factory);
    await controller.handleMessage(initMessage({ mode: "create" }));
    await controller.onInputClosed();
    assert.equal(f.created[0]?.closeReasons[0], "user");
    assert.deepEqual(exitCodes, [0]);
  });
});
