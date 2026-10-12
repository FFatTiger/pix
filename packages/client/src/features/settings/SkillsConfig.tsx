import { useQuery } from "@tanstack/react-query";
import type { SkillInfo, SlashCommandInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { describeCatalogError } from "@/features/catalog/catalog-errors";
import { useI18n } from "@/hooks/useI18n";
import { SettingsSection } from "./settings-ui";

/**
 * Skills page: the global on-disk skill catalog plus the slash-command
 * catalog. Commands live here (not on the plugins page) so each list exists
 * exactly once; plugin packages are listed on their own page.
 */
export function SkillsConfig() {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const canSkills = can("skills");
  const canCommands = can("skills") || can("plugins");

  const skillsQuery = useQuery({
    ...createQueryOptions(http).skills.list(),
    enabled: canSkills,
  });
  const commandsQuery = useQuery({
    ...createQueryOptions(http).commands.list(),
    enabled: canCommands,
  });

  const skillsBody = !canSkills ? (
    <p className="workspace-hint">{t("desktop.catalog.notAvailable", { what: t("desktop.catalog.skills") })}</p>
  ) : skillsQuery.isPending ? (
    <p className="workspace-hint">{t("desktop.catalog.loading", { what: t("desktop.catalog.skills") })}</p>
  ) : skillsQuery.isError ? (
    <p className="workspace-hint workspace-hint--error" role="alert">{describeCatalogError(skillsQuery.error)}</p>
  ) : (() => {
    const skills = (skillsQuery.data?.skills ?? []) as SkillInfo[];
    if (skills.length === 0) return <p className="workspace-hint">{t("desktop.catalog.empty", { what: t("desktop.catalog.skills") })}</p>;
    return (
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
    );
  })();

  const commandsBody = !canCommands ? null : commandsQuery.isPending ? (
    <p className="workspace-hint">{t("desktop.catalog.loading", { what: t("desktop.catalog.commands") })}</p>
  ) : commandsQuery.isError ? (
    <p className="workspace-hint workspace-hint--error" role="alert">{describeCatalogError(commandsQuery.error)}</p>
  ) : (() => {
    const commands = (commandsQuery.data?.commands ?? []) as SlashCommandInfo[];
    if (commands.length === 0) return <p className="workspace-hint">{t("desktop.catalog.empty", { what: t("desktop.catalog.commands") })}</p>;
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
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.catalog.skills")} description={t("desktop.skillsSectionDescription")}>
        {skillsBody}
      </SettingsSection>
      {canCommands ? (
        <SettingsSection title={t("desktop.catalog.commands")} description={t("desktop.commandsSectionDescription")}>
          {commandsBody}
        </SettingsSection>
      ) : null}
    </div>
  );
}
