// Public models surface of the pix Pi SDK Adapter (D3B-R1A).
//
// Read-only ModelCatalogPort backed by an offline Pi SDK model runtime. This
// module satisfies runtime-core ModelCatalogPort WITHOUT importing the Pi SDK:
// the SDK-coupled store lives in src/internal/model-store.ts. It performs sync
// catalog reads only (last-known models, configured default, model lookup); no
// network, no provider calls, no discovery refresh/test/config writes, no
// credential material, no Worker/Agent.
import type {
  ModelCatalogPort,
  ModelInfo,
  ModelRef,
  ModelSelector,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkModelStore } from "../internal/model-store.js";

/**
 * Injectable read-only model store contract. The default implementation
 * (created by the internal store factory) reads the Pi SDK model catalog
 * offline; tests and composition may supply their own to exercise the catalog
 * in isolation. Every method is a pure read-only catalog read.
 */
export interface PiSdkModelStore {
  listModels(): Promise<readonly ModelInfo[]>;
  getDefaultModel(): Promise<ModelRef>;
  resolveModel(selector: ModelSelector): Promise<ModelInfo>;
}

/** Options for the default SDK-backed store (ignored when a store is injected). */
export interface PiSdkModelCatalogOptions {
  /**
   * Canonical absolute working directory for project-scoped settings (default
   * model / enabled models). Defaults to process.cwd(); captured once at the
   * boundary and never re-read inside the store.
   */
  readonly cwd?: string;
  /** Agent config directory; defaults to the SDK agent dir. */
  readonly agentDir?: string;
}

class PiSdkModelCatalog implements ModelCatalogPort {
  constructor(private readonly store: PiSdkModelStore) {}

  listModels(): Promise<readonly ModelInfo[]> {
    return this.store.listModels();
  }

  getDefaultModel(): Promise<ModelRef> {
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
 * {@link PiSdkModelCatalogOptions} (cwd/agentDir) to build the default SDK-backed
 * store. Reads are sync catalog access with zero network and zero
 * Workers/Agents.
 */
export function createPiSdkModelCatalog(
  storeOrOptions: PiSdkModelStore | PiSdkModelCatalogOptions = {
    cwd: process.cwd(),
  },
): ModelCatalogPort {
  const store = isModelStore(storeOrOptions)
    ? storeOrOptions
    : createPiSdkModelStore({
        cwd: storeOrOptions.cwd ?? process.cwd(),
        ...(storeOrOptions.agentDir === undefined
          ? {}
          : { agentDir: storeOrOptions.agentDir }),
      });
  return new PiSdkModelCatalog(store);
}
