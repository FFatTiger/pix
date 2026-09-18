import type {
  AgentRuntimeFactory,
  AgentRuntimePort,
  RuntimeCapability,
  RuntimeOpenInput,
  RuntimeStartInput,
} from "@fffattiger/pix-runtime-core";
import { isRuntimeError, makeRuntimeError } from "@fffattiger/pix-runtime-core";
import type { PiRuntimeDriverFactory } from "../internal/types.js";
import { SdkRuntimeDriverFactory } from "../internal/sdk-runtime.js";
import { readFactoryInjection } from "../internal/factory-options.js";
import { CanonicalAgentRuntimeAdapter } from "../internal/adapter.js";

export interface PiSdkAgentRuntimeFactoryOptions {
  /**
   * Canonical capability set the created runtime advertises. REQUIRED: the
   * factory never silently falls back to the full RUNTIME_CAPABILITIES set —
   * composition (R1/R2) and tests must explicitly choose a capability surface
   * (e.g. PRODUCTION_AGENT_CAPABILITIES for the production happy path, or the full
   * RUNTIME_CAPABILITIES for contract-suite coverage).
   */
  readonly capabilities: readonly RuntimeCapability[];
  /** Capability projection reported after a `reload` command (test/composition seam). */
  readonly reloadCapabilities?: readonly RuntimeCapability[];
}

export class PiSdkAgentRuntimeFactory implements AgentRuntimeFactory {
  private readonly driverFactory: PiRuntimeDriverFactory;
  private readonly driverOptions: {
    capabilities: readonly RuntimeCapability[];
    reloadCapabilities?: readonly RuntimeCapability[];
  };

  constructor(options: PiSdkAgentRuntimeFactoryOptions) {
    const internal = readFactoryInjection(options);
    this.driverFactory = internal?.driverFactory ?? new SdkRuntimeDriverFactory(internal?.trace);
    this.driverOptions = {
      capabilities: options.capabilities,
      ...(options.reloadCapabilities === undefined ? {} : { reloadCapabilities: options.reloadCapabilities }),
    };
  }

  async create(input: RuntimeStartInput): Promise<AgentRuntimePort> {
    try {
      const driver = await this.driverFactory.create(input, this.driverOptions);
      const adapter = new CanonicalAgentRuntimeAdapter(
        driver,
        input.thinkingLevelPinned === undefined
          ? undefined
          : { thinkingPinned: input.thinkingLevelPinned },
      );
      await adapter.ready();
      return adapter;
    } catch (error) {
      throw this.mapFactoryError(error);
    }
  }

  async open(input: RuntimeOpenInput): Promise<AgentRuntimePort> {
    try {
      const driver = await this.driverFactory.open(
        input.sessionId,
        input.cwd,
        input.model === undefined ? undefined : { provider: input.model.provider, id: input.model.modelId },
        this.driverOptions,
      );
      const adapter = new CanonicalAgentRuntimeAdapter(driver);
      await adapter.ready();
      return adapter;
    } catch (error) {
      throw this.mapFactoryError(error);
    }
  }

  private mapFactoryError(error: unknown) {
    if (isRuntimeError(error)) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) return makeRuntimeError("not_found", message);
    return makeRuntimeError("external", message.split("\n")[0] ?? "Pi SDK runtime creation failed", {
      cause: { kind: "backend", detail: "Pi SDK runtime creation failed" },
    });
  }
}

export function createPiSdkAgentRuntimeFactory(
  options: PiSdkAgentRuntimeFactoryOptions,
): AgentRuntimeFactory {
  return new PiSdkAgentRuntimeFactory(options);
}
