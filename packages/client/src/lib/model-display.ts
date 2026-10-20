/** Short display form of a model id: the segment after the last "/". */
export function shortModelName(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/**
 * Display label of the model that answered a message, resolved exactly like
 * the reply footer: `provider:model` name → model-id name → the raw id. Shared
 * so the model-switch divider and the reply footer can never disagree.
 */
export function resolveModelLabel(
  modelNames: Record<string, string> | undefined,
  provider: string,
  model: string,
): string {
  return modelNames?.[`${provider}:${model}`] ?? modelNames?.[model] ?? model;
}

/** Catalog entry shape the pickers/composer already project (`name` = label). */
export interface ModelCatalogEntry {
  provider: string;
  id: string;
  name: string;
}

/**
 * The one `modelNames` map every model label reads: `provider:model` → display
 * name, plus the bare `model` key the footer falls back to. Built from the
 * global catalog so the composer label, the reply footer and the model-switch
 * divider always render identical names.
 */
export function buildModelNameMap(models: readonly ModelCatalogEntry[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const model of models) names[`${model.provider}:${model.id}`] = model.name;
  return names;
}
