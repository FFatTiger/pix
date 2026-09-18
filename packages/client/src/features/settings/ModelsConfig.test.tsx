import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { ModelsConfig } from "./ModelsConfig";

const revision = "a".repeat(64);
const snapshot = {
  revision,
  providers: [{
    sourceId: "acme-deepseek",
    id: "acme-deepseek",
    baseUrl: "http://127.0.0.1:8090/v1",
    api: "openai-responses",
    apiKeyConfigured: true,
    modelsDefined: true,
    models: [{ sourceIndex: 0, id: "deepseek-v4-flash", reasoning: true }],
  }],
  availableProviders: [
    { id: "anthropic", name: "Anthropic", methods: ["oauth", "apiKey"], modelCount: 4 },
    { id: "openai", name: "OpenAI", methods: ["apiKey"], modelCount: 8 },
    { id: "github-copilot", name: "GitHub Copilot", methods: ["oauth"], modelCount: 20 },
  ],
};

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["models", "models.configure"] }}>
          <I18nProvider><ModelsConfig onCloseAction={() => {}} /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ModelsConfig", () => {
  it("renders the provider/model tree and provider picker without exposing API-key material", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/v1/models/config");
      return json(snapshot);
    });
    mount(fetchMock);

    expect((await screen.findAllByText("acme-deepseek")).length).toBeGreaterThan(0);
    expect(screen.getByText("deepseek-v4-flash")).toBeTruthy();
    expect(screen.queryByDisplayValue(/sk-/i)).toBeNull();
    expect(screen.getByPlaceholderText("••••••••••••••••••••••••••••••••").getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByPlaceholderText("Search providers…")).toBeTruthy();
    expect(screen.getByText("OpenAI / Anthropic compatible")).toBeTruthy();
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    // Subscription providers are visible but honestly disabled until the Host
    // mounts an OAuth mutation seam.
    expect(screen.getAllByText("GitHub Copilot")[0]?.closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("imports models through the typed discovery mutation and appends selected rows locally", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/v1/models/discover") {
        expect(init?.method).toBe("POST");
        return json({ models: [{ id: "new-model", name: "New Model" }] });
      }
      return json(snapshot);
    });
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");
    fireEvent.click(screen.getByRole("button", { name: /Import models/i }));
    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Add selected (1)" }));
    expect(screen.getAllByText("new-model").length).toBeGreaterThan(0);
  });

  it("can explicitly remove a stored API key without exposing it", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ ...snapshot, revision: "c".repeat(64), providers: [{ ...snapshot.providers[0], apiKeyConfigured: false }] });
      }
      return json(snapshot);
    });
    mount(fetchMock);

    await screen.findByRole("button", { name: "Remove stored key" });
    fireEvent.click(screen.getByRole("button", { name: "Remove stored key" }));
    expect(screen.getByRole("button", { name: "Keep stored key" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toMatchObject({ providers: [{ apiKey: { mode: "remove" } }] });
  });

  it("shows model-specific conflict copy instead of a catalog or project-path error", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code: "CONFLICT", message: "raw host detail" }, { status: 409 });
      return json(snapshot);
    });
    mount(fetchMock);
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Model configuration changed elsewhere");
    expect(screen.queryByText(/raw host detail|Invalid project path|Catalog unavailable/i)).toBeNull();
  });

  it("saves through the typed global route and preserves an unchanged secret server-side", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/v1/models/config");
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ ...snapshot, revision: "b".repeat(64), providers: [{ ...snapshot.providers[0], id: "renamed", sourceId: "renamed" }] });
      }
      return json(snapshot);
    });
    mount(fetchMock);

    const name = await screen.findByDisplayValue("acme-deepseek");
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toMatchObject({
      expectedRevision: revision,
      providers: [{ sourceId: "acme-deepseek", id: "renamed", apiKey: { mode: "preserve" } }],
    });
    expect(JSON.stringify(putBody)).not.toContain("sk-");
  });
});
