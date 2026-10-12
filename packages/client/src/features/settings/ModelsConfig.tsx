import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import type {
  AvailableModelProvider,
  AuthProviderInfo,
  EditableModelConfig,
  EditableProviderConfig,
  ModelConfigApi,
  ModelConfigApiKeyMutation,
  ModelInfo,
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
import { describeCatalogError } from "@/features/catalog/catalog-errors";
import type { AuthProviderStatusResponse, ModelsResponse } from "@/api/schemas";
import { useSettingsDraft } from "./settings-draft";
import {
  SettingsBadge,
  SettingsButton,
  SettingsDangerButton,
  SettingsField,
  SettingsInput,
  SettingsNumInput,
  SettingsSaveBar,
  SettingsSection,
  SettingsSecretInput,
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

function numberValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * Editable model detail (shown inside the provider detail pane). One flat
 * card of fields plus the limits/cost block; removal is a two-step danger
 * confirm.
 */
function ModelDetail({
  model,
  providerLabel,
  onBack,
  onChange,
  onDelete,
}: {
  model: DraftModel;
  providerLabel: string;
  onBack: () => void;
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
      <button type="button" className="models-back-link" onClick={onBack}>
        <ArrowLeft size={13} aria-hidden="true" />
        {t("desktop.modelsBackToProvider", { provider: providerLabel })}
      </button>
      <SettingsSection
        title={model.name || model.id || t("desktop.modelsNewModel")}
        description={t("desktop.modelsModelDescription")}
        action={<SettingsDangerButton label={t("desktop.modelsRemove")} onConfirm={onDelete} />}
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

function ModelsEditor({ snapshot }: { snapshot: ModelsConfigResponse }) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [revision, setRevision] = useState(snapshot.revision);
  const [providers, setProviders] = useState<DraftProvider[]>(() => draftFromSnapshot(snapshot));
  const [dirty, setDirty] = useState(false);
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
    setDirty(false);
    setSelection((current) => {
      if (current?.type !== "provider") return drafts[0] ? { type: "provider", providerKey: drafts[0].key } : null;
      // Keep the selected provider across reloads when the same identity
      // survives (stable key = sourceId + index).
      const survivor = drafts.find((draft) => draft.key === current.providerKey);
      return survivor ? { type: "provider", providerKey: survivor.key } : drafts[0] ? { type: "provider", providerKey: drafts[0].key } : null;
    });
  }, []);

  useEffect(() => reset(snapshot), [reset, snapshot]);

  useSettingsDraft("providers", {
    isDirty: () => dirty,
    discard: () => reset(snapshot),
  });

  const selectedProvider = selection
    ? providers.find((provider) => provider.key === selection.providerKey)
    : undefined;
  const selectedModel = selection?.type === "model"
    ? selectedProvider?.models.find((model) => model.key === selection.modelKey)
    : undefined;

  const updateProvider = (key: string, patch: Partial<DraftProvider>) => {
    setDirty(true);
    setProviders((current) => current.map((provider) => provider.key === key ? { ...provider, ...patch } : provider));
  };
  const removeProvider = (key: string) => {
    setDirty(true);
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
    setDirty(true);
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
    setDirty(true);
    setProviders((current) => [...current, provider]);
    setSelection({ type: "provider", providerKey: provider.key });
  };
  const addModel = (providerKey: string) => {
    const model: DraftModel = { key: `new:${crypto.randomUUID()}`, sourceIndex: null, id: "" };
    setDirty(true);
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, modelsDefined: true, models: [...provider.models, model] }
      : provider));
    setSelection({ type: "model", providerKey, modelKey: model.key });
  };
  const updateModel = (providerKey: string, modelKey: string, patch: Partial<DraftModel>) => {
    setDirty(true);
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, models: provider.models.map((model) => model.key === modelKey ? { ...model, ...patch } : model) }
      : provider));
  };
  const removeModel = (providerKey: string, modelKey: string) => {
    setDirty(true);
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

  const errorText = validationError ?? (save.isError ? describeModelsConfigError(save.error, t) : null);

  return (
    <div className="models-config-shell">
      <div className="models-config-body">
        <aside className="models-provider-list">
          <div className="models-provider-list-heading">{t("desktop.settingsPage.providers")}</div>
          <div className="models-provider-list-scroll">
            {providers.map((provider) => {
              const providerSelected = selection?.type === "provider" && selection.providerKey === provider.key;
              return (
                <button
                  key={provider.key}
                  type="button"
                  className={providerSelected ? "models-provider-item is-selected" : "models-provider-item"}
                  onClick={() => setSelection({ type: "provider", providerKey: provider.key })}
                >
                  <ProviderIcon id={provider.id} {...(provider.api === undefined ? {} : { api: provider.api })} size={14} />
                  <span className="models-provider-item-label">{provider.id || t("desktop.modelsProvider")}</span>
                  {provider.models.length > 0 ? <span className="models-provider-item-count">{provider.models.length}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="models-provider-list-footer">
            <SettingsButton onClick={() => setPickerOpen(true)} style={{ width: "100%" }}><Plus size={13} />{t("desktop.modelsAddProvider")}</SettingsButton>
          </div>
        </aside>
        <main className="models-detail">
          {selectedProvider && selection?.type === "model" && selectedModel ? (
            <ModelDetail
              model={selectedModel}
              providerLabel={selectedProvider.id || t("desktop.modelsProvider")}
              onBack={() => setSelection({ type: "provider", providerKey: selectedProvider.key })}
              onChange={(patch) => updateModel(selectedProvider.key, selectedModel.key, patch)}
              onDelete={() => removeModel(selectedProvider.key, selectedModel.key)}
            />
          ) : selectedProvider && selection?.type === "provider" ? (
            <div className="models-detail-page">
              <SettingsSection
                title={selectedProvider.id || t("desktop.modelsProvider")}
                description={t("desktop.modelsProviderDescription")}
                action={<SettingsDangerButton label={t("desktop.delete")} onConfirm={() => removeProvider(selectedProvider.key)} />}
              >
                <div className="models-settings-fields">
                  <SettingsField label={t("desktop.modelsProviderName")}>
                    <SettingsInput value={selectedProvider.id} onChange={(id) => updateProvider(selectedProvider.key, { id })} placeholder="provider-name" mono />
                  </SettingsField>
                  <SettingsField label={t("desktop.modelsApi")}>
                    <SettingsSelect
                      value={selectedProvider.api ?? "openai-completions"}
                      onChange={(api) => updateProvider(selectedProvider.key, { api: api as ModelConfigApi })}
                      options={selectedProvider.api && !API_OPTIONS.includes(selectedProvider.api as (typeof API_OPTIONS)[number])
                        ? [selectedProvider.api, ...API_OPTIONS]
                        : API_OPTIONS}
                    />
                  </SettingsField>
                  <SettingsField label={t("desktop.modelsBaseUrl")}>
                    <SettingsInput
                      value={selectedProvider.baseUrl ?? ""}
                      onChange={(baseUrl) => updateProvider(selectedProvider.key, { baseUrl: baseUrl || undefined })}
                      placeholder="https://api.example.com/v1"
                      mono
                    />
                  </SettingsField>
                  <SettingsField label={t("desktop.modelsApiKey")}>
                    <SecretInput provider={selectedProvider} onChange={(patch) => updateProvider(selectedProvider.key, patch)} />
                    <div className="models-secret-meta">
                      <span className="models-field-hint">{t("desktop.modelsApiKeyHelp")}</span>
                      {selectedProvider.apiKeyConfigured ? (
                        selectedProvider.apiKeyMutation === "remove" ? (
                          <SettingsButton
                            size="sm"
                            onClick={() => updateProvider(selectedProvider.key, { apiKeyMutation: "preserve" })}
                          >
                            {t("desktop.modelsKeepStoredKey")}
                          </SettingsButton>
                        ) : (
                          <SettingsDangerButton
                            label={t("desktop.modelsRemoveStoredKey")}
                            onConfirm={() => updateProvider(selectedProvider.key, { apiKeyValue: "", apiKeyMutation: "remove" })}
                          />
                        )
                      ) : null}
                    </div>
                  </SettingsField>
                </div>
              </SettingsSection>

              <SettingsSection
                title={t("desktop.modelsSection")}
                description={t("desktop.modelsSectionDescription")}
                action={<SettingsButton size="sm" onClick={() => addModel(selectedProvider.key)}><Plus size={12} />{t("desktop.modelsAddModel")}</SettingsButton>}
              >
                {selectedProvider.models.length === 0 ? (
                  <p className="workspace-hint">{t("desktop.modelsNone")}</p>
                ) : (
                  <ul className="models-model-list">
                    {selectedProvider.models.map((model) => (
                      <li key={model.key}>
                        <button
                          type="button"
                          className="models-model-row"
                          onClick={() => setSelection({ type: "model", providerKey: selectedProvider.key, modelKey: model.key })}
                        >
                          <code className="models-model-row-id">{model.id || t("desktop.modelsNewModel")}</code>
                          <span className="models-model-row-badges">
                            {model.reasoning ? (
                              <SettingsBadge title={t("desktop.modelsReasoningBadgeTitle")}>{t("desktop.modelsReasoningBadge")}</SettingsBadge>
                            ) : null}
                            {model.input?.includes("image") ? <SettingsBadge>{t("desktop.modelsImageBadge")}</SettingsBadge> : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </SettingsSection>
            </div>
          ) : (
            <div className="models-empty-detail">{t("desktop.modelsSelectProviderOrModel")}</div>
          )}
        </main>
      </div>
      <SettingsSaveBar
        dirty={dirty}
        busy={save.isPending}
        saving={save.isPending}
        error={errorText}
        saved={save.isSuccess && !dirty && !errorText}
        saveDisabled={!dirty || save.isPending || Boolean(validationError)}
        onSave={() => save.mutate(mutationFromDraft(revision, providers), { onSuccess: reset })}
        onDiscard={() => reset(snapshot)}
      />
      {pickerOpen ? <ProviderPicker providers={snapshot.availableProviders} configuredIds={configuredIds} onAddCustom={addCustom} onAddBuiltin={addBuiltin} onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}

export function ModelsConfig() {
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
  return query.data ? <ModelsEditor snapshot={query.data} /> : null;
}

/* ── Read-only fallback (no models.configure capability) ────────────────── */

function EmptyState({ message }: { message: string }) {
  return <p className="workspace-hint">{message}</p>;
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <p className="workspace-hint workspace-hint--error" role="alert">
      {describeCatalogError(error)}
    </p>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ padding: "10px 18px 4px", fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {title}
    </div>
  );
}

function formatContextWindow(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k ctx`;
  return `${value} ctx`;
}

/**
 * Read-only models/providers catalog shown when the Host does not negotiate
 * `models.configure`. Read tokens only — no write surface is fabricated.
 */
function ReadOnlyModelsCatalog() {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const canModels = can("models");
  const canProviders = can("auth.providers");

  // Global read-only catalogs (agent-dir models.json providers + provider
  // credential presence). Not workspace- or cwd-scoped: no project is
  // required to browse them.
  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(),
    enabled: canModels,
  });

  const options = createQueryOptions(http);
  const providersQuery = useQuery({
    ...options.auth.providers(),
    enabled: canProviders,
  });
  const providers = (providersQuery.data?.providers ?? []) as AuthProviderInfo[];
  const statusQueries = useQueries({
    queries: providers.map((provider) => ({
      ...options.auth.providerStatus(provider.id),
      enabled: canProviders && Boolean(provider.id),
    })),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SectionHeader title={t("desktop.catalog.models")} />
      {!canModels ? (
        <EmptyState message={t("desktop.catalog.notAvailable", { what: t("desktop.catalog.models") })} />
      ) : modelsQuery.isPending ? (
        <EmptyState message={t("desktop.catalog.loading", { what: t("desktop.catalog.models") })} />
      ) : modelsQuery.isError ? (
        <ErrorState error={modelsQuery.error} />
      ) : (() => {
        const data = modelsQuery.data as ModelsResponse | undefined;
        const models = data?.models ?? [];
        const defaultModel = data?.defaultModel ?? null;
        if (models.length === 0) return <EmptyState message={t("desktop.catalog.empty", { what: t("desktop.catalog.models") })} />;
        return (
          <ul className="catalog-list" aria-label={t("desktop.catalog.models")}>
            {models.map((model: ModelInfo) => {
              const isDefault =
                defaultModel !== null &&
                defaultModel.id === model.id &&
                defaultModel.provider === model.provider;
              const ctx = formatContextWindow(model.contextWindow);
              return (
                <li key={`${model.provider}:${model.id}`} className="catalog-row">
                  <div className="catalog-row-main">
                    <span className="catalog-row-title">{model.displayName || model.id}</span>
                    {isDefault ? <span className="catalog-chip catalog-chip--accent">{t("desktop.catalog.default")}</span> : null}
                  </div>
                  <div className="catalog-row-meta">
                    <span className="catalog-meta-item">{model.provider}</span>
                    {model.thinking ? <span className="catalog-chip">{t("desktop.catalog.thinking")}</span> : null}
                    {ctx ? <span className="catalog-meta-item">{ctx}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        );
      })()}

      {canProviders ? (
        <>
          <SectionHeader title={t("desktop.catalog.authProviders")} />
          {providersQuery.isPending ? (
            <EmptyState message={t("desktop.catalog.loading", { what: t("desktop.catalog.providers") })} />
          ) : providersQuery.isError ? (
            <ErrorState error={providersQuery.error} />
          ) : providers.length === 0 ? (
            <EmptyState message={t("desktop.catalog.empty", { what: t("desktop.catalog.providers") })} />
          ) : (
            <ul className="catalog-list" aria-label={t("desktop.catalog.authProviders")}>
              {providers.map((provider, index) => {
                const statusQuery = statusQueries[index];
                const statusData = statusQuery?.data as AuthProviderStatusResponse | undefined;
                const configured = statusData?.configured;
                return (
                  <li key={provider.id} className="catalog-row">
                    <div className="catalog-row-main">
                      <span className="catalog-row-title">{provider.name || provider.id}</span>
                    </div>
                    <div className="catalog-row-meta">
                      {provider.methods.map((method) => (
                        <span key={method} className="catalog-chip">{method}</span>
                      ))}
                    </div>
                    <div className="catalog-row-meta">
                      {statusQuery?.isError ? (
                        <span className="catalog-meta-item catalog-meta-item--error">{t("desktop.catalog.statusUnavailable")}</span>
                      ) : statusQuery?.isLoading ? (
                        <span className="catalog-meta-item">{t("desktop.catalog.statusPending")}</span>
                      ) : (
                        // Presence-only report: the backend derives `configured`
                        // from stored-credential/config-file presence (no live
                        // authorization check exists), so only that chip is
                        // shown — no separate "authorized" claim.
                        configured !== undefined ? (
                          <span className={`catalog-chip${configured ? " catalog-chip--ok" : ""}`}>
                            {configured ? t("desktop.catalog.configured") : t("desktop.catalog.notConfigured")}
                          </span>
                        ) : null
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

export function ModelsSettingsTab() {
  const { can } = useCapabilities();
  return can("models.configure")
    ? <ModelsConfig />
    : <ReadOnlyModelsCatalog />;
}
