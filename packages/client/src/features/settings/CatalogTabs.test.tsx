import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { PluginsSettingsTab, SkillsSettingsTab } from "./CatalogTabs";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(
  Tab: typeof SkillsSettingsTab | typeof PluginsSettingsTab,
  fetchImpl: ReturnType<typeof vi.fn>,
  hostCapabilities: HostCapability[],
) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: hostCapabilities }}>
          <I18nProvider><Tab /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CatalogTabs global disk catalogs", () => {
  it("loads skills without a cwd query and shows pending then empty", async () => {
    let resolveGet: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/v1/skills");
      return new Promise<Response>((resolve) => { resolveGet = resolve; });
    });
    mount(SkillsSettingsTab, fetchMock, ["skills"]);
    expect(await screen.findByText("Loading Skills…")).toBeTruthy();
    expect(screen.queryByText("No Skills.")).toBeNull();
    resolveGet(json({ skills: [] }));
    expect(await screen.findByText("No Skills.")).toBeTruthy();
  });

  it("reports a skills catalog error honestly", async () => {
    const fetchMock = vi.fn(async () => json({ code: "UNAVAILABLE", message: "down" }, { status: 503 }));
    mount(SkillsSettingsTab, fetchMock, ["skills"]);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No Skills.")).toBeNull();
  });

  it("loads plugins and commands as global catalogs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/v1/plugins") return json({ plugins: [{ name: "demo", enabled: true, version: "1" }] });
      if (url === "/v1/commands") return json({ commands: [{ name: "ping", source: "skill", description: "hi" }] });
      throw new Error(`unexpected ${url}`);
    });
    mount(PluginsSettingsTab, fetchMock, ["plugins", "skills"]);
    expect(await screen.findByText("demo")).toBeTruthy();
    expect(await screen.findByText("/ping")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.map((call) => String(call[0])).sort()).toEqual(["/v1/commands", "/v1/plugins"]));
  });

  it("shows pending and errors for plugins and commands without pretending they are empty", async () => {
    const responses = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      responses.set(String(input), resolve);
    }));
    mount(PluginsSettingsTab, fetchMock, ["plugins"]);
    expect(screen.getByText("Loading Plugins…")).toBeTruthy();
    expect(screen.getByText("Loading Commands…")).toBeTruthy();
    expect(screen.queryByText("No Plugins.")).toBeNull();
    expect(screen.queryByText("No Commands.")).toBeNull();
    await act(async () => {
      responses.get("/v1/plugins")!(json({ code: "UNAVAILABLE", message: "down" }, { status: 503 }));
      responses.get("/v1/commands")!(json({ code: "UNAVAILABLE", message: "down" }, { status: 503 }));
    });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.queryByText("No Plugins.")).toBeNull();
    expect(screen.queryByText("No Commands.")).toBeNull();
  });

  it("does not fetch plugins or commands without their capabilities", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(PluginsSettingsTab, fetchMock, []);
    expect(screen.getByText("Plugins catalog is not available.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the global commands catalog with only the skills capability", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/v1/commands");
      return json({ commands: [] });
    });
    mount(PluginsSettingsTab, fetchMock, ["skills"]);
    expect(screen.getByText("Plugins catalog is not available.")).toBeTruthy();
    expect(await screen.findByText("No Commands.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not fetch without the matching capability", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(SkillsSettingsTab, fetchMock, []);
    expect(await screen.findByText("Skills catalog is not available.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
