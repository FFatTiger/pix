// Public models surface of the pix Pi SDK Adapter (D3B-R1A).
//
// Read-only ModelCatalogPort backed by an offline Pi SDK model runtime. This
// module satisfies runtime-core ModelCatalogPort WITHOUT importing the Pi SDK:
// the SDK-coupled store lives in src/internal/model-store.ts. It performs sync
// catalog reads only (models.json-configured models, configured default, model
// lookup); no network, no provider calls, no discovery refresh/test/config
// writes, no credential material, no Worker/Agent.
//
// The catalog is GLOBAL (settings-cleanup product decision): it reads the
// agent-dir configuration only. Project-level model scoping is not a pix
// surface, so the factory takes no cwd.
import type {
  ModelCatalogPort,
  ModelConfigStorePort,
  ModelInfo,
  ModelMetadataFields,
  ModelRef,
  ModelSelector,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkModelStore } from "../internal/model-store.js";
import { createPiSdkModelConfigStore } from "../internal/model-config-store.js";

/**
 * Injectable read-only model store contract. The default implementation
 * (created by the internal store factory) reads the Pi SDK model catalog
 * offline; tests and composition may supply their own to exercise the catalog
 * in isolation. Every method is a pure read-only catalog read.
 */
export interface PiSdkModelStore {
  listModels(): Promise<readonly ModelInfo[]>;
  getDefaultModel(): Promise<ModelRef | null>;
  resolveModel(selector: ModelSelector): Promise<ModelInfo>;
}

/** One models.dev model row, reduced to the fields Pix can consume. */
export interface ModelsDevModelEntry {
  /** models.dev provider key (e.g. "openai", "openrouter"). */
  provider: string;
  /** Model id as addressed at that provider. */
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelMetadataFields["cost"];
}

export type ModelsDevCatalog = readonly ModelsDevModelEntry[];

export interface ModelsDevCatalogStore {
  /**
   * Current catalog snapshot. Fresh cache → served as-is. Expired cache →
   * stale entries served immediately while a single-flight background refresh
   * runs (failure keeps the old cache). No cache → one bounded foreground
   * fetch; on failure the store answers empty — it never throws.
   */
  get(): Promise<ModelsDevCatalog>;
}

/** Options for the default SDK-backed store (ignored when a store is injected). */
export interface PiSdkModelCatalogOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  readonly agentDir?: string;
  /** Injectable models.dev catalog store (tests); default is the cached fetcher. */
  readonly modelsDev?: ModelsDevCatalogStore;
}

class PiSdkModelCatalog implements ModelCatalogPort {
  constructor(private readonly store: PiSdkModelStore) {}

  listModels(): Promise<readonly ModelInfo[]> {
    return this.store.listModels();
  }

  getDefaultModel(): Promise<ModelRef | null> {
    return this.store.getDefaultModel();
  }

  resolveModel(selector: ModelSelector): Promise<ModelInfo> {
    return this.store.resolveModel(selector);
  }
}

function isModelStore(value: unknown): value is PiSdkModelStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listModels?: unknown }).listModels === "function"
  );
}

/**
 * Create a read-only ModelCatalogPort backed by the offline Pi SDK model
 * runtime. Pass an explicit {@link PiSdkModelStore} for tests/composition, or
 * {@link PiSdkModelCatalogOptions} (agentDir) to build the default
 * SDK-backed store. Reads are sync catalog access with zero network and zero
 * Workers/Agents; only `<agentDir>/models.json`-configured providers surface.
 */
export function createPiSdkModelCatalog(
  options: PiSdkModelStore | PiSdkModelCatalogOptions = {},
): ModelCatalogPort {
  const store = isModelStore(options)
    ? options
    : createPiSdkModelStore({
        ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
      });
  return new PiSdkModelCatalog(store);
}

/** Create the global credential-blind models.json editor authority. */
export function createPiSdkModelsConfig(
  options: PiSdkModelCatalogOptions = {},
): ModelConfigStorePort {
  return createPiSdkModelConfigStore({
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    ...(options.modelsDev === undefined ? {} : { modelsDev: options.modelsDev }),
  });
}
