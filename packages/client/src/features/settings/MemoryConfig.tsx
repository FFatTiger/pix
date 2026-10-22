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
  SegmentedControl,
} from "./settings-ui";

/** Lore product links, picked by UI locale (official site, zh-CN has /zh-cn). */
const LORE_LINKS = {
  saas: () => "https://app.loremem.com/login",
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

/** Where the Lore server lives: the hosted service or the user's own server. */
type LoreDeployment = "saas" | "self";
const LORE_DEPLOYMENTS: readonly LoreDeployment[] = ["saas", "self"];

const normalizeBase = (value: string) => value.trim().replace(/\/+$/, "");

/** A saved base equal to the hosted endpoint (or none yet) reads as SaaS. */
function deploymentOf(baseUrl: string | null): LoreDeployment {
  return baseUrl === null || normalizeBase(baseUrl) === LORE_SAAS_BASE_URL ? "saas" : "self";
}

/**
 * Fixed copy for a test/save REQUEST failure (the probe's own outcome is a
 * 200 result with a reason; this covers the transport/route rejecting).
 */
function describeLoreRequestError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof HttpError) {
    if (error.status === 429 || error.code === "RATE_LIMITED") return t("desktop.memoryLoreRateLimited");
    if (error.code === "INVALID_INPUT") return t("desktop.memoryLoreInvalidConnection");
    if (error.kind === "network") return t("desktop.memoryLoreHostUnreachable");
    if (error.kind === "timeout") return t("desktop.memoryLoreRequestTimedOut");
  }
  return t("desktop.memoryLoreRequestFailed");
}

interface LoreDraft {
  deployment: LoreDeployment;
  baseUrl: string;
  /** Empty = keep the saved token (or no token yet). Never prefilled. */
  token: string;
}

/**
 * 记忆 settings page: one three-way provider selection (本地记忆 / Lore /
 * 关闭) — never two independent switches. Lore uses the bundled extension
 * plus the shared ~/.lore/config.json connection (managed here, token
 * write-only) and needs a passing connection test, or an already-configured
 * untouched connection, before it can be saved. The page shows no
 * explanatory copy: the rules live in the implementation.
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
  const [testError, setTestError] = useState<unknown>(null);
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
      setTestError(null);
      setError(null);
      saveProvider.reset();
    } else setError(result.error);
  };

  const selectProvider = (next: MemoryProviderWire) => {
    if (busy) return;
    setDraftProvider(data !== undefined && next === data.provider ? null : next);
    // A failure from a previous save attempt belongs to that attempt.
    setError(null);
    saveProvider.reset();
  };

  const editLore = (change: (draft: LoreDraft) => LoreDraft) => {
    if (busy || data === undefined) return;
    setLoreDraft((current) => {
      const base = current ?? {
        deployment: deploymentOf(data.lore.baseUrl),
        baseUrl: data.lore.baseUrl ?? LORE_SAAS_BASE_URL,
        token: "",
      };
      return change(base);
    });
    // Any edit invalidates the last test result for the previous values.
    setTestedDraft(null);
    setTestFailure(null);
    setTestError(null);
    setError(null);
    saveConnection.reset();
    testConnection.reset();
  };

  const selectDeployment = (next: LoreDeployment) => {
    if (busy || data === undefined) return;
    const savedDeployment = deploymentOf(data.lore.baseUrl);
    editLore((draft) => {
      if (draft.deployment === next) return draft;
      // SaaS always targets the hosted endpoint; self-hosting starts from the
      // saved self-hosted address when there is one, otherwise empty.
      const baseUrl = next === "saas"
        ? LORE_SAAS_BASE_URL
        : savedDeployment === "self" ? data.lore.baseUrl ?? "" : "";
      return { ...draft, deployment: next, baseUrl };
    });
  };

  const runTest = () => {
    if (busy || data === undefined) return;
    setTestFailure(null);
    setTestError(null);
    setTestedDraft(null);
    testConnection.mutate(loreDraft === null ? {} : {
      baseUrl: loreDraft.baseUrl.trim(),
      ...(loreDraft.token === "" ? {} : { apiToken: loreDraft.token }),
    }, {
      onSuccess: (result) => {
        if (result.ok) setTestedDraft(loreDraft === null ? "" : `${loreDraft.baseUrl.trim()}\n${loreDraft.token}`);
        else setTestFailure(result);
      },
      onError: (failure) => setTestError(failure),
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
        <SettingsSection title={t("desktop.memorySettingsTitle")}>
          <p className="workspace-hint">{t("desktop.memorySettingsUnavailable")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!data && query.isPending) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.memorySettingsTitle")}>
          <p className="workspace-hint" aria-busy="true">{t("desktop.loading")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title={t("desktop.memorySettingsTitle")}>
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
    : displayedError instanceof HttpError && displayedError.code === "INVALID_INPUT"
      ? t("desktop.memoryLoreInvalidConnection")
      : displayedError
        ? t("desktop.memorySaveFailed")
        : null;

  const connection: LoreDraft = loreDraft ?? {
    deployment: deploymentOf(data.lore.baseUrl),
    baseUrl: data.lore.baseUrl ?? LORE_SAAS_BASE_URL,
    token: "",
  };
  const loreDirty = loreDraft !== null;
  // The saved token only applies to the saved address (server rule): a new
  // address needs its own token, so the placeholder must not claim one.
  const tokenKept = data.lore.tokenConfigured
    && data.lore.baseUrl !== null
    && normalizeBase(connection.baseUrl) === normalizeBase(data.lore.baseUrl);

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
        <SettingsSection title={t("desktop.memoryProviderSection")}>
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
        </SettingsSection>

        {provider === "lore" ? (
          <SettingsSection title={t("desktop.memoryLoreSectionTitle")}>
            <SettingsField label={t("desktop.memoryLoreDeployment")}>
              <SegmentedControl<LoreDeployment>
                value={connection.deployment}
                disabled={busy}
                ariaLabel={t("desktop.memoryLoreDeployment")}
                options={LORE_DEPLOYMENTS.map((value) => ({
                  value,
                  label: t(`desktop.memoryLoreDeployment_${value}`),
                }))}
                onChange={selectDeployment}
              />
            </SettingsField>
            <p className="workspace-hint" style={{ marginTop: 10 }}>
              {connection.deployment === "saas" ? (
                <a href={LORE_LINKS.saas()} target="_blank" rel="noreferrer" style={linkStyle}>{t("desktop.memoryLoreLinkSaas")}</a>
              ) : (
                <>
                  <a href={LORE_LINKS.selfHost(locale)} target="_blank" rel="noreferrer" style={linkStyle}>{t("desktop.memoryLoreLinkSelfHost")}</a>
                  <span> · </span>
                  <a href={LORE_LINKS.manual(locale)} target="_blank" rel="noreferrer" style={linkStyle}>{t("desktop.memoryLoreLinkManual")}</a>
                </>
              )}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
              {connection.deployment === "self" ? (
                <SettingsField label={t("desktop.memoryLoreBaseUrl")} htmlFor="memory-lore-base-url">
                  <SettingsInput
                    id="memory-lore-base-url"
                    value={connection.baseUrl}
                    placeholder="http://192.168.1.10:18901"
                    onChange={(value) => editLore((draft) => ({ ...draft, baseUrl: value }))}
                    disabled={busy}
                  />
                </SettingsField>
              ) : null}
              <SettingsField label={t("desktop.memoryLoreToken")} htmlFor="memory-lore-token">
                <SettingsSecretInput
                  id="memory-lore-token"
                  value={connection.token}
                  placeholder={tokenKept ? t("desktop.memoryLoreTokenKept") : "lm_…"}
                  onChange={(value) => editLore((draft) => ({ ...draft, token: value }))}
                  disabled={busy}
                />
              </SettingsField>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <SettingsButton type="button" onClick={runTest} disabled={busy || normalizeBase(connection.baseUrl) === ""}>
                {t("desktop.memoryLoreTest")}
              </SettingsButton>
              <span role="status" aria-live="polite" style={{ display: "contents" }}>
                {testConnection.isPending ? <span className="workspace-hint">{t("desktop.memoryLoreTesting")}</span> : null}
                {testConnection.isSuccess && testedDraft !== null ? (
                  <span className="workspace-hint" style={{ color: "var(--ok)" }}>{t("desktop.memoryLoreTestPassed")}</span>
                ) : null}
              </span>
              {testFailure !== null && testFailure.ok === false ? (
                <span className="workspace-hint workspace-hint--error" role="alert">{testReasonText(testFailure.reason)}</span>
              ) : null}
              {testError !== null ? (
                <span className="workspace-hint workspace-hint--error" role="alert">{describeLoreRequestError(testError, t)}</span>
              ) : null}
            </div>
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
