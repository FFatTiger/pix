import { useState, type FormEvent } from "react";
import { useGatePasswordChange, useGateStatus } from "@/features/gate/useGate";
import { useI18n } from "@/hooks/useI18n";
import { HttpError } from "@/api/http-client";
import { inputStyle, SettingsSection } from "@/features/settings/settings-ui";

const MAX_KEY_LENGTH = 128;

/**
 * Fixed i18n'd copy for access-key change failures (AGENTS §4: no ad-hoc
 * error strings). Every wire failure mode of PUT /v1/gate/password maps to
 * exactly one key; anything unexpected falls back to the generic copy.
 */
export function describeGatePasswordError(error: unknown, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.code === "INVALID_PASSWORD") return t("desktop.securityKeyWrongCurrent");
    if (error.code === "PASSWORD_ENV_MANAGED") return t("desktop.securityKeyEnvManaged");
    if (error.code === "AUTH_DISABLED") return t("desktop.securityKeyDisabled");
    if (error.status === 429 || error.code === "RATE_LIMITED") {
      return t("desktop.securityKeyRateLimited", error.retryAfterSeconds !== undefined
        ? { seconds: error.retryAfterSeconds }
        : { seconds: 30 });
    }
    if (error.status === 400) return t("desktop.securityKeyInvalidInput");
    if (error.code === "PASSWORD_WRITE_FAILED" || error.status === 500) return t("desktop.securityKeyWriteFailed");
    if (error.status === 503) return t("desktop.securityKeyUnavailable");
  }
  return t("desktop.securityKeyGenericFailure");
}

/**
 * Settings → Security: change the pix access key.
 *
 * The key lives in ~/.pi/pix.json (`auth.password`) and every session cookie
 * is derived from it, so a successful change keeps THIS browser logged in
 * (the host re-issues the cookie) and signs every other browser out.
 */
export function SecurityConfig() {
  const { t } = useI18n();
  const status = useGateStatus();
  const changePassword = useGatePasswordChange();
  const [currentKey, setCurrentKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [saved, setSaved] = useState(false);

  const gateStatus = status.data?.status;
  const localError = (() => {
    if (newKey.length === 0) return null;
    if (newKey.length > MAX_KEY_LENGTH) return t("desktop.securityKeyTooLong", { max: MAX_KEY_LENGTH });
    if (confirmKey.length > 0 && confirmKey !== newKey) return t("desktop.securityKeyMismatch");
    return null;
  })();
  const canSubmit = gateStatus === "enabled"
    && localError === null
    && currentKey.length > 0
    && newKey.length > 0
    && confirmKey === newKey
    && !changePassword.isPending;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaved(false);
    changePassword.mutate(
      { currentPassword: currentKey, newPassword: newKey },
      {
        onSuccess: () => {
          setCurrentKey("");
          setNewKey("");
          setConfirmKey("");
          setSaved(true);
        },
      },
    );
  };

  const fieldStyle = { ...inputStyle, marginBottom: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.securityKey")} description={t("desktop.securityKeyDescription")}>
        {gateStatus === "enabled" ? (
          <form onSubmit={handleSubmit} data-testid="security-key-form">
            <label style={{ display: "block", marginBottom: 4, fontSize: 12, color: "var(--text-muted)" }} htmlFor="security-current-key">
              {t("desktop.securityKeyCurrent")}
            </label>
            <input
              id="security-current-key"
              type="password"
              autoComplete="current-password"
              className="settings-input"
              style={fieldStyle}
              value={currentKey}
              onChange={(event) => { setCurrentKey(event.target.value); setSaved(false); }}
              disabled={changePassword.isPending}
            />
            <label style={{ display: "block", marginBottom: 4, fontSize: 12, color: "var(--text-muted)" }} htmlFor="security-new-key">
              {t("desktop.securityKeyNew")}
            </label>
            <input
              id="security-new-key"
              type="password"
              autoComplete="new-password"
              className="settings-input"
              style={fieldStyle}
              value={newKey}
              onChange={(event) => { setNewKey(event.target.value); setSaved(false); }}
              disabled={changePassword.isPending}
            />
            <label style={{ display: "block", marginBottom: 4, fontSize: 12, color: "var(--text-muted)" }} htmlFor="security-confirm-key">
              {t("desktop.securityKeyConfirm")}
            </label>
            <input
              id="security-confirm-key"
              type="password"
              autoComplete="new-password"
              className="settings-input"
              style={fieldStyle}
              value={confirmKey}
              onChange={(event) => { setConfirmKey(event.target.value); setSaved(false); }}
              disabled={changePassword.isPending}
            />
            {localError !== null ? (
              <p role="alert" data-testid="security-key-local-error" style={{ margin: "0 0 8px", fontSize: 12, color: "var(--danger)" }}>
                {localError}
              </p>
            ) : null}
            {changePassword.error !== null ? (
              <p role="alert" data-testid="security-key-error" style={{ margin: "0 0 8px", fontSize: 12, color: "var(--danger)" }}>
                {describeGatePasswordError(changePassword.error, t)}
              </p>
            ) : null}
            {saved ? (
              <p data-testid="security-key-saved" style={{ margin: "0 0 8px", fontSize: 12, color: "var(--status-success, var(--accent))" }}>
                {t("desktop.securityKeySaved")}
              </p>
            ) : null}
            <button
              type="submit"
              className="settings-save-btn"
              disabled={!canSubmit}
              data-testid="security-key-save"
              style={{
                height: "var(--control-height)",
                padding: "0 14px",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--control-radius)",
                fontSize: 13,
                cursor: canSubmit ? "pointer" : "not-allowed",
                opacity: canSubmit ? 1 : 0.5,
              }}
            >
              {changePassword.isPending ? t("desktop.saving") : t("desktop.securityKeySave")}
            </button>
          </form>
        ) : gateStatus === "unconfigured" ? (
          <p data-testid="security-key-unconfigured" style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {t("desktop.securityKeyUnconfigured")}
          </p>
        ) : gateStatus === "disabled" ? (
          <p data-testid="security-key-disabled" style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {t("desktop.securityKeyDisabledNote")}
          </p>
        ) : gateStatus === "error" ? (
          <p role="alert" data-testid="security-key-error-status" style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>
            {t("desktop.securityKeyConfigError")}
          </p>
        ) : (
          <p data-testid="security-key-loading" style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {t("desktop.loading")}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
