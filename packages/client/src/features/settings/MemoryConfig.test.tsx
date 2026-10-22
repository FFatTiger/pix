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
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
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
    // No saved connection → Lore Cloud: only the key link + token, the
    // hosted address is implied (no address field).
    expect((screen.getByRole("radio", { name: "Lore Cloud" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Create a free cloud key")).toBeTruthy();
    expect(screen.queryByText("Self-host guide")).toBeNull();
    expect(screen.queryByLabelText("Server address")).toBeNull();
    // Token field never echoes a value (write-only).
    const token = screen.getByLabelText("API token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "lm_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/token is invalid or expired/i)).toBeTruthy();
    // Save is blocked while the last test failed.
    expect((screen.getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection OK")).toBeTruthy();
    expect((screen.getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      // Connection first (token write-only), then the provider CAS write.
      expect(calls.filter((entry) => entry.startsWith("PUT /v1/settings/memory"))).toEqual([
        "PUT /v1/settings/memory/lore",
        "PUT /v1/settings/memory",
      ]);
    });
  });

  it("switching providers shows no consequence copy", async () => {
    mount(defaultFetch({ memory: { revision, provider: "lore", providerExplicit: true, lore: LORE_CONNECTED } }));
    await screen.findByRole("radio", { name: "Lore" });
    fireEvent.click(screen.getByRole("radio", { name: "Local memory" }));
    expect(screen.queryByText(/migrat|upload|reload/i)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    // Off keeps the page to the three-way choice — no explanatory section.
    expect(screen.queryByText(/memory_read|plugin/i)).toBeNull();
  });

  it("self-hosted shows the address field and guide links; a saved LAN address preselects it", async () => {
    const LAN = { configured: true, baseUrl: "http://192.168.50.20:18901", source: "config", tokenConfigured: true };
    mount(defaultFetch({ memory: { revision, provider: "lore", providerExplicit: true, lore: LAN } }));
    expect((await screen.findByRole("radio", { name: "Self-hosted" })).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("http://192.168.50.20:18901");
    expect(screen.getByText("Self-host guide")).toBeTruthy();
    expect(screen.getByText("Connect an existing server")).toBeTruthy();
    expect((screen.getByLabelText("API token") as HTMLInputElement).placeholder).toMatch(/Saved/);
    // Switching to Lore Cloud drops the address field; the saved token does
    // not apply to the hosted endpoint, so the placeholder stops claiming it.
    fireEvent.click(screen.getByRole("radio", { name: "Lore Cloud" }));
    expect(screen.queryByLabelText("Server address")).toBeNull();
    expect((screen.getByLabelText("API token") as HTMLInputElement).placeholder).not.toMatch(/Saved/);
    // Back to self-hosted restores the saved address.
    fireEvent.click(screen.getByRole("radio", { name: "Self-hosted" }));
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("http://192.168.50.20:18901");
  });

  it("a test REQUEST failure is shown, never swallowed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/v1/settings/memory/lore-test")) {
        return json({ error: { code: "RATE_LIMITED", message: "slow down" } }, { status: 429 });
      }
      if (path.includes("/v1/settings/memory")) return json({ revision, provider: "lore", providerExplicit: true, lore: LORE_CONNECTED });
      return json({});
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Too many tests/);
  });

  it("an insecure-http probe result shows the LAN/Tailscale rule", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/v1/settings/memory/lore-test")) return json({ ok: false, reason: "insecure_http" });
      if (path.includes("/v1/settings/memory")) return json({ revision, provider: "lore", providerExplicit: true, lore: LORE_CONNECTED });
      return json({});
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/HTTPS.*LAN, Tailscale/);
  });

  it("a failed save's error clears when another provider is picked", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/v1/settings/memory") && init?.method === "PUT") {
        return json({ error: { code: "UNAVAILABLE", message: "x" } }, { status: 503 });
      }
      if (path.includes("/v1/settings/memory")) return json({ revision, provider: "local", providerExplicit: false, lore: LORE_NONE });
      return json({});
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("radio", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Failed to save memory settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Local memory" }));
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(screen.queryByText("Failed to save memory settings")).toBeNull();
  });
});
