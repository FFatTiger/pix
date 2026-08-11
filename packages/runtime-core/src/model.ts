/**
 * Canonical model DTOs — normalized model identity, selectors and catalog
 * entries. Never references SDK `Model` objects.
 */

export interface ModelRef {
  id: string;
  provider: string;
}

/** Create / set-model payload: provider + modelId. */
export interface ModelSelector {
  provider: string;
  modelId: string;
}

/** Catalog entry for a selectable model. */
export interface ModelInfo {
  id: string;
  provider: string;
  displayName?: string;
  /** Whether the model supports visible reasoning. */
  thinking?: boolean;
  contextWindow?: number;
}
