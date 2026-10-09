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
import { SettingsButton, SettingsField, SettingsSection, SettingsSelect } from "./settings-ui";

const ROLES = ["general-purpose", "Explore", "Plan", "verification"] as const;
const fieldGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };

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

  if (!configurable) return <p className="workspace-hint">{t("desktop.subagentSettingsUnavailable")}</p>;
  if (!query.data && query.isPending) return <p className="workspace-hint" aria-busy="true">{t("desktop.loading")}</p>;
  if (!query.data) return (
    <SettingsSection title={t("desktop.subagentSettingsTitle")} description={t("desktop.subagentSettingsDescription")}>
      <p className="workspace-hint workspace-hint--error" role="alert">{t(describeSubagentSettingsError(query.error))}</p>
      <SettingsButton disabled={busy} onClick={() => void reload()}>{t("desktop.subagentSettingsRetry")}</SettingsButton>
    </SettingsSection>
  );

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

  return (
    <form aria-label={t("desktop.subagentSettingsTitle")} aria-busy={busy} onSubmit={(event) => {
      event.preventDefault();
      if (!draft || busy) return;
      setError(null);
      save.mutate(draft, {
        onSuccess: () => setDraft(null),
        onError: (failure) => {
          setError(failure);
          if (failure instanceof HttpError && failure.code === "CONFLICT") void query.refetch();
        },
      });
    }}>
      <SettingsSection title={t("desktop.subagentSettingsTitle")} description={t("desktop.subagentSettingsDescription")}>
        {!can("models") || models.isError ? <p className="workspace-hint" role="status">{t("desktop.subagentModelsUnavailable")}</p>
          : models.isPending ? <p className="workspace-hint" role="status">{t("desktop.subagentModelsLoading")}</p> : null}
        <div style={fieldGrid}>
          {modelField(`${id}-default`, t("desktop.subagentSettingsDefaultModel"), settings.defaultModel, t("desktop.subagentSettingsParentModel"), (defaultModel) => update((current) => ({ ...current, defaultModel })))}
          {modelField(`${id}-fallback`, t("desktop.subagentSettingsGlobalFallback"), settings.fallbackModel, t("desktop.subagentSettingsNoFallback"), (fallbackModel) => update((current) => ({ ...current, fallbackModel })))}
        </div>
        <p className="workspace-hint">{t("desktop.subagentSettingsFallbackHint")}</p>
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
          <SettingsSection key={name} title={t("desktop.subagentSettingsRole", { name })} description={t("desktop.subagentSettingsRoleDescription")}>
            <div style={fieldGrid}>
              {modelField(`${id}-${index}-model`, t("desktop.subagentSettingsRoleModel", { name }), row?.model ?? null, t("desktop.subagentSettingsInherit"), (model) => updateRole({ model }))}
              {modelField(`${id}-${index}-fallback`, t("desktop.subagentSettingsRoleFallback", { name }), row?.fallbackModel ?? null, t("desktop.subagentSettingsInherit"), (fallbackModel) => updateRole({ fallbackModel }))}
              <SettingsField label={t("desktop.subagentSettingsRoleThinking", { name })} htmlFor={`${id}-${index}-thinking`}>
                <SettingsSelect id={`${id}-${index}-thinking`} value={row?.thinking ?? ""} disabled={busy} emptyLabel={t("desktop.subagentSettingsInherit")}
                  options={ThinkingLevelSchema.options.map((value) => ({ value, label: t(`desktop.thinking${value === "xhigh" ? "ExtraHigh" : value[0]!.toUpperCase() + value.slice(1)}`) }))}
                  onChange={(value) => updateRole({ thinking: value === "" ? null : ThinkingLevelSchema.parse(value) })} />
              </SettingsField>
            </div>
          </SettingsSection>
        );
      })}
      <footer className="models-config-footer" style={{ flexWrap: "wrap" }}>
        <span className="models-save-status" role={displayedError ? "alert" : "status"} style={{ flexBasis: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {displayedError ? t(describeSubagentSettingsError(displayedError)) : save.isSuccess && !draft ? t("desktop.modelsSaved") : ""}
        </span>
        <SettingsButton disabled={busy} onClick={() => void reload()}>{t("desktop.subagentSettingsReload")}</SettingsButton>
        <SettingsButton variant="primary" type="submit" disabled={!draft || busy}>{save.isPending ? t("desktop.modelsSaving") : t("desktop.modelsSave")}</SettingsButton>
      </footer>
    </form>
  );
}
