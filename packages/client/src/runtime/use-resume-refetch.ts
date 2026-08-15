/**
 * Resume refetch — revalidate the HTTP boot surface when the PWA resumes.
 *
 * "Resume" is frozen as: reconnect (WS) + replay (epoch/lastEventId) + snapshot
 * convergence, never silent loss. The WS half lives in {@link RuntimeSocket} +
 * {@link SessionStore}; this hook covers the HTTP half: when the tab returns
 * from background/sleep (visibility), the network comes back (online), or the
 * runtime WS reconnects (connection transition from a disconnected state back
 * to sendable), the stale capability/bootstrap/gate/session queries are
 * revalidated so the UI converges to the host's authoritative state (e.g.
 * sessiond up/down, capability tokens, new/deleted sessions).
 *
 * TanStack's built-in `refetchOnReconnect` (library default true) already
 * covers the `online` event for STALE queries. This hook additionally (a)
 * revalidates the boot surface even when it is not yet stale — the boot
 * surface is the source of truth for capability honesty — and (b) covers
 * visibility resume, which the client deliberately disables via
 * `refetchOnWindowFocus: false`. Triggers are coalesced within one tick so a
 * single resume event (which often fires visibility + online + WS reconnect
 * together) causes at most one invalidation burst.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/api/query-keys";
import { canSend } from "./lifecycle.js";
import { useRuntime } from "./runtime-provider.js";

/** Query-key groups revalidated on resume (boot surface + session list). */
const RESUME_QUERY_KEYS: readonly (readonly unknown[])[] = [
  queryKeys.capabilities.all,
  queryKeys.capabilities.bootstrap(),
  queryKeys.gate.status(),
  queryKeys.sessions.lists,
];

/**
 * React hook: revalidate the boot surface when the PWA resumes. Mount once at
 * the app root, below RuntimeProvider + QueryClientProvider.
 */
export function useResumeRefetch(): void {
  const queryClient = useQueryClient();
  const runtime = useRuntime();
  /** True once the socket entered a disconnected state; reset on recovery. */
  const disconnectedRef = useRef(false);
  const scheduledRef = useRef(false);

  const refetchBootSurface = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    // Coalesce triggers that fire together in one resume event (visibility +
    // online + WS reconnect) into a single invalidation burst.
    setTimeout(() => {
      scheduledRef.current = false;
      for (const key of RESUME_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    }, 0);
  }, [queryClient]);

  // Runtime WS reconnect: once the socket has been unavailable/reconnecting, a
  // return to a sendable state means it reconnected and re-handshook (and, when
  // a session is live, re-attached and the snapshot converged). Revalidate the
  // boot surface at that boundary.
  useEffect(() => {
    const current = runtime.connection;
    if (current === "unavailable" || current === "reconnecting") {
      disconnectedRef.current = true;
    } else if (canSend(current) && disconnectedRef.current) {
      disconnectedRef.current = false;
      refetchBootSurface();
    }
  }, [runtime.connection, refetchBootSurface]);

  // Visibility resume (background/sleep → foreground) and network recovery.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refetchBootSurface();
    };
    const onOnline = (): void => refetchBootSurface();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [refetchBootSurface]);
}

/** Null-rendering mount point for {@link useResumeRefetch}. */
export function ResumeRefetch(): null {
  useResumeRefetch();
  return null;
}
