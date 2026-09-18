import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntimeFactory } from "@fffattiger/pix-runtime-core";
import { RUNTIME_CAPABILITIES } from "@fffattiger/pix-runtime-core";
import { createRuntimeAdapterSuite } from "@fffattiger/pix-runtime-contract-tests/suite";
import type { AdapterContractHarness, AdapterPortBundle, HarnessFactoryOptions } from "@fffattiger/pix-runtime-contract-tests";
import { PiSdkAgentRuntimeFactory } from "../src/agent/factory.js";
import { tagFactoryOptions } from "../src/internal/factory-options.js";
import { createPortsFromBackend } from "./ports-helper.js";
import { mapDriverError, mapMessage, mapUsage } from "../src/mappers/index.js";
import { ScriptedSdkDriverFactory, ScriptedSdkStore } from "./scripted-sdk.js";

class Harness implements AdapterContractHarness {
  private readonly stores = new Map<AgentRuntimeFactory, ScriptedSdkStore>();
  async createFactory(options?: HarnessFactoryOptions): Promise<AgentRuntimeFactory> {
    const store = new ScriptedSdkStore();
    // The contract suite exercises the COMPLETE adapter surface, so when the
    // caller does not restrict capabilities we explicitly pass the full
    // RUNTIME_CAPABILITIES set. The factory never defaults capabilities itself.
    const factoryOptions = {
      capabilities: options?.capabilities ?? RUNTIME_CAPABILITIES,
      ...(options?.reloadCapabilities === undefined ? {} : { reloadCapabilities: options.reloadCapabilities }),
    };
    tagFactoryOptions(factoryOptions, {
      driverFactory: new ScriptedSdkDriverFactory(store, {
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.model === undefined ? {} : { model: options.model }),
        // The adapter calls driver.getState() first for the admission busy check
        // (call 1) and then for the authoritative admission snapshot via
        // getSnapshot()/buildState() (call 2) — fail call 2 so the ADMISSION
        // snapshot construction throws (not the busy check), proving the prompt
        // is never launched behind a failing admission barrier.
        ...(options?.failAdmissionSnapshot === undefined ? {} : { failGetStateOnCall: 2 }),
      }),
    });
    const factory = new PiSdkAgentRuntimeFactory(factoryOptions);
    this.stores.set(factory, store);
    return factory;
  }
  async createPorts(factory: AgentRuntimeFactory): Promise<AdapterPortBundle> {
    const store = this.stores.get(factory);
    assert.ok(store, "factory must belong to harness");
    return createPortsFromBackend(store);
  }
  async getSideChatSnapshot(sessionId: string) {
    for (const store of this.stores.values()) {
      const session = store.sessions.get(sessionId);
      if (!session) continue;
      return {
        sessionId,
        systemPrompt: "You are a coding agent.",
        writtenFiles: [...session.written],
        activity: session.entries.slice(-5).map((entry) => ({ entryId: entry.entryId, role: entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.role : "toolResult", text: entry.message.role === "assistant" ? entry.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : entry.message.role === "user" && typeof entry.message.content === "string" ? entry.message.content : "activity" })),
        version: session.entries.length,
      };
    }
    return null;
  }
  async teardown() { this.stores.clear(); }
}

createRuntimeAdapterSuite(new Harness());

describe("Pi SDK mapper and public boundary", () => {
  it("maps real Pi-shaped messages and preserves zero usage", () => {
    const message = mapMessage({ role: "assistant", provider: "anthropic", model: "claude", content: [{ type: "thinking", thinking: "why" }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "x" } }, { type: "text", text: "done" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
    assert.equal(message.role, "assistant");
    if (message.role === "assistant") {
      assert.equal(message.usage?.input, 0);
      assert.ok((message.content ?? []).some((block) => block.type === "toolCall" && block.toolCallId === "c1"));
    }
    assert.equal(mapUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })?.cost.total, 0);
  });

  it("sanitizes nested SDK failures without raw Error leakage", () => {
    const error = mapDriverError(Object.assign(new Error("bad secret-token-abc123\n stack"), { details: { apiKey: "sk-secret", safe: true } }));
    const text = JSON.stringify(error);
    assert.ok(!text.includes("secret-token-abc123"));
    assert.ok(!text.includes("sk-secret"));
    assert.ok(!(error instanceof Error));
  });
});
