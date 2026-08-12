// Read-only model catalog store backed by the Pi SDK ModelRuntime.
//
// This is the ONLY module in the models domain that touches the Pi SDK. It
// performs sync catalog reads only — ModelRuntime.getModels / getModel — plus
// a SettingsManager read for the configured default/enabled scope.
//
// Hard read-only boundary:
//  - ModelRuntime is created with allowModelNetwork:false AND in-memory
//    credential/models stores, so create()/reads create ZERO files/dirs
//    (the SDK's file-backed stores write auth.json/models-store.json
//    placeholders; in-memory stores never touch disk).
//  - No fetch, no provider calls, no discovery/refresh/test/config writes.
//  - Returns canonical runtime-core ModelInfo/ModelRef only; never an SDK
//    Model object, cost/sampling/auth fields, or credential material.
//  - The canonical cwd is captured once and threaded into SettingsManager; no
//    method re-reads process.cwd.
import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
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
 * Resolve the enabled-model scope against the offline catalog. `undefined`/empty
 * enabledModels means all catalog models are enabled; otherwise the SDK scope
 * resolver matches the patterns offline (no network).
 */
async function enabledModels(
  manager: SettingsManager,
  runtime: ModelRuntime,
): Promise<readonly Model<Api>[]> {
  const patterns = manager.getEnabledModels();
  if (!patterns || patterns.length === 0) return runtime.getModels();
  const result = await resolveModelScopeWithDiagnostics(patterns, runtime);
  return result.scopedModels.map((entry) => entry.model);
}

/**
 * Create a read-only model store backed by an offline Pi SDK ModelRuntime. The
 * runtime is created lazily (on first read) with allowModelNetwork:false and
 * in-memory stores, so no network/provider/refresh work and ZERO file writes
 * happen at construction or during reads.
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
    // Lazy + offline + zero-write: in-memory credential/models stores so
    // create() never writes auth.json/models-store.json placeholders.
    cachedRuntime ??= await ModelRuntime.create({
      allowModelNetwork: false,
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      // Pin models.json resolution to the (possibly injected) agentDir so the
      // SDK never falls back to the real ~/.pi/agent/models.json. An
      // empty/missing injected agentDir yields NO custom provider/model
      // config — global user config cannot leak into the isolated catalog.
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
    async getDefaultModel(): Promise<ModelRef | null> {
      const instance = await runtime();
      const manager = settings();
      const allModels = instance.getModels();
      const enabled = await enabledModels(manager, instance);
      const inEnabled = (provider: string, id: string): boolean =>
        enabled.some((model) => model.provider === provider && model.id === id);

      // Configured default: valid only if it exists in the catalog AND is in
      // the enabled scope. Invalid/missing/disabled falls back deterministically.
      const provider = manager.getDefaultProvider();
      const modelId = manager.getDefaultModel();
      if (provider && modelId && inEnabled(provider, modelId)) {
        const exists = allModels.some(
          (model) => model.provider === provider && model.id === modelId,
        );
        if (exists) return { provider, id: modelId };
      }
      // Fallback: first enabled valid model, else null.
      const first = enabled[0];
      return first ? { provider: first.provider, id: first.id } : null;
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
