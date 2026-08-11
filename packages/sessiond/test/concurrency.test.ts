import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeCommandResult } from "@fffattiger/pix-protocol";
import type { SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

const locator: SessionLocatorPort = {
  async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
  async resolveLeafId() { return "leaf"; },
};

const makeService = (options: ConstructorParameters<typeof SessiondService>[1] = {}, workerOptions: ConstructorParameters<typeof FakeWorkerFactory>[0] = {}) => {
  const workers = new FakeWorkerFactory(workerOptions);
  const service = new SessiondService({ sessionLocator: locator, activationContext: { async resolve(sessionId) { return { cwd: `/${sessionId}`, projectRoot: `/${sessionId}` }; } }, workerFactory: workers }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0, ...options });
  return { service, workers };
};

test("command id capacity fails closed without re-executing accepted IDs", async () => {
  const { service, workers } = makeService({ commandResultLimit: 2, commandResultCacheLimit: 1 });
  await service.activate("s");
  const one = { type: "prompt", commandId: "one", message: "one" } as const;
  const two = { type: "prompt", commandId: "two", message: "two" } as const;
  await service.command("s", one); await service.command("s", two);
  const rejected = await service.command("s", { type: "prompt", commandId: "three", message: "three" });
  assert.equal(rejected.result.ok, false);
  if (!rejected.result.ok) assert.equal(rejected.result.error.code, "command_rejected");
  const repeated = await service.command("s", one);
  assert.equal(repeated.result.ok, false);
  if (!repeated.result.ok) assert.equal(repeated.result.error.code, "command_duplicate");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 2);
  await service.shutdown();
});

test("commandId type conflicts are rejected and malicious ID floods fail closed", async () => {
  const { service, workers } = makeService({ commandResultLimit: 3, commandResultCacheLimit: 2 });
  await service.activate("s");
  await service.command("s", { type: "prompt", commandId: "shared", message: "hello" });
  const conflict = await service.command("s", { type: "get_tools", commandId: "shared" });
  assert.equal(conflict.result.ok, false);
  if (!conflict.result.ok) assert.equal(conflict.result.error.code, "command_rejected");
  await service.command("s", { type: "prompt", commandId: "two", message: "two" });
  await service.command("s", { type: "prompt", commandId: "three", message: "three" });
  const flood = await service.command("s", { type: "prompt", commandId: "four", message: "four" });
  assert.equal(flood.result.ok, false);
  if (!flood.result.ok) assert.equal(flood.result.error.code, "command_rejected");
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command").length, 3);
  await service.shutdown();
});

test("stop vs command race never sends after stop commit", async () => {
  const { service, workers } = makeService({}, { commandDelayMs: 30 });
  await service.activate("s");
  const command = service.command("s", { type: "prompt", commandId: "p", message: "hello" });
  const stopped = service.stop("s", "user");
  const [result, stoppedResult] = await Promise.all([command, stopped]);
  assert.equal(stoppedResult, true);
  assert.ok((result as RuntimeCommandResult).result.ok === false || workers.workers[0]!.sent.some((message) => message.type === "worker.command"));
  assert.equal(service.listRunning().sessions.length, 0);
  await assert.rejects(service.command("s", { type: "prompt", commandId: "after", message: "after" }));
  assert.equal(workers.workers[0]!.sent.filter((message) => message.type === "worker.command" && message.payload.command.commandId === "after").length, 0);
});
