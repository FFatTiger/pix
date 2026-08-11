/**
 * Reusable adapter contract suite for the pi-web agent runtime ports.
 *
 * Register it with any conforming harness (`AdapterContractHarness`) — the
 * Pi SDK adapter, a future Pi RPC adapter, and the reference fake must all
 * pass the same suite. Capability degradation is exercised by restricting the
 * harness-reported capability set; the suite never assumes a backend type.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentRuntimeFactory,
  AgentRuntimePort,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeCommandType,
  RuntimeError,
  RuntimeInterruptResult,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@fffattiger/pi-web-runtime-core";
import {
  isRuntimeError,
  RUNTIME_CAPABILITIES,
  RUNTIME_COMMAND_CAPABILITIES,
  RUNTIME_COMMAND_TYPES,
  RUNTIME_INTERRUPT_CAPABILITIES,
  RUNTIME_INTERRUPT_TYPES,
} from "@fffattiger/pi-web-runtime-core";
import type { AdapterContractHarness, HarnessFactoryOptions } from "./harness.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EventCollector {
  readonly events: RuntimeEvent[] = [];
  private readonly unsubscribe: () => void;

  constructor(port: AgentRuntimePort) {
    this.unsubscribe = port.subscribe((event) => this.events.push(event));
  }

  ofType<T extends RuntimeEvent["type"]>(type: T): Extract<RuntimeEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<RuntimeEvent, { type: T }> =>
      event.type === type,
    );
  }

  waitFor(predicate: (event: RuntimeEvent) => boolean, timeoutMs = 5000): Promise<RuntimeEvent> {
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const match = this.events.find(predicate);
        if (match) {
          clearInterval(timer);
          resolve(match);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for runtime event`));
        }
      }, 5);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}

async function waitForSnapshot(
  port: AgentRuntimePort,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
  timeoutMs = 5000,
): Promise<RuntimeSnapshot> {
  const started = Date.now();
  for (;;) {
    const snapshot = await port.getSnapshot();
    if (predicate(snapshot)) return snapshot;
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for snapshot condition");
    }
    await delay(10);
  }
}

async function newRuntime(
  harness: AdapterContractHarness,
  options?: HarnessFactoryOptions,
  start?: { name?: string },
): Promise<{ factory: AgentRuntimeFactory; port: AgentRuntimePort }> {
  const factory = await harness.createFactory(options);
  const port = await factory.create({
    cwd: options?.cwd ?? "/workspace",
    ...(start?.name === undefined ? {} : { name: start.name }),
  });
  return { factory, port };
}

function assertErrorCode(
  result: RuntimeCommandResult,
  code: RuntimeError["code"],
): asserts result is Extract<RuntimeCommandResult, { ok: false }> {
  assert.equal(result.ok, false, "expected a failing command result");
  if (!result.ok) {
    assert.equal(result.error.code, code, `expected error code ${code}`);
  }
}

function assertInterruptErrorCode(
  result: RuntimeInterruptResult,
  code: RuntimeError["code"],
): asserts result is Extract<RuntimeInterruptResult, { ok: false }> {
  assert.equal(result.ok, false, "expected a failing interrupt result");
  if (!result.ok) {
    assert.equal(result.error.code, code, `expected interrupt error code ${code}`);
  }
}

/** Minimal valid command fixture per type (extension commands excluded). */
function fixtureFor(type: RuntimeCommandType): RuntimeCommand {
  switch (type) {
    case "prompt":
      return { type, message: "hi" };
    case "steer":
      return { type, message: "hi" };
    case "follow_up":
      return { type, message: "hi" };
    case "abort":
      return { type };
    case "get_state":
      return { type };
    case "set_model":
      return { type, provider: "openai", modelId: "gpt-5" };
    case "fork":
      return { type, entryId: "entry-1" };
    case "navigate_tree":
      return { type, targetId: "entry-1" };
    case "set_thinking_level":
      return { type, level: "high" };
    case "compact":
      return { type };
    case "set_session_name":
      return { type, name: "Suite" };
    case "get_session_stats":
      return { type };
    case "get_last_assistant_text":
      return { type };
    case "set_auto_compaction":
      return { type, enabled: true };
    case "clear_queue":
      return { type };
    case "get_tools":
      return { type };
    case "get_commands":
      return { type };
    case "set_tools":
      return { type, toolNames: ["read"] };
    case "reload":
      return { type };
    case "abort_compaction":
      return { type };
    case "extension_ui_response":
      return { type, id: "nope", cancelled: true };
    case "extension_ui_input":
      return { type, id: "nope", data: "x" };
    case "set_auto_retry":
      return { type, enabled: true };
    case "bash":
      return { type, command: "pwd" };
    case "abort_bash":
      return { type };
    case "generate_session_title":
      return { type };
  }
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

/**
 * Registers the full adapter contract suite against `harness`.
 * Run once per adapter (e.g. from a `*.test.ts` entry file).
 */
export function createRuntimeAdapterSuite(harness: AdapterContractHarness): void {
  describe("agent runtime adapter contract", () => {
    after(async () => {
      await harness.teardown();
    });
    /* ---------------------------------------------------------------- */
    describe("lifecycle", () => {
      it("create returns a runtime with identity", async () => {
        const { port } = await newRuntime(harness);
        assert.ok(port.identity.sessionId.length > 0, "sessionId must be non-empty");
        assert.ok(port.identity.sessionFile.length > 0, "sessionFile must be non-empty");
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.sessionId, port.identity.sessionId);
        await port.close("user");
      });

      it("open an existing session resumes the same identity and state", async () => {
        const factory = await harness.createFactory();
        const port = await factory.create({ cwd: "/workspace", name: "My Session" });
        const sessionId = port.identity.sessionId;
        await port.execute({ type: "prompt", message: "hi" });
        const opened = await factory.open({ sessionId });
        assert.equal(opened.identity.sessionId, sessionId);
        assert.equal(opened.identity.sessionFile, port.identity.sessionFile);
        const snapshot = await opened.getSnapshot();
        assert.equal(snapshot.state.sessionName, "My Session");
        assert.equal(snapshot.state.messageCount, 3, "user + tool result + assistant");
        await port.close("user");
        await opened.close("user");
      });

      it("subscribe delivers events and unsubscribe stops delivery", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        await port.execute({ type: "set_session_name", name: "X" });
        assert.equal(collector.ofType("runtime_state_changed").length, 1);
        collector.dispose();
        await port.execute({ type: "set_session_name", name: "Y" });
        await delay(30);
        assert.equal(
          collector.ofType("runtime_state_changed").length,
          1,
          "unsubscribed listener must not receive events",
        );
        await port.close("user");
      });

      it("close resolves and marks the runtime unavailable", async () => {
        const { port } = await newRuntime(harness);
        await port.close("user");
        const result = await port.execute({ type: "get_state" });
        assertErrorCode(result, "unavailable");
        await assert.rejects(
          () => port.getSnapshot(),
          (error: unknown) => isRuntimeError(error) && error.code === "unavailable",
        );
      });

      it("duplicate close is idempotent and emits runtime_closed once", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        await port.close("user");
        await port.close("user");
        await port.close("shutdown");
        assert.equal(collector.ofType("runtime_closed").length, 1);
      });

      it("close records the canonical reason", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        await port.close("idle");
        const closed = await collector.waitFor((event) => event.type === "runtime_closed");
        assert.equal(closed.type, "runtime_closed");
        assert.equal(closed.reason, "idle");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("capability & command", () => {
      it("create reports a canonical capability set", async () => {
        const { port } = await newRuntime(harness);
        const capabilities = port.getCapabilities();
        assert.ok(capabilities.capabilities.includes("runtime.prompt"));
        assert.ok(capabilities.capabilities.includes("runtime.fork"));
        assert.ok(capabilities.version >= 1);
        assert.ok(
          capabilities.capabilities.every((capability) => capability.startsWith("runtime.")),
          "capabilities must be canonical runtime.* tokens",
        );
        await port.close("user");
      });

      it("every product command type executes with minimal valid input", async () => {
        const types = RUNTIME_COMMAND_TYPES.filter(
          (type) => type !== "extension_ui_response" && type !== "extension_ui_input",
        );
        assert.equal(types.length, 24, "26 commands minus 2 extension-response types");
        for (const type of types) {
          const factory = await harness.createFactory();
          const port = await factory.create({ cwd: "/workspace" });
          if (type === "fork") {
            // fork needs an existing fork point
            await port.execute({ type: "prompt", message: "hi" });
          }
          const result = await port.execute(fixtureFor(type));
          assert.equal(result.ok, true, `command "${type}" should succeed`);
          await port.close("user");
        }
      });

      it("extension_ui_response/input are covered by the extension UI suite", () => {
        // Explicit marker: both extension command types are exercised against
        // real pending requests in the "extension UI" section.
        assert.ok(RUNTIME_COMMAND_TYPES.includes("extension_ui_response"));
        assert.ok(RUNTIME_COMMAND_TYPES.includes("extension_ui_input"));
      });

      it("missing capability returns unsupported_capability", async () => {
        const factory = await harness.createFactory({ capabilities: ["runtime.prompt"] });
        const port = await factory.create({ cwd: "/workspace" });
        const result = await port.execute({ type: "set_model", provider: "openai", modelId: "gpt-5" });
        assertErrorCode(result, "unsupported_capability");
        const supported = await port.execute({ type: "prompt", message: "hi" });
        assert.equal(supported.ok, true);
        await port.close("user");
      });

      it("every declared capability gates every mapped command", async () => {
        const mapped = new Set(
          Object.values(RUNTIME_COMMAND_CAPABILITIES).filter(
            (capability): capability is (typeof RUNTIME_CAPABILITIES)[number] =>
              capability !== null,
          ),
        );
        assert.deepEqual(
          [...mapped].sort(),
          [...RUNTIME_CAPABILITIES].sort(),
          "every canonical capability must gate at least one command",
        );

        for (const [type, capability] of Object.entries(RUNTIME_COMMAND_CAPABILITIES)) {
          if (capability === null) continue;
          const factory = await harness.createFactory({
            capabilities: RUNTIME_CAPABILITIES.filter((item) => item !== capability),
          });
          const port = await factory.create({ cwd: "/workspace" });
          const result = await port.execute(fixtureFor(type as RuntimeCommandType));
          assertErrorCode(result, "unsupported_capability");
          assert.equal(result.error.message.includes(capability), true);
          await port.close("user");
        }
      });

      it("invalid input returns invalid_input", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({
          type: "set_model",
          provider: "anthropic",
          modelId: "does-not-exist",
        });
        assertErrorCode(result, "invalid_input");
        await port.close("user");
      });

      it("unknown command type returns invalid_command", async () => {
        const { port } = await newRuntime(harness);
        const bogus = { type: "bogus_command" } as unknown as RuntimeCommand;
        const result = await port.execute(bogus);
        assertErrorCode(result, "invalid_command");
        await port.close("user");
      });

      it("get_state returns the canonical runtime state", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({ type: "get_state" });
        assert.equal(result.ok, true);
        if (result.ok && result.type === "get_state") {
          assert.equal(result.state.sessionId, port.identity.sessionId);
          assert.equal(result.state.isStreaming, false);
          assert.ok(result.state.model, "model must be present");
          assert.ok(Array.isArray(result.state.tools));
        }
        await port.close("user");
      });

      it("query commands return typed payloads", async () => {
        const { port } = await newRuntime(harness);
        await port.execute({ type: "prompt", message: "hi" });

        const tools = await port.execute({ type: "get_tools" });
        assert.equal(tools.ok, true);
        if (tools.ok && tools.type === "get_tools") {
          const names = tools.tools.map((tool) => tool.name);
          assert.ok(names.includes("read") && names.includes("write"));
        }

        const commands = await port.execute({ type: "get_commands" });
        assert.equal(commands.ok, true);
        if (commands.ok && commands.type === "get_commands") {
          assert.ok(commands.commands.some((command) => command.name === "compact"));
        }

        const stats = await port.execute({ type: "get_session_stats" });
        assert.equal(stats.ok, true);
        if (stats.ok && stats.type === "get_session_stats") {
          assert.equal(stats.stats.messageCount, 3);
        }

        const last = await port.execute({ type: "get_last_assistant_text" });
        assert.equal(last.ok, true);
        if (last.ok && last.type === "get_last_assistant_text") {
          assert.ok(last.text.includes("Done processing"));
        }
        await port.close("user");
      });

      it("prompt events are causally correlated with the command", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "hi" });
        assert.equal(result.ok, true);
        await delay(20);
        const types = collector.events.map((event) => event.type);
        const expected: RuntimeEvent["type"][] = [
          "agent_start",
          "message_start",
          "message_update",
          "tool_execution_start",
          "tool_execution_end",
          "message_end",
          "agent_end",
          "agent_settled",
          "prompt_done",
        ];
        const positions = expected.map((type) => types.indexOf(type));
        assert.ok(positions.every((position) => position !== -1), "missing causal event");
        for (let i = 1; i < positions.length; i += 1) {
          assert.ok(
            positions[i]! > positions[i - 1]!,
            `events out of order around ${expected[i]}`,
          );
        }
        assert.equal(types[types.length - 1], "prompt_done", "prompt_done must be terminal");
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("interrupt", () => {
      it("independent interrupts share canonical capability semantics with execute", async () => {
        assert.deepEqual(RUNTIME_INTERRUPT_TYPES, [
          "abort",
          "abort_compaction",
          "abort_bash",
          "clear_queue",
        ]);
        for (const type of RUNTIME_INTERRUPT_TYPES) {
          const capability = RUNTIME_INTERRUPT_CAPABILITIES[type];
          assert.equal(
            RUNTIME_COMMAND_CAPABILITIES[type],
            capability,
            `${type} command and interrupt capability must not drift`,
          );
          const factory = await harness.createFactory({
            capabilities: RUNTIME_CAPABILITIES.filter((item) => item !== capability),
          });
          const port = await factory.create({ cwd: "/workspace" });
          const before = await port.getSnapshot();
          const interruptResult = await port.interrupt({ type });
          assertInterruptErrorCode(interruptResult, "unsupported_capability");
          assert.ok(interruptResult.error.message.includes(capability));
          const executeResult = await port.execute(fixtureFor(type));
          assertErrorCode(executeResult, "unsupported_capability");
          assert.equal(executeResult.error.code, interruptResult.error.code);
          assert.equal(executeResult.error.message, interruptResult.error.message);
          const after = await port.getSnapshot();
          assert.deepEqual(after.state.queuedMessages, before.state.queuedMessages);
          assert.equal(after.state.isPromptRunning, before.state.isPromptRunning);
          assert.equal(after.state.isBashRunning, before.state.isBashRunning);
          assert.equal(after.state.isCompacting, before.state.isCompacting);
          await port.close("user");
        }
      });

      it("closed-state lifecycle errors outrank capabilities for every interrupt path", async () => {
        for (const type of RUNTIME_INTERRUPT_TYPES) {
          const capability = RUNTIME_INTERRUPT_CAPABILITIES[type];
          for (const capabilityPresent of [true, false]) {
            const factory = await harness.createFactory({
              capabilities: capabilityPresent
                ? RUNTIME_CAPABILITIES
                : RUNTIME_CAPABILITIES.filter((item) => item !== capability),
            });
            const port = await factory.create({ cwd: "/workspace" });
            const collector = new EventCollector(port);
            const beforeClose = await port.getSnapshot();
            const stableState = structuredClone(beforeClose.state);
            await port.close("user");
            const eventCountAfterClose = collector.events.length;
            assert.equal(collector.ofType("runtime_closed").length, 1);

            const executeResult = await port.execute(fixtureFor(type));
            assertErrorCode(executeResult, "unavailable");
            const interruptResult = await port.interrupt({ type });
            assertInterruptErrorCode(interruptResult, "unavailable");
            assert.equal(executeResult.error.message, interruptResult.error.message);

            await assert.rejects(
              () => port.getSnapshot(),
              (error: unknown) => isRuntimeError(error) && error.code === "unavailable",
            );
            const stateResult = await port.execute({ type: "get_state" });
            assertErrorCode(stateResult, "unavailable");
            assert.deepEqual(beforeClose.state, stableState, "captured state must not mutate");
            assert.equal(
              collector.events.length,
              eventCountAfterClose,
              `${type} must not emit after close (capabilityPresent=${capabilityPresent})`,
            );
            assert.equal(collector.ofType("runtime_closed").length, 1);
            collector.dispose();
          }
        }
      });

      it("unsupported abort cannot interrupt a running prompt", async () => {
        const factory = await harness.createFactory({
          capabilities: RUNTIME_CAPABILITIES.filter((item) => item !== "runtime.abort"),
        });
        const port = await factory.create({ cwd: "/workspace" });
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        await waitForSnapshot(port, (snapshot) => snapshot.state.isPromptRunning);
        assertInterruptErrorCode(await port.interrupt({ type: "abort" }), "unsupported_capability");
        assert.equal((await port.getSnapshot()).state.isPromptRunning, true);
        assert.equal((await pending).ok, true);
        await port.close("user");
      });

      it("unsupported abort_bash cannot interrupt running bash", async () => {
        const factory = await harness.createFactory({
          capabilities: RUNTIME_CAPABILITIES.filter((item) => item !== "runtime.bash.abort"),
        });
        const port = await factory.create({ cwd: "/workspace" });
        const pending = port.execute({ type: "bash", command: "sleep" });
        await waitForSnapshot(port, (snapshot) => snapshot.state.isBashRunning);
        assertInterruptErrorCode(
          await port.interrupt({ type: "abort_bash" }),
          "unsupported_capability",
        );
        assert.equal((await port.getSnapshot()).state.isBashRunning, true);
        assert.equal((await pending).ok, true);
        await port.close("user");
      });

      it("unsupported abort_compaction cannot interrupt compaction", async () => {
        const factory = await harness.createFactory({
          capabilities: RUNTIME_CAPABILITIES.filter(
            (item) => item !== "runtime.compact.abort",
          ),
        });
        const port = await factory.create({ cwd: "/workspace" });
        const pending = port.execute({ type: "compact" });
        await waitForSnapshot(port, (snapshot) => snapshot.state.isCompacting);
        assertInterruptErrorCode(
          await port.interrupt({ type: "abort_compaction" }),
          "unsupported_capability",
        );
        assert.equal((await port.getSnapshot()).state.compaction?.status, "running");
        assert.equal((await pending).ok, true);
        await port.close("user");
      });

      it("unsupported clear_queue cannot mutate queued turns", async () => {
        const factory = await harness.createFactory({
          capabilities: RUNTIME_CAPABILITIES.filter((item) => item !== "runtime.queue"),
        });
        const port = await factory.create({ cwd: "/workspace" });
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        await waitForSnapshot(port, (snapshot) => snapshot.state.isPromptRunning);
        await port.execute({ type: "steer", message: "keep me" });
        const before = await port.getSnapshot();
        assert.equal(before.state.queuedMessages?.steering.length, 1);
        assertInterruptErrorCode(
          await port.interrupt({ type: "clear_queue" }),
          "unsupported_capability",
        );
        const executeResult = await port.execute({ type: "clear_queue" });
        assertErrorCode(executeResult, "unsupported_capability");
        assert.deepEqual(
          (await port.getSnapshot()).state.queuedMessages,
          before.state.queuedMessages,
        );
        assert.equal((await pending).ok, true);
        await port.close("user");
      });

      it("execute and interrupt supported paths have consistent state effects", async () => {
        for (const type of RUNTIME_INTERRUPT_TYPES) {
          const runPath = async (path: "execute" | "interrupt") => {
            const { port } = await newRuntime(harness);
            let pending: Promise<RuntimeCommandResult>;
            if (type === "abort") {
              pending = port.execute({ type: "prompt", message: "long prompt" });
              await waitForSnapshot(port, (snapshot) => snapshot.state.isPromptRunning);
            } else if (type === "abort_bash") {
              pending = port.execute({ type: "bash", command: "sleep" });
              await waitForSnapshot(port, (snapshot) => snapshot.state.isBashRunning);
            } else if (type === "abort_compaction") {
              pending = port.execute({ type: "compact" });
              await waitForSnapshot(port, (snapshot) => snapshot.state.isCompacting);
            } else {
              pending = port.execute({ type: "prompt", message: "long prompt" });
              await waitForSnapshot(port, (snapshot) => snapshot.state.isPromptRunning);
              await port.execute({ type: "steer", message: "clear me" });
              assert.equal(
                (await port.getSnapshot()).state.queuedMessages?.steering.length,
                1,
              );
            }

            const controlResult =
              path === "execute"
                ? await port.execute(fixtureFor(type))
                : await port.interrupt({ type });
            assert.equal(controlResult.ok, true, `${path}:${type} must be supported`);
            const afterControl = await port.getSnapshot();

            if (type === "clear_queue") {
              assert.deepEqual(afterControl.state.queuedMessages, {
                steering: [],
                followUp: [],
              });
              assert.equal((await pending).ok, true);
            } else {
              const operation = await pending;
              if (type === "abort_compaction") {
                assert.equal(operation.ok, true);
              } else {
                assertErrorCode(operation, "interrupted");
              }
            }
            const final = await port.getSnapshot();
            await port.close("user");
            return final;
          };

          const commandState = await runPath("execute");
          const interruptState = await runPath("interrupt");
          assert.equal(
            interruptState.state.isPromptRunning,
            commandState.state.isPromptRunning,
          );
          assert.equal(
            interruptState.state.isBashRunning,
            commandState.state.isBashRunning,
          );
          assert.equal(
            interruptState.state.isCompacting,
            commandState.state.isCompacting,
          );
          assert.deepEqual(
            interruptState.state.queuedMessages,
            commandState.state.queuedMessages,
          );
        }
      });

      it("abort preempts a running prompt without being blocked", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        let settled = false;
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        pending.then(() => {
          settled = true;
        });
        await delay(30);
        assert.equal(settled, false, "prompt must still be running");
        const started = Date.now();
        const interrupt = await port.interrupt({ type: "abort" });
        assert.equal(interrupt.ok, true);
        assert.ok(Date.now() - started < 1000, "interrupt must not be blocked by the prompt");
        const result = await pending;
        assertErrorCode(result, "interrupted");
        await delay(10);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.isPromptRunning, false);
        assert.equal(snapshot.state.isStreaming, false);
        assert.equal(collector.ofType("agent_end").length, 1);
        assert.equal(collector.ofType("agent_settled").length, 1);
        await port.close("user");
      });

      it("repeated abort is idempotent", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        await delay(30);
        assert.equal((await port.interrupt({ type: "abort" })).ok, true);
        assert.equal((await port.interrupt({ type: "abort" })).ok, true);
        assert.equal((await port.interrupt({ type: "abort" })).ok, true);
        const result = await pending;
        assertErrorCode(result, "interrupted");
        assert.equal(collector.ofType("agent_end").length, 1, "exactly one agent_end");
        assert.equal(collector.ofType("agent_settled").length, 1, "exactly one agent_settled");
        await port.close("user");
      });

      it("interrupt while idle is a no-op", async () => {
        const { port } = await newRuntime(harness);
        assert.equal((await port.interrupt({ type: "abort" })).ok, true);
        assert.equal((await port.interrupt({ type: "abort_bash" })).ok, true);
        assert.equal((await port.interrupt({ type: "abort_compaction" })).ok, true);
        assert.equal((await port.interrupt({ type: "clear_queue" })).ok, true);
        const result = await port.execute({ type: "get_state" });
        assert.equal(result.ok, true);
        await port.close("user");
      });

      it("abort cancels pending confirm and clears the reconnect snapshot", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "confirm please" });
        await collector.waitFor((event) => event.type === "extension_ui_request");
        await port.interrupt({ type: "abort" });
        const result = await pending;
        assertErrorCode(result, "interrupted");
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.pendingExtensionUi?.length, 0);
        assert.equal(collector.ofType("agent_end").length, 1);
        assert.equal(collector.ofType("agent_settled").length, 1);
        await port.close("user");
      });

      it("abort cancels pending input and settles exactly once", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "input-request" });
        await collector.waitFor(
          (event) => event.type === "extension_ui_request" && event.request.method === "input",
        );
        await port.interrupt({ type: "abort" });
        await port.interrupt({ type: "abort" });
        const result = await pending;
        assertErrorCode(result, "interrupted");
        assert.equal((await port.getSnapshot()).state.pendingExtensionUi?.length, 0);
        assert.equal(collector.ofType("agent_end").length, 1);
        assert.equal(collector.ofType("agent_settled").length, 1);
        await port.close("user");
      });

      it("abort_bash preempts a running bash", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "bash", command: "sleep 1" });
        await delay(15);
        await port.interrupt({ type: "abort_bash" });
        const result = await pending;
        assertErrorCode(result, "interrupted");
        const cancelled = collector
          .ofType("bash_update")
          .find((event) => event.cancelled === true);
        assert.ok(cancelled, "bash_update must report cancelled");
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.isBashRunning, false);
        await port.close("user");
      });

      it("running bash is fully recoverable from a mid-operation snapshot", async () => {
        const { port } = await newRuntime(harness);
        const pending = port.execute({
          type: "bash",
          command: "printf lines",
          excludeFromContext: true,
        });
        const snapshot = await waitForSnapshot(
          port,
          (value) => value.state.isBashRunning && (value.state.bash?.updateCount ?? 0) >= 2,
        );
        assert.equal(snapshot.state.bash?.command, "printf lines");
        assert.ok(snapshot.state.bash?.output.includes("line 1"));
        assert.equal(snapshot.state.bash?.excludeFromContext, true);
        assert.equal(snapshot.state.bash?.completed, false);
        await port.interrupt({ type: "abort_bash" });
        await pending;
        await port.close("user");
      });

      it("abort_compaction preempts compaction and is idempotent", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "compact" });
        await delay(10);
        await port.interrupt({ type: "abort_compaction" });
        await port.interrupt({ type: "abort_compaction" });
        const result = await pending;
        assert.equal(result.ok, true, "aborted compaction is a normal outcome");
        const end = await collector.waitFor((event) => event.type === "compaction_end");
        assert.equal(end.type, "compaction_end");
        assert.equal(end.aborted, true);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.isCompacting, false);
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("streaming & partial", () => {
      it("message_start/update/end stream in order with complete content", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "stream me" });
        assert.equal(result.ok, true);
        const starts = collector.ofType("message_start");
        const updates = collector.ofType("message_update");
        const ends = collector.ofType("message_end");
        assert.ok(starts.length >= 2, "user + assistant starts");
        assert.ok(updates.length >= 2, "at least two updates");
        const assistantEnd = ends.find((event) => event.message.role === "assistant");
        assert.ok(assistantEnd, "assistant message_end missing");
        const message = assistantEnd.message;
        if (message.role === "assistant") {
          assert.ok(message.content.length >= 2);
          assert.equal(message.model, "claude-sonnet-4");
          const texts = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text);
          assert.ok(texts.some((text) => text.includes("Done processing")));
          assert.ok(message.usage, "assistant message must carry usage");
        }
        await port.close("user");
      });

      it("partial snapshot exposes in-flight streaming state", async () => {
        const { port } = await newRuntime(harness);
        const pending = port.execute({ type: "prompt", message: "stream me" });
        await delay(30);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.isStreaming, true);
        assert.equal(snapshot.streaming?.active, true);
        assert.equal(snapshot.streaming?.partialMessage?.role, "assistant");
        const result = await pending;
        assert.equal(result.ok, true);
        await port.close("user");
      });

      it("unsubscribe during streaming loses events but final snapshot is authoritative", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "long stream" });
        await collector.waitFor((event) => event.type === "message_update");
        collector.dispose();
        const countAtDisconnect = collector.events.length;
        const result = await pending;
        assert.equal(result.ok, true);
        assert.equal(collector.events.length, countAtDisconnect);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.isStreaming, false);
        assert.equal(snapshot.streaming?.active, false);
        assert.equal(snapshot.state.messageCount, 3);
        assert.ok(
          snapshot.messages?.some(
            (message) => message.role === "assistant" && message.content.length > 0,
          ),
        );
        await port.close("user");
      });

      it("snapshot clears streaming state after completion", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({ type: "prompt", message: "stream me" });
        assert.equal(result.ok, true);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.isStreaming, false);
        assert.equal(snapshot.streaming?.active, false);
        assert.equal(snapshot.streaming?.partialMessage, undefined);
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("tools", () => {
      it("get_tools reports canonical tool names and active flags", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({ type: "get_tools" });
        assert.equal(result.ok, true);
        if (result.ok && result.type === "get_tools") {
          const names = result.tools.map((tool) => tool.name);
          assert.ok(names.includes("read"));
          assert.ok(names.includes("write"));
          assert.ok(result.tools.every((tool) => typeof tool.active === "boolean"));
        }
        await port.close("user");
      });

      it("set_tools filters active tools", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({ type: "set_tools", toolNames: ["read"] });
        assert.equal(result.ok, true);
        const tools = await port.execute({ type: "get_tools" });
        assert.equal(tools.ok, true);
        if (tools.ok && tools.type === "get_tools") {
          const read = tools.tools.find((tool) => tool.name === "read");
          const write = tools.tools.find((tool) => tool.name === "write");
          assert.equal(read?.active, true);
          assert.equal(write?.active, false);
        }
        await port.close("user");
      });

      it("all-tools-off clears the system prompt", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({ type: "set_tools", toolNames: [] });
        assert.equal(result.ok, true);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.systemPrompt, "");
        assert.ok(
          (snapshot.state.tools ?? []).every((tool) => !tool.active),
          "no active tools when all-tools-off",
        );
        await port.close("user");
      });

      it("factory all-tools-off and thinking pins apply atomically at startup", async () => {
        const factory = await harness.createFactory();
        const port = await factory.create({
          cwd: "/workspace",
          toolNames: [],
          thinkingLevel: "high",
          thinkingLevelPinned: true,
        });
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.systemPrompt, "");
        assert.ok((snapshot.state.tools ?? []).every((tool) => !tool.active));
        assert.equal(snapshot.state.thinkingLevel, "high");
        assert.equal(snapshot.state.thinkingLevelPinned, true);
        await port.close("user");
      });

      it("tool execution events carry canonical args", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "hi" });
        assert.equal(result.ok, true);
        const start = collector
          .ofType("tool_execution_start")
          .find((event) => event.toolName === "write");
        assert.ok(start, "write tool_execution_start missing");
        assert.ok(start.args && typeof start.args === "object");
        await port.close("user");
      });

      it("tool result message with isError=false and written files", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "hi" });
        assert.equal(result.ok, true);
        const writeEnd = collector
          .ofType("tool_execution_end")
          .find((event) => event.toolName === "write");
        assert.ok(writeEnd);
        assert.equal(writeEnd.isError, false);
        assert.equal(writeEnd.writtenFiles?.length, 1);
        const toolResult = collector
          .ofType("message_end")
          .find((event) => event.message.role === "toolResult");
        assert.ok(toolResult, "toolResult message_end missing");
        assert.equal(toolResult.message.role === "toolResult" && toolResult.message.isError, false);
        const snapshot = await port.getSnapshot();
        assert.ok(
          (snapshot.state.writtenFiles ?? []).some((path) => path.endsWith(".md")),
          "written files must appear in the snapshot",
        );
        await port.close("user");
      });

      it("failing tool surfaces isError=true and writes nothing", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "fail-tool" });
        assert.equal(result.ok, true);
        const failEnd = collector
          .ofType("tool_execution_end")
          .find((event) => event.toolName === "failing_tool");
        assert.ok(failEnd);
        assert.equal(failEnd.isError, true);
        const toolResult = collector
          .ofType("message_end")
          .find((event) => event.message.role === "toolResult");
        assert.equal(toolResult?.message.role === "toolResult" && toolResult.message.isError, true);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.writtenFiles?.length ?? 0, 0);
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("model & thinking", () => {
      it("set_model updates state and emits runtime_state_changed", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "set_model", provider: "openai", modelId: "gpt-5" });
        assert.equal(result.ok, true);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.model?.id, "gpt-5");
        assert.equal(snapshot.state.model?.provider, "openai");
        assert.ok(collector.ofType("runtime_state_changed").length >= 1);
        await port.close("user");
      });

      it("unknown model is rejected", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({
          type: "set_model",
          provider: "anthropic",
          modelId: "nope",
        });
        assertErrorCode(result, "invalid_input");
        await port.close("user");
      });

      it("set_thinking_level updates the level and rejects unknown levels", async () => {
        const { port } = await newRuntime(harness);
        const ok = await port.execute({ type: "set_thinking_level", level: "high" });
        assert.equal(ok.ok, true);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.thinkingLevel, "high");
        const bad = await port.execute({
          type: "set_thinking_level",
          level: "ultra" as never,
        });
        assertErrorCode(bad, "invalid_input");
        await port.close("user");
      });

      it("assistant message includes thinking content when enabled", async () => {
        const { port } = await newRuntime(harness);
        await port.execute({ type: "set_thinking_level", level: "high" });
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "think" });
        assert.equal(result.ok, true);
        const assistantEnd = collector
          .ofType("message_end")
          .find((event) => event.message.role === "assistant");
        assert.ok(assistantEnd);
        assert.ok(
          assistantEnd.message.role === "assistant" &&
            assistantEnd.message.content.some((block) => block.type === "thinking"),
          "assistant content must include a thinking block",
        );
        await port.close("user");
      });

      it("reload emits a capability update event", async () => {
        const factory = await harness.createFactory({ reloadCapabilities: ["runtime.prompt"] });
        const port = await factory.create({ cwd: "/workspace" });
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "reload" });
        assert.equal(result.ok, true);
        const event = await collector.waitFor((e) => e.type === "runtime_capabilities_changed");
        assert.equal(event.type, "runtime_capabilities_changed");
        assert.ok(!event.capabilities.capabilities.includes("runtime.fork"));
        const forkResult = await port.execute({ type: "fork", entryId: "entry-1" });
        assertErrorCode(forkResult, "unsupported_capability");
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("queue", () => {
      it("steer/follow_up while running preserve text and images in snapshot", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        await delay(30);
        const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" } as const;
        const steer = await port.execute({ type: "steer", message: "steer me", images: [image] });
        const followUp = await port.execute({ type: "follow_up", message: "follow me", images: [image] });
        assert.equal(steer.ok, true);
        assert.equal(followUp.ok, true);
        const snapshot = await port.getSnapshot();
        assert.deepEqual(snapshot.state.queuedMessages?.steering, [
          { message: "steer me", images: [image] },
        ]);
        assert.deepEqual(snapshot.state.queuedMessages?.followUp, [
          { message: "follow me", images: [image] },
        ]);
        assert.ok(collector.ofType("queue_update").length >= 2);
        await port.interrupt({ type: "abort" });
        await pending;
        await port.close("user");
      });

      it("queued messages drain in order after the turn settles", async () => {
        const { port } = await newRuntime(harness);
        const pending = port.execute({ type: "prompt", message: "hi" });
        await delay(20);
        await port.execute({ type: "steer", message: "steer me" });
        await port.execute({ type: "follow_up", message: "follow me" });
        const result = await pending;
        assert.equal(result.ok, true);
        await waitForSnapshot(port, (snapshot) => snapshot.state.messageCount === 9);
        const last = await port.execute({ type: "get_last_assistant_text" });
        assert.equal(last.ok, true);
        if (last.ok && last.type === "get_last_assistant_text") {
          assert.ok(last.text.includes("follow me"), "follow_up must be the final drained turn");
        }
        const snapshot = await port.getSnapshot();
        assert.deepEqual(snapshot.state.queuedMessages, { steering: [], followUp: [] });
        await port.close("user");
      });

      it("clear_queue empties the queue", async () => {
        const { port } = await newRuntime(harness);
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        await delay(30);
        await port.execute({ type: "steer", message: "steer me" });
        const result = await port.execute({ type: "clear_queue" });
        assert.equal(result.ok, true);
        const snapshot = await port.getSnapshot();
        assert.deepEqual(snapshot.state.queuedMessages, { steering: [], followUp: [] });
        await port.interrupt({ type: "abort" });
        await pending;
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("extension UI", () => {
      it("pending request surfaces in events and snapshot, response resumes the turn", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "confirm please" });
        const requestEvent = await collector.waitFor((event) => event.type === "extension_ui_request");
        assert.equal(requestEvent.type, "extension_ui_request");
        assert.equal(requestEvent.request.method, "confirm");
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.pendingExtensionUi?.length, 1);
        assert.equal(snapshot.state.pendingExtensionUi?.[0]?.id, requestEvent.request.id);
        const response = await port.execute({
          type: "extension_ui_response",
          id: requestEvent.request.id,
          confirmed: true,
        });
        assert.equal(response.ok, true);
        const result = await pending;
        assert.equal(result.ok, true, "turn must complete after the response");
        const after = await port.getSnapshot();
        assert.equal(after.state.pendingExtensionUi?.length, 0);
        await port.close("user");
      });

      it("extension_ui_response cancelled resolves the pending request", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "confirm please" });
        const requestEvent = await collector.waitFor((event) => event.type === "extension_ui_request");
        assert.equal(requestEvent.type, "extension_ui_request");
        const response = await port.execute({
          type: "extension_ui_response",
          id: requestEvent.request.id,
          cancelled: true,
        });
        assert.equal(response.ok, true);
        const result = await pending;
        assert.equal(result.ok, true);
        await port.close("user");
      });

      it("extension_ui_input delivers data into the turn", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const pending = port.execute({ type: "prompt", message: "input-request" });
        const requestEvent = await collector.waitFor(
          (event) => event.type === "extension_ui_request" && event.request.method === "input",
        );
        assert.equal(requestEvent.type, "extension_ui_request");
        const response = await port.execute({
          type: "extension_ui_input",
          id: requestEvent.request.id,
          data: "hello-data",
        });
        assert.equal(response.ok, true);
        const result = await pending;
        assert.equal(result.ok, true);
        const last = await port.execute({ type: "get_last_assistant_text" });
        assert.equal(last.ok, true);
        if (last.ok && last.type === "get_last_assistant_text") {
          assert.ok(last.text.includes("hello-data"), "input data must reach the turn");
        }
        await port.close("user");
      });

      it("extension status/widget events and snapshot projection", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "widget please" });
        assert.equal(result.ok, true);
        assert.equal(collector.ofType("extension_statuses").length, 1);
        assert.equal(collector.ofType("extension_widgets").length, 1);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.extensionStatuses?.length, 2);
        assert.equal(snapshot.state.extensionWidgets?.[0]?.placement, "belowEditor");
        await port.close("user");
      });

      it("unknown extension response id is rejected", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({
          type: "extension_ui_response",
          id: "missing",
          confirmed: true,
        });
        assertErrorCode(result, "not_found");
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("compaction", () => {
      it("manual compaction emits start/end with reason and trims history", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        await port.execute({ type: "prompt", message: "hi" });
        const before = (await port.getSnapshot()).state.messageCount;
        assert.equal(before, 3);
        const result = await port.execute({ type: "compact" });
        assert.equal(result.ok, true);
        const starts = collector.ofType("compaction_start");
        const ends = collector.ofType("compaction_end");
        assert.equal(starts.length, 1);
        assert.equal(starts[0]?.reason, "manual");
        assert.equal(ends.length, 1);
        assert.equal(ends[0]?.aborted, false);
        assert.equal(ends[0]?.reason, "manual");
        const after = (await port.getSnapshot()).state.messageCount;
        assert.equal(after, 2, "history must be trimmed to the last 2 entries");
        assert.ok(after < before);
        await port.close("user");
      });

      it("running compaction is fully recoverable from a mid-operation snapshot", async () => {
        const { port } = await newRuntime(harness);
        const pending = port.execute({ type: "compact", customInstructions: "keep decisions" });
        const snapshot = await waitForSnapshot(port, (value) => value.state.isCompacting);
        assert.equal(snapshot.state.compaction?.reason, "manual");
        assert.equal(snapshot.state.compaction?.status, "running");
        assert.equal(snapshot.state.compaction?.customInstructions, "keep decisions");
        assert.ok((snapshot.state.compaction?.startedAt ?? 0) > 0);
        await pending;
        await port.close("user");
      });

      it("auto compaction exposes recoverable state while running", async () => {
        const { port } = await newRuntime(harness);
        await port.execute({ type: "set_auto_compaction", enabled: true });
        const pending = port.execute({ type: "prompt", message: "auto-compact now" });
        const snapshot = await waitForSnapshot(
          port,
          (value) => value.state.compaction?.reason === "auto",
        );
        assert.equal(snapshot.state.isCompacting, true);
        assert.equal(snapshot.state.compaction?.status, "running");
        await pending;
        assert.equal((await port.getSnapshot()).state.compaction, undefined);
        await port.close("user");
      });

      it("auto compaction emits start/end when enabled", async () => {
        const { port } = await newRuntime(harness);
        await port.execute({ type: "set_auto_compaction", enabled: true });
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "auto-compact now" });
        assert.equal(result.ok, true);
        assert.equal(collector.ofType("auto_compaction_start").length, 1);
        assert.equal(collector.ofType("auto_compaction_end").length, 1);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.autoCompactionEnabled, true);
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("fork", () => {
      describe("fork contract (requires createPorts)", () => {
        it("fork returns a new session id and ends the old runtime after the result", async () => {
          const factory = await harness.createFactory();
          const port = await factory.create({ cwd: "/workspace" });
          await port.execute({ type: "prompt", message: "hi" });
          const ports = await harness.createPorts!(factory);
          const detail = await ports.sessionCatalog.readSession(port.identity.sessionId);
          const entryId = detail.entries?.[0]?.entryId;
          assert.ok(entryId, "fork point entry must exist");
          const collector = new EventCollector(port);
          let resultSettled = false;
          const executePromise = port.execute({ type: "fork", entryId: entryId! });
          executePromise.then(() => {
            resultSettled = true;
          });
          const result = await executePromise;
          assert.equal(resultSettled, true, "fork result promise must settle first");
          assert.equal(
            collector.ofType("runtime_closed").length,
            0,
            "runtime_closed must not be observable before the fork result",
          );
          assert.equal(result.ok, true);
          if (result.ok && result.type === "fork") {
            assert.ok(result.forkedSessionId.length > 0);
            assert.equal(result.forkPointEntryId, entryId);
          }
          const closed = await collector.waitFor((event) => event.type === "runtime_closed");
          assert.equal(closed.type, "runtime_closed");
          assert.equal(closed.reason, "forked");
          const after = await port.execute({ type: "get_state" });
          assertErrorCode(after, "unavailable");
        });

        it("forked session opens with a distinct jsonl and fork-point history", async () => {
          const factory = await harness.createFactory();
          const port = await factory.create({ cwd: "/workspace" });
          await port.execute({ type: "prompt", message: "hi" });
          const ports = await harness.createPorts!(factory);
          const detail = await ports.sessionCatalog.readSession(port.identity.sessionId);
          const firstEntry = detail.entries?.[0];
          assert.ok(firstEntry, "prompt must create a catalog entry before fork");
          const entryId = firstEntry.entryId;
          const result = await port.execute({ type: "fork", entryId });
          assert.equal(result.ok, true);
          if (result.ok && result.type === "fork") {
            const forked = await factory.open({ sessionId: result.forkedSessionId });
            assert.notEqual(forked.identity.sessionFile, port.identity.sessionFile, "new jsonl");
            assert.ok(forked.identity.sessionFile.endsWith(".jsonl"));
            const snapshot = await forked.getSnapshot();
            assert.equal(snapshot.state.messageCount, 1, "history starts at the fork point");
            await forked.close("user");
          }
        });

        it("fork provenance (parentSession/fork point) is recorded in the catalog", async () => {
          const factory = await harness.createFactory();
          const port = await factory.create({ cwd: "/workspace" });
          await port.execute({ type: "prompt", message: "hi" });
          const ports = await harness.createPorts!(factory);
          const detail = await ports.sessionCatalog.readSession(port.identity.sessionId);
          const firstEntry = detail.entries?.[0];
          assert.ok(firstEntry, "prompt must create a catalog entry before fork");
          const entryId = firstEntry.entryId;
          const result = await port.execute({ type: "fork", entryId });
          assert.equal(result.ok, true);
          if (result.ok && result.type === "fork") {
            const headers = await ports.sessionCatalog.listSessions();
            const forkedHeader = headers.find(
              (header) => header.sessionId === result.forkedSessionId,
            );
            assert.ok(forkedHeader, "forked session must appear in the catalog");
            assert.equal(forkedHeader.parentSessionId, port.identity.sessionId);
            assert.equal(forkedHeader.forkPointEntryId, entryId);
          }
        });
      });
    });

    /* ---------------------------------------------------------------- */
    describe("usage", () => {
      it("usage fields preserve zero values through JSON", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "zero-usage please" });
        assert.equal(result.ok, true);
        const assistantEnd = collector
          .ofType("message_end")
          .find((event) => event.message.role === "assistant");
        assert.ok(assistantEnd);
        assert.ok(assistantEnd.message.role === "assistant" && assistantEnd.message.usage);
        if (assistantEnd.message.role === "assistant" && assistantEnd.message.usage) {
          assert.deepEqual(assistantEnd.message.usage.cost, {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          });
        }
        const roundTrip = JSON.parse(JSON.stringify(assistantEnd));
        assert.equal(roundTrip.message.usage.output, 0);
        assert.equal(roundTrip.message.usage.input, 0);
        assert.equal(roundTrip.message.usage.cost.total, 0);
        assert.equal(roundTrip.message.usage.cacheRead, 0);
        await port.close("user");
      });

      it("context usage zero values are preserved", async () => {
        const { port } = await newRuntime(harness);
        const snapshot = await port.getSnapshot();
        assert.equal(snapshot.state.contextUsage?.percent, 0);
        assert.equal(snapshot.state.contextUsage?.tokens, 0);
        const roundTrip = JSON.parse(JSON.stringify(snapshot));
        assert.equal(roundTrip.state.contextUsage.percent, 0);
        assert.equal(roundTrip.state.contextUsage.tokens, 0);
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("errors", () => {
      it("external errors map to a structured sanitized RuntimeError", async () => {
        const { port } = await newRuntime(harness);
        const collector = new EventCollector(port);
        const result = await port.execute({ type: "prompt", message: "boom" });
        assertErrorCode(result, "external");
        assert.ok(
          !result.error.message.includes("secret-token-abc123"),
          "raw secret must be scrubbed from the message",
        );
        assert.ok(result.error.message.includes("[REDACTED]"));
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.cause?.kind, "backend");
        const entirePayload = JSON.stringify(result.error);
        assert.ok(!entirePayload.includes("secret-token-abc123"));
        assert.ok(!entirePayload.includes("sk-nested-secret"));
        assert.ok(!(result.error instanceof Error), "must be a plain canonical object");
        assert.equal(collector.ofType("prompt_error").length, 1);
        await port.close("user");
      });

      it("retryable classification is explicit", async () => {
        const { port } = await newRuntime(harness);
        const pending = port.execute({ type: "prompt", message: "long prompt" });
        await delay(30);
        const busy = await port.execute({ type: "prompt", message: "again" });
        assertErrorCode(busy, "session_busy");
        assert.equal(busy.error.retryable, true);
        await port.interrupt({ type: "abort" });
        await pending;
        await port.close("user");
      });

      it("error payloads are serializable and never raw Error instances", async () => {
        const { port } = await newRuntime(harness);
        const result = await port.execute({ type: "prompt", message: "boom" });
        assertErrorCode(result, "external");
        const roundTrip = JSON.parse(JSON.stringify(result.error));
        assert.deepEqual(roundTrip, result.error);
        assert.equal(roundTrip.code, "external");
        assert.ok(structuredClone(result.error));
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("catalog & locator (requires createPorts)", () => {
      it("list/read/context via SessionCatalogPort", async () => {
        const factory = await harness.createFactory();
        const port = await factory.create({ cwd: "/workspace", name: "Sess A" });
        await port.execute({ type: "prompt", message: "hi" });
        const ports = await harness.createPorts!(factory);
        const headers = await ports.sessionCatalog.listSessions();
        assert.ok(headers.some((header) => header.sessionId === port.identity.sessionId));
        const detail = await ports.sessionCatalog.readSession(port.identity.sessionId);
        assert.equal(detail.messageCount, 3);
        const context = await ports.sessionCatalog.readSessionContext(port.identity.sessionId);
        assert.equal(context.entries.length, 3);
        assert.ok(context.entries.every((entry) => entry.entryId.length > 0));
        assert.equal(context.entries[1]?.parentEntryId, context.entries[0]?.entryId);
        assert.equal(detail.cwd, "/workspace");
        assert.equal(detail.projectRoot, "/workspace");
        const filtered = await ports.sessionCatalog.listSessions({ cwd: "/workspace" });
        assert.ok(filtered.some((header) => header.sessionId === port.identity.sessionId));
        await port.close("user");
      });

      it("locate/resolveLeafId via SessionLocatorPort", async () => {
        const factory = await harness.createFactory();
        const port = await factory.create({ cwd: "/workspace" });
        await port.execute({ type: "prompt", message: "hi" });
        const ports = await harness.createPorts!(factory);
        const location = await ports.sessionLocator.locate(port.identity.sessionId);
        assert.equal(location.sessionFile, port.identity.sessionFile);
        assert.equal(location.exists, true);
        const leaf = await ports.sessionLocator.resolveLeafId(port.identity.sessionId);
        assert.ok(leaf.length > 0);
        await port.close("user");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("model catalog (requires createPorts)", () => {
      it("listModels/getDefaultModel/resolveModel", async () => {
        const factory = await harness.createFactory();
        const ports = await harness.createPorts!(factory);
        const models = await ports.modelCatalog.listModels();
        assert.ok(models.length >= 2);
        const defaults = await ports.modelCatalog.getDefaultModel();
        assert.ok(defaults.id.length > 0);
        const resolved = await ports.modelCatalog.resolveModel({
          provider: "openai",
          modelId: "gpt-5",
        });
        assert.equal(resolved.id, "gpt-5");
        await assert.rejects(() =>
          ports.modelCatalog.resolveModel({ provider: "x", modelId: "y" }),
        );
      });
    });

    /* ---------------------------------------------------------------- */
    describe("credential store (requires createPorts)", () => {
      it("provider status never exposes raw credentials", async () => {
        const factory = await harness.createFactory();
        const ports = await harness.createPorts!(factory);
        const providers = await ports.credentialStore.listProviders();
        assert.ok(providers.length >= 2);
        const openai = providers.find((provider) => provider.id === "openai");
        assert.deepEqual(openai?.methods, ["apiKey", "oauth"]);
        assert.equal(
          providers.filter((provider) => provider.id === "openai").length,
          1,
          "dual-auth providers must not be duplicated",
        );
        const before = await ports.credentialStore.getProviderStatus("anthropic");
        assert.equal(before.authorized, false);
        const result = await ports.credentialStore.authorize("anthropic", {
          type: "apiKey",
          apiKey: "sk-test-secret",
        });
        assert.equal(result.authorized, true);
        const serialized = JSON.stringify(result);
        assert.ok(!serialized.includes("sk-test-secret"), "raw credential must never be returned");
        const after = await ports.credentialStore.getProviderStatus("anthropic");
        assert.equal(after.authorized, true);
        assert.ok(!JSON.stringify(after).includes("sk-test-secret"));
      });

      it("device-code start returns public pending info only", async () => {
        const factory = await harness.createFactory();
        const ports = await harness.createPorts!(factory);
        const result = await ports.credentialStore.authorize("github", { type: "start" });
        assert.equal(result.authorized, false);
        assert.ok(result.pending?.userCode);
        assert.ok(!JSON.stringify(result).includes("secret"));
      });
    });

    /* ---------------------------------------------------------------- */
    describe("resources & trust (requires createPorts)", () => {
      it("skills/plugins/commands listing", async () => {
        const factory = await harness.createFactory();
        const ports = await harness.createPorts!(factory);
        const skills = await ports.resourceCatalog.listSkills();
        assert.ok(skills.some((skill) => skill.name === "frontend"));
        const plugins = await ports.resourceCatalog.listPlugins();
        assert.ok(plugins.some((plugin) => plugin.name === "pi-web-side-chat"));
        const commands = await ports.resourceCatalog.listCommands();
        assert.ok(commands.some((command) => command.name === "compact"));

        const plugin = await ports.resourceCatalog.writePlugin({
          name: "local-plugin",
          content: "export default {}",
          enabled: false,
        });
        assert.equal(plugin.enabled, false);
        assert.equal(
          (await ports.resourceCatalog.setPluginEnabled("local-plugin", true)).enabled,
          true,
        );
        const installed = await ports.resourceCatalog.installSkill({
          source: "https://example.com/skills/new-skill",
          name: "new-skill",
        });
        assert.equal(installed.enabled, true);
        assert.equal(
          (await ports.resourceCatalog.setSkillEnabled("new-skill", false)).enabled,
          false,
        );
        assert.equal(
          (await ports.resourceCatalog.updateSkill("new-skill")).version,
          "updated",
        );
      });

      it("project trust gate controls resource reload", async () => {
        const factory = await harness.createFactory();
        const ports = await harness.createPorts!(factory);
        const initial = await ports.projectTrust.getTrust("/workspace");
        assert.equal(initial.level, "untrusted");
        const blocked = await ports.projectTrust.canReloadResources("/workspace");
        assert.equal(blocked.allowed, false);
        await ports.projectTrust.setTrust("/workspace", "trusted");
        assert.equal(await ports.projectTrust.isTrusted("/workspace"), true);
        const allowed = await ports.projectTrust.canReloadResources("/workspace");
        assert.equal(allowed.allowed, true);
      });
    });

    /* ---------------------------------------------------------------- */
    const sideChatSuite = harness.getSideChatSnapshot ? describe : describe.skip;
    sideChatSuite("side chat snapshot DTO (future-optional)", () => {
      it("main snapshot is a serializable canonical DTO", async () => {
        const { port } = await newRuntime(harness);
        await port.execute({ type: "prompt", message: "hi" });
        const snapshot = await harness.getSideChatSnapshot!(port.identity.sessionId);
        assert.ok(snapshot, "side chat snapshot must be available");
        assert.equal(snapshot!.sessionId, port.identity.sessionId);
        assert.ok(snapshot!.systemPrompt && snapshot!.systemPrompt.length > 0);
        assert.ok(snapshot!.writtenFiles.some((path) => path.endsWith(".md")));
        assert.ok(snapshot!.activity.length >= 1);
        assert.equal(typeof snapshot!.version, "number");
        const roundTrip = JSON.parse(JSON.stringify(snapshot));
        assert.deepEqual(roundTrip, snapshot, "DTO must survive JSON round-trip");
        assert.ok(structuredClone(snapshot));
        await port.close("user");
      });
    });
  });
}
