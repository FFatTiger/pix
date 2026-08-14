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
          "runtime.tools.read",
          "runtime.tools.write",
          "runtime.reload",
          "runtime.compact",
          "runtime.compact.abort",
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
        // D2-P6: the tools+reload triple IS in the production surface — verify
        // the capability gate reports them OPEN (real behavior is exercised by
        // the dedicated tools+reload smoke test).
        const toolsRead = port.getCapabilities().capabilities.includes("runtime.tools.read");
        const toolsWrite = port.getCapabilities().capabilities.includes("runtime.tools.write");
        const reloadCap = port.getCapabilities().capabilities.includes("runtime.reload");
        assert.equal(toolsRead, true, "runtime.tools.read must be open");
        assert.equal(toolsWrite, true, "runtime.tools.write must be open");
        assert.equal(reloadCap, true, "runtime.reload must be open");
        // D2-P7: the manual-compact pair IS in the production surface — verify
        // the capability gate reports them OPEN (real behavior is exercised by
        // the dedicated D2-P7 compact smoke test).
        const compactCap = port.getCapabilities().capabilities.includes("runtime.compact");
        const compactAbortCap = port.getCapabilities().capabilities.includes("runtime.compact.abort");
        assert.equal(compactCap, true, "runtime.compact must be open");
        assert.equal(compactAbortCap, true, "runtime.compact.abort must be open");
        // runtime.auto_name is explicitly NOT unlocked in D2-P1..P7.
        const autoName = await port.execute({ type: "generate_session_title" });
        assert.equal(autoName.ok, false);
        if (!autoName.ok) {
          assert.equal(autoName.error.code, "unsupported_capability");
          assert.match(autoName.error.message, /runtime\.auto_name/);
        }
        // runtime.fork is NOT in the production surface.
        const fork = await port.execute({ type: "fork", entryId: "entry-1" });
        assert.equal(fork.ok, false);
        if (!fork.ok) {
          assert.equal(fork.error.code, "unsupported_capability");
          assert.match(fork.error.message, /runtime\.fork/);
        }
        // runtime.navigate is NOT in the production surface.
        const navigate = await port.execute({ type: "navigate_tree", targetId: "entry-1" });
        assert.equal(navigate.ok, false);
        if (!navigate.ok) {
          assert.equal(navigate.error.code, "unsupported_capability");
          assert.match(navigate.error.message, /runtime\.navigate/);
        }
      } finally {
        await port.close("user");
      }
    });
  });

  it("production compact: tiny/fresh session compact fails structured and leaves a clean snapshot (D2-P7)", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P7 Compact Smoke",
      });
      try {
        assert.equal(port.getCapabilities().capabilities.length, 16);
        assert.deepEqual([...port.getCapabilities().capabilities], [...PRODUCTION_AGENT_CAPABILITIES]);

        // A tiny/fresh session has nothing to compact: the real SDK compact
        // must fail STRUCTURED (external / invalid_input / nothing-to-compact),
        // never a raw SDK error, and must leave the snapshot isCompacting:false
        // with no pending compaction projection.
        const compact = await port.execute({ type: "compact" });
        assert.equal(compact.ok, false, `fresh-session compact should not claim success: ${JSON.stringify(compact)}`);
        if (!compact.ok) {
          assert.equal(compact.type, "compact");
          assert.equal(typeof compact.error.code, "string");
          assert.equal(typeof compact.error.message, "string");
          assert.ok(!/\n|\tat |node:internal/i.test(compact.error.message), "no raw stack text");
          assert.ok(!compact.error.message.includes("sk-"), "no secret-shaped raw leak");
        }
        const afterFail = await port.execute({ type: "get_state" });
        assert.equal(afterFail.ok, true);
        if (afterFail.ok && afterFail.type === "get_state") {
          assert.equal(afterFail.state.isCompacting, false, "failed compact must leave isCompacting:false");
          assert.equal(afterFail.state.compaction, undefined, "no pending compaction projection after failed compact");
        }

        // Idle abort_compaction is an idempotent supported no-op.
        const idleAbort = await port.interrupt({ type: "abort_compaction" });
        assert.equal(idleAbort.ok, true, JSON.stringify(idleAbort));
        if (idleAbort.ok) assert.equal(idleAbort.type, "abort_compaction");

        // set_auto_compaction is a pure local SDK setting (wire-open under
        // runtime.compact) and must work offline with the flag reflected.
        const auto = await port.execute({ type: "set_auto_compaction", enabled: true });
        assert.equal(auto.ok, true, JSON.stringify(auto));
        if (auto.ok) assert.equal(auto.type, "set_auto_compaction");
        const afterAuto = await port.execute({ type: "get_state" });
        assert.equal(afterAuto.ok, true);
        if (afterAuto.ok && afterAuto.type === "get_state") {
          assert.equal(afterAuto.state.autoCompactionEnabled, true);
        }
      } finally {
        await port.close("user");
      }
    });
  });
  it("production compact after a COMPLETED bash reaches the SDK and is never session_busy (D2-P7 F1 fix)", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: [],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P7 BashThenCompact Smoke",
      });
      try {
        // Complete a real bash command; the terminal bash projection is retained
        // forever (this.bash.completed === true).
        const bash = await port.execute({ type: "bash", command: "echo pix-bash-then-compact" });
        assert.equal(bash.ok, true, JSON.stringify(bash));
        const afterBash = await port.execute({ type: "get_state" });
        assert.equal(afterBash.ok, true);
        if (afterBash.ok && afterBash.type === "get_state") {
          assert.equal(afterBash.state.isBashRunning, false);
          assert.equal(afterBash.state.bash?.completed, true, "terminal bash projection retained");
        }

        // Compact MUST reach the SDK: the tiny session has nothing to compact, so
        // the real SDK answers a structured non-busy failure — NEVER session_busy
        // (a completed bash must not block compact forever).
        const compact = await port.execute({ type: "compact" });
        assert.equal(compact.ok, false, `compact should not claim success: ${JSON.stringify(compact)}`);
        if (!compact.ok) {
          assert.equal(compact.type, "compact");
          assert.notEqual(compact.error.code, "session_busy", "completed bash must not make compact session_busy (F1 fix)");
          assert.equal(typeof compact.error.message, "string");
          assert.ok(!/\n|\tat |node:internal/i.test(compact.error.message), "no raw stack text");
          assert.ok(!compact.error.message.includes("sk-"), "no secret-shaped raw leak");
        }
        // State clean after the failed compact (no pending compaction).
        const afterCompact = await port.execute({ type: "get_state" });
        assert.equal(afterCompact.ok, true);
        if (afterCompact.ok && afterCompact.type === "get_state") {
          assert.equal(afterCompact.state.isCompacting, false, "failed compact must leave isCompacting:false");
          assert.equal(afterCompact.state.compaction, undefined, "no pending compaction after failed compact");
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

  it("production tools + reload: get_tools query, set_tools authority, reload converges tools/systemPrompt/capabilities", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: ["read", "bash"],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P6 Tools+Reload Smoke",
      });
      try {
        // get_tools — QUERY: typed result with canonical names + active flags
        // reflecting the create-time toolNames selection (read/bash active).
        const tools = await port.execute({ type: "get_tools" });
        assert.equal(tools.ok, true, JSON.stringify(tools));
        if (tools.ok && tools.type === "get_tools") {
          const names = tools.tools.map((tool) => tool.name);
          for (const expected of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
            assert.ok(names.includes(expected), `tool ${expected} missing: ${JSON.stringify(names)}`);
          }
          const read = tools.tools.find((tool) => tool.name === "read");
          assert.equal(read?.active, true);
          const write = tools.tools.find((tool) => tool.name === "write");
          assert.equal(write?.active, false);
          assert.ok(tools.tools.every((tool) => typeof tool.active === "boolean"));
        }

        // set_tools subset with a duplicate → de-duplicated active selection and
        // a non-empty system prompt in the authoritative state.
        const set = await port.execute({ type: "set_tools", toolNames: ["read", "edit", "read"] });
        assert.equal(set.ok, true, JSON.stringify(set));
        if (set.ok) {
          assert.equal(set.type, "set_tools");
        }
        const after = await port.execute({ type: "get_state" });
        assert.equal(after.ok, true);
        if (after.ok && after.type === "get_state") {
          const active = (after.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();
          assert.deepEqual(active, ["edit", "read"], JSON.stringify(after.state.tools));
          assert.ok(typeof after.state.systemPrompt === "string" && after.state.systemPrompt.length > 0, "subset selection must keep a non-empty system prompt");
        }

        // reload → converges tools (re-applies configured selection), systemPrompt
        // and bumps the capability version (never broadens the production set).
        const versionBefore = port.getCapabilities().version;
        const reload = await port.execute({ type: "reload" });
        assert.equal(reload.ok, true, JSON.stringify(reload));
        if (reload.ok) {
          assert.equal(reload.type, "reload");
        }
        const afterReload = await port.execute({ type: "get_state" });
        assert.equal(afterReload.ok, true);
        if (afterReload.ok && afterReload.type === "get_state") {
          const active = (afterReload.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();
          assert.deepEqual(active, ["edit", "read"], "reload must re-apply the configured tool selection");
        }
        assert.ok(port.getCapabilities().version > versionBefore, `reload must bump the capability version (${port.getCapabilities().version} > ${versionBefore})`);
        // The reloaded set must never broaden beyond the production allowed set.
        assert.deepEqual([...port.getCapabilities().capabilities], [...PRODUCTION_AGENT_CAPABILITIES]);

        // all-tools-off → systemPrompt cleared.
        const off = await port.execute({ type: "set_tools", toolNames: [] });
        assert.equal(off.ok, true, JSON.stringify(off));
        const offState = await port.execute({ type: "get_state" });
        assert.equal(offState.ok, true);
        if (offState.ok && offState.type === "get_state") {
          assert.equal(offState.state.systemPrompt, "");
          assert.ok((offState.state.tools ?? []).every((tool) => !tool.active));
        }
      } finally {
        await port.close("user");
      }
    });
  });

  it("production set_tools rejects unknown/blank/control names with invalid_input and no mutation (D2-P6 fix)", async () => {
    await withAgentDir(async (root) => {
      const cwd = join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES }).create({
        cwd,
        toolNames: ["read", "bash"],
        thinkingLevel: "off",
        thinkingLevelPinned: true,
        name: "D2-P6 Invalid Tools Smoke",
      });
      try {
        // Baseline active set (create-time toolNames read+bash; extensions are
        // auto-included by the real driver, so capture whatever is active).
        const before = await port.execute({ type: "get_state" });
        assert.equal(before.ok, true, JSON.stringify(before));
        const beforeActive = before.ok && before.type === "get_state"
          ? (before.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort()
          : [];

        // Unknown tool → structured invalid_input; the name is displayed sanely
        // (no secret/path/object coercion) and retryable=false.
        const unknown = await port.execute({ type: "set_tools", toolNames: ["read", "does-not-exist"] });
        assert.equal(unknown.ok, false, JSON.stringify(unknown));
        if (!unknown.ok) {
          assert.equal(unknown.type, "set_tools");
          assert.equal(unknown.error.code, "invalid_input");
          assert.equal(unknown.error.retryable, false);
          assert.match(unknown.error.message, /^unknown tool: does-not-exist$/);
          assert.ok(!/sk-[A-Za-z0-9_-]+/.test(unknown.error.message), "no secret-shaped raw leak");
        }

        // A secret-shaped unknown name must be redacted in the message (no raw
        // key material leaks into the structured error).
        const secret = await port.execute({ type: "set_tools", toolNames: ["read", "sk-CANARY-SECRET-TOKEN"] });
        assert.equal(secret.ok, false, JSON.stringify(secret));
        if (!secret.ok) {
          assert.equal(secret.error.code, "invalid_input");
          assert.ok(!secret.error.message.includes("sk-CANARY-SECRET-TOKEN"), "secret must be redacted");
        }

        // Blank / control name → invalid_input before any mutation.
        for (const bad of ["   ", "\n\t", "read\u0000evil", "\u001f"]) {
          const blank = await port.execute({ type: "set_tools", toolNames: ["read", bad] });
          assert.equal(blank.ok, false, JSON.stringify(blank));
          if (!blank.ok) {
            assert.equal(blank.error.code, "invalid_input");
            assert.match(blank.error.message, /non-empty|unknown tool/i);
          }
        }

        // No partial mutation: state AND get_tools unchanged after the failures.
        const after = await port.execute({ type: "get_state" });
        assert.equal(after.ok, true, JSON.stringify(after));
        if (after.ok && after.type === "get_state") {
          const afterActive = (after.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();
          assert.deepEqual(afterActive, beforeActive, "failed set_tools must not mutate active tools");
        }
        const getTools = await port.execute({ type: "get_tools" });
        assert.equal(getTools.ok, true, JSON.stringify(getTools));

        // Valid dynamic/builtin set still works (read + bash + edit active).
        const valid = await port.execute({ type: "set_tools", toolNames: ["read", "bash", "edit"] });
        assert.equal(valid.ok, true, JSON.stringify(valid));
        if (valid.ok) {
          assert.equal(valid.type, "set_tools");
        }
        const validState = await port.execute({ type: "get_state" });
        assert.equal(validState.ok, true);
        if (validState.ok && validState.type === "get_state") {
          const active = (validState.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();
          assert.deepEqual(active, ["bash", "edit", "read"], JSON.stringify(validState.state.tools));
        }

        // All-off still works (systemPrompt cleared, no active tools).
        const off = await port.execute({ type: "set_tools", toolNames: [] });
        assert.equal(off.ok, true, JSON.stringify(off));
        const offState = await port.execute({ type: "get_state" });
        assert.equal(offState.ok, true);
        if (offState.ok && offState.type === "get_state") {
          assert.equal(offState.state.systemPrompt, "");
          assert.ok((offState.state.tools ?? []).every((tool) => !tool.active));
        }
      } finally {
        await port.close("user");
      }
    });
  });
});
