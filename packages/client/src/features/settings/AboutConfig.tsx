import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HttpError } from "@/api/http-client";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { SettingsButton, SettingsRow, SettingsSection } from "./settings-ui";

const RELEASES_TAG_URL = "https://github.com/FFatTiger/pix/releases/tag/";

const COPIED_RESET_MS = 1600;

/**
 * Fixed about error copy. Never renders body/stack/raw dynamic host messages.
 * Code/status-first, transport-kind fallback — mirrors describeCatalogError.
 */
export function describeAboutError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.isUnauthorized) return "You are not authorized for this action.";
    if (error.kind === "network") return "Network error — the host is unreachable.";
    if (error.kind === "timeout") return "Request timed out — try again.";
  }
  return "About information is unavailable right now.";
}

/**
 * About page: Pix version + on-demand update check, runtime environment, and
 * the bundled curated plugins. Everything renders from GET /v1/about facts —
 * no version or plugin list is maintained client-side.
 */
export function AboutConfig() {
  const http = useHttpClient();
  const { can } = useCapabilities();
  const { t } = useI18n();
  const options = createQueryOptions(http);
  const canAbout = can("settings.configure");

  const aboutQuery = useQuery({ ...options.about.info(), enabled: canAbout });
  // On-demand only (enabled: false): the probe fires on the explicit button
  // click via refetch(); the result is session-cached by the query layer.
  const updateQuery = useQuery(options.about.checkUpdate());

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  if (!canAbout) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <SettingsSection>
          <p className="workspace-hint">{t("desktop.about.unavailable")}</p>
        </SettingsSection>
      </div>
    );
  }

  const about = aboutQuery.data;
  const checking = updateQuery.isFetching;
  const updateResult = updateQuery.data;
  // Install command composes from the wire's own package name — the client
  // never hardcodes a sibling package name.
  const updateCommand = updateResult?.updateAvailable && updateResult.latest !== null
    ? `npm install -g ${updateResult.package}@${updateResult.latest}`
    : null;

  const onCheckUpdate = () => {
    void updateQuery.refetch();
  };

  const onCopyCommand = (command: string) => {
    copyText(command).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    }).catch(() => {
      // Copy failed: keep the honest un-copied label (no fake "Copied").
      setCopied(false);
    });
  };

  return (
    <div className="about-page" style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection>
        {aboutQuery.isPending ? (
          <p className="workspace-hint">{t("desktop.loading")}</p>
        ) : aboutQuery.isError ? (
          <p className="workspace-hint workspace-hint--error" role="alert">{describeAboutError(aboutQuery.error)}</p>
        ) : about ? (
          <>
            <div className="about-header" data-testid="about-header">
              <div className="transcript-home-logo about-icon" aria-hidden="true" />
              <div className="about-header-text">
                <div className="about-title">
                  <span className="about-name">Pix</span>
                  <span className="about-version">{`v${about.pix.version}`}</span>
                </div>
                {about.pix.build ? (
                  <div className="about-build">
                    {[about.pix.build.hash, about.pix.build.builtAt].filter(Boolean).join(" · ")}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="about-update">
              <SettingsButton
                variant="primary"
                onClick={onCheckUpdate}
                disabled={checking}
                testId="about-check-update"
              >
                {checking ? t("desktop.about.checking") : t("desktop.about.checkUpdate")}
              </SettingsButton>
              {checking ? null : updateQuery.isError ? (
                <span className="about-update-result about-update-result--error" role="alert">
                  {describeAboutError(updateQuery.error)}
                </span>
              ) : updateResult === undefined ? null : updateResult.latest === null ? (
                <span className="about-update-result" data-testid="about-update-unreachable">
                  {t("desktop.about.unreachable")}
                </span>
              ) : updateResult.updateAvailable ? (
                <span className="about-update-result" data-testid="about-update-available">
                  {t("desktop.about.newVersion", { version: updateResult.latest })}
                </span>
              ) : (
                <span className="about-update-result" data-testid="about-update-latest">
                  {t("desktop.about.upToDate", { version: updateResult.current })}
                </span>
              )}
            </div>
            {updateResult?.updateAvailable && updateResult.latest !== null && updateCommand ? (
              <div className="about-update-detail">
                <div className="about-update-command" data-testid="about-update-command">
                  <code>{updateCommand}</code>
                  <SettingsButton size="sm" onClick={() => onCopyCommand(updateCommand)}>
                    {copied ? t("desktop.copied") : t("desktop.copy")}
                  </SettingsButton>
                </div>
                <a className="about-release-link" href={`${RELEASES_TAG_URL}v${updateResult.latest}`} target="_blank" rel="noreferrer">
                  {t("desktop.about.releaseNotes")}
                </a>
              </div>
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      {about ? (
        <>
          <SettingsSection title={t("desktop.about.runtime")}>
            <SettingsRow label={t("desktop.about.rowPi")} description="pi-coding-agent">
              <span className="about-fact">{about.pi.codingAgent}</span>
            </SettingsRow>
            <SettingsRow label={t("desktop.about.rowNode")}>
              <span className="about-fact">{about.node}</span>
            </SettingsRow>
            <SettingsRow label={t("desktop.about.rowPlatform")}>
              <span className="about-fact">{`${about.platform} · ${about.arch}`}</span>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title={t("desktop.about.plugins")}>
            {about.plugins.map((plugin) => (
              <SettingsRow key={plugin.id} label={plugin.name}>
                <span className="about-fact">{plugin.version}</span>
              </SettingsRow>
            ))}
          </SettingsSection>
        </>
      ) : null}
    </div>
  );
}
