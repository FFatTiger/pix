import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { RuntimeProvider, ResumeRefetch } from "@/runtime";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import type { HostInfo } from "@fffattiger/pix-protocol";

export interface AppProvidersProps {
  children: ReactNode;
  /** Override host capabilities (tests / story). Default: readonly shell. */
  host?: Partial<HostInfo> | null;
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

export function AppProviders({ children, host }: AppProvidersProps) {
  const [queryClient] = useState(createQueryClient);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider>
              {/* PWA resume: revalidate the boot surface on visibility/online/runtime reconnect. */}
              <ResumeRefetch />
              {children}
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
