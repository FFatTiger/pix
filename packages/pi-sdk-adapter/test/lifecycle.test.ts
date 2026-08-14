import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { PiSdkAgentRuntimeFactory } from "../src/agent/factory.js";
import { tagFactoryOptions } from "../src/internal/factory-options.js";
import type { DriverEventListener, DriverFactoryOptions, PiRuntimeDriver, PiRuntimeDriverFactory } from "../src/internal/types.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

class CountingDriver implements PiRuntimeDriver {
  subscribes = 0;
  unsubscribes = 0;
  closeCalls = 0;
  constructor(private readonly inner: PiRuntimeDriver) {}
  get identity() { return this.inner.identity; }
  get capabilities() { return this.inner.capabilities; }
  getState() { return this.inner.getState(); }
  subscribe(listener: DriverEventListener) { this.subscribes += 1; const off = this.inner.subscribe(listener); return () => { this.unsubscribes += 1; off(); }; }
  prompt(...args: Parameters<PiRuntimeDriver["prompt"]>) { return this.inner.prompt(...args); }
  steer(...args: Parameters<PiRuntimeDriver["steer"]>) { return this.inner.steer(...args); }
  followUp(...args: Parameters<PiRuntimeDriver["followUp"]>) { return this.inner.followUp(...args); }
  abort() { return this.inner.abort(); }
  setModel(...args: Parameters<PiRuntimeDriver["setModel"]>) { return this.inner.setModel(...args); }
  setThinkingLevel(...args: Parameters<PiRuntimeDriver["setThinkingLevel"]>) { return this.inner.setThinkingLevel(...args); }
  compact(...args: Parameters<PiRuntimeDriver["compact"]>) { return this.inner.compact(...args); }
  abortCompaction() { return this.inner.abortCompaction(); }
  setSessionName(...args: Parameters<PiRuntimeDriver["setSessionName"]>) { return this.inner.setSessionName(...args); }
  setAutoCompaction(...args: Parameters<PiRuntimeDriver["setAutoCompaction"]>) { return this.inner.setAutoCompaction(...args); }
  setAutoRetry(...args: Parameters<PiRuntimeDriver["setAutoRetry"]>) { return this.inner.setAutoRetry(...args); }
  clearQueue() { return this.inner.clearQueue(); }
  setTools(...args: Parameters<PiRuntimeDriver["setTools"]>) { return this.inner.setTools(...args); }
  reload() { return this.inner.reload(); }
  bash(...args: Parameters<PiRuntimeDriver["bash"]>) { return this.inner.bash(...args); }
  abortBash() { return this.inner.abortBash(); }
  navigate(...args: Parameters<PiRuntimeDriver["navigate"]>) { return this.inner.navigate(...args); }
  fork(...args: Parameters<PiRuntimeDriver["fork"]>) { return this.inner.fork(...args); }
  generateSessionTitle() { return this.inner.generateSessionTitle(); }
  bindUi(...args: Parameters<PiRuntimeDriver["bindUi"]>) { return this.inner.bindUi(...args); }
  async close(...args: Parameters<PiRuntimeDriver["close"]>) { this.closeCalls += 1; await this.inner.close(...args); }
}

class CountingFactory implements PiRuntimeDriverFactory {
  latest?: CountingDriver;
  constructor(private readonly inner: PiRuntimeDriverFactory) {}
  async create(input: Parameters<PiRuntimeDriverFactory["create"]>[0], options: DriverFactoryOptions) { return this.latest = new CountingDriver(await this.inner.create(input, options)); }
  async open(...args: Parameters<PiRuntimeDriverFactory["open"]>) { return this.latest = new CountingDriver(await this.inner.open(...args)); }
}

describe("adapter set_tools validation (malformed/unknown names, D2-P6 fix)", () => {
  it("rejects unknown/blank/control names with invalid_input and no mutation; valid set + all-off still work", async () => {
    const store = new ScriptedSdkStore();
    const options = { capabilities: RUNTIME_CAPABILITIES };
    tagFactoryOptions(options, { driverFactory: new ScriptedSdkDriverFactory(store) });
    const port = await new PiSdkAgentRuntimeFactory(options).create({ cwd: "/workspace", toolNames: ["read"] });
    try {
      const before = await port.getSnapshot();
      const beforeActive = (before.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();

      // Unknown tool → exact canonical invalid_input, no mutation.
      const unknown = await port.execute({ type: "set_tools", toolNames: ["read", "does-not-exist"] });
      assert.equal(unknown.ok, false, JSON.stringify(unknown));
      if (!unknown.ok) {
        assert.equal(unknown.type, "set_tools");
        assert.equal(unknown.error.code, "invalid_input");
        assert.equal(unknown.error.retryable, false);
        assert.match(unknown.error.message, /^unknown tool: does-not-exist$/);
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

      // No partial mutation: state unchanged after failures.
      const after = await port.getSnapshot();
      const afterActive = (after.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();
      assert.deepEqual(afterActive, beforeActive, "failed set_tools must not mutate active tools");

      // Valid dynamic/builtin set still works (de-duplicated read+write).
      const valid = await port.execute({ type: "set_tools", toolNames: ["read", "write", "read"] });
      assert.equal(valid.ok, true, JSON.stringify(valid));
      if (valid.ok) {
        assert.equal(valid.type, "set_tools");
      }
      const validState = await port.getSnapshot();
      const validActive = (validState.state.tools ?? []).filter((tool) => tool.active).map((tool) => tool.name).sort();
      assert.deepEqual(validActive, ["read", "write"], JSON.stringify(validState.state.tools));

      // All-off still works (systemPrompt cleared).
      const off = await port.execute({ type: "set_tools", toolNames: [] });
      assert.equal(off.ok, true, JSON.stringify(off));
      const offState = await port.getSnapshot();
      assert.ok((offState.state.tools ?? []).every((tool) => !tool.active));
      assert.equal(offState.state.systemPrompt, "");
    } finally {
      await port.close("user");
    }
  });
});

describe("adapter cleanup and fork ordering", () => {
  it("unsubscribes the single SDK event bridge and closes the driver exactly once", async () => {
    const counting = new CountingFactory(new ScriptedSdkDriverFactory(new ScriptedSdkStore()));
    const options = { capabilities: RUNTIME_CAPABILITIES };
    tagFactoryOptions(options, { driverFactory: counting });
    const port = await new PiSdkAgentRuntimeFactory(options).create({ cwd: "/workspace" });
    assert.equal(counting.latest?.subscribes, 1);
    await port.close("user");
    await port.close("shutdown");
    assert.equal(counting.latest?.unsubscribes, 1);
    assert.equal(counting.latest?.closeCalls, 1);
  });

  it("fork result settles before runtime_closed is observable", async () => {
    const store = new ScriptedSdkStore();
    const options = { capabilities: RUNTIME_CAPABILITIES };
    tagFactoryOptions(options, { driverFactory: new ScriptedSdkDriverFactory(store) });
    const factory = new PiSdkAgentRuntimeFactory(options);
    const port = await factory.create({ cwd: "/workspace" });
    await port.execute({ type: "prompt", message: "hi" });
    const entry = (await store.readSession(port.identity.sessionId)).entries?.[0];
    assert.ok(entry);
    const events: string[] = [];
    port.subscribe((event) => events.push(event.type));
    const result = await port.execute({ type: "fork", entryId: entry.entryId });
    assert.equal(result.ok, true);
    assert.equal(events.includes("runtime_closed"), false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events.at(-1), "runtime_closed");
  });
});
