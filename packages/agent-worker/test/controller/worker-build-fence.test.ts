import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerToSessiondPushSchema, WORKER_BUILD_IDENTITY, SESSIOND_BUILD_IDENTITY, type SessiondBuild } from "@fffattiger/pix-protocol";
import type { SessiondToWorkerMessage, WorkerToSessiondMessage } from "@fffattiger/pix-protocol";
import { WorkerController, type WorkerOutbound } from "../../src/controller/worker-controller.js";
import { FakeAgentRuntimeFactory } from "../helpers/fake-runtime.js";

/**
 * Phase 7A build fence (Worker side): the Worker validates the sessiond build
 * identity carried by `worker.init` BEFORE any runtime is created, and its
 * `worker.ready` carries the exact Worker build identity. Unknown/older/
 * malformed sessiond builds fail closed with a fixed protocol_mismatch fatal
 * and NEVER touch the runtime factory — the existing identity fencing (phase,
 * session id) is unchanged and still applies afterwards.
 */

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

function initMessage(build: unknown): SessiondToWorkerMessage {
  return {
    type: "worker.init",
    id: "init-1",
    protocolVersion: 2,
    payload: {
      mode: "create",
      sessionId: "provisional-session",
      epoch: "e1",
      cwd: "/workspace",
      projectRoot: "/workspace",
      // The test double carries arbitrary build bytes on purpose; the cast
      // exists so malformed shapes reach the controller untyped.
      build: build as SessiondBuild,
    },
  };
}

const isFatal = (message: WorkerToSessiondMessage): message is Extract<WorkerToSessiondMessage, { type: "worker.fatal" }> =>
  message.type === "worker.fatal";
const isReady = (message: WorkerToSessiondMessage): message is Extract<WorkerToSessiondMessage, { type: "worker.ready" }> =>
  message.type === "worker.ready";

describe("worker build fence (worker.init validation)", () => {
  it("an exact build activates and ready carries the exact Worker build identity", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({ sessionId: "sess-real" });
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage(initMessage(SESSIOND_BUILD_IDENTITY));

    assert.equal(controller.phase, "ready");
    const ready = recorder.messages.find(isReady);
    assert.ok(ready !== undefined, "expected a worker.ready");
    assert.deepEqual(ready.payload.build, WORKER_BUILD_IDENTITY);
    // The full frame stays schema-valid.
    assert.equal(WorkerToSessiondPushSchema.safeParse(ready).success, true);
    assert.deepEqual(exitCodes, []);
  });

  it("a missing build block fails closed before any runtime is created", async () => {
    const factory = new FakeAgentRuntimeFactory();
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage(initMessage(undefined));

    assert.equal(controller.phase, "failed");
    assert.equal(factory.createCalls.length, 0, "no runtime may be created for an unverifiable sessiond build");
    const fatal = recorder.messages.find(isFatal);
    assert.ok(fatal !== undefined, "expected worker.fatal");
    assert.equal(fatal.payload.error.code, "protocol_mismatch");
    assert.match(fatal.payload.error.message, /missing_build/);
    assert.deepEqual(exitCodes, [1]);
  });

  it("an older/unknown sessiond contract generation fails closed (worker_contract)", async () => {
    const factory = new FakeAgentRuntimeFactory();
    const { controller, recorder, exitCodes } = createHarness(factory);
    await controller.handleMessage(
      initMessage({ ...SESSIOND_BUILD_IDENTITY, workerContract: SESSIOND_BUILD_IDENTITY.workerContract + 1 }),
    );

    assert.equal(controller.phase, "failed");
    assert.equal(factory.createCalls.length, 0);
    const fatal = recorder.messages.find(isFatal);
    assert.ok(fatal !== undefined, "expected worker.fatal");
    assert.equal(fatal.payload.error.code, "protocol_mismatch");
    assert.match(fatal.payload.error.message, /worker_contract/);
    assert.deepEqual(exitCodes, [1]);
  });

  it("a different capability fingerprint fails closed (fingerprint)", async () => {
    const factory = new FakeAgentRuntimeFactory();
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ ...SESSIOND_BUILD_IDENTITY, fingerprint: "a".repeat(64) }));

    assert.equal(controller.phase, "failed");
    assert.equal(factory.createCalls.length, 0);
    const fatal = recorder.messages.find(isFatal);
    assert.ok(fatal !== undefined, "expected worker.fatal");
    assert.match(fatal.payload.error.message, /fingerprint/);
  });

  it("a malformed build block fails closed (malformed_build)", async () => {
    const factory = new FakeAgentRuntimeFactory();
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage({ product: 1 }));

    assert.equal(controller.phase, "failed");
    assert.equal(factory.createCalls.length, 0);
    const fatal = recorder.messages.find(isFatal);
    assert.ok(fatal !== undefined, "expected worker.fatal");
    assert.match(fatal.payload.error.message, /malformed_build/);
  });

  it("a rejected build does not disable the existing identity fencing: a valid retry still conflicts on phase", async () => {
    const factory = new FakeAgentRuntimeFactory();
    const { controller, recorder } = createHarness(factory);
    await controller.handleMessage(initMessage(undefined));
    const fatalsBefore = recorder.messages.filter(isFatal).length;
    // A second init — even with a VALID build — must hit the phase fence, not
    // bootstrap a runtime: identity fencing still owns the phase machine.
    await controller.handleMessage(initMessage(SESSIOND_BUILD_IDENTITY));
    assert.equal(controller.phase, "failed");
    assert.equal(factory.createCalls.length, 0);
    const fatals = recorder.messages.filter(isFatal);
    assert.equal(fatals.length, fatalsBefore + 1);
    assert.equal(fatals.at(-1)?.payload.error.code, "conflict");
  });
});
