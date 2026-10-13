import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { PluginsConfig } from "./PluginsConfig";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, hostCapabilities: HostCapability[]) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: hostCapabilities }}>
          <I18nProvider><PluginsConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PluginsConfig global disk catalog", () => {
  it("loads plugin packages and never duplicates the commands catalog here", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/v1/plugins") return json({ plugins: [{ name: "demo", enabled: true, version: "1" }] });
      throw new Error(`unexpected ${url}`);
    });
    mount(fetchMock, ["plugins", "skills"]);
    expect(await screen.findByText("demo")).toBeTruthy();
    expect(screen.queryByText("Commands")).toBeNull();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/v1/plugins"]);
  });

  it("shows pending and errors without pretending they are empty", async () => {
    let resolvePlugins: (response: Response) => void = () => {};
    const fetchMock = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolvePlugins = resolve;
    }));
    mount(fetchMock, ["plugins"]);
    expect(screen.getByText("Loading Plugins…")).toBeTruthy();
    expect(screen.queryByText("No Plugins.")).toBeNull();
    await act(async () => {
      resolvePlugins(json({ code: "UNAVAILABLE", message: "down" }, { status: 503 }));
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No Plugins.")).toBeNull();
  });

  it("shows package names with source badges and only marks disabled entries", async () => {
    const fetchMock = vi.fn(async () => json({ plugins: [
      { name: "npm:pi-smart-compact@1.2.3", enabled: true, version: "1.2.3" },
      { name: "npm:@scope/kit@2.0.0", enabled: true },
      { name: "https://github.com/user/diagram-design", enabled: false },
      { name: "/local/plugin", enabled: true },
    ] }));
    mount(fetchMock, ["plugins"]);
    await screen.findByText("pi-smart-compact");
    expect(screen.getByText("@scope/kit")).toBeTruthy();
    expect(screen.getByText("diagram-design")).toBeTruthy();
    expect(screen.getByText("/local/plugin")).toBeTruthy();
    // Source metadata as small badges; local installs say so, in a fixed
    // source-then-version order (entries without a version show only the source).
    expect(screen.getAllByText("npm").length).toBe(2);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Local")).toBeTruthy();
    // Enabled entries carry no status badge; disabled ones do.
    expect(screen.getByText("disabled")).toBeTruthy();
    expect(screen.queryByText("enabled")).toBeNull();
  });

  it("does not fetch plugins without the capability", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(fetchMock, []);
    expect(screen.getByText("Plugins catalog is not available.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
