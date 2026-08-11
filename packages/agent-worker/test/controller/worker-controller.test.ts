import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerToSessiondPushSchema } from "@fffattiger/pix-protocol";
import type { SessiondToWorkerMessage, WorkerToSessiondMessage } from "@fffattiger/pix-protocol";
import type { RuntimeCommand as ProtocolRuntimeCommand } from "@fffattiger/pix-protocol";
import type { RuntimeCommandResult as CoreRuntimeCommandResult } from "@fffattiger/pix-runtime-core";
import { WorkerController, type WorkerOutbound } from "../../src/controller/worker-controller.js";
import { FakeAgentRuntimeFactory } from "../helpers/fake-runtime.js";

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
    protocolVersion: 1,
    payload: {
      sessionId: "provisional-session",
      cwd: "/workspace",
      projectRoot: "/workspace",
      ...overrides,
    },
  };
}

function commandMessage(command: DistributiveOmit<ProtocolRuntimeCommand, "commandId">, sessionId = "sess-real", id = "wire-1"): SessiondToWorkerMessage {
  return {
    type: "worker.command",
    id,
    protocolVersion: 1,
    payload: { sessionId, command: { ...command, commandId: "cmd-1" } },
  };
}

function interruptMessage(sessionId = "sess-real", id = "wire-i"): SessiondToWorkerMessage {
  return {
    type: "worker.interrupt",
    id,
    protocolVersion: 1,
    payload: { sessionId, commandId: "cmd-1", interrupt: { type: "abort" } },
  };
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

  it("prompt command streams events and resolves exactly one correlated commandResult", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onExecute: async (command, runtime) => {
        if (command.type === "prompt") {
          runtime.emit({ type: "agent_start", sessionId: "sess-real" });
          runtime.emit({ type: "message_update", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } });
          runtime.emit({ type: "message_update", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
          runtime.emit({ type: "message_end", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], model: "m", provider: "p" } });
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
    await controller.handleMessage({ type: "worker.getSnapshot", id: "snap-1", protocolVersion: 1, payload: { sessionId: "sess-real" } });

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
    await controller.handleMessage({ type: "worker.hostResponse", id: "h1", protocolVersion: 1, payload: { requestId: "r1", ok: true, data: {} } });

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
    await controller.handleMessage({ type: "worker.shutdown", id: "sh-1", protocolVersion: 1, payload: { sessionId: "sess-real", reason: "user" } });

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
    await controller.handleMessage({ type: "worker.shutdown", id: "sh-1", protocolVersion: 1, payload: { reason: "user" } });

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
