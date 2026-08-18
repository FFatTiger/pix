import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { AllowedRootsConfig } from "./AllowedRootsConfig";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <I18nProvider>{children}</I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  return render(<AllowedRootsConfig />, { wrapper: Wrapper });
}

describe("AllowedRootsConfig", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("lists current roots and expands an absolute path via cwd.validate", async () => {
    let roots = ["/x"];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/v1/cwd/roots")) return json({ roots, defaultCwd: "/x" });
      if (path.includes("/v1/cwd/validate")) {
        expect(init?.method ?? "POST").toBe("POST");
        roots = ["/x", "/other/repo"];
        return json({ success: true, cwd: "/other/repo" });
      }
      return json({});
    }) as unknown as typeof fetch;
    renderTab();
    await waitFor(() => expect(screen.getByTestId("allowed-roots-list").textContent).toContain("/x"));
    fireEvent.change(screen.getByTestId("allowed-roots-path"), { target: { value: "/other/repo" } });
    fireEvent.click(screen.getByTestId("allowed-roots-add"));
    await waitFor(() => expect(screen.getByTestId("allowed-roots-list").textContent).toContain("/other/repo"));
  });

  it("keeps the current roots when authorize fails", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/v1/cwd/roots")) return json({ roots: ["/x"], defaultCwd: "/x" });
      if (path.includes("/v1/cwd/validate")) {
        return json({ error: "Path is outside the allowed roots", code: "PATH_FORBIDDEN" }, 403);
      }
      return json({});
    }) as unknown as typeof fetch;
    renderTab();
    await waitFor(() => expect(screen.getByTestId("allowed-roots-list").textContent).toContain("/x"));
    fireEvent.change(screen.getByTestId("allowed-roots-path"), { target: { value: "/secret" } });
    fireEvent.click(screen.getByTestId("allowed-roots-add"));
    await waitFor(() => expect(screen.getByTestId("allowed-roots-error").textContent).toBe("Project path is outside the allowed roots."));
    expect(screen.getByTestId("allowed-roots-list").textContent).toContain("/x");
    expect(screen.getByTestId("allowed-roots-list").textContent).not.toContain("/secret");
  });
});
