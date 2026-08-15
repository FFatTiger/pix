import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Cpu, Plug, Puzzle, Stack, TerminalWindow, X } from "@phosphor-icons/react";
import type { AuthProviderInfo, ModelInfo, PluginInfo, SkillInfo, SlashCommandInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import type { AuthProviderStatusResponse, ModelsResponse } from "@/api/schemas";
import { describeCatalogError } from "./catalog-errors";
import { TrustBadge } from "./TrustBadge";

export type CatalogTab = "models" | "providers" | "skills" | "plugins" | "commands";

export interface CatalogPanelProps {
  cwd: string | undefined;
  open: boolean;
  onClose: () => void;
}

const TAB_ORDER: readonly CatalogTab[] = ["models", "providers", "skills", "plugins", "commands"];

const TAB_LABEL: Record<CatalogTab, string> = {
  models: "Models",
  providers: "Providers",
  skills: "Skills",
  plugins: "Plugins",
  commands: "Commands",
};

/** Reference tab grammar: compact leading icon per section. */
const TAB_ICON: Record<CatalogTab, typeof Cpu> = {
  models: Cpu,
  providers: Plug,
  skills: Stack,
  plugins: Puzzle,
  commands: TerminalWindow,
};

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

function ModelsTab({ cwd, enabled }: { cwd: string | undefined; enabled: boolean }) {
  const http = useHttpClient();
  const canFetch = enabled && Boolean(cwd);
  const query = useQuery({
    ...createQueryOptions(http).models.list(cwd ?? ""),
    enabled: canFetch,
  });

  if (!cwd) return <EmptyState message="Open a project to browse models." />;
  if (!enabled) return <EmptyState message="Models catalog is not available." />;
  if (query.isLoading) return <EmptyState message="Loading models…" />;
  if (query.isError) return <ErrorState error={query.error} />;

  const data = query.data as ModelsResponse | undefined;
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
}

function ProvidersTab({ enabled }: { enabled: boolean }) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  const providersQuery = useQuery({
    ...options.auth.providers(),
    enabled,
  });

  const providers = (providersQuery.data?.providers ?? []) as AuthProviderInfo[];
  const statusQueries = useQueries({
    queries: providers.map((provider) => ({
      ...options.auth.providerStatus(provider.id),
      enabled: enabled && Boolean(provider.id),
    })),
  });

  if (!enabled) return <EmptyState message="Providers catalog is not available." />;
  if (providersQuery.isLoading) return <EmptyState message="Loading providers…" />;
  if (providersQuery.isError) return <ErrorState error={providersQuery.error} />;
  if (providers.length === 0) return <EmptyState message="No providers." />;

  return (
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
  );
}

function SkillsTab({ cwd, enabled }: { cwd: string | undefined; enabled: boolean }) {
  const http = useHttpClient();
  const canFetch = enabled && Boolean(cwd);
  const query = useQuery({
    ...createQueryOptions(http).skills.list(cwd ?? ""),
    enabled: canFetch,
  });

  if (!cwd) return <EmptyState message="Open a project to browse skills." />;
  if (!enabled) return <EmptyState message="Skills catalog is not available." />;
  if (query.isLoading) return <EmptyState message="Loading skills…" />;
  if (query.isError) return <ErrorState error={query.error} />;

  const skills = (query.data?.skills ?? []) as SkillInfo[];
  if (skills.length === 0) return <EmptyState message="No skills." />;

  return (
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
  );
}

function PluginsTab({ cwd, enabled }: { cwd: string | undefined; enabled: boolean }) {
  const http = useHttpClient();
  const canFetch = enabled && Boolean(cwd);
  const query = useQuery({
    ...createQueryOptions(http).plugins.list(cwd ?? ""),
    enabled: canFetch,
  });

  if (!cwd) return <EmptyState message="Open a project to browse plugins." />;
  if (!enabled) return <EmptyState message="Plugins catalog is not available." />;
  if (query.isLoading) return <EmptyState message="Loading plugins…" />;
  if (query.isError) return <ErrorState error={query.error} />;

  const plugins = (query.data?.plugins ?? []) as PluginInfo[];
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
}

function CommandsTab({ cwd, enabled }: { cwd: string | undefined; enabled: boolean }) {
  const http = useHttpClient();
  const canFetch = enabled && Boolean(cwd);
  const query = useQuery({
    ...createQueryOptions(http).commands.list(cwd ?? ""),
    enabled: canFetch,
  });

  if (!cwd) return <EmptyState message="Open a project to browse commands." />;
  if (!enabled) return <EmptyState message="Commands catalog is not available." />;
  if (query.isLoading) return <EmptyState message="Loading commands…" />;
  if (query.isError) return <ErrorState error={query.error} />;

  const commands = (query.data?.commands ?? []) as SlashCommandInfo[];
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
}

/**
 * Independent right-side Catalog dock. Capability-gated tabs only; no mutation
 * controls. Mutual exclusion with WorkspacePanel is owned by AppShell.
 */
export function CatalogPanel({ cwd, open, onClose }: CatalogPanelProps) {
  const { can } = useCapabilities();
  const canModels = can("models");
  const canProviders = can("auth.providers");
  const canSkills = can("skills");
  const canPlugins = can("plugins");
  const canCommands = canSkills || canPlugins;
  const canAny = canModels || canProviders || canSkills || canPlugins;
  const showTrust = (canSkills || canPlugins) && Boolean(cwd);

  const availableTabs = useMemo(() => {
    const tabs: CatalogTab[] = [];
    if (canModels) tabs.push("models");
    if (canProviders) tabs.push("providers");
    if (canSkills) tabs.push("skills");
    if (canPlugins) tabs.push("plugins");
    if (canCommands) tabs.push("commands");
    return tabs;
  }, [canModels, canProviders, canSkills, canPlugins, canCommands]);

  const [tab, setTab] = useState<CatalogTab>(() => availableTabs[0] ?? "models");

  // Keep the active tab valid as capabilities change (e.g. host retracts a cap).
  useEffect(() => {
    if (availableTabs.length === 0) return;
    if (!availableTabs.includes(tab)) setTab(availableTabs[0]!);
  }, [availableTabs, tab]);

  // Cap revocation: panel returns null; caller should also close via effect.
  if (!canAny) return null;
  if (!open) return null;

  return (
    <aside className="workspace-panel catalog-panel" aria-label="Catalog">
      <div className="workspace-panel-tabs" role="tablist" aria-label="Catalog sections">
        {TAB_ORDER.filter((id) => availableTabs.includes(id)).map((id) => {
          const Icon = TAB_ICON[id];
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`catalog-tab-${id}`}
              aria-controls={`catalog-panel-${id}`}
              aria-selected={active}
              className={`workspace-panel-tab${active ? " workspace-panel-tab--active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon size={13} aria-hidden="true" />
              <span className="workspace-panel-tab-label">{TAB_LABEL[id]}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="icon-btn workspace-panel-close"
          aria-label="Close catalog panel"
          title="Close catalog panel"
          onClick={onClose}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      {showTrust ? (
        <header className="workspace-panel-header catalog-panel-header">
          <TrustBadge cwd={cwd} variant="summary" />
        </header>
      ) : null}
      <div
        className="workspace-panel-body"
        role="tabpanel"
        id={`catalog-panel-${tab}`}
        aria-labelledby={`catalog-tab-${tab}`}
      >
        {tab === "models" && canModels ? <ModelsTab cwd={cwd} enabled={canModels} /> : null}
        {tab === "providers" && canProviders ? <ProvidersTab enabled={canProviders} /> : null}
        {tab === "skills" && canSkills ? <SkillsTab cwd={cwd} enabled={canSkills} /> : null}
        {tab === "plugins" && canPlugins ? <PluginsTab cwd={cwd} enabled={canPlugins} /> : null}
        {tab === "commands" && canCommands ? <CommandsTab cwd={cwd} enabled={canCommands} /> : null}
      </div>
    </aside>
  );
}

/** True when any catalog capability token is present. */
export function hasCatalogCapability(can: (cap: "models" | "auth.providers" | "skills" | "plugins") => boolean): boolean {
  return can("models") || can("auth.providers") || can("skills") || can("plugins");
}
