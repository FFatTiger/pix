import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BuiltInCapabilityId } from "@fffattiger/pix-protocol";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions } from "@/api/query-keys";
import { HttpError } from "@/api/http-client";
import { useHttpClient } from "@/app/http-context";
import { SettingToggle } from "@/components/SettingToggle";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { SettingsSection } from "./settings-ui";

const VISIBLE_FEATURES: readonly { readonly id: BuiltInCapabilityId; readonly labelKey: string }[] = [
  { id: "subagents", labelKey: "desktop.agentFeature.subagents" },
  { id: "todo", labelKey: "desktop.agentFeature.todo" },
  { id: "ask_user_question", labelKey: "desktop.agentFeature.askUserQuestion" },
  { id: "side_chat", labelKey: "desktop.agentFeature.sideChat" },
];

export function BuiltInCapabilitiesConfig() {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const configurable = can("builtins.configure");
  const query = useQuery({
    ...createQueryOptions(http).settingsFile.builtIns(),
    enabled: configurable,
  });
  const save = useMutation(createMutationOptions(http, queryClient).settings.saveBuiltIns());
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const setEnabled = (id: BuiltInCapabilityId, enabled: boolean) => {
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
          ? "desktop.agentFeaturesChanged"
          : "desktop.agentFeaturesSaveFailed");
      },
    });
  };

  let content;
  if (!configurable) {
    content = <div className="workspace-hint">{t("desktop.agentFeaturesUnavailable")}</div>;
  } else if (query.isPending) {
    content = <div className="workspace-hint" aria-busy="true">{t("desktop.loading")}</div>;
  } else if (query.isError || !query.data) {
    content = <div className="workspace-hint workspace-hint--error" role="alert">{t("desktop.agentFeaturesUnavailable")}</div>;
  } else {
    content = VISIBLE_FEATURES.map(({ id, labelKey }) => {
      const row = query.data.capabilities.find((candidate) => candidate.id === id);
      if (row === undefined) return null;
      return (
        <SettingToggle
          key={row.id}
          checked={row.enabled}
          onChange={(enabled) => setEnabled(row.id, enabled)}
          label={t(labelKey)}
          disabled={save.isPending}
          loading={save.isPending && save.variables?.capabilities.some((candidate) => (
            candidate.id === row.id && candidate.enabled !== row.enabled
          ))}
        />
      );
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.agentFeatures")} description={t("desktop.agentFeaturesDescription")}>
        {content}
        {errorKey ? <div className="workspace-hint workspace-hint--error" role="alert">{t(errorKey)}</div> : null}
      </SettingsSection>
    </div>
  );
}
