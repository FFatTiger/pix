import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { M2_AGENT_CAPABILITIES, PiSdkAgentRuntimeFactory } from "../src/agent/index.js";

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
      const port = await new PiSdkAgentRuntimeFactory({ capabilities: M2_AGENT_CAPABILITIES }).create({
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
        () => new PiSdkAgentRuntimeFactory({ capabilities: M2_AGENT_CAPABILITIES }).create({
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
});
