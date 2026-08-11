import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createHttpClient,
  redirectToLogin,
  type HttpClient,
} from "@/api/http-client";

const HttpClientContext = createContext<HttpClient | null>(null);

export function HttpClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      createHttpClient({
        credentials: "same-origin",
        onUnauthorized: () => {
          redirectToLogin();
        },
      }),
    [],
  );

  return (
    <HttpClientContext.Provider value={client}>
      {children}
    </HttpClientContext.Provider>
  );
}

export function useHttpClient(): HttpClient {
  const ctx = useContext(HttpClientContext);
  if (!ctx) {
    throw new Error("useHttpClient must be used within HttpClientProvider");
  }
  return ctx;
}
