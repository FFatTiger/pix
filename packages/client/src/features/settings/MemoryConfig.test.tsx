import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { MemoryConfig } from "./MemoryConfig";

const revision = "a".repeat(64);

const LORE_NONE = { configured: false, baseUrl: null, source: "none", tokenConfigured: false };
const LORE_CONNECTED = { configured: true, baseUrl: "https://api.loremem.com", source: "config", tokenConfigured: true };

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["settings.configure"] }}>
          <I18nProvider><MemoryConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function defaultFetch(overrides: { memory?: unknown } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/v1/settings/memory/lore-test")) return json({ ok: true, baseUrl: "https://api.loremem.com" });
    if (path.includes("/v1/settings/memory/lore")) return json(LORE_CONNECTED);
    if (path.includes("/v1/settings/memory")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider?: string };
        return json({
          revision: "b".repeat(64),
          provider: body.provider ?? "local",
          providerExplicit: true,
          lore: overrides.memory ? (overrides.memory as { lore: unknown }).lore : LORE_NONE,
        });
      }
      return json(overrides.memory ?? { revision, provider: "local", providerExplicit: false, lore: LORE_NONE });
    }
    return json({});
  });
}

describe("MemoryConfig", () => {
  it("renders the three-way provider selection with the current provider and no dirty bar", async () => {
    mount(defaultFetch());
    expect(await screen.findByRole("radio", { name: "Local memory" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Lore" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Off" })).toBeTruthy();
    expect(screen.getByText("Current: local memory (all sessions share ~/.pi/agent/memory)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("local selection shows the bundled pi-memory description", async () => {
    mount(defaultFetch());
    await screen.findByRole("radio", { name: "Local memory" });
    expect(screen.getByText(/memory_read \/ memory_write/)).toBeTruthy();
    expect(screen.getByText(/session-exit summary is disabled/)).toBeTruthy();
  });

  it("lore selection without a connection shows guidance links and requires a passing test before save", async () => {
    let tested = 0;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method) calls.push(`${init.method} ${path}`);
      if (path.includes("/v1/settings/memory/lore-test")) {
        tested += 1;
        return json(tested === 1 ? { ok: false, reason: "unauthorized" } : { ok: true, baseUrl: "https://api.loremem.com" });
      }
      if (path.includes("/v1/settings/memory/lore") && init?.method === "PUT") return json(LORE_CONNECTED);
      if (path.includes("/v1/settings/memory") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: string };
        return json({ revision: "b".repeat(64), provider: body.provider, providerExplicit: true, lore: LORE_CONNECTED });
      }
      if (path.includes("/v1/settings/memory")) return json({ revision, provider: "local", providerExplicit: false, lore: LORE_NONE });
      return json({});
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("radio", { name: "Lore" }));
    // Guidance links for SaaS signup / self-host / manual connection.
    expect(screen.getByText("Sign up on loremem.com")).toBeTruthy();
    expect(screen.getByText("Self-host guide")).toBeTruthy();
    expect(screen.getByText("Connect an existing server")).toBeTruthy();
    // Token field never echoes a value (write-only).
    const token = screen.getByLabelText("API token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "lm_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/token is invalid or expired/i)).toBeTruthy();
    // Save is blocked while the last test failed.
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection OK")).toBeTruthy();
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      // Connection first (token write-only), then the provider CAS write.
      expect(calls.filter((entry) => entry.startsWith("PUT /v1/settings/memory"))).toEqual([
        "PUT /v1/settings/memory/lore",
        "PUT /v1/settings/memory",
      ]);
    });
  });

  it("switching lore→local warns that Lore memories are not migrated", async () => {
    mount(defaultFetch({ memory: { revision, provider: "lore", providerExplicit: true, lore: LORE_CONNECTED } }));
    await screen.findByText(/Current: Lore \(connected\)/);
    fireEvent.click(screen.getByRole("radio", { name: "Local memory" }));
    expect(screen.getByText(/memories stored in Lore are NOT migrated/)).toBeTruthy();
  });

  it("off hides every memory section copy", async () => {
    mount(defaultFetch());
    await screen.findByRole("radio", { name: "Local memory" });
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(screen.getByText(/No memory plugin loads/)).toBeTruthy();
    expect(screen.queryByText(/memory_read \/ memory_write/)).toBeNull();
  });
});
