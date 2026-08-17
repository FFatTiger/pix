import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { RuntimeProvider, ResumeRefetch } from "@/runtime";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { I18nProvider } from "@/hooks/useI18n";
import { ThemeProvider } from "@/hooks/useTheme";
import { ContextMenuProvider } from "@/components/ContextMenu";
import type { HostInfo } from "@fffattiger/pix-protocol";

export interface AppProvidersProps {
  children: ReactNode;
  /** Override host capabilities (tests / story). Default: readonly shell. */
  host?: Partial<HostInfo> | null;
  /**
   * Route-level project scope for the theme controller, supplied from
   * validated router search (never parsed from window.location).
   */
  cwd?: string | null;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

/**
 * Dismiss the CSS-only startup splash after React has committed the provider
 * tree. The desktop source toggled `html.pi-booted` from AppShell, but Pix also
 * has a standalone `/login` route where AppShell never mounts; owning the
 * readiness signal here makes both authenticated and gate screens reachable.
 */
function StartupSplashDismiss() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.documentElement.classList.add("pi-booted");
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

export function AppProviders({ children, host, cwd }: AppProvidersProps) {
  const [queryClient] = useState(createQueryClient);

  return (
    <ErrorBoundary>
      <StartupSplashDismiss />
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider>
              {/* PWA resume: revalidate the boot surface on visibility/online/runtime reconnect. */}
              <ResumeRefetch />
              {/* UI infrastructure providers (ported from the upstream desktop app
                  app/page.tsx nesting): I18n outer, Theme + ContextMenu inner, both
                  wrapping the routed UI. The single ThemeProvider owns ALL theme
                  state + DOM application; consumers only read shared state/actions. */}
              <I18nProvider>
                <ThemeProvider cwd={cwd ?? null}>
                  <ContextMenuProvider>{children}</ContextMenuProvider>
                </ThemeProvider>
              </I18nProvider>
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
