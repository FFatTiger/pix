import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ThinkingLevelSchema, type SubagentSettingsMutation, type SubagentSettingsWire } from "@fffattiger/pix-protocol";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { describeSubagentSettingsError } from "@/lib/subagent-settings-errors";
import { useSettingsDraft } from "./settings-draft";
import { SettingsButton, SettingsField, SettingsSaveBar, SettingsSection, SettingsSelect } from "./settings-ui";

const ROLES = ["general-purpose", "Explore", "Plan", "verification"] as const;
const fieldGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };

/** Localized display name for a known subagent type; null for custom roles. */
function roleDisplayName(t: ReturnType<typeof useI18n>["t"], name: string): string | null {
  switch (name) {
    case "general-purpose": return t("desktop.subagentRole.general-purpose");
    case "Explore": return t("desktop.subagentRole.Explore");
    case "Plan": return t("desktop.subagentRole.Plan");
    case "verification": return t("desktop.subagentRole.verification");
    default: return null;
  }
}

function SubagentRoleSection({ name, children }: { name: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const displayName = roleDisplayName(t, name);
  const title = displayName && displayName !== name
    ? t("desktop.subagentRoleTitle", { name: displayName, id: name })
    : name;
  return (
    <SettingsSection title={title}>
      {children}
    </SettingsSection>
  );
}

/**
 * Subagents page: default/fallback models for subagent launches plus
 * per-type overrides (model / fallback / thinking effort). Draft-based with
 * the shared save bar; "follow default" leaves a slot null so the agent
 * definition or project settings decide.
 */
export function SubagentSettingsConfig() {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const id = useId();
  const configurable = can("settings.configure");
  const query = useQuery({ ...createQueryOptions(http).settingsFile.subagents(), enabled: configurable });
  const models = useQuery({ ...createQueryOptions(http).models.list(), enabled: configurable && can("models") });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveSubagents());
  const [draft, setDraft] = useState<SubagentSettingsMutation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busy = save.isPending || query.isFetching;

  const reload = async () => {
    if (busy) return;
    const result = await query.refetch();
    if (result.isSuccess) {
      setDraft(null);
      setError(null);
      save.reset();
    } else setError(result.error);
  };
  const update = (change: (settings: SubagentSettingsWire) => SubagentSettingsWire) => {
    if (busy || !query.data) return;
    setDraft((current) => {
      // Pin the complete snapshot and CAS revision only on the first edit.
      const base = current ?? { settings: query.data.settings, expectedRevision: query.data.revision };
      return { ...base, settings: change(base.settings) };
    });
    save.reset();
  };

  useSettingsDraft("subagents", {
    isDirty: () => draft !== null,
    discard: () => void reload(),
  });

  if (!configurable) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.subagentSettingsTitle")} description={t("desktop.subagentSettingsDescription")}>
          <p className="workspace-hint">{t("desktop.subagentSettingsUnavailable")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!query.data && query.isPending) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.subagentSettingsTitle")} description={t("desktop.subagentSettingsDescription")}>
          <p className="workspace-hint" aria-busy="true">{t("desktop.loading")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!query.data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.subagentSettingsTitle")} description={t("desktop.subagentSettingsDescription")}>
          <p className="workspace-hint workspace-hint--error" role="alert">{t(describeSubagentSettingsError(query.error))}</p>
          <SettingsButton disabled={busy} onClick={() => void reload()}>{t("desktop.subagentSettingsRetry")}</SettingsButton>
        </SettingsSection>
      </div>
    );
  }

  const settings = draft?.settings ?? query.data.settings;
  const roles = [...new Set<string>([...ROLES, ...settings.agentOverrides.map((row) => row.name)])];
  const options = new Map((models.data?.models ?? []).map((model) => [
    `${model.provider}/${model.id}`,
    { value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.displayName ?? model.id}` },
  ]));
  for (const snapshot of [query.data.settings, settings]) {
    for (const value of [snapshot.defaultModel, snapshot.fallbackModel, ...snapshot.agentOverrides.flatMap((row) => [row.model, row.fallbackModel])]) {
      if (value !== null && !options.has(value)) options.set(value, { value, label: t("desktop.subagentSettingsSavedModel", { model: value }) });
    }
  }
  const modelOptions = [...options.values()];
  const modelField = (fieldId: string, label: string, value: string | null, emptyLabel: string, onChange: (value: string | null) => void) => (
    <SettingsField label={label} htmlFor={fieldId}>
      <SettingsSelect id={fieldId} value={value ?? ""} onChange={(next) => onChange(next || null)} options={modelOptions} emptyLabel={emptyLabel} disabled={busy} />
    </SettingsField>
  );
  const displayedError = error ?? (query.isError ? query.error : null);
  const errorText = displayedError ? t(describeSubagentSettingsError(displayedError)) : null;
  const commit = () => {
    if (!draft || busy) return;
    setError(null);
    save.mutate(draft, {
      onSuccess: () => setDraft(null),
      onError: (failure) => {
        setError(failure);
        if (failure instanceof HttpError && failure.code === "CONFLICT") void query.refetch();
      },
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
      <form
        aria-label={t("desktop.subagentSettingsTitle")}
        aria-busy={busy}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <SettingsSection title={t("desktop.subagentDefaultsSection")} description={t("desktop.subagentSettingsDescription")}>
          {!can("models") || models.isError ? <p className="workspace-hint" role="status">{t("desktop.subagentModelsUnavailable")}</p>
            : models.isPending ? <p className="workspace-hint" role="status">{t("desktop.subagentModelsLoading")}</p> : null}
          <div style={fieldGrid}>
            {modelField(`${id}-default`, t("desktop.subagentSettingsDefaultModel"), settings.defaultModel, t("desktop.subagentSettingsParentModel"), (defaultModel) => update((current) => ({ ...current, defaultModel })))}
            <SettingsField label={t("desktop.subagentFieldFallback")} htmlFor={`${id}-fallback`}>
              <SettingsSelect id={`${id}-fallback`} value={settings.fallbackModel ?? ""} onChange={(next) => update((current) => ({ ...current, fallbackModel: next || null }))} options={modelOptions} emptyLabel={t("desktop.subagentSettingsNoFallback")} disabled={busy} />
              <p className="models-field-hint" style={{ margin: "5px 0 0" }}>{t("desktop.subagentSettingsFallbackHint")}</p>
            </SettingsField>
          </div>
        </SettingsSection>
        {roles.map((name, index) => {
          const row = settings.agentOverrides.find((candidate) => candidate.name === name);
          const updateRole = (patch: Partial<Omit<SubagentSettingsWire["agentOverrides"][number], "name">>) => update((current) => {
            const existing = current.agentOverrides.find((candidate) => candidate.name === name);
            return {
              ...current,
              agentOverrides: existing
                ? current.agentOverrides.map((candidate) => candidate.name === name ? { ...candidate, ...patch } : candidate)
                : [...current.agentOverrides, { name, model: null, fallbackModel: null, thinking: null, ...patch }],
            };
          });
          return (
            <SubagentRoleSection key={name} name={name}>
              <div style={fieldGrid}>
                {modelField(`${id}-${index}-model`, t("desktop.subagentFieldModel"), row?.model ?? null, t("desktop.subagentSettingsInherit"), (model) => updateRole({ model }))}
                {modelField(`${id}-${index}-fallback`, t("desktop.subagentFieldFallback"), row?.fallbackModel ?? null, t("desktop.subagentSettingsInherit"), (fallbackModel) => updateRole({ fallbackModel }))}
                <SettingsField label={t("desktop.subagentFieldThinking")} htmlFor={`${id}-${index}-thinking`}>
                  <SettingsSelect id={`${id}-${index}-thinking`} value={row?.thinking ?? ""} disabled={busy} emptyLabel={t("desktop.subagentSettingsInherit")}
                    options={ThinkingLevelSchema.options.map((value) => ({ value, label: t(`desktop.thinking${value === "xhigh" ? "ExtraHigh" : value[0]!.toUpperCase() + value.slice(1)}`) }))}
                    onChange={(value) => updateRole({ thinking: value === "" ? null : ThinkingLevelSchema.parse(value) })} />
                </SettingsField>
              </div>
            </SubagentRoleSection>
          );
        })}
      </form>
      <SettingsSaveBar
        dirty={draft !== null}
        busy={busy}
        saving={save.isPending}
        error={errorText}
        saved={save.isSuccess && draft === null && !errorText}
        onSave={commit}
        onDiscard={() => void reload()}
      />
    </div>
  );
}
