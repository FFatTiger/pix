// Read-only model catalog store backed by the Pi SDK ModelRuntime.
//
// This is the ONLY module in the models domain that touches the Pi SDK. It
// performs sync catalog reads only — ModelRuntime.getModels / getModel — plus
// a SettingsManager read for the configured default/enabled scope.
//
// Hard read-only boundary:
//  - ModelRuntime is created with allowModelNetwork:false (the exact SDK
//    offline equivalent). create() never refreshes catalogs over the network,
//    never calls a provider, never tests/configures models.
//  - No fetch, no provider calls, no discovery/refresh/test/config writes.
//  - Returns canonical runtime-core ModelInfo/ModelRef only; never an SDK
//    Model object, cost/sampling/auth fields, or credential material.
//  - The canonical cwd is captured once at construction and threaded into
//    SettingsManager; no method re-reads process.cwd.
import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  ModelInfo,
  ModelRef,
  ModelSelector,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import type { PiSdkModelStore } from "../models/index.js";

/** Options for the SDK-backed read-only model store. */
export interface PiSdkModelStoreOptions {
  /**
   * Canonical absolute working directory for project-scoped settings
   * (default model / enabled models). Captured once; never re-read from
   * process.cwd inside the store.
   */
  cwd: string;
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /** Inject a pre-built offline ModelRuntime (tests/composition). */
  modelRuntime?: ModelRuntime;
  /** Inject a SettingsManager (tests/composition). */
  settingsManager?: SettingsManager;
}

/** Project a backend SDK Model onto the canonical backend-neutral ModelInfo. */
function toModelInfo(model: Model<Api>): ModelInfo {
  return {
    id: model.id,
    provider: model.provider,
    ...(model.name ? { displayName: model.name } : {}),
    thinking: model.reasoning,
    contextWindow: model.contextWindow,
  };
}

/**
 * Create a read-only model store backed by an offline Pi SDK ModelRuntime.
 * The runtime is created lazily (on first read) with allowModelNetwork:false
 * so no network/provider/refresh work happens at construction or during reads.
 */
export function createPiSdkModelStore(options: PiSdkModelStoreOptions): PiSdkModelStore {
  if (!options.cwd || options.cwd.trim().length === 0) {
    throw makeRuntimeError(
      "invalid_input",
      "PiSdkModelStore requires an explicit canonical cwd (no implicit process.cwd)",
    );
  }
  const agentDir = options.agentDir ?? getAgentDir();
  let cachedRuntime: ModelRuntime | undefined;
  let cachedSettings: SettingsManager | undefined;

  const runtime = async (): Promise<ModelRuntime> => {
    if (options.modelRuntime) return options.modelRuntime;
    // Lazy + offline: built once per store; allowModelNetwork:false is the
    // exact SDK equivalent that forbids network catalog refresh at create().
    cachedRuntime ??= await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    return cachedRuntime;
  };

  const settings = (): SettingsManager => {
    if (options.settingsManager) return options.settingsManager;
    cachedSettings ??= SettingsManager.create(options.cwd, agentDir);
    return cachedSettings;
  };

  return {
    async listModels(): Promise<readonly ModelInfo[]> {
      return (await runtime()).getModels().map(toModelInfo);
    },
    async getDefaultModel(): Promise<ModelRef> {
      const manager = settings();
      const provider = manager.getDefaultProvider();
      const modelId = manager.getDefaultModel();
      if (provider && modelId) return { provider, id: modelId };
      const first = (await runtime()).getModels()[0];
      if (!first) throw makeRuntimeError("not_found", "no models available");
      return { provider: first.provider, id: first.id };
    },
    async resolveModel(selector: ModelSelector): Promise<ModelInfo> {
      const model = (await runtime()).getModel(selector.provider, selector.modelId);
      if (!model) {
        throw makeRuntimeError(
          "not_found",
          `unknown model: ${selector.provider}/${selector.modelId}`,
        );
      }
      return toModelInfo(model);
    },
  };
}
