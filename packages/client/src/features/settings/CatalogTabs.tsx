import { useQueries, useQuery } from "@tanstack/react-query";
import type { AuthProviderInfo, ModelInfo, PluginInfo, SkillInfo, SlashCommandInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import type { AuthProviderStatusResponse, ModelsResponse } from "@/api/schemas";
import { describeCatalogError } from "@/features/catalog/catalog-errors";
import { useI18n } from "@/hooks/useI18n";
import { ModelsConfig } from "./ModelsConfig";

/**
 * Read-only catalog tabs for the Settings modal (absorbing the D3B Catalog
 * read queries: models / auth providers / skills / plugins / commands).
 *
 * Write controls are rendered ONLY behind a specific negotiated capability
 * token. The Host currently exposes read tokens only (`models`,
 * `auth.providers`, `skills`, `plugins`) — there is no models/skills/plugins
 * write capability, so no write button is fabricated here. When a write token
 * appears, gate the control on `can(<token>)` exactly like the tabs below.
 */

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

function useCatalogI18n() {
  return useI18n();
}

function ReadOnlyModelsSettingsTab() {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useCatalogI18n();
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
      ) : modelsQuery.isLoading ? (
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
          {providersQuery.isLoading ? (
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

export function ModelsSettingsTab({ onCloseAction }: { onCloseAction: () => void }) {
  const { can } = useCapabilities();
  return can("models.configure")
    ? <ModelsConfig onCloseAction={onCloseAction} />
    : <ReadOnlyModelsSettingsTab />;
}

export function SkillsSettingsTab({
  cwd,
  liveWorkspaceEnabled = true,
}: {
  cwd: string | null;
  liveWorkspaceEnabled?: boolean;
}) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useCatalogI18n();
  const canSkills = can("skills");
  const canFetch = canSkills && liveWorkspaceEnabled && Boolean(cwd);

  const query = useQuery({
    ...createQueryOptions(http).skills.list(cwd ?? ""),
    enabled: canFetch,
  });

  if (!cwd) return <EmptyState message={t("desktop.catalog.openProjectToBrowse", { what: t("desktop.catalog.skills") })} />;
  if (!canSkills) return <EmptyState message={t("desktop.catalog.notAvailable", { what: t("desktop.catalog.skills") })} />;
  if (query.isLoading) return <EmptyState message={t("desktop.catalog.loading", { what: t("desktop.catalog.skills") })} />;
  if (query.isError) return <ErrorState error={query.error} />;

  const skills = (query.data?.skills ?? []) as SkillInfo[];
  if (skills.length === 0) return <EmptyState message={t("desktop.catalog.empty", { what: t("desktop.catalog.skills") })} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <ul className="catalog-list" aria-label={t("desktop.catalog.skills")}>
        {skills.map((skill) => (
          <li key={skill.name} className="catalog-row">
            <div className="catalog-row-main">
              <span className="catalog-row-title">{skill.name}</span>
              <span className={`catalog-chip${skill.enabled ? " catalog-chip--ok" : ""}`}>
                {skill.enabled ? t("desktop.catalog.enabled") : t("desktop.catalog.disabled")}
              </span>
              {skill.updateAvailable ? <span className="catalog-chip catalog-chip--accent">{t("desktop.catalog.updateAvailable")}</span> : null}
            </div>
            <div className="catalog-row-meta">
              {skill.version ? <span className="catalog-meta-item">{t("desktop.catalog.version", { version: skill.version })}</span> : null}
              {skill.description ? <span className="catalog-meta-item catalog-meta-item--wrap">{skill.description}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PluginsSettingsTab({
  cwd,
  liveWorkspaceEnabled = true,
}: {
  cwd: string | null;
  liveWorkspaceEnabled?: boolean;
}) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useCatalogI18n();
  const canPlugins = can("plugins");
  const canCommands = can("skills") || can("plugins");
  const canFetchPlugins = canPlugins && liveWorkspaceEnabled && Boolean(cwd);
  const canFetchCommands = canCommands && liveWorkspaceEnabled && Boolean(cwd);

  const pluginsQuery = useQuery({
    ...createQueryOptions(http).plugins.list(cwd ?? ""),
    enabled: canFetchPlugins,
  });
  const commandsQuery = useQuery({
    ...createQueryOptions(http).commands.list(cwd ?? ""),
    enabled: canFetchCommands,
  });

  if (!cwd) return <EmptyState message={t("desktop.catalog.openProjectToBrowse", { what: t("desktop.catalog.plugins") })} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      {!canPlugins ? (
        <EmptyState message={t("desktop.catalog.notAvailable", { what: t("desktop.catalog.plugins") })} />
      ) : pluginsQuery.isLoading ? (
        <EmptyState message={t("desktop.catalog.loading", { what: t("desktop.catalog.plugins") })} />
      ) : pluginsQuery.isError ? (
        <ErrorState error={pluginsQuery.error} />
      ) : (() => {
        const plugins = (pluginsQuery.data?.plugins ?? []) as PluginInfo[];
        if (plugins.length === 0) return <EmptyState message={t("desktop.catalog.empty", { what: t("desktop.catalog.plugins") })} />;
        return (
          <ul className="catalog-list" aria-label={t("desktop.catalog.plugins")}>
            {plugins.map((plugin) => (
              <li key={plugin.name} className="catalog-row">
                <div className="catalog-row-main">
                  <span className="catalog-row-title">{plugin.name}</span>
                  <span className={`catalog-chip${plugin.enabled ? " catalog-chip--ok" : ""}`}>
                    {plugin.enabled ? t("desktop.catalog.enabled") : t("desktop.catalog.disabled")}
                  </span>
                </div>
                <div className="catalog-row-meta">
                  {plugin.version ? <span className="catalog-meta-item">{t("desktop.catalog.version", { version: plugin.version })}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        );
      })()}

      {canCommands ? (
        <>
          <SectionHeader title={t("desktop.catalog.commands")} />
          {commandsQuery.isLoading ? (
            <EmptyState message={t("desktop.catalog.loading", { what: t("desktop.catalog.commands") })} />
          ) : commandsQuery.isError ? (
            <ErrorState error={commandsQuery.error} />
          ) : (() => {
            const commands = (commandsQuery.data?.commands ?? []) as SlashCommandInfo[];
            if (commands.length === 0) return <EmptyState message={t("desktop.catalog.empty", { what: t("desktop.catalog.commands") })} />;
            return (
              <ul className="catalog-list" aria-label={t("desktop.catalog.commands")}>
                {commands.map((command) => (
                  <li key={`${command.source}:${command.name}`} className="catalog-row">
                    <div className="catalog-row-main">
                      <span className="catalog-row-title">/{command.name}</span>
                      <span className="catalog-chip">{command.source}</span>
                    </div>
                    {command.description ? (
                      <div className="catalog-row-meta">
                        <span className="catalog-meta-item catalog-meta-item--wrap">{command.description}</span>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            );
          })()}
        </>
      ) : null}
    </div>
  );
}
