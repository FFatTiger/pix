import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider, useCapabilities } from "./CapabilityProvider";

function Probe() {
  const value = useCapabilities();
  return <div>{value.mode}:{String(value.canAgent)}:{String(value.isReadonly)}:{String(value.unavailable)}:{String(value.canBrowseSessions)}:{value.capabilities.join(",")}</div>;
}

function renderProvider(host?: Parameters<typeof CapabilityProvider>[0]["host"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><HttpClientProvider>{children}</HttpClientProvider></QueryClientProvider>;
  return render(<CapabilityProvider {...(host === undefined ? {} : { host })}><Probe /></CapabilityProvider>, { wrapper: Wrapper });
}

function bootstrapResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "pi-web-host",
      protocolVersion: 1,
      sessiond: "up",
      capabilities: ["agent", "files"],
      mode: "lan",
      gate: { required: true, status: "enabled" },
      ...overrides,
    }),
    { status: 200 },
  );
}

describe("CapabilityProvider", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { previousFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previousFetch; });

  it("loads capabilities and LAN mode from the real bootstrap surface", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("bootstrap")) return bootstrapResponse();
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    renderProvider();
    await waitFor(() => expect(screen.getByText("lan:true:false:false:true:agent,files")).toBeTruthy());
    // Backend-neutral: no SDK/RPC leakage in the negotiated capabilities.
    expect(screen.getByText(/lan:/).textContent).not.toMatch(/sdk|rpc/i);
  });

  it("fails safely to empty capability when host is unavailable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch;
    renderProvider();
    await waitFor(() => expect(screen.getByText("local:false:true:true:false:")).toBeTruthy());
  });

  it("disables session browsing until sessiond is up", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("bootstrap")) return bootstrapResponse({ sessiond: "down", capabilities: [], mode: "local" });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    renderProvider();
    await waitFor(() => expect(screen.getByText("local:false:true:true:false:")).toBeTruthy());
  });

  it("supports an explicit test override without network", () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderProvider({ mode: "local", capabilities: ["files", "git"] });
    expect(screen.getByText("local:false:true:false:false:files,git")).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
