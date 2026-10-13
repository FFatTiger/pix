import { useQuery } from "@tanstack/react-query";
import type { PluginInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { describeCatalogError } from "@/features/catalog/catalog-errors";
import { useI18n } from "@/hooks/useI18n";
import { SettingsBadge, SettingsSection } from "./settings-ui";

type PluginSource = "npm" | "github" | "git" | "local";

interface PluginDisplay {
  title: string;
  source: PluginSource | null;
}

/**
 * Raw plugin names arrive as storage references ("npm:pkg@version", git URLs,
 * or local paths). Show the human package name; keep where it comes from as
 * secondary metadata.
 */
export function pluginDisplayName(name: string): PluginDisplay {
  if (name.startsWith("npm:")) {
    const rest = name.slice(4);
    const match = rest.match(/^(?:@([^/@\s]+)\/)?([^@\s]+)(?:@.*)?$/);
    const title = match ? (match[1] ? `@${match[1]}/${match[2]}` : match[2]!) : rest;
    return { title, source: "npm" };
  }
  const github = name.match(/github\.com[/:]([^/\s]+)\/([^/#?\s]+)/);
  if (github) return { title: github[2]!.replace(/\.git$/, ""), source: "github" };
  if (/^(?:git\+)?https?:\/\//.test(name)) {
    const tail = name.split(/[/?#]/).filter(Boolean).pop() ?? name;
    return { title: tail.replace(/\.git$/, ""), source: "git" };
  }
  return { title: name, source: null };
}

/**
 * Plugins page: the global plugin-package catalog only. Commands are listed
 * on the Skills page — never duplicated here.
 */
export function PluginsConfig() {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const canPlugins = can("plugins");

  const pluginsQuery = useQuery({
    ...createQueryOptions(http).plugins.list(),
    enabled: canPlugins,
  });

  const sourceLabel = (source: PluginSource | null): string | null => {
    if (source === "npm") return "npm";
    if (source === "github") return "GitHub";
    if (source === "git") return t("desktop.pluginSourceGit");
    if (source === null) return null;
    return source;
  };

  const pluginsBody = !canPlugins ? (
    <p className="workspace-hint">{t("desktop.catalog.notAvailable", { what: t("desktop.catalog.plugins") })}</p>
  ) : pluginsQuery.isPending ? (
    <p className="workspace-hint">{t("desktop.catalog.loading", { what: t("desktop.catalog.plugins") })}</p>
  ) : pluginsQuery.isError ? (
    <p className="workspace-hint workspace-hint--error" role="alert">{describeCatalogError(pluginsQuery.error)}</p>
  ) : (() => {
    const plugins = (pluginsQuery.data?.plugins ?? []) as PluginInfo[];
    if (plugins.length === 0) return <p className="workspace-hint">{t("desktop.catalog.empty", { what: t("desktop.catalog.plugins") })}</p>;
    return (
      <ul className="catalog-list" aria-label={t("desktop.catalog.plugins")}>
        {plugins.map((plugin) => {
          const display = pluginDisplayName(plugin.name);
          const source = sourceLabel(display.source);
          return (
            <li key={plugin.name} className="catalog-row">
              <div className="catalog-row-main">
                <span className="catalog-row-title">{display.title}</span>
                {plugin.enabled ? null : <SettingsBadge tone="warning">{t("desktop.catalog.disabled")}</SettingsBadge>}
              </div>
              <div className="catalog-row-meta">
                {source ? <SettingsBadge>{source}</SettingsBadge> : null}
                {plugin.version ? <span className="catalog-meta-item">{t("desktop.catalog.version", { version: plugin.version })}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection>
        {pluginsBody}
      </SettingsSection>
    </div>
  );
}
