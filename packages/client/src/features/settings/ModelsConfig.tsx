import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import type {
  AvailableModelProvider,
  DiscoveredModelConfig,
  EditableModelConfig,
  EditableProviderConfig,
  ModelConfigApi,
  ModelConfigApiKeyMutation,
  ModelsConfigMutation,
  ModelsConfigResponse,
} from "@fffattiger/pix-protocol";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { ProviderIcon } from "@/components/chat/ProviderIcon";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import {
  SettingsButton,
  SettingsField,
  SettingsInput,
  SettingsNumInput,
  SettingsSecretInput,
  SettingsSection,
  SettingsSelect,
} from "./settings-ui";

const API_OPTIONS: readonly ModelConfigApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

type Selection =
  | { type: "provider"; providerKey: string }
  | { type: "model"; providerKey: string; modelKey: string };

interface DraftModel extends Omit<EditableModelConfig, "id"> {
  key: string;
  id: string;
}

interface DraftProvider extends Omit<EditableProviderConfig, "id" | "models"> {
  key: string;
  id: string;
  models: DraftModel[];
  apiKeyValue: string;
  apiKeyMutation: ModelConfigApiKeyMutation["mode"];
}

function draftFromSnapshot(snapshot: ModelsConfigResponse): DraftProvider[] {
  return snapshot.providers.map((provider, providerIndex) => ({
    ...provider,
    key: `${provider.sourceId ?? "new"}:${providerIndex}`,
    models: provider.models.map((model, modelIndex) => ({
      ...model,
      key: `${provider.sourceId ?? "new"}:${model.sourceIndex ?? `new-${modelIndex}`}`,
    })),
    apiKeyValue: "",
    apiKeyMutation: provider.apiKeyConfigured ? "preserve" : "remove",
  }));
}

function mutationFromDraft(revision: string, providers: DraftProvider[]): ModelsConfigMutation {
  return {
    expectedRevision: revision,
    providers: providers.map((provider) => ({
      sourceId: provider.sourceId,
      id: provider.id,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.api ? { api: provider.api } : {}),
      apiKey: provider.apiKeyMutation === "replace"
        ? { mode: "replace", value: provider.apiKeyValue }
        : { mode: provider.apiKeyMutation },
      modelsDefined: provider.modelsDefined,
      models: provider.models.map(({ key: _key, ...model }) => ({
        ...model,
        id: model.id,
      })),
    })),
  };
}

function describeModelsConfigError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof HttpError) {
    if (error.code === "CONFLICT") return t("desktop.modelsConfigurationChanged");
    if (error.code === "INVALID_INPUT" || error.code === "INVALID_MODELS_CONFIG") return t("desktop.modelsInvalidConfiguration");
    if (error.kind === "network") return t("desktop.modelsNetworkUnavailable");
    if (error.kind === "timeout") return t("desktop.modelsRequestTimedOut");
  }
  return t("desktop.modelsConfigUnavailable");
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: "var(--text-dim)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
      {children}
    </div>
  );
}

function SecretInput({
  provider,
  onChange,
}: {
  provider: DraftProvider;
  onChange: (patch: Partial<DraftProvider>) => void;
}) {
  const { t } = useI18n();
  const placeholder = provider.apiKeyConfigured && provider.apiKeyMutation === "preserve"
    ? "••••••••••••••••••••••••••••••••"
    : t("desktop.modelsApiKeyPlaceholder");
  return (
    <SettingsSecretInput
      value={provider.apiKeyValue}
      placeholder={placeholder}
      mono
      showLabel={t("desktop.modelsShowApiKey")}
      hideLabel={t("desktop.modelsHideApiKey")}
      onChange={(value) => onChange({
        apiKeyValue: value,
        apiKeyMutation: value ? "replace" : provider.apiKeyConfigured ? "preserve" : "remove",
      })}
    />
  );
}

function ProviderDetail({
  provider,
  revision,
  onChange,
  onDelete,
  onAddModels,
}: {
  provider: DraftProvider;
  revision: string;
  onChange: (patch: Partial<DraftProvider>) => void;
  onDelete: () => void;
  onAddModels: (models: readonly DiscoveredModelConfig[]) => void;
}) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const discovery = useMutation(createMutationOptions(http, queryClient).models.discover());
  const [selected, setSelected] = useState<string[]>([]);
  const existing = useMemo(() => new Set(provider.models.map((model) => model.id)), [provider.models]);

  useEffect(() => {
    discovery.reset();
    setSelected([]);
  }, [provider.key, provider.id, provider.baseUrl, provider.api, provider.apiKeyValue]);

  return (
    <div className="models-detail-page">
      <SettingsSection
        title={provider.id || t("desktop.modelsProvider")}
        description={t("desktop.modelsProviderDescription")}
        action={<SettingsButton variant="danger" size="sm" onClick={onDelete}>{t("desktop.delete")}</SettingsButton>}
      >
        <div className="models-settings-fields">
          <SettingsField label={t("desktop.modelsProviderName")}>
            <SettingsInput value={provider.id} onChange={(id) => onChange({ id })} placeholder="provider-name" mono />
          </SettingsField>
          <SettingsField label={t("desktop.modelsApi")}>
            <SettingsSelect
              value={provider.api ?? "openai-completions"}
              onChange={(api) => onChange({ api: api as ModelConfigApi })}
              options={provider.api && !API_OPTIONS.includes(provider.api as (typeof API_OPTIONS)[number])
                ? [provider.api, ...API_OPTIONS]
                : API_OPTIONS}
            />
          </SettingsField>
          <SettingsField label={t("desktop.modelsBaseUrl")}>
            <SettingsInput
              value={provider.baseUrl ?? ""}
              onChange={(baseUrl) => onChange({ baseUrl: baseUrl || undefined })}
              placeholder="https://api.example.com/v1"
              mono
            />
          </SettingsField>
          <SettingsField label={t("desktop.modelsApiKey")}>
            <SecretInput provider={provider} onChange={onChange} />
            <div className="models-secret-meta">
              <span className="models-field-hint">{t("desktop.modelsApiKeyHelp")}</span>
              {provider.apiKeyConfigured ? (
                <SettingsButton
                  size="sm"
                  variant={provider.apiKeyMutation === "remove" ? "default" : "danger"}
                  onClick={() => onChange({
                    apiKeyValue: "",
                    apiKeyMutation: provider.apiKeyMutation === "remove" ? "preserve" : "remove",
                  })}
                >
                  {provider.apiKeyMutation === "remove" ? t("desktop.modelsKeepStoredKey") : t("desktop.modelsRemoveStoredKey")}
                </SettingsButton>
              ) : null}
            </div>
          </SettingsField>
        </div>
      </SettingsSection>

      <SettingsSection title={t("desktop.modelsImportModels")} description={t("desktop.modelsImportDescription")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <SettingsButton
            disabled={!provider.baseUrl?.trim() || discovery.isPending}
            onClick={() => discovery.mutate({
              expectedRevision: revision,
              sourceId: provider.sourceId,
              providerId: provider.id,
              baseUrl: provider.baseUrl!,
              api: provider.api ?? "openai-completions",
              ...(provider.apiKeyMutation === "replace" && provider.apiKeyValue ? { apiKey: provider.apiKeyValue } : {}),
            })}
            style={{ alignSelf: "flex-start" }}
          >
            {discovery.isPending ? t("desktop.modelsImportingModels") : t("desktop.modelsImportModels")}
          </SettingsButton>
          {discovery.isError ? <p className="workspace-hint workspace-hint--error" role="alert">{describeModelsConfigError(discovery.error, t)}</p> : null}
          {discovery.data ? (
            <>
              <div className="models-discovery-list">
                {discovery.data.models.map((model) => {
                  const added = existing.has(model.id);
                  const checked = added || selected.includes(model.id);
                  return (
                    <label key={model.id}>
                      <input type="checkbox" checked={checked} disabled={added} onChange={() => setSelected((current) => current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id])} />
                      <span><strong>{model.name ?? model.id}</strong>{model.name ? <small>{model.id}</small> : null}</span>
                      {added ? <small>{t("desktop.modelsImportAdded")}</small> : null}
                    </label>
                  );
                })}
              </div>
              <SettingsButton
                variant="primary"
                disabled={selected.length === 0}
                onClick={() => {
                  onAddModels(discovery.data!.models.filter((model) => selected.includes(model.id)));
                  setSelected([]);
                }}
                style={{ alignSelf: "flex-end" }}
              >
                {selected.length ? t("desktop.modelsImportAddSelectedCount", { count: selected.length }) : t("desktop.modelsImportAddSelected")}
              </SettingsButton>
            </>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}

function numberValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function ModelDetail({
  model,
  onChange,
  onDelete,
}: {
  model: DraftModel;
  onChange: (patch: Partial<DraftModel>) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const updateCost = (key: "input" | "output" | "cacheRead" | "cacheWrite", value: string) => {
    const parsed = value === "" ? undefined : Number(value);
    const cost = { ...(model.cost ?? {}), [key]: Number.isFinite(parsed) ? parsed : undefined };
    for (const costKey of Object.keys(cost) as (keyof typeof cost)[]) {
      if (cost[costKey] === undefined) delete cost[costKey];
    }
    onChange({ cost: Object.keys(cost).length ? cost : undefined });
  };
  return (
    <div className="models-detail-page">
      <SettingsSection
        title={model.name || model.id || t("desktop.modelsNewModel")}
        description={t("desktop.modelsModelDescription")}
        action={<SettingsButton variant="danger" size="sm" onClick={onDelete}>{t("desktop.modelsRemove")}</SettingsButton>}
      >
        <div className="models-settings-fields">
          <SettingsField label={t("desktop.modelsIdRequired")}>
            <SettingsInput value={model.id} onChange={(id) => onChange({ id })} mono />
          </SettingsField>
          <SettingsField label={t("desktop.modelsName")}>
            <SettingsInput value={model.name ?? ""} onChange={(name) => onChange({ name: name || undefined })} placeholder={t("desktop.modelsDisplayName")} />
          </SettingsField>
          <SettingsField label={t("desktop.modelsApiOverride")}>
            <SettingsSelect
              value={model.api ?? ""}
              onChange={(api) => onChange({ api: (api || undefined) as ModelConfigApi | undefined })}
              emptyLabel={t("desktop.modelsInheritNone")}
              options={model.api && !API_OPTIONS.includes(model.api as (typeof API_OPTIONS)[number])
                ? [model.api, ...API_OPTIONS]
                : API_OPTIONS}
            />
          </SettingsField>
          <div className="models-check-row">
            <label className="models-check"><input type="checkbox" checked={model.reasoning ?? false} onChange={(event) => onChange({ reasoning: event.target.checked || undefined })} />{t("desktop.modelsReasoningThinking")}</label>
            <label className="models-check"><input type="checkbox" checked={model.input?.includes("image") ?? false} onChange={(event) => onChange({ input: event.target.checked ? ["text", "image"] : undefined })} />{t("desktop.modelsImageInput")}</label>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t("desktop.modelsLimitsAndCost")} description={t("desktop.modelsLimitsDescription")}>
        <div className="models-form-grid">
          <SettingsField label={t("desktop.modelsContextWindow")}>
            <SettingsNumInput value={numberValue(model.contextWindow)} min={1} onChange={(value) => onChange({ contextWindow: value ? Number(value) : undefined })} />
          </SettingsField>
          <SettingsField label={t("desktop.modelsMaxOutputTokens")}>
            <SettingsNumInput value={numberValue(model.maxTokens)} min={1} onChange={(value) => onChange({ maxTokens: value ? Number(value) : undefined })} />
          </SettingsField>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          <SectionTitle>{t("desktop.modelsCostPerMillionTokens")}</SectionTitle>
          <div className="models-cost-grid">
            {(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => (
              <SettingsField key={key} label={t({ input: "desktop.modelsCostInput", output: "desktop.modelsCostOutput", cacheRead: "desktop.modelsCostCacheRead", cacheWrite: "desktop.modelsCostCacheWrite" }[key])}>
                <SettingsNumInput value={numberValue(model.cost?.[key])} min={0} step="any" onChange={(value) => updateCost(key, value)} />
              </SettingsField>
            ))}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function ProviderPicker({
  providers,
  configuredIds,
  onAddCustom,
  onAddBuiltin,
  onClose,
}: {
  providers: readonly AvailableModelProvider[];
  configuredIds: ReadonlySet<string>;
  onAddCustom: () => void;
  onAddBuiltin: (provider: AvailableModelProvider) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const normalized = search.trim().toLocaleLowerCase();
  const matches = useCallback((provider: AvailableModelProvider) => !normalized
    || provider.id.toLocaleLowerCase().includes(normalized)
    || provider.name.toLocaleLowerCase().includes(normalized), [normalized]);
  const available = providers.filter((provider) => !configuredIds.has(provider.id) && matches(provider));
  const subscriptions = available.filter((provider) => provider.methods.includes("oauth"));
  const apiKey = available.filter((provider) => provider.methods.includes("apiKey"));
  const showCustom = !normalized || "custom openai anthropic compatible".includes(normalized);

  const card = (provider: AvailableModelProvider, oauthOnly = false) => (
    <button
      key={provider.id}
      type="button"
      disabled={oauthOnly}
      title={oauthOnly ? t("desktop.modelsOAuthUnavailable") : undefined}
      onClick={() => { onAddBuiltin(provider); onClose(); }}
      className="models-provider-card"
      style={oauthOnly ? { opacity: 0.72, cursor: "not-allowed" } : undefined}
    >
      <span style={{ minWidth: 0, flex: 1 }}>
        <strong>{provider.name}</strong>
        <small>{oauthOnly ? "OAuth" : t("desktop.modelsCount", { count: provider.modelCount })}</small>
      </span>
      <ProviderIcon id={provider.id} size={28} />
    </button>
  );

  return (
    <div className="models-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="models-provider-picker" role="dialog" aria-modal="true" aria-label={t("desktop.modelsAddProvider")}>
        <div className="models-provider-search">
          <MagnifyingGlass size={14} />
          <input ref={inputRef} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} placeholder={t("desktop.modelsSearchProviders")} />
          <button type="button" onClick={onClose} aria-label={t("desktop.close")}><X size={15} /></button>
        </div>
        <div className="models-provider-picker-scroll">
          {showCustom ? (
            <div className="models-provider-group">
              <SectionTitle>{t("desktop.modelsCustom")}</SectionTitle>
              <button type="button" className="models-provider-card" onClick={() => { onAddCustom(); onClose(); }}>
                <span style={{ minWidth: 0, flex: 1 }}><strong>{t("desktop.modelsCompatibleProvider")}</strong><small>{t("desktop.modelsCustomEndpointFormat")}</small></span>
                <span className="models-provider-add-icon"><Plus size={14} /></span>
              </button>
            </div>
          ) : null}
          {subscriptions.length ? (
            <div className="models-provider-group">
              <SectionTitle>{t("desktop.modelsSubscriptions")}</SectionTitle>
              <div className="models-provider-grid">{subscriptions.map((provider) => card(provider, true))}</div>
            </div>
          ) : null}
          {apiKey.length ? (
            <div className="models-provider-group">
              <SectionTitle>{t("desktop.modelsApiKey")}</SectionTitle>
              <div className="models-provider-grid">{apiKey.map((provider) => card(provider))}</div>
            </div>
          ) : null}
          {!showCustom && subscriptions.length === 0 && apiKey.length === 0 ? <p className="workspace-hint">{t("desktop.modelsNoProvidersMatch")}</p> : null}
        </div>
      </section>
    </div>
  );
}

function ModelsEditor({ snapshot, onCloseAction }: { snapshot: ModelsConfigResponse; onCloseAction: () => void }) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [revision, setRevision] = useState(snapshot.revision);
  const [providers, setProviders] = useState<DraftProvider[]>(() => draftFromSnapshot(snapshot));
  const [selection, setSelection] = useState<Selection | null>(() => {
    const first = draftFromSnapshot(snapshot)[0];
    return first ? { type: "provider", providerKey: first.key } : null;
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const save = useMutation(createMutationOptions(http, queryClient).models.saveConfig());

  const reset = useCallback((next: ModelsConfigResponse) => {
    const drafts = draftFromSnapshot(next);
    setRevision(next.revision);
    setProviders(drafts);
    setSelection(drafts[0] ? { type: "provider", providerKey: drafts[0].key } : null);
  }, []);

  useEffect(() => reset(snapshot), [reset, snapshot]);

  const selectedProvider = selection
    ? providers.find((provider) => provider.key === selection.providerKey)
    : undefined;
  const selectedModel = selection?.type === "model"
    ? selectedProvider?.models.find((model) => model.key === selection.modelKey)
    : undefined;

  const updateProvider = (key: string, patch: Partial<DraftProvider>) => {
    setProviders((current) => current.map((provider) => provider.key === key ? { ...provider, ...patch } : provider));
  };
  const removeProvider = (key: string) => {
    setProviders((current) => {
      const next = current.filter((provider) => provider.key !== key);
      const first = next[0];
      setSelection(first ? { type: "provider", providerKey: first.key } : null);
      return next;
    });
  };
  const addCustom = () => {
    const ids = new Set(providers.map((provider) => provider.id));
    let id = "new-provider";
    let suffix = 1;
    while (ids.has(id)) id = `new-provider-${suffix++}`;
    const provider: DraftProvider = {
      key: `new:${crypto.randomUUID()}`,
      sourceId: null,
      id,
      api: "openai-completions",
      apiKeyConfigured: false,
      apiKeyValue: "",
      apiKeyMutation: "remove",
      modelsDefined: false,
      models: [],
    };
    setProviders((current) => [...current, provider]);
    setSelection({ type: "provider", providerKey: provider.key });
  };
  const addBuiltin = (available: AvailableModelProvider) => {
    if (providers.some((provider) => provider.id === available.id)) return;
    const provider: DraftProvider = {
      key: `new:${crypto.randomUUID()}`,
      sourceId: null,
      id: available.id,
      apiKeyConfigured: false,
      apiKeyValue: "",
      apiKeyMutation: "remove",
      modelsDefined: false,
      models: [],
    };
    setProviders((current) => [...current, provider]);
    setSelection({ type: "provider", providerKey: provider.key });
  };
  const addDiscoveredModels = (providerKey: string, discovered: readonly DiscoveredModelConfig[]) => {
    setProviders((current) => current.map((provider) => {
      if (provider.key !== providerKey) return provider;
      const ids = new Set(provider.models.map((model) => model.id));
      const additions = discovered
        .filter((model) => !ids.has(model.id))
        .map((model) => ({
          key: `new:${crypto.randomUUID()}`,
          sourceIndex: null,
          id: model.id,
          ...(model.name === undefined ? {} : { name: model.name }),
        }));
      return additions.length ? { ...provider, modelsDefined: true, models: [...provider.models, ...additions] } : provider;
    }));
  };
  const addModel = (providerKey: string) => {
    const model: DraftModel = { key: `new:${crypto.randomUUID()}`, sourceIndex: null, id: "" };
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, modelsDefined: true, models: [...provider.models, model] }
      : provider));
    setSelection({ type: "model", providerKey, modelKey: model.key });
  };
  const updateModel = (providerKey: string, modelKey: string, patch: Partial<DraftModel>) => {
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, models: provider.models.map((model) => model.key === modelKey ? { ...model, ...patch } : model) }
      : provider));
  };
  const removeModel = (providerKey: string, modelKey: string) => {
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, models: provider.models.filter((model) => model.key !== modelKey) }
      : provider));
    setSelection({ type: "provider", providerKey });
  };

  const validationError = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (!provider.id.trim()) return t("desktop.modelsProviderNameRequired");
      if (ids.has(provider.id)) return t("desktop.modelsProviderDuplicate", { provider: provider.id });
      ids.add(provider.id);
      const modelIds = new Set<string>();
      for (const model of provider.models) {
        if (!model.id.trim()) return t("desktop.modelsModelIdRequired");
        if (modelIds.has(model.id)) return t("desktop.modelsModelDuplicate", { model: model.id });
        modelIds.add(model.id);
      }
      const hasApiKey = provider.apiKeyMutation === "replace" ? Boolean(provider.apiKeyValue.trim()) : provider.apiKeyConfigured && provider.apiKeyMutation === "preserve";
      if (provider.sourceId === null && !provider.baseUrl && !hasApiKey && provider.models.length === 0) {
        return t("desktop.modelsProviderIncomplete", { provider: provider.id });
      }
    }
    return null;
  }, [providers, t]);

  const configuredIds = useMemo(() => new Set(providers.map((provider) => provider.id)), [providers]);

  return (
    <div className="models-config-shell">
      <div className="models-config-body">
        <aside className="models-tree">
          <div className="models-tree-heading">{t("desktop.models")}</div>
          <div className="models-tree-scroll">
            {providers.map((provider) => {
              const providerSelected = selection?.type === "provider" && selection.providerKey === provider.key;
              return (
                <div key={provider.key} className="models-tree-group">
                  <button type="button" className={`models-tree-provider${providerSelected ? " is-selected" : ""}`} onClick={() => setSelection({ type: "provider", providerKey: provider.key })}>
                    <ProviderIcon id={provider.id} {...(provider.api === undefined ? {} : { api: provider.api })} size={14} />
                    <span className="models-tree-label">{provider.id || t("desktop.modelsProvider")}</span>
                  </button>
                  {provider.models.map((model) => {
                    const selected = selection?.type === "model" && selection.providerKey === provider.key && selection.modelKey === model.key;
                    return (
                      <button key={model.key} type="button" className={`models-tree-model${selected ? " is-selected" : ""}`} onClick={() => setSelection({ type: "model", providerKey: provider.key, modelKey: model.key })}>
                        <span className="models-tree-label">{model.id || t("desktop.modelsNewModel")}</span>
                        {model.reasoning ? <small>T</small> : null}
                      </button>
                    );
                  })}
                  <button type="button" className="models-tree-add-model" onClick={() => addModel(provider.key)}>{t("desktop.modelsAddModel")}</button>
                </div>
              );
            })}
          </div>
          <div className="models-tree-footer">
            <SettingsButton onClick={() => setPickerOpen(true)} style={{ width: "100%" }}><Plus size={13} />{t("desktop.modelsAddProvider").replace(/^\+\s*/, "")}</SettingsButton>
          </div>
        </aside>
        <main className="models-detail">
          {selectedProvider && selection?.type === "provider" ? (
            <ProviderDetail
              provider={selectedProvider}
              revision={revision}
              onChange={(patch) => updateProvider(selectedProvider.key, patch)}
              onDelete={() => removeProvider(selectedProvider.key)}
              onAddModels={(models) => addDiscoveredModels(selectedProvider.key, models)}
            />
          ) : selectedProvider && selectedModel && selection?.type === "model" ? (
            <ModelDetail model={selectedModel} onChange={(patch) => updateModel(selectedProvider.key, selectedModel.key, patch)} onDelete={() => removeModel(selectedProvider.key, selectedModel.key)} />
          ) : (
            <div className="models-empty-detail">{t("desktop.modelsSelectProviderOrModel")}</div>
          )}
        </main>
      </div>
      <footer className="models-config-footer">
        <span role={save.isError || validationError ? "alert" : undefined} className="models-save-status">
          {validationError ?? (save.isError ? describeModelsConfigError(save.error, t) : save.isSuccess ? t("desktop.modelsSaved") : "")}
        </span>
        <SettingsButton onClick={onCloseAction}>{t("desktop.cancel")}</SettingsButton>
        <SettingsButton
          variant="primary"
          disabled={Boolean(validationError) || save.isPending}
          onClick={() => save.mutate(mutationFromDraft(revision, providers), { onSuccess: reset })}
          style={{ minWidth: 92 }}
        >
          {save.isPending ? t("desktop.modelsSaving") : t("desktop.modelsSave")}
        </SettingsButton>
      </footer>
      {pickerOpen ? <ProviderPicker providers={snapshot.availableProviders} configuredIds={configuredIds} onAddCustom={addCustom} onAddBuiltin={addBuiltin} onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}

export function ModelsConfig({ onCloseAction }: { onCloseAction: () => void }) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const query = useQuery({
    ...createQueryOptions(http).models.config(),
    enabled: can("models.configure"),
    // This is an editable form, not a passive catalog. Reconnect refetches
    // must not replace an in-progress draft or a newly typed one-way API key.
    refetchOnReconnect: false,
  });
  if (!can("models.configure")) return <p className="workspace-hint">{t("desktop.modelsConfigUnavailable")}</p>;
  if (query.isLoading) return <p className="workspace-hint">{t("desktop.modelsLoading")}</p>;
  if (query.isError) return <p className="workspace-hint workspace-hint--error" role="alert">{describeModelsConfigError(query.error, t)}</p>;
  return query.data ? <ModelsEditor snapshot={query.data} onCloseAction={onCloseAction} /> : null;
}
