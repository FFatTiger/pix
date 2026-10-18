import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import type {
  AvailableModelProvider,
  AuthProviderInfo,
  DiscoveredModelConfig,
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
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { Switch } from "@/components/ui/switch";
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

/**
 * One picker-visibility intent computed at save time: the CURRENT draft
 * identity (provider/id) plus the desired state. Derived from the final
 * draft, so provider renames are naturally handled.
 */
interface VisibilityIntent {
  provider: string;
  id: string;
  visible: boolean;
}

interface DraftModel extends Omit<EditableModelConfig, "id" | "visibleInPicker"> {
  key: string;
  id: string;
  /** Server truth for THIS row's identity when the page loaded (new rows: visible). */
  visibleInPicker: boolean;
  /** Current desired picker visibility (the switch state). */
  pickerVisible: boolean;
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
      visibleInPicker: model.visibleInPicker ?? true,
      pickerVisible: model.visibleInPicker ?? true,
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
      models: provider.models.map(({ key: _key, visibleInPicker: _visible, pickerVisible: _desired, ...model }) => ({
        ...model,
        id: model.id,
      })),
    })),
  };
}

/**
 * Picker-visibility intents for save: one per row whose desired state differs
 * from the server truth recorded for its identity. A provider rename re-bases
 * every row's `visibleInPicker` to "visible" (the new identity starts visible
 * via the server-side whitelist hygiene), so this diff is rename-safe.
 */
function visibilityIntentsFrom(providers: readonly DraftProvider[]): VisibilityIntent[] {
  const intents: VisibilityIntent[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.pickerVisible === model.visibleInPicker) continue;
      intents.push({ provider: provider.id, id: model.id, visible: model.pickerVisible });
    }
  }
  return intents;
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

/** 128000 → "128K", 2000000 → "2M" (compact token counts). */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions % 1 === 0 ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** One-line faded parameter summary; null when no parameter is known. */
function modelParamsSummary(
  model: Pick<EditableModelConfig, "reasoning" | "input" | "contextWindow" | "maxTokens">,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  const parts: string[] = [];
  if (model.contextWindow !== undefined) parts.push(t("desktop.modelsParamContext", { size: formatTokenCount(model.contextWindow) }));
  if (model.maxTokens !== undefined) parts.push(t("desktop.modelsParamOutput", { size: formatTokenCount(model.maxTokens) }));
  if (model.input?.includes("image")) parts.push(t("desktop.modelsParamImage"));
  if (model.reasoning) parts.push(t("desktop.modelsParamReasoning"));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Editable model detail (shown inside the provider detail pane). One flat
 * card of fields plus the limits/cost block; removal is a two-step danger
 * confirm.
 */
function ModelDetail({
  model,
  providerApi,
  providerLabel,
  onBack,
  onChange,
  onDelete,
}: {
  model: DraftModel;
  providerApi: ModelConfigApi;
  providerLabel: string;
  onBack: () => void;
  onChange: (patch: Partial<DraftModel>) => void;
  onDelete: () => void;
}) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [fillMissing, setFillMissing] = useState(false);
  const modelId = model.id.trim();
  // "Fill from models.dev": one bounded lookup for THIS id. A miss is a
  // normal outcome (fixed hint), not an error; the patch lands in the draft
  // only, so the save bar can still discard it.
  const fill = useMutation({
    ...createMutationOptions(http, queryClient).models.metadata(),
    onMutate: () => { setFillMissing(false); },
    onSuccess: (data) => {
      const fields = modelId ? data.metadata[modelId] ?? null : null;
      setFillMissing(fields === null);
      if (fields === null) return;
      onChange({
        ...(fields.reasoning === undefined ? {} : { reasoning: fields.reasoning }),
        ...(fields.input === undefined ? {} : { input: [...fields.input] }),
        ...(fields.contextWindow === undefined ? {} : { contextWindow: fields.contextWindow }),
        ...(fields.maxTokens === undefined ? {} : { maxTokens: fields.maxTokens }),
        ...(fields.cost === undefined ? {} : { cost: { ...fields.cost } }),
        ...(model.name === undefined && fields.name !== undefined ? { name: fields.name } : {}),
      });
    },
  });
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

      <SettingsSection
        title={t("desktop.modelsLimitsAndCost")}
        description={t("desktop.modelsLimitsDescription")}
        action={(
          <SettingsButton
            size="sm"
            disabled={!modelId || fill.isPending}
            onClick={() => fill.mutate({ ids: [modelId], api: providerApi })}
          >
            {fill.isPending ? t("desktop.modelsFillFilling") : t("desktop.modelsFillFromCatalog")}
          </SettingsButton>
        )}
      >
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
          {fill.isError ? (
            <p className="workspace-hint workspace-hint--error" role="alert">{describeModelsConfigError(fill.error, t)}</p>
          ) : null}
          {fillMissing && !fill.isPending ? (
            <p className="models-field-hint" role="status">{t("desktop.modelsFillNotFound")}</p>
          ) : null}
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

/**
 * Expanded discovery results: an inline selection area (not a modal) with a
 * search box, select-all, one row per discovered model (id, dim name, dim
 * parameter summary or the fixed no-parameters copy) and a footer that adds
 * the checked rows — with their models.dev parameters — to the DRAFT.
 */
function DiscoveryResults({
  models,
  existingIds,
  selected,
  onToggle,
  onSetSelected,
  onAdd,
  onCancel,
}: {
  models: readonly DiscoveredModelConfig[];
  existingIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSetSelected: (ids: ReadonlySet<string>) => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const normalized = search.trim().toLocaleLowerCase();
  const rows = models.filter((model) => !normalized
    || model.id.toLocaleLowerCase().includes(normalized)
    || (model.name ?? "").toLocaleLowerCase().includes(normalized));
  const selectable = rows.filter((model) => !existingIds.has(model.id));
  const allSelected = selectable.length > 0 && selectable.every((model) => selected.has(model.id));
  return (
    <div className="models-discovery">
      <div className="models-discovery-toolbar">
        <div className="models-discovery-search">
          <MagnifyingGlass size={13} aria-hidden="true" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("desktop.modelsDiscoverySearch")} />
        </div>
        <SettingsButton
          size="sm"
          disabled={selectable.length === 0}
          onClick={() => onSetSelected(allSelected ? new Set() : new Set(selectable.map((model) => model.id)))}
        >
          {allSelected ? t("desktop.modelsDiscoveryClear") : t("desktop.modelsDiscoverySelectAll")}
        </SettingsButton>
      </div>
      <div className="models-discovery-list" role="list">
        {rows.map((model) => {
          const added = existingIds.has(model.id);
          const checked = added || selected.has(model.id);
          const params = modelParamsSummary(model, t);
          return (
            <label key={model.id} className={added ? "models-discovery-row models-discovery-row--added" : "models-discovery-row"}>
              <input
                type="checkbox"
                checked={checked}
                disabled={added}
                onChange={() => onToggle(model.id)}
              />
              <span className="models-discovery-row-main">
                <span className="models-discovery-row-id">{model.id}</span>
                {model.name && model.name !== model.id ? <span className="models-discovery-row-name">{model.name}</span> : null}
                <span className="models-discovery-row-params">{params ?? t("desktop.modelsDiscoveryNoParams")}</span>
              </span>
              {added ? <span className="models-discovery-added-tag">{t("desktop.modelsDiscoveryAdded")}</span> : null}
            </label>
          );
        })}
      </div>
      <div className="models-discovery-footer">
        <SettingsButton size="sm" onClick={onCancel}>{t("desktop.modelsDiscoveryCancel")}</SettingsButton>
        <SettingsButton size="sm" variant="primary" disabled={selected.size === 0} onClick={onAdd}>
          {selected.size > 0 ? t("desktop.modelsDiscoveryAddSelectedCount", { count: selected.size }) : t("desktop.modelsDiscoveryAddSelected")}
        </SettingsButton>
      </div>
    </div>
  );
}

/**
 * Provider detail page: identity/endpoint fields plus the model sub-list.
 * Each row carries a "show in picker" switch (settings.json `enabledModels`;
 * requires the settings.configure capability); hidden rows render faded and
 * the row that is the last visible model cannot be turned off.
 * "拉取模型列表" fetches the provider's own /models endpoint through the typed
 * discovery mutation and expands the inline selection area below the list.
 */
function ProviderDetail({
  provider,
  revision,
  defaultModel,
  canToggleVisibility,
  isBuiltinProvider,
  lastVisibleKeys,
  onToggleModelVisible,
  onChange,
  onDelete,
  onAddModel,
  onOpenModel,
  onAddDiscoveredModels,
}: {
  provider: DraftProvider;
  revision: string;
  /** Raw settings.json default model; drives the hidden-default hint. */
  defaultModel: { provider: string; id: string } | null;
  canToggleVisibility: boolean;
  /**
   * Provider id is in the Pi BUILT-IN catalog (the same catalog the Add
   * Provider picker lists). A built-in endpoint defaults to Pi's own Base URL,
   * so discovery works without the user typing one; a custom provider still
   * needs an explicit endpoint.
   */
  isBuiltinProvider: boolean;
  /** Draft rows that are the single remaining visible model (lock their switch). */
  lastVisibleKeys: ReadonlySet<string>;
  onToggleModelVisible: (providerKey: string, modelKey: string, visible: boolean) => void;
  onChange: (patch: Partial<DraftProvider>) => void;
  onDelete: () => void;
  onAddModel: () => void;
  onOpenModel: (modelKey: string) => void;
  onAddDiscoveredModels: (models: readonly DiscoveredModelConfig[]) => void;
}) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const discovery = useMutation(createMutationOptions(http, queryClient).models.discover());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const existing = useMemo(() => new Set(provider.models.map((model) => model.id)), [provider.models]);

  // Endpoint identity drives discovery safety (persisted keys are only
  // replayed to the exact source endpoint), so any change collapses the
  // results and clears the selection.
  useEffect(() => {
    discovery.reset();
    setSelected(new Set());
  }, [provider.key, provider.id, provider.baseUrl, provider.api, provider.apiKeyValue]);

  const baseUrl = provider.baseUrl?.trim();
  // A built-in provider resolves its own default endpoint server-side; any
  // other provider must have one typed in.
  const canDiscover = Boolean(baseUrl) || isBuiltinProvider;
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="models-detail-page">
      <SettingsSection
        title={provider.id || t("desktop.modelsProvider")}
        description={t("desktop.modelsProviderDescription")}
        action={<SettingsDangerButton label={t("desktop.delete")} onConfirm={onDelete} />}
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
                provider.apiKeyMutation === "remove" ? (
                  <SettingsButton
                    size="sm"
                    onClick={() => onChange({ apiKeyMutation: "preserve" })}
                  >
                    {t("desktop.modelsKeepStoredKey")}
                  </SettingsButton>
                ) : (
                  <SettingsDangerButton
                    label={t("desktop.modelsRemoveStoredKey")}
                    onConfirm={() => onChange({ apiKeyValue: "", apiKeyMutation: "remove" })}
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
        action={(
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <SettingsButton
              size="sm"
              disabled={!canDiscover || discovery.isPending}
              {...(canDiscover ? {} : { title: t("desktop.modelsDiscoverNeedsBaseUrl") })}
              onClick={() => discovery.mutate({
                expectedRevision: revision,
                sourceId: provider.sourceId,
                providerId: provider.id,
                // Blank Base URL + built-in provider → sessiond uses Pi's own
                // default endpoint and api for that provider. Only an explicit
                // endpoint falls back to the editable form's api default.
                ...(baseUrl === undefined ? {} : { baseUrl }),
                ...(provider.api !== undefined
                  ? { api: provider.api }
                  : baseUrl === undefined ? {} : { api: "openai-completions" }),
                ...(provider.apiKeyMutation === "replace" && provider.apiKeyValue
                  ? { apiKey: provider.apiKeyValue }
                  : {}),
              })}
            >
              {discovery.isPending ? t("desktop.modelsDiscovering") : t("desktop.modelsDiscover")}
            </SettingsButton>
            <SettingsButton size="sm" onClick={onAddModel}><Plus size={12} />{t("desktop.modelsAddModel")}</SettingsButton>
          </div>
        )}
      >
        {provider.models.length === 0 ? (
          <p className="workspace-hint">{t("desktop.modelsNone")}</p>
        ) : (
          <ul className="models-model-list">
            {provider.models.map((model) => (
              <li
                key={model.key}
                style={{ display: "flex", alignItems: "center", gap: 6, ...(model.pickerVisible ? {} : { opacity: 0.55 }) }}
              >
                <button
                  type="button"
                  className="models-model-row"
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => onOpenModel(model.key)}
                >
                  <code className="models-model-row-id">{model.id || t("desktop.modelsNewModel")}</code>
                  <span className="models-model-row-badges">
                    {model.reasoning ? (
                      <SettingsBadge title={t("desktop.modelsReasoningBadgeTitle")}>{t("desktop.modelsReasoningBadge")}</SettingsBadge>
                    ) : null}
                    {model.input?.includes("image") ? <SettingsBadge>{t("desktop.modelsImageBadge")}</SettingsBadge> : null}
                  </span>
                </button>
                {canToggleVisibility ? (
                  <Switch
                    checked={model.pickerVisible}
                    onChange={(visible) => onToggleModelVisible(provider.key, model.key, visible)}
                    disabled={model.pickerVisible && lastVisibleKeys.has(model.key)}
                    label={t("desktop.modelsShowInPicker", { model: model.name || model.id || t("desktop.modelsNewModel") })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canToggleVisibility && defaultModel && provider.id === defaultModel.provider
          && provider.models.some((model) => model.id === defaultModel.id && !model.pickerVisible) ? (
          <p className="workspace-hint" role="status">{t("desktop.modelsDefaultHidden")}</p>
        ) : null}
        {discovery.isError ? (
          <p className="workspace-hint workspace-hint--error" role="alert">{describeModelsConfigError(discovery.error, t)}</p>
        ) : null}
        {discovery.data ? (
          <DiscoveryResults
            models={discovery.data.models}
            existingIds={existing}
            selected={selected}
            onToggle={toggle}
            onSetSelected={setSelected}
            onAdd={() => {
              onAddDiscoveredModels(discovery.data!.models.filter((model) => selected.has(model.id)));
              setSelected(new Set());
              discovery.reset();
            }}
            onCancel={() => {
              setSelected(new Set());
              discovery.reset();
            }}
          />
        ) : null}
      </SettingsSection>
    </div>
  );
}

function ModelsEditor({ snapshot }: { snapshot: ModelsConfigResponse }) {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const [revision, setRevision] = useState(snapshot.revision);
  const [providers, setProviders] = useState<DraftProvider[]>(() => draftFromSnapshot(snapshot));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(() => {
    const first = draftFromSnapshot(snapshot)[0];
    return first ? { type: "provider", providerKey: first.key } : null;
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  // Built-in provider ids come from the SAME authoritative catalog the Add
  // Provider picker renders (never a client-side copy of the address book):
  // those providers have a Pi default endpoint, so discovery works without a
  // typed Base URL.
  const builtinProviderIds = useMemo(
    () => new Set(snapshot.availableProviders.map((available) => available.id)),
    [snapshot.availableProviders],
  );
  const save = useMutation(createMutationOptions(http, queryClient).models.saveConfig());
  const saveVisibility = useMutation(createMutationOptions(http, queryClient).models.saveVisibility());
  // Picker visibility lives in settings.json (`enabledModels`): its default
  // model drives the hidden-default hint, and its revision is fetched fresh
  // at save time. Requires the settings.configure capability — without it the
  // switches simply don't render (capability-driven degradation).
  const canToggleVisibility = can("settings.configure");
  const visibilityQuery = useQuery({
    ...createQueryOptions(http).models.visibility(),
    enabled: canToggleVisibility,
  });

  // Desired picker visibility diverging from the server truth recorded for
  // each row's identity is its own dirty signal — it rides the same save bar
  // as the models.json draft but is committed to a second document.
  const visibilityDirty = useMemo(
    () => providers.some((provider) => provider.models.some((model) => model.pickerVisible !== model.visibleInPicker)),
    [providers],
  );
  const anyDirty = dirty || visibilityDirty;
  const lastVisibleKeys = useMemo(() => {
    const visible = providers.flatMap((provider) => provider.models.filter((model) => model.pickerVisible));
    return visible.length === 1 ? new Set([visible[0]!.key]) : new Set<string>();
  }, [providers]);

  // Picker toggles the user asked for but that are not committed yet. They
  // survive every snapshot re-base (a models save rewrites settings.json and
  // refreshes the draft; only a successful visibility commit or an explicit
  // discard clears them), so a failed visibility half never silently drops
  // the user's pending switches.
  const [pendingToggles, setPendingToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const pendingTogglesRef = useRef(pendingToggles);
  const setPending = (next: ReadonlyMap<string, boolean>) => {
    pendingTogglesRef.current = next;
    setPendingToggles(next);
  };

  /** Apply uncommitted toggle desires onto a fresh draft (by model identity). */
  const withDesiredToggles = useCallback((drafts: DraftProvider[]): DraftProvider[] => {
    const pending = pendingTogglesRef.current;
    if (pending.size === 0) return drafts;
    return drafts.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => {
        const desired = pending.get(`${provider.id}\0${model.id}`);
        return desired === undefined ? model : { ...model, pickerVisible: desired };
      }),
    }));
  }, []);

  const reset = useCallback((next: ModelsConfigResponse) => {
    const drafts = withDesiredToggles(draftFromSnapshot(next));
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
  }, [withDesiredToggles]);

  useEffect(() => reset(snapshot), [reset, snapshot]);

  useSettingsDraft("providers", {
    isDirty: () => dirty || visibilityDirty,
    discard: () => {
      setPending(new Map());
      reset(snapshot);
    },
  });

  const selectedProvider = selection
    ? providers.find((provider) => provider.key === selection.providerKey)
    : undefined;
  const selectedModel = selection?.type === "model"
    ? selectedProvider?.models.find((model) => model.key === selection.modelKey)
    : undefined;

  const updateProvider = (key: string, patch: Partial<DraftProvider>) => {
    setDirty(true);
    setProviders((current) => current.map((provider) => {
      if (provider.key !== key) return provider;
      const renamed = patch.id !== undefined && patch.id !== provider.id;
      return {
        ...provider,
        ...patch,
        // A renamed provider is a NEW identity: its models start visible in
        // the picker (the server-side whitelist hygiene appends them), so the
        // per-row server truth re-bases while the user's desired toggles stay.
        ...(renamed ? { models: provider.models.map((model) => ({ ...model, visibleInPicker: true })) } : {}),
      };
    }));
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
    const model: DraftModel = { key: `new:${crypto.randomUUID()}`, sourceIndex: null, id: "", visibleInPicker: true, pickerVisible: true };
    setDirty(true);
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, modelsDefined: true, models: [...provider.models, model] }
      : provider));
    setSelection({ type: "model", providerKey, modelKey: model.key });
  };
  const addDiscoveredModels = (providerKey: string, discovered: readonly DiscoveredModelConfig[]) => {
    setDirty(true);
    setProviders((current) => current.map((provider) => {
      if (provider.key !== providerKey) return provider;
      const ids = new Set(provider.models.map((model) => model.id));
      const additions = discovered
        .filter((model) => !ids.has(model.id))
        .map((model): DraftModel => ({
          key: `new:${crypto.randomUUID()}`,
          sourceIndex: null,
          id: model.id,
          visibleInPicker: true,
          pickerVisible: true,
          ...(model.name === undefined ? {} : { name: model.name }),
          ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
          ...(model.input === undefined ? {} : { input: [...model.input] }),
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.cost === undefined ? {} : { cost: { ...model.cost } }),
        }));
      return additions.length ? { ...provider, modelsDefined: true, models: [...provider.models, ...additions] } : provider;
    }));
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
  const toggleModelVisibility = (providerKey: string, modelKey: string, visible: boolean) => {
    // Visibility has its own dirty derivation (pickerVisible vs visibleInPicker),
    // so it must NOT flip the models.json draft dirty flag.
    setProviders((current) => current.map((provider) => provider.key === providerKey
      ? { ...provider, models: provider.models.map((model) => model.key === modelKey ? { ...model, pickerVisible: visible } : model) }
      : provider));
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

  // Two documents, two revision fences, one save bar:
  //  1. models.json draft (if dirty) → PUT /v1/models/config. The server also
  //     keeps the settings.json enabledModels whitelist consistent with the
  //     new catalog during this write (add new exact rows, drop dead ones).
  //  2. picker-visibility intents (if any) → fresh GET /v1/settings/
  //     model-visibility for the settings.json CAS revision (step 1 may have
  //     rewritten it), then PUT the intents. The server computes the actual
  //     whitelist entries; a conflict or validation failure surfaces as an
  //     honest error and the pending toggles are re-applied onto the refreshed
  //     draft so a second Save click retries just this step.
  const doSave = async () => {
    if (validationError || saving) return;
    // Snapshot the user's toggle desires now; they stay pending until the
    // visibility commit succeeds (or the draft is discarded).
    const pending = visibilityIntentsFrom(providers);
    setPending(new Map(pending.map((intent) => [`${intent.provider}\0${intent.id}`, intent.visible])));
    setSaving(true);
    setSaveError(null);
    try {
      let baseDrafts = providers;
      if (dirty) {
        const next = await save.mutateAsync(mutationFromDraft(revision, providers));
        reset(next);
        // Intents are derived from the post-save identities WITH the pending
        // desires re-applied, so a provider rename naturally carries them.
        baseDrafts = withDesiredToggles(draftFromSnapshot(next));
      }
      const intents = visibilityIntentsFrom(baseDrafts);
      if (intents.length > 0) {
        // Fresh settings.json CAS revision: a models save (hygiene) may have
        // rewritten settings.json after the page loaded.
        const visibility = await queryClient.fetchQuery(createQueryOptions(http).models.visibility());
        await saveVisibility.mutateAsync({ expectedRevision: visibility.revision, changes: intents });
      }
      setPending(new Map());
      setSavedFlash(true);
    } catch (error) {
      setSaveError(describeModelsConfigError(error, t));
      // The models half may have committed while the visibility half failed:
      // the pending toggles stay registered, so every re-base (including the
      // one triggered by this refetch) re-applies them onto the fresh draft
      // and the save bar stays dirty for an honest retry.
      await queryClient.invalidateQueries({ queryKey: queryKeys.models.visibility() });
    } finally {
      setSaving(false);
    }
  };

  const errorText = validationError ?? saveError;

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
              providerApi={selectedProvider.api ?? "openai-completions"}
              providerLabel={selectedProvider.id || t("desktop.modelsProvider")}
              onBack={() => setSelection({ type: "provider", providerKey: selectedProvider.key })}
              onChange={(patch) => updateModel(selectedProvider.key, selectedModel.key, patch)}
              onDelete={() => removeModel(selectedProvider.key, selectedModel.key)}
            />
          ) : selectedProvider && selection?.type === "provider" ? (
            <ProviderDetail
              provider={selectedProvider}
              revision={revision}
              defaultModel={visibilityQuery.data?.defaultModel ?? null}
              canToggleVisibility={canToggleVisibility}
              isBuiltinProvider={builtinProviderIds.has(selectedProvider.id)}
              lastVisibleKeys={lastVisibleKeys}
              onToggleModelVisible={toggleModelVisibility}
              onChange={(patch) => updateProvider(selectedProvider.key, patch)}
              onDelete={() => removeProvider(selectedProvider.key)}
              onAddModel={() => addModel(selectedProvider.key)}
              onOpenModel={(modelKey) => setSelection({ type: "model", providerKey: selectedProvider.key, modelKey })}
              onAddDiscoveredModels={(models) => addDiscoveredModels(selectedProvider.key, models)}
            />
          ) : (
            <div className="models-empty-detail">{t("desktop.modelsSelectProviderOrModel")}</div>
          )}
        </main>
      </div>
      <SettingsSaveBar
        dirty={anyDirty}
        busy={saving || save.isPending || saveVisibility.isPending}
        saving={saving || save.isPending || saveVisibility.isPending}
        error={errorText}
        saved={savedFlash && !anyDirty && !errorText}
        saveDisabled={!anyDirty || saving || Boolean(validationError)}
        onSave={() => { void doSave(); }}
        onDiscard={() => { setPending(new Map()); reset(snapshot); }}
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
