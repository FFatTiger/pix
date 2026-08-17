import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider, useCapabilities } from "./CapabilityProvider";
import type { HostInfo } from "@fffattiger/pix-protocol";

function Probe() {
  const value = useCapabilities();
  return <div>{value.mode}:{String(value.canAgent)}:{String(value.isReadonly)}:{String(value.unavailable)}:{String(value.canBrowseSessions)}:{value.capabilities.join(",")}</div>;
}

function WriteProbe() {
  const value = useCapabilities();
  return (
    <div>
      {String(value.canWriteSessions)}:{String(value.canDeleteSessions)}:{String(value.canBrowseSessions)}
    </div>
  );
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
      service: "pix-host",
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
      if (path.includes("bootstrap")) return bootstrapResponse({ capabilities: ["agent", "sessions", "files"] });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    renderProvider();
    await waitFor(() => expect(screen.getByText("lan:true:false:false:true:agent,sessions,files")).toBeTruthy());
    // Backend-neutral: no SDK/RPC leakage in the negotiated capabilities.
    expect(screen.getByText(/lan:/).textContent).not.toMatch(/sdk|rpc/i);
  });

  it("fails safely to empty capability when host is unavailable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch;
    renderProvider();
    await waitFor(() => expect(screen.getByText("local:false:true:true:false:")).toBeTruthy());
  });

  it("canBrowseSessions follows the `sessions` token, not sessiond liveness: up but no token → false", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = String(input);
      if (path.includes("bootstrap")) return bootstrapResponse({ sessiond: "up", capabilities: ["agent", "files"], mode: "local" });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    renderProvider();
    await waitFor(() => expect(screen.getByText("local:true:false:false:false:agent,files")).toBeTruthy());
  });

  it("canBrowseSessions is false when sessiond is down (token retracted)", async () => {
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

  it("canWriteSessions follows the session.write token (rename gate) and never infers it", () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><HttpClientProvider>{children}</HttpClientProvider></QueryClientProvider>;
    const renderWrite = (capabilities: string[]) => render(
      <CapabilityProvider host={{ mode: "local", capabilities: capabilities as HostInfo["capabilities"] }}><WriteProbe /></CapabilityProvider>,
      { wrapper: Wrapper },
    );
    renderWrite(["sessions", "session.write"]);
    expect(screen.getByText("true:false:true")).toBeTruthy();
    cleanup();
    // session.delete alone does NOT imply session.write (and vice versa).
    renderWrite(["sessions", "session.delete"]);
    expect(screen.getByText("false:true:true")).toBeTruthy();
    cleanup();
    // No session token at all → rename gate closed.
    renderWrite(["agent"]);
    expect(screen.getByText("false:false:false")).toBeTruthy();
  });
});
