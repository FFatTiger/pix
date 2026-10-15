import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretRight } from "@phosphor-icons/react";
import {
  CAPABILITY_CATALOG,
  memoryProviderLabelKey,
  type CapabilityCatalogEntry,
} from "@fffattiger/pix-protocol";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { SettingToggle } from "@/components/SettingToggle";
import type { SettingsPageId } from "@/features/settings/settings-page";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { SettingsSection } from "./settings-ui";

/** Pages a catalog entry may link into (the settings nav vocabulary). */
const OPENABLE_PAGES: readonly string[] = [
  ...new Set(CAPABILITY_CATALOG.flatMap((entry) => (entry.detailPage === null ? [] : [entry.detailPage]))),
];

function isOpenablePage(value: string): value is SettingsPageId {
  return OPENABLE_PAGES.includes(value);
}

/**
 * Capabilities overview: one row per registered capability (name,
 * description, switch or current provider choice, entry into the detail
 * settings). Rows and groups come from the Protocol capability catalog —
 * this page keeps no capability list of its own. Saves are instant CAS full
 * replacements; running sessions keep their own feature set.
 */
export function CapabilitiesConfig({ onOpenPage }: { onOpenPage?: (page: SettingsPageId) => void }) {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const configurable = can("builtins.configure");
  const query = useQuery({
    ...createQueryOptions(http).settingsFile.builtIns(),
    enabled: configurable,
  });
  // Current memory provider choice for the memory row — the same stored
  // setting the memory page edits.
  const memoryQuery = useQuery({
    ...createQueryOptions(http).settingsFile.memory(),
    enabled: can("settings.configure"),
  });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveBuiltIns());
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const setEnabled = (id: string, enabled: boolean) => {
    const current = query.data;
    if (!current || save.isPending) return;
    setErrorKey(null);
    save.mutate({
      expectedRevision: current.revision,
      capabilities: current.capabilities.map((row) => row.id === id ? { ...row, enabled } : row),
    }, {
      onError: (error) => {
        const conflict = error instanceof HttpError && error.code === "CONFLICT";
        if (conflict) void query.refetch();
        setErrorKey(conflict
          ? "desktop.capabilitiesChanged"
          : "desktop.capabilitiesSaveFailed");
      },
    });
  };

  const openDetail = (entry: CapabilityCatalogEntry) => {
    if (entry.detailPage !== null && isOpenablePage(entry.detailPage)) onOpenPage?.(entry.detailPage);
  };

  // iOS-style rows: a capability with its own page is one tappable row that
  // shows its current state and a chevron (the switch lives on that page); a
  // capability without a page is a plain switch row. Trailing controls share
  // one right edge either way.
  const renderPageRow = (entry: CapabilityCatalogEntry, value: string): ReactNode => (
    <button
      key={entry.id}
      type="button"
      className="settings-capability-row"
      onClick={() => openDetail(entry)}
      aria-label={t("desktop.capabilitiesOpenDetail", { page: t(`desktop.settingsPage.${entry.detailPage}`) })}
    >
      <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
        <span className="settings-capability-row-label">{t(entry.labelKey)}</span>
        <span className="settings-capability-row-desc">{t(entry.descriptionKey)}</span>
      </span>
      <span className="settings-capability-row-value">{value}</span>
      <CaretRight size={14} aria-hidden="true" className="settings-capability-row-caret" />
    </button>
  );

  const renderRow = (entry: CapabilityCatalogEntry): ReactNode => {
    if (entry.control === "memory_provider") {
      const provider = memoryQuery.data?.provider;
      return renderPageRow(entry, provider === undefined ? "—" : t(memoryProviderLabelKey(provider)));
    }
    const row = query.data?.capabilities.find((candidate) => candidate.id === entry.id);
    if (row === undefined) return null;
    if (entry.detailPage !== null && onOpenPage !== undefined && isOpenablePage(entry.detailPage)) {
      return renderPageRow(entry, t(row.enabled ? "desktop.capabilityStateOn" : "desktop.capabilityStateOff"));
    }
    return (
      <SettingToggle
        key={entry.id}
        checked={row.enabled}
        onChange={(enabled) => setEnabled(entry.id, enabled)}
        label={t(entry.labelKey)}
        description={t(entry.descriptionKey)}
        disabled={save.isPending}
        loading={save.isPending && save.variables?.capabilities.some((candidate) => (
          candidate.id === entry.id && candidate.enabled !== row.enabled
        ))}
      />
    );
  };

  let content;
  if (!configurable) {
    content = <div className="workspace-hint">{t("desktop.capabilitiesUnavailable")}</div>;
  } else if (query.isPending) {
    content = <div className="workspace-hint" aria-busy="true">{t("desktop.loading")}</div>;
  } else if (query.isError || !query.data) {
    content = <div className="workspace-hint workspace-hint--error" role="alert">{t("desktop.capabilitiesUnavailable")}</div>;
  } else {
    content = CAPABILITY_CATALOG.map(renderRow);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection>
        {content}
        {errorKey ? <div className="workspace-hint workspace-hint--error" role="alert">{t(errorKey)}</div> : null}
      </SettingsSection>
    </div>
  );
}
