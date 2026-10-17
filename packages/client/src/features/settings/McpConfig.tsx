import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "@phosphor-icons/react";
import type {
  McpImportPreviewResponse,
  McpSecretMutationWire,
  McpServerKindWire as McpServerKind,
  McpServerSnapshotWire,
  McpSettingsResponse,
  McpServerWriteWire,
} from "@fffattiger/pix-protocol";
import { HttpError } from "@/api/http-client";
import { createMutationOptions } from "@/api/mutations";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { Switch } from "@/components/ui/switch";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import {
  SegmentedControl,
  SettingsBadge,
  SettingsButton,
  SettingsDangerButton,
  SettingsField,
  SettingsInput,
  SettingsSecretInput,
  SettingsSection,
  SettingsWarningBanner,
} from "./settings-ui";

/** Tool rows shown before the "N more" expander. */
const TOOLS_PREVIEW_COUNT = 5;

type ProbeState = McpServerSnapshotWire["status"]["state"];

function statusText(state: ProbeState, toolCount: number, t: ReturnType<typeof useI18n>["t"]): string {
  if (state === "connected") {
    return toolCount > 0 ? t("desktop.mcpStatusConnectedTools", { count: String(toolCount) }) : t("desktop.mcpStatusConnected");
  }
  return shortStatusText(state, t);
}

/** List-row form: state word only (tool counts stay in the detail header). */
function shortStatusText(state: ProbeState, t: ReturnType<typeof useI18n>["t"]): string {
  if (state === "connected") return t("desktop.mcpStatusConnected");
  if (state === "needs_auth") return t("desktop.mcpStatusNeedsAuth");
  if (state === "failed") return t("desktop.mcpStatusFailed");
  if (state === "disabled") return t("desktop.mcpStatusDisabled");
  if (state === "unknown") return t("desktop.mcpStatusUnknown");
  return t("desktop.mcpStatusProbing");
}

function statusTone(state: ProbeState): "success" | "warning" | "muted" {
  if (state === "connected") return "success";
  if (state === "needs_auth" || state === "failed") return "warning";
  return "muted";
}

function statusDotColor(state: ProbeState): string {
  if (state === "connected") return "var(--status-success, var(--accent))";
  if (state === "needs_auth" || state === "failed") return "var(--status-warning)";
  return "var(--text-dim)";
}

/** Fixed error copy for the MCP surface (no raw messages, no secrets). */
function describeMcpError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (error instanceof HttpError) {
    if (error.code === "INVALID_MCP_INPUT") return t("desktop.mcpInvalidInputError");
    if (error.code === "MCP_SERVER_NOT_FOUND") return t("desktop.mcpNotFound");
    if (error.code === "RATE_LIMITED") return t("desktop.mcpRateLimited");
    if (error.kind === "network") return t("desktop.modelsNetworkUnavailable");
    if (error.kind === "timeout") return t("desktop.modelsRequestTimedOut");
  }
  return t("desktop.mcpUnavailable");
}

// ---------------------------------------------------------------------------
// Secret pair editor (env / headers)
// ---------------------------------------------------------------------------

interface DraftPair {
  key: string;
  /** Current input; empty on a saved literal (placeholder explains it). */
  value: string;
  /** True when the stored value is a redacted literal (empty input = keep). */
  secret: boolean;
}

interface PairFieldProps {
  rows: DraftPair[];
  onChange: (rows: DraftPair[]) => void;
  keyLabel: string;
  valueLabel: string;
  secretPlaceholder: string;
  removeLabel: string;
  addLabel: string;
  disabled?: boolean;
}

function PairRows({ rows, onChange, keyLabel, valueLabel, secretPlaceholder, removeLabel, addLabel, disabled }: PairFieldProps) {
  const update = (index: number, patch: Partial<DraftPair>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="mcp-pair-rows">
      {rows.map((row, index) => (
        <div key={index} className="mcp-pair-row">
          <SettingsInput
            value={row.key}
            onChange={(key) => update(index, { key })}
            placeholder={keyLabel}
            mono
            {...(disabled === undefined ? {} : { disabled })}
          />
          <SettingsSecretInput
            value={row.value}
            onChange={(value) => update(index, { value })}
            placeholder={row.secret && row.value === "" ? secretPlaceholder : valueLabel}
            mono
            {...(disabled === undefined ? {} : { disabled })}
          />
          <SettingsButton size="sm" {...(disabled === undefined ? {} : { disabled })} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            {removeLabel}
          </SettingsButton>
        </div>
      ))}
      <div>
        <SettingsButton size="sm" {...(disabled === undefined ? {} : { disabled })} onClick={() => onChange([...rows, { key: "", value: "", secret: false }])}>
          <Plus size={12} />
          {addLabel}
        </SettingsButton>
      </div>
    </div>
  );
}

/** Build the per-key preserve/remove/replace map from the draft rows. */
function secretMutations(existing: Record<string, { redacted: boolean; value?: string }> | null, rows: DraftPair[]): Record<string, McpSecretMutationWire> {
  const mutations: Record<string, McpSecretMutationWire> = {};
  const present = new Set(rows.map((row) => row.key).filter((key) => key !== ""));
  if (existing !== null) {
    for (const key of Object.keys(existing)) {
      if (!present.has(key)) mutations[key] = { mode: "remove" };
    }
  }
  for (const row of rows) {
    if (row.key === "") continue;
    if (row.value === "" && row.secret) {
      mutations[row.key] = { mode: "preserve" };
      continue;
    }
    if (row.value === "") continue;
    mutations[row.key] = { mode: "replace", value: row.value };
  }
  return mutations;
}

function draftPairsFrom(existing: Record<string, { redacted: boolean; value?: string }> | null): DraftPair[] {
  if (existing === null) return [];
  return Object.entries(existing).map(([key, value]) => ({
    key,
    value: value.redacted ? "" : (value.value ?? ""),
    secret: value.redacted,
  }));
}

// ---------------------------------------------------------------------------
// Server form (add + edit)
// ---------------------------------------------------------------------------

interface ServerFormDraft {
  name: string;
  kind: McpServerKind;
  command: string;
  args: string;
  env: DraftPair[];
  url: string;
  headers: DraftPair[];
  description: string;
  timeout: string;
  cwd: string;
}

function draftFromServer(server: McpServerSnapshotWire): ServerFormDraft {
  return {
    name: server.name,
    kind: server.kind ?? "stdio",
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    env: draftPairsFrom(server.env),
    url: server.url ?? "",
    headers: draftPairsFrom(server.headers),
    description: server.description ?? "",
    timeout: server.timeout === null ? "" : String(server.timeout),
    cwd: server.cwd ?? "",
  };
}

function writeFromDraft(draft: ServerFormDraft, existing: McpServerSnapshotWire | null): McpServerWriteWire {
  const envMutations = secretMutations(existing?.env ?? null, draft.env);
  const headerMutations = secretMutations(existing?.headers ?? null, draft.headers);
  const timeout = draft.timeout === "" ? undefined : Number(draft.timeout);
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    ...(draft.kind === "stdio"
      ? {
          command: draft.command.trim(),
          ...(draft.args.trim() === "" ? {} : { args: draft.args.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "") }),
          ...(Object.keys(envMutations).length === 0 ? {} : { env: envMutations }),
          ...(draft.cwd.trim() === "" ? {} : { cwd: draft.cwd.trim() }),
        }
      : {
          url: draft.url.trim(),
          ...(Object.keys(headerMutations).length === 0 ? {} : { headers: headerMutations }),
        }),
    ...(timeout === undefined || Number.isNaN(timeout) ? {} : { timeout }),
    ...(draft.description.trim() === "" ? {} : { description: draft.description }),
  };
}

function ServerForm({
  draft,
  existing,
  onChange,
  onSubmit,
  submitting,
  error,
  submitLabel,
}: {
  draft: ServerFormDraft;
  existing: McpServerSnapshotWire | null;
  onChange: (draft: ServerFormDraft) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
  submitLabel: string;
}) {
  const { t } = useI18n();
  const patch = (part: Partial<ServerFormDraft>) => onChange({ ...draft, ...part });
  return (
    <form
      className="models-settings-fields"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <SettingsField label={t("desktop.mcpFieldName")}>
        <SettingsInput value={draft.name} onChange={(name) => patch({ name })} placeholder="github" mono disabled={existing !== null} />
      </SettingsField>
      <SettingsField label={t("desktop.mcpFieldKind")}>
        <SegmentedControl<McpServerKind>
          value={draft.kind}
          onChange={(kind) => patch({ kind })}
          ariaLabel={t("desktop.mcpFieldKind")}
          options={[
            { value: "stdio", label: t("desktop.mcpKindStdio") },
            { value: "http", label: t("desktop.mcpKindHttp") },
          ]}
        />
      </SettingsField>
      {draft.kind === "stdio" ? (
        <>
          <SettingsField label={t("desktop.mcpFieldCommand")}>
            <SettingsInput value={draft.command} onChange={(command) => patch({ command })} placeholder="npx" mono />
          </SettingsField>
          <SettingsField label={t("desktop.mcpFieldArgs")}>
            <textarea
              className="settings-json-editor mcp-args-editor"
              rows={4}
              value={draft.args}
              onChange={(event) => patch({ args: event.target.value })}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
            />
          </SettingsField>
          <SettingsField label={t("desktop.mcpFieldEnv")}>
            <PairRows
              rows={draft.env}
              onChange={(env) => patch({ env })}
              keyLabel={t("desktop.mcpKeyLabel")}
              valueLabel={t("desktop.mcpValueLabel")}
              secretPlaceholder={t("desktop.mcpSecretKept")}
              removeLabel={t("desktop.mcpRemovePair")}
              addLabel={t("desktop.mcpAddPair")}
            />
          </SettingsField>
          {existing !== null ? (
            <SettingsField label={t("desktop.mcpFieldCwd")}>
              <SettingsInput value={draft.cwd} onChange={(cwd) => patch({ cwd })} placeholder="~/Documents" mono />
            </SettingsField>
          ) : null}
        </>
      ) : (
        <>
          <SettingsField label={t("desktop.mcpFieldUrl")}>
            <SettingsInput value={draft.url} onChange={(url) => patch({ url })} placeholder="https://example.com/mcp" mono />
          </SettingsField>
          <SettingsField label={t("desktop.mcpFieldHeaders")}>
            <PairRows
              rows={draft.headers}
              onChange={(headers) => patch({ headers })}
              keyLabel={t("desktop.mcpKeyLabel")}
              valueLabel={t("desktop.mcpValueLabel")}
              secretPlaceholder={t("desktop.mcpSecretKept")}
              removeLabel={t("desktop.mcpRemovePair")}
              addLabel={t("desktop.mcpAddPair")}
            />
          </SettingsField>
        </>
      )}
      {existing !== null ? (
        <SettingsField label={t("desktop.mcpFieldTimeout")}>
          <SettingsInput value={draft.timeout} onChange={(timeout) => patch({ timeout })} placeholder="60" mono />
        </SettingsField>
      ) : null}
      <SettingsField label={t("desktop.mcpFieldDescription")}>
        <SettingsInput value={draft.description} onChange={(description) => patch({ description })} placeholder={t("desktop.mcpFieldDescription")} />
      </SettingsField>
      {error ? <p className="workspace-hint workspace-hint--error" role="alert">{error}</p> : null}
      <div>
        <SettingsButton type="submit" variant="primary" disabled={submitting}>{submitLabel}</SettingsButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Paste-import (JSON)
// ---------------------------------------------------------------------------

function PasteImport({ existingNames, onImported }: { existingNames: readonly string[]; onImported: (name: string) => void }) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<McpImportPreviewResponse | null>(null);
  const previewMutation = useMutation(createMutationOptions(http, queryClient).settings.mcpImportPreview());
  const importMutation = useMutation(createMutationOptions(http, queryClient).settings.mcpImport());

  // Quick local parse feedback; the authoritative validation is the server
  // preview, debounced so typing does not spam it.
  const localError = useMemo(() => {
    if (raw.trim() === "") return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return t("desktop.mcpInvalidInputError");
      return null;
    } catch {
      return t("desktop.mcpInvalidInputError");
    }
  }, [raw, t]);

  useEffect(() => {
    if (raw.trim() === "" || localError !== null) {
      setPreview(null);
      previewMutation.reset();
      return;
    }
    const timer = window.setTimeout(() => {
      previewMutation.mutate({ json: raw }, { onSuccess: setPreview });
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, localError]);

  const entries = preview?.entries ?? [];
  const hasInvalid = entries.some((entry) => !entry.valid);
  const busy = previewMutation.isPending || importMutation.isPending;

  return (
    <div className="models-settings-fields">
      <textarea
        className="settings-json-editor"
        rows={10}
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        placeholder={t("desktop.mcpPastePlaceholder")}
        spellCheck={false}
      />
      {localError ? <p className="workspace-hint workspace-hint--error" role="alert">{localError}</p> : null}
      {previewMutation.isError ? (
        <p className="workspace-hint workspace-hint--error" role="alert">{describeMcpError(previewMutation.error, t)}</p>
      ) : null}
      {entries.length > 0 ? (
        <p className="workspace-hint">
          {t("desktop.mcpPreviewWillAdd", { count: String(entries.length), names: "" })}
          {entries.map((entry, index) => (
            <span key={entry.name}>
              {index > 0 ? "、" : ""}
              {entry.valid
                ? entry.overwrite
                  ? t("desktop.mcpPreviewOverwrite", { name: entry.name })
                  : existingNames.includes(entry.name)
                    ? t("desktop.mcpPreviewOverwrite", { name: entry.name })
                    : entry.name
                : t("desktop.mcpPreviewInvalid", { name: entry.name, reason: entry.invalidReason ?? "" })}
            </span>
          ))}
        </p>
      ) : raw.trim() === "" ? (
        <p className="workspace-hint">{t("desktop.mcpPreviewEmpty")}</p>
      ) : null}
      {importMutation.isError ? (
        <p className="workspace-hint workspace-hint--error" role="alert">{describeMcpError(importMutation.error, t)}</p>
      ) : null}
      <div>
        <SettingsButton
          variant="primary"
          disabled={busy || entries.length === 0 || hasInvalid}
          onClick={() =>
            importMutation.mutate(
              { json: raw },
              {
                onSuccess: () => {
                  setRaw("");
                  setPreview(null);
                  // Land on the last valid entry (servers append in mcp.json
                  // order, so this is the one the user just pasted in).
                  const lastValid = [...entries].reverse().find((entry) => entry.valid);
                  onImported(lastValid?.name ?? "");
                },
              },
            )
          }
        >
          {t("desktop.mcpImport")}
        </SettingsButton>
      </div>
      {hasInvalid ? <p className="workspace-hint workspace-hint--error" role="alert">{t("desktop.mcpImportHasInvalid")}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add server (form | paste)
// ---------------------------------------------------------------------------

function AddServer({ existing, onDone }: { existing: readonly McpServerSnapshotWire[]; onDone: (name: string) => void }) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"form" | "json">("form");
  const [draft, setDraft] = useState<ServerFormDraft>({ name: "", kind: "stdio", command: "", args: "", env: [], url: "", headers: [], description: "", timeout: "", cwd: "" });
  const upsert = useMutation(createMutationOptions(http, queryClient).settings.mcpUpsert());
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    upsert.mutate(writeFromDraft(draft, null), {
      onSuccess: () => onDone(writeFromDraft(draft, null).name),
      onError: (failure) => setError(describeMcpError(failure, t)),
    });
  };

  return (
    <div className="models-detail-page">
      <button type="button" className="models-back-link" onClick={() => onDone("")}>
        <ArrowLeft size={13} aria-hidden="true" />
        {t("desktop.mcpServersHeading")}
      </button>
      <SettingsSection
        title={t("desktop.mcpAddServer")}
        action={
          <SegmentedControl<"form" | "json">
            value={mode}
            onChange={setMode}
            ariaLabel={t("desktop.mcpAddServer")}
            options={[
              { value: "form", label: t("desktop.mcpAddModeForm") },
              { value: "json", label: t("desktop.mcpAddModeJson") },
            ]}
          />
        }
      >
        {mode === "form" ? (
          <ServerForm
            draft={draft}
            existing={null}
            onChange={setDraft}
            onSubmit={submit}
            submitting={upsert.isPending}
            error={error}
            submitLabel={t("desktop.modelsSave")}
          />
        ) : (
          <PasteImport existingNames={existing.map((server) => server.name)} onImported={onDone} />
        )}
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server detail
// ---------------------------------------------------------------------------

function ServerDetail({ server, onBack }: { server: McpServerSnapshotWire; onBack: () => void }) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const upsert = useMutation(createMutationOptions(http, queryClient).settings.mcpUpdate());
  const setEnabled = useMutation(createMutationOptions(http, queryClient).settings.mcpSetEnabled());
  const remove = useMutation(createMutationOptions(http, queryClient).settings.mcpRemove());
  const test = useMutation(createMutationOptions(http, queryClient).settings.mcpTest());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ServerFormDraft>(() => draftFromServer(server));
  const [editError, setEditError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [stderrOpen, setStderrOpen] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(draftFromServer(server));
  }, [server, editing]);

  const shownState: ProbeState = server.enabled ? server.status.state : "disabled";
  const probing = test.isPending && test.variables?.name === server.name;
  const visibleState: ProbeState = probing ? "unknown" : shownState;
  const tools = server.status.tools;
  const visibleTools = toolsOpen ? tools : tools.slice(0, TOOLS_PREVIEW_COUNT);
  const hiddenTools = tools.length - visibleTools.length;
  const busy = upsert.isPending || setEnabled.isPending || remove.isPending || test.isPending;

  const saveEdit = () => {
    setEditError(null);
    upsert.mutate(
      { name: server.name, write: writeFromDraft(draft, server) },
      {
        onSuccess: () => setEditing(false),
        onError: (failure) => setEditError(describeMcpError(failure, t)),
      },
    );
  };

  return (
    <div className="models-detail-page">
      <button type="button" className="models-back-link" onClick={onBack}>
        <ArrowLeft size={13} aria-hidden="true" />
        {t("desktop.mcpServersHeading")}
      </button>

      {!server.valid ? (
        <SettingsSection title={server.name} action={<SettingsBadge tone="warning">{t("desktop.mcpStatusFailed")}</SettingsBadge>}>
          <p className="workspace-hint workspace-hint--error" role="alert">{t("desktop.mcpInvalidEntry", { reason: server.invalidReason ?? "" })}</p>
          <p className="workspace-hint">{t("desktop.mcpInvalidEntryHint")}</p>
          <div className="mcp-detail-actions">
            <SettingsDangerButton
              label={t("desktop.delete")}
              onConfirm={() => remove.mutate(server.name, { onSuccess: onBack })}
            />
          </div>
          {remove.isError ? <p className="workspace-hint workspace-hint--error" role="alert">{describeMcpError(remove.error, t)}</p> : null}
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            title={server.name}
            action={
              <span className="mcp-detail-header">
                <SettingsBadge tone={statusTone(visibleState)}>
                  {probing ? t("desktop.mcpStatusProbing") : statusText(shownState, tools.length, t)}
                </SettingsBadge>
                <Switch
                  checked={server.enabled}
                  onChange={(checked) => setEnabled.mutate({ name: server.name, enabled: checked })}
                  label={t("desktop.mcpEnable")}
                  disabled={busy}
                  loading={setEnabled.isPending && setEnabled.variables?.name === server.name}
                />
              </span>
            }
          >
            {editing ? (
              <ServerForm
                draft={draft}
                existing={server}
                onChange={setDraft}
                onSubmit={saveEdit}
                submitting={upsert.isPending}
                error={editError}
                submitLabel={t("desktop.modelsSave")}
              />
            ) : (
              <div className="models-settings-fields">
                <SettingsField label={t("desktop.mcpFieldKind")}>
                  <SettingsInput value={server.kind === "http" ? t("desktop.mcpKindHttp") : t("desktop.mcpKindStdio")} onChange={() => {}} disabled />
                </SettingsField>
                {server.kind === "http" ? (
                  <SettingsField label={t("desktop.mcpFieldUrl")}>
                    <SettingsInput value={server.url ?? ""} onChange={() => {}} mono disabled />
                  </SettingsField>
                ) : (
                  <>
                    <SettingsField label={t("desktop.mcpFieldCommand")}>
                      <SettingsInput value={[server.command ?? "", ...(server.args ?? [])].join(" ")} onChange={() => {}} mono disabled />
                    </SettingsField>
                    {server.cwd !== null ? (
                      <SettingsField label={t("desktop.mcpFieldCwd")}>
                        <SettingsInput value={server.cwd} onChange={() => {}} mono disabled />
                      </SettingsField>
                    ) : null}
                  </>
                )}
                {Object.entries(server.env ?? {}).map(([key, value]) => (
                  <SettingsField key={`env-${key}`} label={`${t("desktop.mcpFieldEnv")} ${key}`}>
                    <SettingsSecretInput
                      value={value.redacted ? "" : (value.value ?? "")}
                      onChange={() => {}}
                      {...(value.redacted ? { placeholder: t("desktop.mcpSecretKept") } : {})}
                      mono
                      disabled
                    />
                  </SettingsField>
                ))}
                {Object.entries(server.headers ?? {}).map(([key, value]) => (
                  <SettingsField key={`header-${key}`} label={`${t("desktop.mcpFieldHeaders")} ${key}`}>
                    <SettingsSecretInput
                      value={value.redacted ? "" : (value.value ?? "")}
                      onChange={() => {}}
                      {...(value.redacted ? { placeholder: t("desktop.mcpSecretKept") } : {})}
                      mono
                      disabled
                    />
                  </SettingsField>
                ))}
                {server.timeout !== null ? (
                  <SettingsField label={t("desktop.mcpFieldTimeout")}>
                    <SettingsInput value={t("desktop.mcpTimeoutSeconds", { seconds: String(server.timeout) })} onChange={() => {}} disabled />
                  </SettingsField>
                ) : null}
                {server.description !== null ? (
                  <SettingsField label={t("desktop.mcpFieldDescription")}>
                    <SettingsInput value={server.description} onChange={() => {}} disabled />
                  </SettingsField>
                ) : null}
              </div>
            )}
            <p className="workspace-hint">{t("desktop.mcpHintNewSession")}</p>
          </SettingsSection>

          {server.enabled && shownState === "needs_auth" ? (
            <SettingsSection>
              <SettingsWarningBanner>
                {t("desktop.mcpNeedsAuthHint", { name: server.name })}
              </SettingsWarningBanner>
              <pre className="codex-tool-detail-section mcp-shell-command">{t("desktop.mcpNeedsAuthHintShell", { name: server.name })}</pre>
            </SettingsSection>
          ) : null}

          {server.enabled && shownState === "failed" ? (
            <SettingsSection title={t("desktop.mcpStatusFailed")}>
              {server.status.error ? (
                <p className="workspace-hint workspace-hint--error" role="alert">{server.status.error}</p>
              ) : null}
              {server.status.stderrTail.length > 0 ? (
                <div className="mcp-detail-actions">
                  <SettingsButton size="sm" onClick={() => setStderrOpen((open) => !open)}>
                    {stderrOpen ? t("desktop.mcpStderrHide") : t("desktop.mcpStderrShow")}
                  </SettingsButton>
                </div>
              ) : null}
              {stderrOpen && server.status.stderrTail.length > 0 ? (
                <pre className="codex-tool-detail-section">{server.status.stderrTail.join("\n")}</pre>
              ) : null}
            </SettingsSection>
          ) : null}

          {tools.length > 0 ? (
            <SettingsSection title={t("desktop.mcpToolsSection")}>
              <ul className="mcp-tool-list">
                {visibleTools.map((tool) => (
                  <li key={tool.name} className="mcp-tool-row">
                    <code className="mcp-tool-row-name">{tool.name}</code>
                    <span className="mcp-tool-row-desc">{tool.description}</span>
                  </li>
                ))}
                {hiddenTools > 0 || toolsOpen ? (
                  <li className="mcp-tool-list-more">
                    <SettingsButton size="sm" onClick={() => setToolsOpen((open) => !open)}>
                      {toolsOpen ? t("desktop.mcpFewerTools") : t("desktop.mcpMoreTools", { count: String(hiddenTools) })}
                    </SettingsButton>
                  </li>
                ) : null}
              </ul>
            </SettingsSection>
          ) : null}

          <SettingsSection>
            <div className="mcp-detail-actions">
              <SettingsButton disabled={busy} onClick={() => test.mutate({ name: server.name, refresh: true })}>
                {shownState === "failed" ? t("desktop.mcpReconnect") : t("desktop.mcpTestConnection")}
              </SettingsButton>
              <SettingsButton disabled={busy} onClick={() => setEditing((value) => !value)}>
                {editing ? t("desktop.cancel") : t("desktop.mcpEdit")}
              </SettingsButton>
              <SettingsDangerButton
                label={t("desktop.delete")}
                onConfirm={() => remove.mutate(server.name, { onSuccess: onBack })}
              />
            </div>
            {(test.isError && test.variables?.name === server.name) || remove.isError ? (
              <p className="workspace-hint workspace-hint--error" role="alert">
                {describeMcpError(test.isError && test.variables?.name === server.name ? test.error : remove.error, t)}
              </p>
            ) : null}
          </SettingsSection>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function McpEditor({ snapshot }: { snapshot: McpSettingsResponse }) {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | "add" | null>(snapshot.servers[0]?.name ?? null);
  const test = useMutation(createMutationOptions(http, queryClient).settings.mcpTest());
  // Probe in-flight tracking is keyed by server name in component state: the
  // shared mutation's `variables`/`isPending` only reflect the latest call, so
  // an earlier probe settling would clear another row's 检测中 mid-flight.
  const [probingNames, setProbingNames] = useState<ReadonlySet<string>>(() => new Set());
  const probeServer = (name: string, refresh: boolean) => {
    setProbingNames((current) => { const next = new Set(current); next.add(name); return next; });
    test.mutate({ name, refresh }, {
      onSettled: () => setProbingNames((current) => { const next = new Set(current); next.delete(name); return next; }),
    });
  };

  // First-load probe pass: every enabled, valid, untested server is probed
  // once through the cache-respecting test endpoint (never a silent poll —
  // the 检测中 badge reflects the in-flight call and the row updates on
  // arrival). Keyed by name+entry identity so an edit re-probes honestly.
  const probed = useRef(new Set<string>());
  useEffect(() => {
    for (const server of snapshot.servers) {
      if (!server.valid || !server.enabled || server.status.state !== "unknown") continue;
      const key = `${server.name}:${JSON.stringify(server.env ?? {})}:${server.url ?? ""}:${server.command ?? ""}`;
      if (probed.current.has(key)) continue;
      probed.current.add(key);
      probeServer(server.name, false);
    }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const servers = snapshot.servers;
  const current = selected !== "add" ? servers.find((server) => server.name === selected) : undefined;

  const stateFor = (server: McpServerSnapshotWire): ProbeState => {
    if (!server.enabled) return "disabled";
    return server.status.state;
  };

  // After a save/import the query cache already holds the fresh snapshot
  // (mutations setQueryData on success) — read it from the cache instead of
  // the stale `snapshot` prop so the just-written server gets selected.
  const selectAfterAdd = (name: string) => {
    const fresh = queryClient.getQueryData<McpSettingsResponse>(queryKeys.settingsConfig.mcp());
    const list = fresh?.servers ?? servers;
    setSelected(list.some((server) => server.name === name) ? name : list[list.length - 1]?.name ?? null);
  };

  return (
    <div className="models-config-shell">
      <div className="models-config-body">
        <aside className="models-provider-list">
          <div className="models-provider-list-heading">{t("desktop.mcpServersHeading")}</div>
          <div className="models-provider-list-scroll">
            {servers.map((server) => {
              const shown = stateFor(server);
              const probing = probingNames.has(server.name);
              return (
                <button
                  key={server.name}
                  type="button"
                  className={selected === server.name ? "models-provider-item is-selected" : "models-provider-item"}
                  onClick={() => setSelected(server.name)}
                >
                  <span
                    aria-hidden="true"
                    title={probing ? t("desktop.mcpStatusProbing") : statusText(shown, server.status.tools.length, t)}
                    style={{ width: 6, height: 6, borderRadius: 99, flex: "none", background: statusDotColor(shown) }}
                  />
                  <span className="models-provider-item-label">{server.name}</span>
                  <span
                    className="models-provider-item-count"
                    title={statusText(shown, server.status.tools.length, t)}
                  >
                    {probing ? t("desktop.mcpStatusProbing") : shortStatusText(shown, t)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="models-provider-list-footer">
            <SettingsButton style={{ width: "100%" }} onClick={() => setSelected("add")}>
              <Plus size={13} />
              {t("desktop.mcpAddServer")}
            </SettingsButton>
          </div>
        </aside>
        <main className="models-detail">
          {selected === "add" ? (
            <AddServer existing={servers} onDone={selectAfterAdd} />
          ) : current ? (
            <ServerDetail key={current.name} server={current} onBack={() => setSelected(null)} />
          ) : (
            <div className="models-empty-detail">{servers.length > 0 ? t("desktop.mcpEmptyDetail") : t("desktop.mcpEmptyList")}</div>
          )}
        </main>
      </div>
      <p className="mcp-page-hints workspace-hint">
        {t("desktop.mcpHintProject")}
      </p>
    </div>
  );
}

export function McpConfig() {
  const { t } = useI18n();
  const http = useHttpClient();
  const { can } = useCapabilities();
  const configurable = can("mcp.configure");
  const query = useQuery({ ...createQueryOptions(http).settingsFile.mcp(), enabled: configurable });

  if (!configurable) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title="MCP">
          <p className="workspace-hint">{t("desktop.mcpUnavailable")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title="MCP">
          <p className="workspace-hint" aria-busy="true">{t("desktop.loading")}</p>
        </SettingsSection>
      </div>
    );
  }
  if (query.isError) {
    const invalidFile = query.error instanceof HttpError && query.error.code === "INVALID_MCP_INPUT";
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection title="MCP">
          <p className="workspace-hint workspace-hint--error" role="alert">
            {invalidFile ? t("desktop.mcpConfigInvalidFile") : describeMcpError(query.error, t)}
          </p>
        </SettingsSection>
      </div>
    );
  }
  return query.data ? <McpEditor snapshot={query.data} /> : null;
}
