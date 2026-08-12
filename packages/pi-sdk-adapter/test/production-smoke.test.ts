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
        // runtime.model.set is NOT in the production surface.
        const model = await port.execute({ type: "set_model", provider: "anthropic", modelId: "claude" });
        assert.equal(model.ok, false);
        if (!model.ok) {
          assert.equal(model.error.code, "unsupported_capability");
          assert.match(model.error.message, /runtime\.model\.set/);
        }
        // runtime.bash is NOT in the production surface.
        const bash = await port.execute({ type: "bash", command: "ls" });
        assert.equal(bash.ok, false);
        if (!bash.ok) {
          assert.equal(bash.error.code, "unsupported_capability");
          assert.match(bash.error.message, /runtime\.bash/);
        }
        // runtime.auto_name is explicitly NOT unlocked in D2-P1/D2-P2.
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
        // runtime.queue is NOT in the production surface.
        const queue = await port.execute({ type: "clear_queue" });
        assert.equal(queue.ok, false);
        if (!queue.ok) {
          assert.equal(queue.error.code, "unsupported_capability");
          assert.match(queue.error.message, /runtime\.queue/);
        }
      } finally {
        await port.close("user");
      }
    });
  });
});
