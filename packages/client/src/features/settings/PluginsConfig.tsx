import { useQuery } from "@tanstack/react-query";
import type { PluginInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { describeCatalogError } from "@/features/catalog/catalog-errors";
import { useI18n } from "@/hooks/useI18n";
import { SettingsSection } from "./settings-ui";

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
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.catalog.plugins")} description={t("desktop.pluginsSectionDescription")}>
        {pluginsBody}
      </SettingsSection>
    </div>
  );
}
