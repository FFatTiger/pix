/**
 * Reference runtime factory — creates/opens in-memory runtimes and exposes
 * the store so the reference harness can bind the other ports.
 */
import type {
  AgentRuntimeFactory,
  AgentRuntimePort,
  RuntimeOpenInput,
  RuntimeStartInput,
} from "@fffattiger/pi-web-runtime-core";
import {
  createCapabilitySet,
  makeRuntimeError,
  RUNTIME_CAPABILITIES,
} from "@fffattiger/pi-web-runtime-core";
import type { HarnessFactoryOptions } from "../harness.js";
import { ReferenceModelCatalog } from "./ports.js";
import { ReferenceAgentRuntime } from "./runtime.js";
import { ReferenceSessionStore } from "./store.js";

export interface ReferenceFactoryOptions extends HarnessFactoryOptions {
  baseDir?: string;
}

export class ReferenceRuntimeFactory implements AgentRuntimeFactory {
  readonly store: ReferenceSessionStore;
  readonly modelCatalog = new ReferenceModelCatalog();

  constructor(private readonly options: ReferenceFactoryOptions = {}) {
    this.store = new ReferenceSessionStore(
      options.baseDir === undefined ? undefined : { baseDir: options.baseDir },
    );
  }

  async create(input: RuntimeStartInput): Promise<AgentRuntimePort> {
    const session = this.store.createSession({
      ...(input.name === undefined ? {} : { title: input.name }),
      cwd: input.cwd,
      projectRoot: input.cwd,
    });
    const model = input.model
      ? this.resolveOrThrow(input.model)
      : await this.modelCatalog.getDefaultModel();
    const reloadCapabilities = this.reloadCapabilities();
    return new ReferenceAgentRuntime({
      store: this.store,
      session,
      cwd: input.cwd,
      capabilities: this.initialCapabilities(),
      ...(reloadCapabilities === undefined ? {} : { reloadCapabilities }),
      model,
      resolveModel: (selector) => this.modelCatalog.resolve(selector),
      ...(input.toolNames === undefined ? {} : { initialTools: input.toolNames }),
      ...(input.thinkingLevel === undefined
        ? {}
        : { initialThinkingLevel: input.thinkingLevel }),
      ...(input.thinkingLevelPinned === undefined
        ? {}
        : { initialThinkingLevelPinned: input.thinkingLevelPinned }),
    });
  }

  async open(input: RuntimeOpenInput): Promise<AgentRuntimePort> {
    const session = this.store.getSession(input.sessionId);
    if (!session) {
      throw makeRuntimeError("not_found", `session not found: ${input.sessionId}`);
    }
    const model = input.model
      ? this.resolveOrThrow(input.model)
      : session.model ?? (await this.modelCatalog.getDefaultModel());
    const reloadCapabilities = this.reloadCapabilities();
    return new ReferenceAgentRuntime({
      store: this.store,
      session,
      cwd: input.cwd ?? session.cwd,
      capabilities: this.initialCapabilities(),
      ...(reloadCapabilities === undefined ? {} : { reloadCapabilities }),
      model,
      resolveModel: (selector) => this.modelCatalog.resolve(selector),
    });
  }

  private initialCapabilities() {
    return createCapabilitySet(this.options.capabilities ?? RUNTIME_CAPABILITIES, 1);
  }

  private reloadCapabilities() {
    return this.options.reloadCapabilities
      ? createCapabilitySet(this.options.reloadCapabilities, 2)
      : undefined;
  }

  private resolveOrThrow(selector: { provider: string; modelId: string }) {
    const resolved = this.modelCatalog.resolve(selector);
    if (!resolved) {
      throw makeRuntimeError(
        "invalid_input",
        `unknown model: ${selector.provider}/${selector.modelId}`,
      );
    }
    return resolved;
  }
}
