import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useGateLogin, useGateStatus } from "@/features/gate/useGate";
import { HttpError } from "@/api/http-client";
import { isMeaningfulNext, resolveSafeNext } from "@/lib/safe-next";

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

export function LoginPage({ next = "/" }: LoginPageProps) {
  const navigate = useNavigate();
  const status = useGateStatus();
  const login = useGateLogin();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const safeTarget = useMemo(() => resolveSafeNext(next), [next]);
  const showNextHint = isMeaningfulNext(safeTarget);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ password });
      await navigateAfterLogin(navigate, next);
    } catch (err) {
      if (err instanceof HttpError) {
        setError(err.message || `Login failed (${err.status})`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Login failed");
      }
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>Pi Web Gate</h1>
        <p className="login-lead">
          Authenticate to the host. LAN deployments require gate credentials.
        </p>

        {status.isLoading ? (
          <p className="login-meta">Checking gate status…</p>
        ) : status.isError ? (
          <p className="login-meta login-meta--warn">
            Host gate status unavailable (shell can still render offline UI).
          </p>
        ) : status.data ? (
          <p className="login-meta">
            required: {String(status.data.required)} · authenticated:{" "}
            {String(status.data.authenticated)}
          </p>
        ) : null}

        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={login.isPending}
          />
        </label>

        {error ? <p className="login-error">{error}</p> : null}

        <button type="submit" className="login-submit" disabled={login.isPending}>
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>

        <p className="login-footer">
          <Link to="/" search={{}}>
            Back to workstation
          </Link>
          {showNextHint ? (
            <span className="login-next"> · next: {safeTarget.href}</span>
          ) : null}
        </p>
      </form>
    </div>
  );
}
