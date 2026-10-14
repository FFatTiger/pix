import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LORE_SAAS_BASE_URL,
  MEMORY_PROVIDERS,
  type LoreTestResponse,
  type MemoryProviderWire,
} from "@fffattiger/pix-protocol";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { useSettingsDraft } from "./settings-draft";
import {
  SettingsButton,
  SettingsField,
  SettingsInput,
  SettingsSaveBar,
  SettingsSecretInput,
  SettingsSection,
  SettingsWarningBanner,
  SegmentedControl,
} from "./settings-ui";

/** Lore product links, picked by UI locale (official site, zh-CN has /zh-cn). */
const LORE_LINKS = {
  saas: (locale: string) => (locale === "zh-CN" ? "https://loremem.com/zh-cn" : "https://loremem.com"),
  selfHost: (locale: string) =>
    locale === "zh-CN"
      ? "https://loremem.com/zh-cn/documents/installation/install-lore"
      : "https://loremem.com/documents/installation/install-lore",
  manual: (locale: string) =>
    locale === "zh-CN"
      ? "https://loremem.com/zh-cn/documents/installation/manual-configuration"
      : "https://loremem.com/documents/installation/manual-configuration",
} as const;

const linkStyle = { color: "var(--accent)", textDecoration: "underline" } as const;

interface LoreDraft {
  baseUrl: string;
  /** Empty = keep the saved token (or no token yet). Never prefilled. */
  token: string;
}

/**
 * 记忆 settings page: one three-way provider selection (本地记忆 / Lore /
 * 关闭) — never two independent switches. The bundled pi-memory plugin runs
 * globally with its exit summary off and without semantic search; Lore uses
 * the bundled extension plus the shared ~/.lore/config.json connection
 * (managed here, token write-only). Selecting Lore needs a passing
 * connection test (or an already-configured, untouched connection). Saves
 * apply to NEW sessions and reloads; running sessions keep their loaded
 * memory backend until then.
 */
export function MemoryConfig() {
  const { t, locale } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const configurable = can("settings.configure");
  const query = useQuery({ ...createQueryOptions(http).settingsFile.memory(), enabled: configurable });
  const saveProvider = useMutation(createMutationOptions(http, queryClient).settings.saveMemory());
  const saveConnection = useMutation(createMutationOptions(http, queryClient).settings.saveLoreConnection());
  const testConnection = useMutation(createMutationOptions(http, queryClient).settings.testLoreConnection());

  const [draftProvider, setDraftProvider] = useState<MemoryProviderWire | null>(null);
  const [loreDraft, setLoreDraft] = useState<LoreDraft | null>(null);
  const [testedDraft, setTestedDraft] = useState<string | null>(null);
  const [testFailure, setTestFailure] = useState<LoreTestResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busy = saveProvider.isPending || saveConnection.isPending || testConnection.isPending || query.isFetching;

  const data = query.data;
  const provider = draftProvider ?? data?.provider ?? null;

  const reload = async () => {
    if (busy) return;
    const result = await query.refetch();
    if (result.isSuccess) {
      setDraftProvider(null);
      setLoreDraft(null);
      setTestedDraft(null);
      setTestFailure(null);
      setError(null);
      saveProvider.reset();
    } else setError(result.error);
  };

  const selectProvider = (next: MemoryProviderWire) => {
    if (busy) return;
    setDraftProvider(data !== undefined && next === data.provider ? null : next);
    saveProvider.reset();
  };

  const editLore = (change: (draft: LoreDraft) => LoreDraft) => {
    if (busy || data === undefined) return;
    setLoreDraft((current) => {
      const base = current ?? { baseUrl: data.lore.baseUrl ?? LORE_SAAS_BASE_URL, token: "" };
      return change(base);
    });
    // Any edit invalidates the last test result for the previous values.
    setTestedDraft(null);
    setTestFailure(null);
    saveConnection.reset();
    testConnection.reset();
  };

  const runTest = () => {
    if (busy || data === undefined) return;
    setTestFailure(null);
    setTestedDraft(null);
    testConnection.mutate(loreDraft === null ? {} : {
      baseUrl: loreDraft.baseUrl.trim(),
      ...(loreDraft.token === "" ? {} : { apiToken: loreDraft.token }),
    }, {
      onSuccess: (result) => {
        if (result.ok) setTestedDraft(loreDraft === null ? "" : `${loreDraft.baseUrl.trim()}\n${loreDraft.token}`);
        else setTestFailure(result);
      },
    });
  };

  useSettingsDraft("memory", {
    isDirty: () => draftProvider !== null || loreDraft !== null,
    discard: () => void reload(),
  });

  const loreConfiguredUntouched = data !== undefined && data.lore.configured && loreDraft === null;
  const testedFingerprint = loreDraft === null ? null : `${loreDraft.baseUrl.trim()}\n${loreDraft.token}`;
  const loreVerified = loreConfiguredUntouched || (testedFingerprint !== null && testedFingerprint === testedDraft);

  if (!configurable) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.memorySettingsTitle")} description={t("desktop.memorySettingsDescription")}>
          <p className="workspace-hint">{t("desktop.memorySettingsUnavailable")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!data && query.isPending) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.memorySettingsTitle")} description={t("desktop.memorySettingsDescription")}>
          <p className="workspace-hint" aria-busy="true">{t("desktop.loading")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.memorySettingsTitle")} description={t("desktop.memorySettingsDescription")}>
          <p className="workspace-hint workspace-hint--error" role="alert">{t("desktop.memorySettingsUnavailable")}</p>
          <button type="button" className="settings-retry" onClick={() => void reload()}>{t("desktop.subagentSettingsRetry")}</button>
        </SettingsSection>
      </div>
    );
  }

  const currentProvider = data.provider;
  const displayedError = error ?? (query.isError ? query.error : null);
  const errorText = displayedError instanceof HttpError && displayedError.code === "CONFLICT"
    ? t("desktop.memoryChanged")
    : displayedError
      ? t("desktop.memorySaveFailed")
      : null;

  const connection = loreDraft ?? {
    baseUrl: data.lore.baseUrl ?? LORE_SAAS_BASE_URL,
    token: "",
  };
  const loreDirty = loreDraft !== null;

  const commit = async () => {
    if (busy || (draftProvider === null && loreDraft === null)) return;
    setError(null);
    const targetProvider = draftProvider ?? currentProvider;
    try {
      if (targetProvider === "lore" && loreDirty) {
        await saveConnection.mutateAsync({
          baseUrl: connection.baseUrl.trim(),
          ...(connection.token === "" ? {} : { apiToken: connection.token }),
        });
      }
      await saveProvider.mutateAsync({ expectedRevision: data.revision, provider: targetProvider });
      setDraftProvider(null);
      setLoreDraft(null);
      setTestedDraft(null);
      setTestFailure(null);
    } catch (failure) {
      setError(failure);
      if (failure instanceof HttpError && failure.code === "CONFLICT") void query.refetch();
    }
  };

  const testReasonText = (reason: Exclude<LoreTestResponse, { ok: true }>["reason"]) =>
    t(`desktop.memoryLoreTest_${reason}`);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <form
        aria-label={t("desktop.memorySettingsTitle")}
        aria-busy={busy}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <SettingsSection title={t("desktop.memoryProviderSection")} description={t("desktop.memorySettingsDescription")}>
          <SettingsField label={t("desktop.memoryProviderLabel")}>
            <SegmentedControl<MemoryProviderWire>
              value={provider ?? "local"}
              disabled={busy}
              ariaLabel={t("desktop.memoryProviderLabel")}
              options={MEMORY_PROVIDERS.map((value) => ({
                value,
                label: t(`desktop.memoryProvider_${value}`),
              }))}
              onChange={selectProvider}
            />
          </SettingsField>
          <p className="workspace-hint">
            {currentProvider === "lore"
              ? t("desktop.memoryCurrentLore", { baseUrl: data.lore.baseUrl ?? "" })
              : t(`desktop.memoryCurrent_${currentProvider}`)}
          </p>
          {provider !== null && provider !== currentProvider ? (
            <SettingsWarningBanner>
              {currentProvider === "lore" && provider === "local"
                ? t("desktop.memorySwitchLoreToLocal")
                : currentProvider === "local" && provider === "lore"
                  ? t("desktop.memorySwitchLocalToLore")
                  : t("desktop.memorySwitchToOff")}
            </SettingsWarningBanner>
          ) : null}
        </SettingsSection>

        {provider === "local" ? (
          <SettingsSection title={t("desktop.memoryLocalSectionTitle")}>
            <p className="workspace-hint">{t("desktop.memoryLocalDescription")}</p>
          </SettingsSection>
        ) : null}

        {provider === "off" ? (
          <SettingsSection title={t("desktop.memoryOffSectionTitle")}>
            <p className="workspace-hint">{t("desktop.memoryOffDescription")}</p>
          </SettingsSection>
        ) : null}

        {provider === "lore" ? (
          <SettingsSection title={t("desktop.memoryLoreSectionTitle")}>
            <p className="workspace-hint">{t("desktop.memoryLoreIntro")}</p>
            <p className="workspace-hint">
              <a href={LORE_LINKS.saas(locale)} target="_blank" rel="noreferrer" style={linkStyle}>{t("desktop.memoryLoreLinkSaas")}</a>
              <span> · </span>
              <a href={LORE_LINKS.selfHost(locale)} target="_blank" rel="noreferrer" style={linkStyle}>{t("desktop.memoryLoreLinkSelfHost")}</a>
              <span> · </span>
              <a href={LORE_LINKS.manual(locale)} target="_blank" rel="noreferrer" style={linkStyle}>{t("desktop.memoryLoreLinkManual")}</a>
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
              <SettingsField label={t("desktop.memoryLoreBaseUrl")} htmlFor="memory-lore-base-url">
                <SettingsInput
                  id="memory-lore-base-url"
                  value={connection.baseUrl}
                  placeholder={LORE_SAAS_BASE_URL}
                  onChange={(value) => editLore((draft) => ({ ...draft, baseUrl: value }))}
                  disabled={busy}
                />
              </SettingsField>
              <SettingsField label={t("desktop.memoryLoreToken")} htmlFor="memory-lore-token">
                <SettingsSecretInput
                  id="memory-lore-token"
                  value={connection.token}
                  placeholder={data.lore.tokenConfigured ? t("desktop.memoryLoreTokenKept") : "lm_…"}
                  onChange={(value) => editLore((draft) => ({ ...draft, token: value }))}
                  disabled={busy}
                />
              </SettingsField>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <SettingsButton type="button" onClick={runTest} disabled={busy}>
                {t("desktop.memoryLoreTest")}
              </SettingsButton>
              {testConnection.isPending ? <span className="workspace-hint">{t("desktop.memoryLoreTesting")}</span> : null}
              {testConnection.isSuccess && testedDraft !== null ? (
                <span className="workspace-hint">{t("desktop.memoryLoreTestPassed")}</span>
              ) : null}
              {testFailure !== null && testFailure.ok === false ? (
                <span className="workspace-hint workspace-hint--error" role="alert">{testReasonText(testFailure.reason)}</span>
              ) : null}
            </div>
            {!loreVerified && provider === "lore" ? (
              <SettingsWarningBanner>{t("desktop.memoryLoreNeedsTest")}</SettingsWarningBanner>
            ) : null}
          </SettingsSection>
        ) : null}
      </form>
      <SettingsSaveBar
        dirty={draftProvider !== null || loreDraft !== null}
        busy={busy}
        saveDisabled={provider === "lore" && !loreVerified}
        saving={saveProvider.isPending || saveConnection.isPending}
        error={errorText}
        saved={saveProvider.isSuccess && draftProvider === null && loreDraft === null && !errorText}
        onSave={() => void commit()}
        onDiscard={() => void reload()}
      />
    </div>
  );
}
