import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRODUCTION_AGENT_CAPABILITIES, PiSdkAgentRuntimeFactory } from "../src/agent/index.js";

async function withAgentDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pix-pi-sdk-public-smoke-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try { return await fn(root); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

describe("public production SDK factory smoke", () => {
  it("creates a real SDK-backed persisted runtime without an injected driver", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "Production Smoke",
      });
      assert.ok(port.identity.sessionId.length > 0);
      assert.ok(port.identity.sessionFile.endsWith(".jsonl"));
      const snapshot = await port.getSnapshot();
      assert.equal(snapshot.state.systemPrompt, "");
      assert.equal(snapshot.state.tools?.every((tool) => !tool.active), true);
      assert.equal(snapshot.state.thinkingLevelPinned, true);
      assert.equal(snapshot.state.sessionName, "Production Smoke");
      await assert.rejects(
        () => new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
          cwd,
          model: { provider: "missing", modelId: "missing" },
        }),
        (error: unknown) => (error as { code?: string }).code === "external",
      );
      await port.close("user");
      const closed = await port.execute({ type: "get_state" });
      assert.equal(closed.ok, false);
    });
  });

  it("production runtime serves the D2-P1/D2-P2 light commands with no network", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P2 Smoke",
      });
      try {
        assert.deepEqual(port.getCapabilities().capabilities, [
          "runtime.prompt",
          "runtime.abort",
          "runtime.stats",
          "runtime.session.rename",
          "runtime.thinking.set",
          "runtime.model.set",
          "runtime.steer",
          "runtime.follow_up",
          "runtime.queue",
          "runtime.bash",
          "runtime.bash.abort",
        ]);

        // Baseline query: get_state (always available, no capability gate).
        // Real SDK may report a model-default thinking level other than the
        // create input (e.g. "minimal" instead of "off"); pin honesty is the
        // D2-P2 contract, not a specific absolute level at create time.
        const state = await port.execute({ type: "get_state" });
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.type, "get_state");
          assert.equal(state.state.sessionName, "D2-P2 Smoke");
          assert.equal(state.state.messageCount, 0);
          assert.equal(state.state.thinkingLevelPinned, true);
          assert.ok(typeof state.state.thinkingLevel === "string");
        }

        // Baseline query: get_commands (always available).
        const commands = await port.execute({ type: "get_commands" });
        assert.equal(commands.ok, true);
        if (commands.ok) {
          assert.equal(commands.type, "get_commands");
          assert.ok(Array.isArray(commands.commands));
        }

        // Baseline query: get_last_assistant_text (always available).
        const last = await port.execute({ type: "get_last_assistant_text" });
        assert.equal(last.ok, true);
        if (last.ok) {
          assert.equal(last.type, "get_last_assistant_text");
          assert.equal(typeof last.text, "string");
        }

        // Capability-gated: get_session_stats (runtime.stats).
        const stats = await port.execute({ type: "get_session_stats" });
        assert.equal(stats.ok, true);
        if (stats.ok) {
          assert.equal(stats.type, "get_session_stats");
          assert.equal(stats.stats.messageCount, 0);
        }

        // Capability-gated: set_session_name (runtime.session.rename).
        const rename = await port.execute({ type: "set_session_name", name: "Renamed" });
        assert.equal(rename.ok, true);
        if (rename.ok) {
          assert.equal(rename.type, "set_session_name");
        }
        const afterRename = await port.execute({ type: "get_state" });
        assert.equal(afterRename.ok, true);
        if (afterRename.ok && afterRename.type === "get_state") {
          assert.equal(afterRename.state.sessionName, "Renamed");
        }

        // Capability-gated: set_thinking_level (runtime.thinking.set).
        // Real SDK may clamp unsupported levels for the active model; "minimal"
        // is accepted by the no-network production smoke path and pins the level.
        const thinking = await port.execute({ type: "set_thinking_level", level: "minimal" });
        assert.equal(thinking.ok, true);
        if (thinking.ok) {
          assert.equal(thinking.type, "set_thinking_level");
        }
        const afterThinking = await port.execute({ type: "get_state" });
        assert.equal(afterThinking.ok, true);
        if (afterThinking.ok && afterThinking.type === "get_state") {
          assert.equal(afterThinking.state.thinkingLevel, "minimal");
          assert.equal(afterThinking.state.thinkingLevelPinned, true);
        }

        // Capability-gated: set_model (runtime.model.set, D2-P3). The real SDK
        // re-clamps thinking for the new model and the adapter reapplies the
        // pinned level, so the post-set state must carry BOTH the new model and
        // the preserved pin (level is the authoritative SDK clamp, not asserted
        // absolutely).
        const model = await port.execute({ type: "set_model", provider: "openai", modelId: "gpt-5" });
        assert.equal(model.ok, true);
        if (model.ok) {
          assert.equal(model.type, "set_model");
        }
        const afterModel = await port.execute({ type: "get_state" });
        assert.equal(afterModel.ok, true);
        if (afterModel.ok && afterModel.type === "get_state") {
          assert.equal(afterModel.state.model?.provider, "openai");
          assert.equal(afterModel.state.model?.id, "gpt-5");
          assert.equal(afterModel.state.thinkingLevelPinned, true, "set_model must preserve the pinned thinking pin");
        }
      } finally {
        await port.close("user");
      }
    });
  });

  it("unknown model set_model is a structured sanitized invalid_input with no raw leak", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
      });
      try {
        const result = await port.execute({ type: "set_model", provider: "sk-CANARY-SECRET-provider", modelId: "sk-CANARY-SECRET-model" });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.type, "set_model");
          assert.equal(result.error.code, "invalid_input");
          assert.equal(result.error.retryable, false);
          assert.equal(typeof result.error.message, "string");
          // Sanitizer must not leak the raw unknown-model text as a secret; the
          // fixed message shape keeps provider/id out of raw rendering paths.
          assert.ok(!result.error.message.includes("sk-CANARY-SECRET-provider"));
          assert.ok(!result.error.message.includes("sk-CANARY-SECRET-model"));
          assert.equal((result.error.cause as { kind?: string })?.kind, "model");
        }
        // The model was never applied.
        const state = await port.execute({ type: "get_state" });
        assert.equal(state.ok, true);
        if (state.ok && state.type === "get_state") {
          assert.notEqual(state.state.model?.id, "sk-CANARY-SECRET-model");
        }
      } finally {
        await port.close("user");
      }
    });
  });

  it("production surface returns unsupported_capability for commands outside the set", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
      });
      try {
        // runtime.bash IS in the production surface (D2-P5) — verify the pair is
        // OPEN at the capability gate (a real command runs in the bash smoke test).
        const bashCap = port.getCapabilities().capabilities.includes("runtime.bash");
        const abortBashCap = port.getCapabilities().capabilities.includes("runtime.bash.abort");
        assert.equal(bashCap, true, "runtime.bash must be open");
        assert.equal(abortBashCap, true, "runtime.bash.abort must be open");
        // runtime.auto_name is explicitly NOT unlocked in D2-P1..P5.
        const autoName = await port.execute({ type: "generate_session_title" });
        assert.equal(autoName.ok, false);
        if (!autoName.ok) {
          assert.equal(autoName.error.code, "unsupported_capability");
          assert.match(autoName.error.message, /runtime\.auto_name/);
        }
        // runtime.tools.write is NOT in the production surface.
        const tools = await port.execute({ type: "set_tools", toolNames: [] });
        assert.equal(tools.ok, false);
        if (!tools.ok) {
          assert.equal(tools.error.code, "unsupported_capability");
          assert.match(tools.error.message, /runtime\.tools\.write/);
        }
        // runtime.reload is NOT in the production surface.
        const reload = await port.execute({ type: "reload" });
        assert.equal(reload.ok, false);
        if (!reload.ok) {
          assert.equal(reload.error.code, "unsupported_capability");
          assert.match(reload.error.message, /runtime\.reload/);
        }
      } finally {
        await port.close("user");
      }
    });
  });

  it("production bash control: real command projects exact output/exitCode and abort_bash preempts without blocking", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P5 Bash Smoke",
      });
      try {
        // Normal bash: deterministic real command, exact accumulated projection.
        const result = await port.execute({ type: "bash", command: "echo pix-bash-smoke-output" });
        assert.equal(result.ok, true, JSON.stringify(result));
        if (result.ok) {
          assert.equal(result.type, "bash");
        }
        const after = await port.execute({ type: "get_state" });
        assert.equal(after.ok, true);
        if (after.ok && after.type === "get_state") {
          assert.equal(after.state.isBashRunning, false);
          assert.equal(after.state.bash?.completed, true);
          assert.equal(after.state.bash?.exitCode, 0);
          assert.ok(
            after.state.bash?.output.includes("pix-bash-smoke-output"),
            `projected output=${JSON.stringify(after.state.bash?.output)}`,
          );
        }

        // abort_bash interrupt while idle is a supported no-op.
        const idleAbort = await port.interrupt({ type: "abort_bash" });
        assert.equal(idleAbort.ok, true, JSON.stringify(idleAbort));
        if (idleAbort.ok) {
          assert.equal(idleAbort.type, "abort_bash");
        }

        // Long bash + immediate abort_bash: the interrupt must not be blocked
        // behind the command, and the command settles (ok or interrupted).
        const pending = port.execute({ type: "bash", command: "sleep 1" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const started = Date.now();
        const abortResult = await port.interrupt({ type: "abort_bash" });
        assert.equal(abortResult.ok, true, JSON.stringify(abortResult));
        assert.ok(Date.now() - started < 500, "abort_bash must not block behind the long bash");
        const bashOutcome = await pending;
        assert.ok(
          bashOutcome.ok === true || (bashOutcome.ok === false && bashOutcome.error.code === "interrupted"),
          JSON.stringify(bashOutcome),
        );
      } finally {
        await port.close("user");
      }
    });
  });

  it("production queue control: steer/follow_up enqueue, clear_queue empties, set_auto_retry updates state (no network)", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P4 Smoke",
      });
      try {
        // Steering / following-up while idle still enqueues: the SDK exposes
        // getSteeringMessages()/getFollowUpMessages() and emits queue_update,
        // which the adapter reconciles into snapshot.state.queuedMessages.
        const steer = await port.execute({ type: "steer", message: "steer while idle" });
        assert.equal(steer.ok, true, JSON.stringify(steer));
        const follow = await port.execute({ type: "follow_up", message: "follow while idle" });
        assert.equal(follow.ok, true, JSON.stringify(follow));

        const queued = await port.execute({ type: "get_state" });
        assert.equal(queued.ok, true);
        if (queued.ok && queued.type === "get_state") {
          const texts = [...(queued.state.queuedMessages?.steering ?? []), ...(queued.state.queuedMessages?.followUp ?? [])]
            .map((turn) => turn.message);
          assert.ok(texts.includes("steer while idle"), `steering=${JSON.stringify(queued.state.queuedMessages?.steering)}`);
          assert.ok(texts.includes("follow while idle"), `followUp=${JSON.stringify(queued.state.queuedMessages?.followUp)}`);
        }

        // clear_queue empties both queues (no network; the driver clearQueue is local).
        const cleared = await port.execute({ type: "clear_queue" });
        assert.equal(cleared.ok, true, JSON.stringify(cleared));
        const afterClear = await port.execute({ type: "get_state" });
        assert.equal(afterClear.ok, true);
        if (afterClear.ok && afterClear.type === "get_state") {
          assert.equal(afterClear.state.queuedMessages?.steering?.length ?? 0, 0);
          assert.equal(afterClear.state.queuedMessages?.followUp?.length ?? 0, 0);
          assert.equal(afterClear.state.pendingMessageCount, 0);
        }

        // set_auto_retry is a pure local setting (no network); state reflects it.
        const retry = await port.execute({ type: "set_auto_retry", enabled: true });
        assert.equal(retry.ok, true, JSON.stringify(retry));
        const afterRetry = await port.execute({ type: "get_state" });
        assert.equal(afterRetry.ok, true);
        if (afterRetry.ok && afterRetry.type === "get_state") {
          assert.equal(afterRetry.state.autoRetryEnabled, true);
        }
      } finally {
        await port.close("user");
      }
    });
  });
});
