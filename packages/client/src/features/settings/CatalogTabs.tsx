import { useQueries, useQuery } from "@tanstack/react-query";
import type { AuthProviderInfo, ModelInfo, PluginInfo, SkillInfo, SlashCommandInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import type { AuthProviderStatusResponse, ModelsResponse } from "@/api/schemas";
import { describeCatalogError } from "@/features/catalog/catalog-errors";

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

function formatExpiry(expiresAt: number | undefined): string | null {
  if (expiresAt === undefined) return null;
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) return null;
  return expiry.toLocaleString();
}

export function ModelsSettingsTab({ cwd }: { cwd: string | null }) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const canModels = can("models");
  const canProviders = can("auth.providers");
  const canFetchModels = canModels && Boolean(cwd);

  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(cwd ?? ""),
    enabled: canFetchModels,
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

  if (!cwd) return <EmptyState message="Open a project to browse models." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SectionHeader title="Models" />
      {!canModels ? (
        <EmptyState message="Models catalog is not available." />
      ) : modelsQuery.isLoading ? (
        <EmptyState message="Loading models…" />
      ) : modelsQuery.isError ? (
        <ErrorState error={modelsQuery.error} />
      ) : (() => {
        const data = modelsQuery.data as ModelsResponse | undefined;
        const models = data?.models ?? [];
        const defaultModel = data?.defaultModel ?? null;
        if (models.length === 0) return <EmptyState message="No models." />;
        return (
          <ul className="catalog-list" aria-label="Models">
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
                    {isDefault ? <span className="catalog-chip catalog-chip--accent">Default</span> : null}
                  </div>
                  <div className="catalog-row-meta">
                    <span className="catalog-meta-item">{model.provider}</span>
                    {model.thinking ? <span className="catalog-chip">thinking</span> : null}
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
          <SectionHeader title="Auth providers" />
          {providersQuery.isLoading ? (
            <EmptyState message="Loading providers…" />
          ) : providersQuery.isError ? (
            <ErrorState error={providersQuery.error} />
          ) : providers.length === 0 ? (
            <EmptyState message="No providers." />
          ) : (
            <ul className="catalog-list" aria-label="Providers">
              {providers.map((provider, index) => {
                const statusQuery = statusQueries[index];
                const statusData = statusQuery?.data as AuthProviderStatusResponse | undefined;
                const status = statusData?.status;
                const configured = statusData?.configured;
                const expiry = formatExpiry(status?.expiresAt);
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
                        <span className="catalog-meta-item catalog-meta-item--error">Status unavailable</span>
                      ) : statusQuery?.isLoading ? (
                        <span className="catalog-meta-item">Status…</span>
                      ) : (
                        <>
                          {configured !== undefined ? (
                            <span className={`catalog-chip${configured ? " catalog-chip--ok" : ""}`}>
                              {configured ? "configured" : "not configured"}
                            </span>
                          ) : null}
                          {status ? (
                            <span className={`catalog-chip${status.authorized ? " catalog-chip--ok" : ""}`}>
                              {status.authorized ? "authorized" : "not authorized"}
                            </span>
                          ) : null}
                          {status?.accountName ? (
                            <span className="catalog-meta-item">{status.accountName}</span>
                          ) : null}
                          {expiry ? <span className="catalog-meta-item">exp {expiry}</span> : null}
                        </>
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

export function SkillsSettingsTab({ cwd }: { cwd: string | null }) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const canSkills = can("skills");
  const canFetch = canSkills && Boolean(cwd);

  const query = useQuery({
    ...createQueryOptions(http).skills.list(cwd ?? ""),
    enabled: canFetch,
  });

  if (!cwd) return <EmptyState message="Open a project to browse skills." />;
  if (!canSkills) return <EmptyState message="Skills catalog is not available." />;
  if (query.isLoading) return <EmptyState message="Loading skills…" />;
  if (query.isError) return <ErrorState error={query.error} />;

  const skills = (query.data?.skills ?? []) as SkillInfo[];
  if (skills.length === 0) return <EmptyState message="No skills." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <ul className="catalog-list" aria-label="Skills">
        {skills.map((skill) => (
          <li key={skill.name} className="catalog-row">
            <div className="catalog-row-main">
              <span className="catalog-row-title">{skill.name}</span>
              <span className={`catalog-chip${skill.enabled ? " catalog-chip--ok" : ""}`}>
                {skill.enabled ? "enabled" : "disabled"}
              </span>
              {skill.updateAvailable ? <span className="catalog-chip catalog-chip--accent">update</span> : null}
            </div>
            <div className="catalog-row-meta">
              {skill.version ? <span className="catalog-meta-item">v{skill.version}</span> : null}
              {skill.description ? <span className="catalog-meta-item catalog-meta-item--wrap">{skill.description}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PluginsSettingsTab({ cwd }: { cwd: string | null }) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const canPlugins = can("plugins");
  const canCommands = can("skills") || can("plugins");
  const canFetchPlugins = canPlugins && Boolean(cwd);
  const canFetchCommands = canCommands && Boolean(cwd);

  const pluginsQuery = useQuery({
    ...createQueryOptions(http).plugins.list(cwd ?? ""),
    enabled: canFetchPlugins,
  });
  const commandsQuery = useQuery({
    ...createQueryOptions(http).commands.list(cwd ?? ""),
    enabled: canFetchCommands,
  });

  if (!cwd) return <EmptyState message="Open a project to browse plugins." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      {!canPlugins ? (
        <EmptyState message="Plugins catalog is not available." />
      ) : pluginsQuery.isLoading ? (
        <EmptyState message="Loading plugins…" />
      ) : pluginsQuery.isError ? (
        <ErrorState error={pluginsQuery.error} />
      ) : (() => {
        const plugins = (pluginsQuery.data?.plugins ?? []) as PluginInfo[];
        if (plugins.length === 0) return <EmptyState message="No plugins." />;
        return (
          <ul className="catalog-list" aria-label="Plugins">
            {plugins.map((plugin) => (
              <li key={plugin.name} className="catalog-row">
                <div className="catalog-row-main">
                  <span className="catalog-row-title">{plugin.name}</span>
                  <span className={`catalog-chip${plugin.enabled ? " catalog-chip--ok" : ""}`}>
                    {plugin.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <div className="catalog-row-meta">
                  {plugin.version ? <span className="catalog-meta-item">v{plugin.version}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        );
      })()}

      {canCommands ? (
        <>
          <SectionHeader title="Commands" />
          {commandsQuery.isLoading ? (
            <EmptyState message="Loading commands…" />
          ) : commandsQuery.isError ? (
            <ErrorState error={commandsQuery.error} />
          ) : (() => {
            const commands = (commandsQuery.data?.commands ?? []) as SlashCommandInfo[];
            if (commands.length === 0) return <EmptyState message="No commands." />;
            return (
              <ul className="catalog-list" aria-label="Commands">
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
