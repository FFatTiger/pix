import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SkillInfo, SlashCommandInfo } from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { describeCatalogError } from "@/features/catalog/catalog-errors";
import { useI18n } from "@/hooks/useI18n";
import { SettingsSection } from "./settings-ui";

/** Commands owned by a skill, shown as small chips on the skill row itself. */
function skillCommandNames(skill: SkillInfo, commands: readonly SlashCommandInfo[]): string[] {
  return commands
    .filter((command) => command.source === "skill" && (command.name === skill.name || command.name === `skill:${skill.name}`))
    .map((command) => `/${command.name}`);
}

/** Long descriptions clamp to two lines; one click expands the full text. */
function ClampedDescription({ text }: { text: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const expandable = text.length > 100;
  return (
    <div className="catalog-row-meta">
      <span className={expanded ? "catalog-meta-item catalog-meta-item--wrap" : "catalog-meta-item catalog-meta-item--wrap settings-clamp"}>
        {text}
      </span>
      {expandable ? (
        <button
          type="button"
          className="settings-clamp-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("desktop.collapse") : t("desktop.expand")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Skills page: the global on-disk skill catalog plus the slash-command
 * catalog. A skill's own commands appear as chips on its row; the commands
 * section lists only commands that do not come from a skill, so no entry
 * exists twice. Plugin packages are listed on their own page.
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

  const skills = (skillsQuery.data?.skills ?? []) as SkillInfo[];
  const commands = (commandsQuery.data?.commands ?? []) as SlashCommandInfo[];
  const skillOwned = new Set(
    skills.flatMap((skill) => [skill.name, `skill:${skill.name}`]),
  );
  const otherCommands = commands.filter((command) => !(command.source === "skill" && skillOwned.has(command.name)));

  const skillsBody = !canSkills ? (
    <p className="workspace-hint">{t("desktop.catalog.notAvailable", { what: t("desktop.catalog.skills") })}</p>
  ) : skillsQuery.isPending ? (
    <p className="workspace-hint">{t("desktop.catalog.loading", { what: t("desktop.catalog.skills") })}</p>
  ) : skillsQuery.isError ? (
    <p className="workspace-hint workspace-hint--error" role="alert">{describeCatalogError(skillsQuery.error)}</p>
  ) : skills.length === 0 ? (
    <p className="workspace-hint">{t("desktop.catalog.empty", { what: t("desktop.catalog.skills") })}</p>
  ) : (
    <ul className="catalog-list" aria-label={t("desktop.catalog.skills")}>
      {skills.map((skill) => {
        const chips = skillCommandNames(skill, commands);
        return (
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
              {chips.map((chip) => <code key={chip} className="settings-command-chip">{chip}</code>)}
            </div>
            {skill.description ? <ClampedDescription text={skill.description} /> : null}
          </li>
        );
      })}
    </ul>
  );

  // Honest lifecycle: the section renders while commands are pending or
  // failed (loading/error copy), and hides only on a successful empty read —
  // never silently swallowing a failed query behind a hidden section.
  const showCommandsSection = canCommands && (!commandsQuery.isSuccess || otherCommands.length > 0);
  const commandsBody = !canCommands ? null : commandsQuery.isPending ? (
    <p className="workspace-hint">{t("desktop.catalog.loading", { what: t("desktop.catalog.commands") })}</p>
  ) : commandsQuery.isError ? (
    <p className="workspace-hint workspace-hint--error" role="alert">{describeCatalogError(commandsQuery.error)}</p>
  ) : showCommandsSection ? (
    <ul className="catalog-list" aria-label={t("desktop.catalog.commands")}>
      {otherCommands.map((command) => (
        <li key={`${command.source}:${command.name}`} className="catalog-row">
          <div className="catalog-row-main">
            <span className="catalog-row-title">/{command.name}</span>
            <span className="catalog-chip">{command.source}</span>
          </div>
          {command.description ? (
            <ClampedDescription text={command.description} />
          ) : null}
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection>
        {skillsBody}
      </SettingsSection>
      {showCommandsSection ? (
        <SettingsSection title={t("desktop.catalog.commands")} description={t("desktop.commandsSectionDescription")}>
          {commandsBody}
        </SettingsSection>
      ) : null}
    </div>
  );
}
