import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { createQueryOptions } from "@/api";
import { useHttpClient } from "@/app/http-context";
import { useGateStatus } from "@/features/gate/useGate";
import { hydratePreferencesFromServer } from "@/lib/preferences/preference-sync";

/**
 * Mounted around the workspace route. The child shell is withheld until the
 * authenticated server preference map has been applied to local mirrors.
 * This ordering is significant: shell mount effects may persist derived UI
 * state (for example, auto-expanding the selected project), and must never
 * publish an empty local snapshot before server hydration completes.
 *
 * An unavailable preference endpoint degrades honestly to the existing local
 * mirrors instead of blocking the workspace. The unauthenticated gate remains
 * reachable because it does not need preference hydration.
 */
export function ServerPreferenceSync({ children }: { children: ReactNode }): ReactNode {
  const http = useHttpClient();
  const gateStatus = useGateStatus();
  const gateAllowsPreferences = gateStatus.data !== undefined
    && (gateStatus.data.required !== true || gateStatus.data.authenticated === true);
  const hydratedForAuth = useRef(false);
  const [hydrated, setHydrated] = useState(false);

  const query = useQuery({
    ...createQueryOptions(http).preferences.map(),
    enabled: gateAllowsPreferences,
  });

  useEffect(() => {
    if (!gateAllowsPreferences || !query.isSuccess || hydratedForAuth.current) return;
    hydratedForAuth.current = true;
    // Local mirror application is synchronous. Any one-time migration PUT may
    // finish later, but children can mount as soon as their reads observe the
    // hydrated values.
    void hydratePreferencesFromServer(query.data?.preferences ?? {});
    setHydrated(true);
  }, [gateAllowsPreferences, query.isSuccess, query.data]);

  if (gateStatus.isError) return children;
  if (!gateStatus.isSuccess) return null;
  if (!gateAllowsPreferences) return children;
  if (query.isError) return children;
  return hydrated ? children : null;
}
