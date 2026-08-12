import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { TrustBadge } from "./TrustBadge";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderBadge(host: Partial<HostInfo>, props: { cwd?: string | undefined; variant?: "badge" | "summary" } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>{children}</CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  return render(<TrustBadge cwd={props.cwd} variant={props.variant ?? "badge"} />, { wrapper: Wrapper });
}

describe("TrustBadge", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
    cleanup();
  });

  it("issues ZERO requests without cwd", () => {
    const fetchImpl = vi.fn();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const { container } = renderBadge({ mode: "local", capabilities: ["skills"] }, { cwd: undefined });
    expect(container.textContent).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("issues ZERO requests without skills/plugins cap", () => {
    const fetchImpl = vi.fn();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    const { container } = renderBadge({ mode: "local", capabilities: ["models"] }, { cwd: "/proj" });
    expect(container.firstChild).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders Trusted / Denied / Unknown states", async () => {
    for (const [level, label] of [
      ["trusted", "Trusted"],
      ["denied", "Denied"],
      ["unknown", "Unknown"],
    ] as const) {
      cleanup();
      const fetchImpl = vi.fn(async () =>
        json({
          cwd: "/proj",
          level,
          trusted: level === "trusted",
          canReloadResources: {
            allowed: level === "trusted",
            level,
            ...(level === "trusted" ? {} : { reason: "Project resources are not trusted" }),
          },
        }),
      );
      globalThis.fetch = fetchImpl as unknown as typeof fetch;
      renderBadge({ mode: "local", capabilities: ["skills"] }, { cwd: "/proj" });
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
      const firstCall = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL] | undefined;
      expect(String(firstCall?.[0])).toContain("/v1/trust?cwd=%2Fproj");
    }
  });

  it("sanitizes error — no path/secret/raw body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: "secret /Users/proxy/.agent key=sk-xyz", code: "PATH_FORBIDDEN" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    renderBadge({ mode: "local", capabilities: ["plugins"] }, { cwd: "/proj", variant: "summary" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Project path is outside the allowed roots."),
    );
    expect(screen.queryByText(/sk-xyz/)).toBeNull();
    expect(screen.queryByText(/\.agent/)).toBeNull();
  });
});
