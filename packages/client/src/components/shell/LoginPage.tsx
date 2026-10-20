import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useGateLogin, useGateSetup, useGateStatus } from "@/features/gate/useGate";
import { HttpError } from "@/api/http-client";
import { queryKeys } from "@/api/query-keys";
import type { GateStatus } from "@/api/schemas";
import { useI18n } from "@/hooks/useI18n";
import { isMeaningfulNext, resolveSafeNext } from "@/lib/safe-next";

/** The access-key rules the Host enforces (see PUT /v1/gate/password). */
export const MAX_ACCESS_KEY_LENGTH = 128;

export interface LoginPageProps {
  next?: string;
}

/**
 * Post-login navigation uses TanStack Router typed `to` + `search`.
 * `next` may be a full path+query from buildLoginRedirect; resolveSafeNext
 * splits it so session/cwd deep links survive.
 */
export async function navigateAfterLogin(
  navigate: ReturnType<typeof useNavigate>,
  next: string | undefined,
): Promise<void> {
  const target = resolveSafeNext(next);
  await navigate({
    to: target.to,
    search: target.search,
    replace: true,
  });
}

/**
 * The gate state the login screen renders for.
 *
 * - `setup`: the host has no access key yet — the page offers to set one.
 * - `form`: a key exists — the page asks for it.
 * - `configError`: the host could not read a valid configuration.
 * - `open`: the operator explicitly turned the gate off; the host is open.
 * - `unknown`: the gate status could not be read — the sign-in form stays
 *   visible, because there may well be a key to type.
 */
export type LoginGateState = "setup" | "form" | "configError" | "open" | "unknown";

/** Map the host's gate status onto the state the login screen renders. */
export function resolveLoginGateState(
  data: Pick<GateStatus, "status"> | undefined,
): LoginGateState {
  if (!data) return "unknown";
  switch (data.status) {
    case "enabled":
      return "form";
    case "unconfigured":
      return "setup";
    case "error":
      return "configError";
    case "disabled":
      return "open";
    default:
      return "unknown";
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Fixed copy for a failed sign-in (AGENTS §4: no ad-hoc error strings, no raw
 * host message in the UI). Every wire failure mode of POST /v1/gate/login maps
 * to exactly one key; anything unexpected falls back to the generic copy.
 */
export function describeLoginError(error: unknown, t: Translate): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "AUTH_NOT_CONFIGURED":
        return t("desktop.login.error.unconfigured");
      case "AUTH_CONFIG_ERROR":
        return t("desktop.login.error.configError");
      case "RATE_LIMITED":
        return t("desktop.login.error.rateLimited", {
          seconds: error.retryAfterSeconds ?? 30,
        });
      default:
        break;
    }
    if (error.status === 401) return t("desktop.login.error.wrongPassword");
    if (error.status === 429) {
      return t("desktop.login.error.rateLimited", {
        seconds: error.retryAfterSeconds ?? 30,
      });
    }
    if (error.status === 503) return t("desktop.login.error.unavailable");
    if (error.kind === "network") return t("desktop.login.error.network");
    if (error.kind === "timeout") return t("desktop.login.error.unavailable");
  }
  return t("desktop.login.error.generic");
}

/**
 * Fixed copy for a failed access-key setup. The 409 family means the state
 * changed under us (a key already exists, the key is env-managed, or the
 * operator turned the gate off) — the page then asks for a normal sign-in.
 */
export function describeSetupError(error: unknown, t: Translate): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "AUTH_ALREADY_CONFIGURED":
        return t("desktop.login.error.alreadyConfigured");
      case "PASSWORD_ENV_MANAGED":
        return t("desktop.login.error.envManaged");
      case "AUTH_DISABLED":
        return t("desktop.login.error.disabled");
      case "AUTH_CONFIG_ERROR":
        return t("desktop.login.error.configError");
      case "PASSWORD_WRITE_FAILED":
        return t("desktop.login.error.writeFailed");
      case "INVALID_INPUT":
        return t("desktop.login.error.invalidInput");
      default:
        break;
    }
    if (error.status === 503) return t("desktop.login.error.unavailable");
    if (error.kind === "network") return t("desktop.login.error.network");
    if (error.kind === "timeout") return t("desktop.login.error.unavailable");
  }
  return t("desktop.login.error.generic");
}

export function LoginPage({ next = "/" }: LoginPageProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const status = useGateStatus();
  const login = useGateLogin();
  const setup = useGateSetup();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const safeTarget = useMemo(() => resolveSafeNext(next), [next]);
  const showNextHint = isMeaningfulNext(safeTarget);
  const gateState = resolveLoginGateState(status.data);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ password });
      await navigateAfterLogin(navigate, next);
    } catch (err) {
      setError(describeLoginError(err, t));
    }
  }

  // Local rules for the first access key (the Host enforces the same ones):
  // a non-empty key of at most 128 characters, and a confirmation that
  // matches. The confirmation never leaves the browser.
  const setupLocalError = (() => {
    if (password.length === 0) return null;
    if (password.length > MAX_ACCESS_KEY_LENGTH) {
      return t("desktop.login.setupTooLong", { max: MAX_ACCESS_KEY_LENGTH });
    }
    if (confirm.length > 0 && confirm !== password) return t("desktop.login.setupMismatch");
    return null;
  })();
  const setupReady =
    password.length > 0
    && password.length <= MAX_ACCESS_KEY_LENGTH
    && confirm === password
    && setupLocalError === null;

  async function onSetupSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!setupReady) return;
    try {
      await setup.mutateAsync({ password, next });
      await navigateAfterLogin(navigate, next);
    } catch (err) {
      setError(describeSetupError(err, t));
      // A conflict means the host's gate state changed (another browser set
      // the key, the key is env-managed, or the gate was turned off): re-read
      // it so the page shows the matching screen instead of the setup form.
      if (err instanceof HttpError && err.status === 409) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.gate.all });
      }
    }
  }

  const title = (() => {
    switch (gateState) {
      case "setup":
        return t("desktop.login.setupTitle");
      case "configError":
        return t("desktop.login.configErrorTitle");
      case "open":
        return t("desktop.login.openTitle");
      default:
        return t("desktop.login.title");
    }
  })();

  const loginForm = (
    <form className="login-form" onSubmit={onSubmit}>
      <label className="login-field">
        <span className="login-label">{t("desktop.login.password")}</span>
        <input
          className="login-input"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={login.isPending}
        />
      </label>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="login-submit" disabled={login.isPending}>
        {login.isPending ? t("desktop.login.submitting") : t("desktop.login.submit")}
      </button>
    </form>
  );

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="pix-mark" aria-hidden="true" />
        <h1 className="login-title">{title}</h1>

        {gateState === "setup" ? (
          <>
            <p className="login-subtitle">{t("desktop.login.setupSubtitle")}</p>
            <form className="login-form" onSubmit={onSetupSubmit}>
              <label className="login-field">
                <span className="login-label">{t("desktop.login.setupPassword")}</span>
                <input
                  className="login-input"
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={setup.isPending}
                />
              </label>
              <label className="login-field">
                <span className="login-label">{t("desktop.login.setupConfirm")}</span>
                <input
                  className="login-input"
                  type="password"
                  name="password-confirm"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={setup.isPending}
                />
              </label>

              {setupLocalError ? (
                <p className="login-error" role="alert">
                  {setupLocalError}
                </p>
              ) : null}
              {error ? (
                <p className="login-error" role="alert">
                  {error}
                </p>
              ) : null}

              <button type="submit" className="login-submit" disabled={!setupReady || setup.isPending}>
                {setup.isPending ? t("desktop.login.setupSubmitting") : t("desktop.login.setupSubmit")}
              </button>
            </form>
            <p className="login-hint">
              {t("desktop.login.setupOptOut")}{" "}
              <code className="login-code">{'{"auth":{"disabled":true}}'}</code>{" "}
              {t("desktop.login.setupOptOutTail")}
            </p>
          </>
        ) : gateState === "configError" ? (
          <div className="login-note">
            <p className="login-note-text">{t("desktop.login.configErrorBody")}</p>
          </div>
        ) : gateState === "open" ? (
          <div className="login-note">
            <p className="login-note-text">{t("desktop.login.openBody")}</p>
            <button
              type="button"
              className="login-submit"
              onClick={() => {
                void navigate({ to: "/", search: {}, replace: true });
              }}
            >
              {t("desktop.login.openAction")}
            </button>
          </div>
        ) : status.isLoading ? (
          <p className="login-note-text">{t("desktop.login.checking")}</p>
        ) : (
          <>
            {gateState === "unknown" ? (
              <p className="login-note-text login-note-text--warn">
                {t("desktop.login.statusUnavailable")}
              </p>
            ) : null}
            <p className="login-subtitle">{t("desktop.login.subtitle")}</p>
            {loginForm}
          </>
        )}

        {showNextHint && gateState === "form" ? (
          <p className="login-hint">{t("desktop.login.continueHint")}</p>
        ) : null}
      </div>
    </div>
  );
}
