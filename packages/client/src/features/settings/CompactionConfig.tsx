import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SMART_COMPACT_THINKING_LEVELS,
  type BuiltInCapabilityId,
  type CompactionSettingsMutation,
  type CompactionSettingsWire,
  type SmartCompactThinkingLevelWire,
} from "@fffattiger/pix-protocol";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { SettingToggle } from "@/components/SettingToggle";
import { useSettingsDraft } from "./settings-draft";
import {
  SettingsField,
  SettingsNumInput,
  SettingsSaveBar,
  SettingsSection,
  SettingsSelect,
} from "./settings-ui";
import { CompactionProfileControl } from "./compaction-profile-control";

const fieldGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };

const PERCENT_PRESETS = [50, 60, 70, 75, 80, 85, 90, 95];

/** Percent options always include the current value (custom values stay selectable). */
function percentOptions(current: number, label: (value: number) => string) {
  const values = [...new Set([...PERCENT_PRESETS, current])].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: label(value) }));
}

/**
 * 上下文压缩 settings page. One switch — 智能压缩 — and it is the SAME
 * setting as the 能力 page (`pix-builtins.json` `smart_compact`), written
 * through the built-ins mutation. Pi's own auto-compaction has no switch: it
 * always runs, and its token parameters live under 高级. Smart compaction's
 * own settings collapse with the switch; nothing explains the internals.
 */
export function CompactionConfig() {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const id = useId();
  const configurable = can("settings.configure");
  const query = useQuery({ ...createQueryOptions(http).settingsFile.compaction(), enabled: configurable });
  const builtIns = useQuery({ ...createQueryOptions(http).settingsFile.builtIns(), enabled: configurable && can("builtins.configure") });
  const models = useQuery({ ...createQueryOptions(http).models.list(), enabled: configurable && can("models") });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveCompaction());
  const saveBuiltIns = useMutation(createMutationOptions(http, queryClient).settings.saveBuiltIns());
  const [draft, setDraft] = useState<CompactionSettingsMutation | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = save.isPending || saveBuiltIns.isPending || query.isFetching;

  // Same capability row the 能力 page writes. Absent data reads as on — that
  // matches the server default for a missing pix-builtins.json.
  const smartRow = builtIns.data?.capabilities.find((row) => row.id === "smart_compact");
  const smartEnabled = smartRow?.enabled !== false;

  const reload = async () => {
    if (busy) return;
    const result = await query.refetch();
    if (result.isSuccess) {
      setDraft(null);
      setError(null);
      save.reset();
    } else setError(result.error);
  };
  const update = (change: (settings: CompactionSettingsWire) => CompactionSettingsWire) => {
    if (busy || !query.data) return;
    setDraft((current) => {
      const base = current ?? { settings: query.data.settings, expectedRevision: query.data.revision };
      return { ...base, settings: change(base.settings) };
    });
    save.reset();
  };
  const updateNative = (change: (native: CompactionSettingsWire["native"]) => CompactionSettingsWire["native"]) =>
    update((current) => ({ ...current, native: change(current.native) }));
  const updateSmart = (change: (smart: CompactionSettingsWire["smart"]) => CompactionSettingsWire["smart"]) =>
    update((current) => ({ ...current, smart: change(current.smart) }));

  useSettingsDraft("compaction", {
    isDirty: () => draft !== null,
    discard: () => void reload(),
  });

  if (!configurable) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.compactionSettingsTitle")}>
          <p className="workspace-hint">{t("desktop.compactionSettingsUnavailable")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!query.data && query.isPending) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.compactionSettingsTitle")}>
          <p className="workspace-hint" aria-busy="true">{t("desktop.loading")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!query.data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.compactionSettingsTitle")}>
          <p className="workspace-hint workspace-hint--error" role="alert">{t("desktop.compactionSettingsUnavailable")}</p>
          <button type="button" className="settings-retry" onClick={() => void reload()}>{t("desktop.subagentSettingsRetry")}</button>
        </SettingsSection>
      </div>
    );
  }

  const settings = draft?.settings ?? query.data.settings;
  const modelOptions = (() => {
    const options = new Map((models.data?.models ?? []).map((model) => [
      `${model.provider}/${model.id}`,
      { value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.displayName ?? model.id}` },
    ]));
    for (const snapshot of [query.data.settings, settings]) {
      for (const value of [snapshot.smart.summaryModel, snapshot.smart.segmentationModel]) {
        if (value !== null && !options.has(value)) {
          options.set(value, { value, label: t("desktop.subagentSettingsSavedModel", { model: value }) });
        }
      }
    }
    return [...options.values()];
  })();
  const modelField = (fieldId: string, label: string, value: string | null, onChange: (value: string | null) => void) => (
    <SettingsField label={label} htmlFor={fieldId}>
      <SettingsSelect id={fieldId} value={value ?? ""} onChange={(next) => onChange(next || null)} options={modelOptions} emptyLabel={t("desktop.compactionFollowDefault")} disabled={busy || !smartEnabled} />
    </SettingsField>
  );
  const thinkingOptions = SMART_COMPACT_THINKING_LEVELS.map((value) => ({
    value,
    label: t(`desktop.thinking${value === "xhigh" ? "ExtraHigh" : value[0]!.toUpperCase() + value.slice(1)}`),
  }));
  const thinkingField = (fieldId: string, label: string, value: SmartCompactThinkingLevelWire | null, onChange: (value: SmartCompactThinkingLevelWire | null) => void) => (
    <SettingsField label={label} htmlFor={fieldId}>
      <SettingsSelect id={fieldId} value={value ?? ""} disabled={busy || !smartEnabled} emptyLabel={t("desktop.compactionFollowDefault")}
        options={thinkingOptions}
        onChange={(value) => onChange(value === "" ? null : value as SmartCompactThinkingLevelWire)} />
    </SettingsField>
  );
  const displayedError = error ?? (query.isError ? query.error : null);
  const errorText = displayedError instanceof HttpError && displayedError.code === "CONFLICT"
    ? t("desktop.compactionChanged")
    : displayedError
      ? t("desktop.compactionSaveFailed")
      : null;
  const setSmartEnabled = (enabled: boolean) => {
    const current = builtIns.data;
    if (!current || busy) return;
    setError(null);
    saveBuiltIns.mutate({
      expectedRevision: current.revision,
      capabilities: current.capabilities.map((row) => row.id === "smart_compact" satisfies BuiltInCapabilityId ? { ...row, enabled } : row),
    }, {
      onError: (failure) => {
        setError(failure);
        if (failure instanceof HttpError && failure.code === "CONFLICT") void builtIns.refetch();
      },
    });
  };

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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <form
        aria-label={t("desktop.compactionSettingsTitle")}
        aria-busy={busy}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <SettingsSection title={t("desktop.compactionSmartSection")} description={t("desktop.compactionSmartDescription")}>
          <SettingToggle
            checked={smartEnabled}
            onChange={setSmartEnabled}
            label={t("desktop.agentFeature.smartCompact")}
            disabled={busy || !builtIns.data}
          />
          {smartEnabled ? (
          <div style={{ marginTop: 12 }}>
            <SettingToggle
              checked={settings.smart.autoTrigger}
              onChange={(autoTrigger) => updateSmart((current) => ({ ...current, autoTrigger }))}
              label={t("desktop.compactionAutoTrigger")}
              description={t("desktop.compactionAutoTriggerDescription")}
              disabled={busy}
            />
            <div style={{ ...fieldGrid, marginTop: 12 }}>
              <SettingsField label={t("desktop.compactionThreshold")} htmlFor={`${id}-threshold`}>
                <SettingsSelect
                  id={`${id}-threshold`}
                  value={String(settings.smart.minContextPercent)}
                  disabled={busy}
                  options={percentOptions(settings.smart.minContextPercent, (value) => t("desktop.compactionThresholdPercent", { value }))}
                  onChange={(value) => updateSmart((current) => ({ ...current, minContextPercent: Number(value) }))}
                />
              </SettingsField>
              <SettingsField label={t("desktop.compactionProfile")} htmlFor={`${id}-profile`}>
                <CompactionProfileControl
                  id={`${id}-profile`}
                  value={settings.smart.profile}
                  disabled={busy || !smartEnabled}
                  onChange={(profile) => updateSmart((current) => ({ ...current, profile }))}
                />
              </SettingsField>
              {modelField(`${id}-summary-model`, t("desktop.compactionSummaryModel"), settings.smart.summaryModel, (summaryModel) => updateSmart((current) => ({ ...current, summaryModel })))}
              {modelField(`${id}-segmentation-model`, t("desktop.compactionSegmentationModel"), settings.smart.segmentationModel, (segmentationModel) => updateSmart((current) => ({ ...current, segmentationModel })))}
              {thinkingField(`${id}-summary-thinking`, t("desktop.compactionSummaryThinking"), settings.smart.summaryThinkingLevel, (summaryThinkingLevel) => updateSmart((current) => ({ ...current, summaryThinkingLevel })))}
              {thinkingField(`${id}-segmentation-thinking`, t("desktop.compactionSegmentationThinking"), settings.smart.segmentationThinkingLevel, (segmentationThinkingLevel) => updateSmart((current) => ({ ...current, segmentationThinkingLevel })))}
            </div>
          </div>
          ) : null}
        </SettingsSection>

        {smartEnabled ? (
        <SettingsSection
          title={
            <button type="button" className="settings-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
              {t("desktop.compactionAdvancedSection")}
            </button>
          }
        >
          {advancedOpen ? (
            <>
            <div style={fieldGrid}>
              <SettingsField label={t("desktop.compactionReserveTokens")} htmlFor={`${id}-reserve`}>
                <SettingsNumInput
                  id={`${id}-reserve`}
                  value={settings.native.reserveTokens === null ? "" : String(settings.native.reserveTokens)}
                  onChange={(value) => updateNative((current) => ({
                    ...current,
                    reserveTokens: value.trim() === "" ? null : Math.max(0, Math.round(Number(value))),
                  }))}
                  min={0}
                  placeholder={t("desktop.compactionTokensPlaceholder")}
                  disabled={busy}
                />
              </SettingsField>
              <SettingsField label={t("desktop.compactionKeepRecentTokens")} htmlFor={`${id}-keep`}>
                <SettingsNumInput
                  id={`${id}-keep`}
                  value={settings.native.keepRecentTokens === null ? "" : String(settings.native.keepRecentTokens)}
                  onChange={(value) => updateNative((current) => ({
                    ...current,
                    keepRecentTokens: value.trim() === "" ? null : Math.max(0, Math.round(Number(value))),
                  }))}
                  min={0}
                  placeholder={t("desktop.compactionTokensPlaceholder")}
                  disabled={busy}
                />
              </SettingsField>
              {smartEnabled ? (
              <SettingsField label={t("desktop.compactionTimeout")} htmlFor={`${id}-timeout`}>
                <SettingsSelect
                  id={`${id}-timeout`}
                  value={String(settings.smart.autoTriggerTimeoutMs)}
                  disabled={busy}
                  options={[30, 60, 120, 180, 300].map((seconds) => ({
                    value: String(seconds * 1000),
                    label: t("desktop.compactionTimeoutSeconds", { value: seconds }),
                  }))}
                  onChange={(value) => updateSmart((current) => ({ ...current, autoTriggerTimeoutMs: Number(value) }))}
                />
              </SettingsField>
              ) : null}
            </div>
            {smartEnabled ? (
            <div style={{ marginTop: 12 }}>
            <SettingToggle
              checked={settings.smart.backupEnabled}
              onChange={(backupEnabled) => updateSmart((current) => ({ ...current, backupEnabled }))}
              label={t("desktop.compactionBackup")}
              description={t("desktop.compactionBackupDescription")}
              disabled={busy || !smartEnabled}
            />
            <SettingToggle
              checked={settings.smart.scrubSecrets}
              onChange={(scrubSecrets) => updateSmart((current) => ({ ...current, scrubSecrets }))}
              label={t("desktop.compactionScrubSecrets")}
              description={t("desktop.compactionScrubSecretsDescription")}
              disabled={busy || !smartEnabled}
            />
            <SettingToggle
              checked={settings.smart.focusWeighting}
              onChange={(focusWeighting) => updateSmart((current) => ({ ...current, focusWeighting }))}
              label={t("desktop.compactionFocusWeighting")}
              description={t("desktop.compactionFocusWeightingDescription")}
              disabled={busy || !smartEnabled}
            />
            <SettingToggle
              checked={settings.smart.onlineDamageMonitor}
              onChange={(onlineDamageMonitor) => updateSmart((current) => ({ ...current, onlineDamageMonitor }))}
              label={t("desktop.compactionDamageMonitor")}
              description={t("desktop.compactionDamageMonitorDescription")}
              disabled={busy || !smartEnabled}
            />
            <SettingToggle
              checked={settings.smart.adaptiveDamageFeedback}
              onChange={(adaptiveDamageFeedback) => updateSmart((current) => ({ ...current, adaptiveDamageFeedback }))}
              label={t("desktop.compactionDamageFeedback")}
              description={t("desktop.compactionDamageFeedbackDescription")}
              disabled={busy || !smartEnabled}
            />
            </div>
            ) : null}
            </>
          ) : null}
        </SettingsSection>
        ) : null}
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
