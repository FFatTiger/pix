import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export type PwaSurfaceState = "installable" | "web-only" | "insecure-origin" | "registration-error";

export function resolvePwaSurfaceState(input: {
  secureContext: boolean;
  serviceWorker: boolean;
  production: boolean;
}): "web-only" | "insecure-origin" | "ready-to-register" {
  if (!input.secureContext) return "insecure-origin";
  if (!input.serviceWorker || !input.production) return "web-only";
  return "ready-to-register";
}

/**
 * Registers the Vite-hosted service worker only in a secure production
 * context. HTTP LAN and other insecure origins stay web-only.
 */
export function PwaRegistration() {
  const { t } = useI18n();
  const [state, setState] = useState<PwaSurfaceState | null>(null);

  useEffect(() => {
    const secureContext = typeof window !== "undefined" && window.isSecureContext === true;
    const serviceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
    const production = !import.meta.env.DEV;
    const baseline = resolvePwaSurfaceState({ secureContext, serviceWorker, production });
    if (baseline !== "ready-to-register") {
      setState(baseline);
      return;
    }

    let cancelled = false;
    const version = import.meta.env.VITE_SW_VERSION;
    if (!version) {
      setState("registration-error");
      return;
    }
    const swUrl = `/sw.js?v=${encodeURIComponent(version)}`;

    navigator.serviceWorker
      .register(swUrl, { scope: "/" })
      .then(() => {
        if (!cancelled) setState("installable");
      })
      .catch(() => {
        if (!cancelled) setState("registration-error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!state || state === "installable") return null;
  // Dev is expected to stay web-only; do not occupy the page with that notice.
  if (state === "web-only" && import.meta.env.DEV) return null;

  const label = state === "insecure-origin"
    ? t("pwa.insecureOrigin")
    : state === "registration-error"
      ? t("pwa.registrationError")
      : t("pwa.webOnly");

  return (
    <div
      data-pwa-state={state}
      role="status"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 40,
        maxWidth: 360,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-panel)",
        color: state === "registration-error" ? "var(--status-danger)" : "var(--text-dim)",
        fontSize: 12,
        lineHeight: 1.45,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
      }}
    >
      {label}
    </div>
  );
}
