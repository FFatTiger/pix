import { useEffect, useState } from "react";

/**
 * Registers the Vite-hosted service worker.
 * No next/script — plain browser registration.
 */
export function PwaRegistration() {
  const [state, setState] = useState<"idle" | "registered" | "error" | "unsupported">(
    "idle",
  );

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      setState("unsupported");
      return;
    }

    // Skip SW on Vite dev server to avoid stale module cache during HMR.
    if (import.meta.env.DEV) {
      setState("idle");
      return;
    }

    let cancelled = false;
    const version = import.meta.env.VITE_SW_VERSION ?? "1";
    const swUrl = `/sw.js?v=${encodeURIComponent(String(version))}`;

    navigator.serviceWorker
      .register(swUrl, { scope: "/" })
      .then(() => {
        if (!cancelled) setState("registered");
      })
      .catch((err: unknown) => {
        console.warn("SW registration failed", err);
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Invisible helper — state is for tests / future toast hooks.
  return <span data-pwa-state={state} hidden />;
}
