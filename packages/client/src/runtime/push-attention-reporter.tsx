/**
 * PushAttentionReporter — keeps the runtime connection's attention reports
 * carrying this browser's CURRENT push endpoint hash (per-device Web Push
 * suppression, D-PUSH).
 *
 * The socket reports attention (visible + focused + hash) on every
 * visibility/focus change and on each handshake ack; this module owns the
 * hash's lifecycle: adopted once on mount (after the service worker is ready)
 * and refreshed whenever a push subscribe/unsubscribe mutation settles, so
 * enabling or disabling notifications on this device immediately changes
 * which endpoint its "attended" reports suppress.
 *
 * Fail-open by design: when the endpoint cannot be read (storage/private-mode
 * quirks), the hash is undefined and this device's reports suppress nothing —
 * the honest no-mapping state, never a fabricated one.
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { currentPushEndpointHash, readPushBrowserEnv } from "@/lib/push-subscription";
import { useRuntimeOwners } from "./runtime-provider.js";

/** Injectable seams (tests); production wires the browser env + connection. */
export interface PushAttentionReporterSeams {
  /** Read this browser's current push endpoint hash (undefined = no mapping). */
  readonly readHash: () => Promise<string | undefined>;
  /** Push the hash onto the runtime connection's attention reports. */
  readonly setHash: (hash: string | undefined) => void;
  readonly queryClient: QueryClient;
}

/**
 * Wire the endpoint-hash lifecycle: report once immediately, then re-report
 * whenever a push subscribe/unsubscribe mutation settles (the only in-app
 * events that can change this browser's endpoint — both carry a
 * `["pix","push",…]` mutationKey). Returns the cleanup.
 */
export function connectPushAttentionReporter(seams: PushAttentionReporterSeams): () => void {
  let cancelled = false;
  const report = (): void => {
    void seams.readHash()
      .then((hash) => {
        if (!cancelled) seams.setHash(hash);
      })
      .catch(() => undefined); // fail-open: unreadable endpoint = no mapping
  };
  report();
  const unsubscribe = seams.queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const key = event.mutation.options.mutationKey;
    if (!Array.isArray(key) || key[0] !== "pix" || key[1] !== "push") return;
    if (key[2] !== "subscribe" && key[2] !== "unsubscribe") return;
    const status = event.mutation.state.status;
    if (status !== "success" && status !== "error") return;
    report();
  });
  return () => {
    cancelled = true;
    unsubscribe();
    seams.setHash(undefined);
  };
}

/** The browser env read (injected seam shape so the core stays testable). */
function readBrowserEndpointHash(): Promise<string | undefined> {
  const { env } = readPushBrowserEnv({
    navigator: typeof navigator === "undefined" ? undefined : navigator,
    Notification: typeof Notification === "undefined" ? undefined : Notification,
    matchMedia: typeof matchMedia === "function" ? matchMedia.bind(window) : undefined,
    window: typeof window === "undefined" ? undefined : window,
  });
  return currentPushEndpointHash(env);
}

/**
 * React component: mount ONCE at the app root, below RuntimeProvider +
 * QueryClientProvider (next to ResumeRefetch). Renders nothing.
 */
export function PushAttentionReporter(): null {
  const { connection } = useRuntimeOwners();
  const queryClient = useQueryClient();
  useEffect(() => connectPushAttentionReporter({
    readHash: readBrowserEndpointHash,
    setHash: (hash) => connection.setPushEndpointHash(hash),
    queryClient,
  }), [connection, queryClient]);
  return null;
}
