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
  const [state, setState] = useState<PwaSurfaceState>("web-only");

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
    const version = import.meta.env.VITE_SW_VERSION ?? "1";
    const swUrl = `/sw.js?v=${encodeURIComponent(String(version))}`;

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

  const label = state === "installable"
    ? t("pwa.installable")
    : state === "insecure-origin"
      ? t("pwa.insecureOrigin")
      : state === "registration-error"
        ? t("pwa.registrationError")
        : t("pwa.webOnly");

  return <span data-pwa-state={state} hidden>{label}</span>;
}
