// Read-only model catalog store backed by the Pi SDK ModelRuntime.
//
// This is the ONLY module in the models domain that touches the Pi SDK. It
// performs sync catalog reads only — getModels / getModel — plus a
// SettingsManager read for the configured default/enabled scope.
//
// Catalog scope (settings-cleanup product decision):
//  - GLOBAL, not project-scoped. The catalog lists the operator's agent-dir
//    configuration (`<agentDir>/models.json` providers intersected with the
//    global `enabledModels`/default from `<agentDir>/settings.json`). Pi's
//    project-level `.pi/settings.json` model overrides are NOT a pix surface;
//    a read-only SDK SettingsManager storage exposes only the global file and
//    withholds the project scope entirely.
//  - ONLY models.json-configured providers surface. Stored auth.json
//    credentials or environment keys for built-in providers do NOT add
//    catalog rows — the config file is the source of truth.
//
// Hard read-only boundary:
//  - ModelRuntime is created with allowModelNetwork:false AND in-memory
//    credential/models stores, so create()/reads create ZERO files/dirs
//    (the SDK's file-backed stores write auth.json/models-store.json
//    placeholders; in-memory stores never touch disk).
//  - No fetch, no provider calls, no discovery/refresh/test/config writes.
//  - Returns canonical runtime-core ModelInfo/ModelRef only; never an SDK
//    Model object, cost/sampling/auth fields, or credential material.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, ModelRuntime, resolveModelScopeWithDiagnostics, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  ModelInfo,
  ModelRef,
  ModelSelector,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { readConfiguredProviderIds } from "./models-json.js";
import type { PiSdkModelStore } from "../models/index.js";

/** Options for the SDK-backed read-only model store. */
export interface PiSdkModelStoreOptions {
  /**
   * Agent config directory; defaults to the SDK agent dir. The catalog is
   * global: models.json (provider/model identities) and settings.json
   * (default/enabled scope) are both read from here.
   */
  agentDir?: string;
  /** Inject a pre-built offline ModelRuntime (tests/composition). */
  modelRuntime?: ModelRuntime;
  /** Inject a SettingsManager (tests). */
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
 * Models that belong to providers explicitly configured in models.json. This
 * is the picker surface: never dump builtin providers the operator did not
 * configure, even when stored credentials or environment keys would make
 * them "available" to the SDK.
 */
async function configuredModels(
  runtime: ModelRuntime,
  allowedProviders: ReadonlySet<string>,
): Promise<readonly Model<Api>[]> {
  if (allowedProviders.size === 0) return [];
  return runtime.getModels().filter((model) => allowedProviders.has(model.provider));
}

/**
 * Resolve the enabled-model scope against models.json-configured models.
 * `undefined`/empty enabledModels means all configured models are enabled;
 * otherwise the SDK scope resolver matches the patterns offline (no network).
 * A pattern set that matches nothing stays empty — it never falls back to
 * builtin providers.
 */
async function enabledModels(
  manager: SettingsManager,
  runtime: ModelRuntime,
  allowedProviders: ReadonlySet<string>,
): Promise<readonly Model<Api>[]> {
  const configured = await configuredModels(runtime, allowedProviders);
  const patterns = manager.getEnabledModels();
  if (!patterns || patterns.length === 0) return configured;
  const result = await resolveModelScopeWithDiagnostics(patterns, runtime);
  const configuredKeys = new Set(configured.map((model) => `${model.provider}\0${model.id}`));
  return result.scopedModels
    .map((entry) => entry.model)
    .filter((model) => configuredKeys.has(`${model.provider}\0${model.id}`));
}

function assertGlobalModelSettings(manager: SettingsManager): void {
  const settings: unknown = manager.getGlobalSettings();
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw makeRuntimeError("invalid_input", "global model settings are invalid");
  }
  const record = settings as Record<string, unknown>;
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    const value = record[key];
    if (value !== undefined && typeof value !== "string") {
      throw makeRuntimeError("invalid_input", "global model settings are invalid");
    }
  }
  const enabled = record.enabledModels;
  if (
    enabled !== undefined
    && (!Array.isArray(enabled) || enabled.some((pattern) => typeof pattern !== "string"))
  ) {
    throw makeRuntimeError("invalid_input", "global model settings are invalid");
  }
}

/**
 * Create a read-only model store backed by an offline Pi SDK ModelRuntime. The
 * runtime is created lazily (on first read) with allowModelNetwork:false and
 * in-memory stores, so no network/provider/refresh work and ZERO file writes
 * happen at construction or during reads.
 */
export function createPiSdkModelStore(options: PiSdkModelStoreOptions = {}): PiSdkModelStore {
  const agentDir = options.agentDir ?? getAgentDir();
  let cachedRuntime: ModelRuntime | undefined;
  let cachedSettings: SettingsManager | undefined;
  let cachedAllowed: Promise<ReadonlySet<string>> | undefined;

  const runtime = async (): Promise<ModelRuntime> => {
    const instance = options.modelRuntime ?? cachedRuntime ?? await ModelRuntime.create({
      allowModelNetwork: false,
      // Empty in-memory credentials: catalog membership is models.json-only;
      // auth.json/environment credentials must never add rows and need not be
      // read at all. Provider model definitions compose without auth checks.
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      // Pin models.json resolution to the (possibly injected) agentDir so the
      // SDK never falls back to the real ~/.pi/agent/models.json. An
      // empty/missing injected agentDir yields NO custom provider/model
      // config — global user config cannot leak into the isolated catalog.
      modelsPath: join(agentDir, "models.json"),
    });
    // ModelRuntime reports schema/composition failures through getError() and
    // otherwise keeps a fallback catalog. Serving that fallback as success
    // would turn malformed config into a fake empty/partial catalog.
    if (instance.getError()) {
      throw makeRuntimeError("invalid_input", "model configuration is invalid");
    }
    cachedRuntime ??= instance;
    return instance;
  };

  const settings = (): SettingsManager => {
    if (options.settingsManager) {
      assertGlobalModelSettings(options.settingsManager);
      return options.settingsManager;
    }
    if (cachedSettings) return cachedSettings;

    // Global-only read through the SDK SettingsManager: expose exactly
    // `<agentDir>/settings.json` as the global scope and withhold project
    // settings entirely. This preserves Pi's parsing/migration semantics
    // without inventing a fake cwd or reading `<cwd>/.pi/settings.json`.
    const storage = {
      withLock(
        scope: "global" | "project",
        read: (current: string | undefined) => string | undefined,
      ): void {
        if (scope === "project") {
          read(undefined);
          return;
        }
        let current: string | undefined;
        try {
          current = readFileSync(join(agentDir, "settings.json"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const write = read(current);
        if (write !== undefined) {
          throw new Error("global model settings storage is read-only");
        }
      },
    };
    const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
    const errors = manager.drainErrors();
    if (errors.length > 0) {
      const code = (errors[0]?.error as NodeJS.ErrnoException | undefined)?.code;
      throw makeRuntimeError(
        code === undefined ? "invalid_input" : "unavailable",
        "global model settings could not be read",
      );
    }
    // SettingsManager is runtime-unvalidated TypeScript data. Validate every
    // field this catalog consumes before enabledModels can be treated as an
    // iterable or wrong-type defaults can silently fall back.
    assertGlobalModelSettings(manager);
    cachedSettings = manager;
    return manager;
  };

  const allowedProviders = (): Promise<ReadonlySet<string>> => {
    // The config-file filter is ALWAYS read from the agent dir on disk —
    // injected runtimes/settings do not bypass it.
    cachedAllowed ??= readConfiguredProviderIds(agentDir);
    return cachedAllowed;
  };

  return {
    async listModels(): Promise<readonly ModelInfo[]> {
      const allowed = await allowedProviders();
      const instance = await runtime();
      return (await enabledModels(settings(), instance, allowed)).map(toModelInfo);
    },
    async getDefaultModel(): Promise<ModelRef | null> {
      const allowed = await allowedProviders();
      const instance = await runtime();
      const manager = settings();
      const enabled = await enabledModels(manager, instance, allowed);
      const inEnabled = (provider: string, id: string): boolean =>
        enabled.some((model) => model.provider === provider && model.id === id);

      // Configured default: valid only if it is a models.json-configured
      // model AND in the enabled scope. Invalid/missing/disabled falls back
      // deterministically.
      const provider = manager.getDefaultProvider();
      const modelId = manager.getDefaultModel();
      if (provider && modelId && inEnabled(provider, modelId)) {
        const exists = (await configuredModels(instance, allowed)).some(
          (model) => model.provider === provider && model.id === modelId,
        );
        if (exists) return { provider, id: modelId };
      }
      // Fallback: first enabled configured model, else null.
      const first = enabled[0];
      return first ? { provider: first.provider, id: first.id } : null;
    },
    async resolveModel(selector: ModelSelector): Promise<ModelInfo> {
      // Unrestricted lookup helper (validation of concrete selectors, e.g.
      // a session pinned to a builtin model); catalog SCOPING lives in
      // listModels/getDefaultModel above.
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
