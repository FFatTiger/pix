import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { AboutConfig } from "./AboutConfig";

const ABOUT = {
  pix: { version: "0.3.1" },
  pi: { codingAgent: "1.0.0" },
  node: "25.0.0",
  platform: "darwin",
  arch: "arm64",
  plugins: [
    { id: "subagents", name: "pi-claude-subagents", version: "0.3.9" },
    { id: "lore", name: "@local/lore-pi-extension", version: "1.5.1" },
  ],
};

// Wire package name comes from the host (the client never hardcodes a
// sibling package name); any non-empty value exercises the composition.
const UPDATE_PACKAGE = "pix-update-pkg";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(updateResult: unknown) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.includes("/v1/about/check-update")) {
      return json({ package: UPDATE_PACKAGE, ...(updateResult as Record<string, unknown>) });
    }
    if (path.includes("/v1/about")) return json(ABOUT);
    return json({});
  });
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["settings.configure"] }}>
          <I18nProvider><AboutConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AboutConfig", () => {
  it("renders the header, runtime, and bundled-plugin groups from /v1/about", async () => {
    const { calls } = mount({ current: "0.3.1", latest: null, updateAvailable: false });
    expect(await screen.findByTestId("about-header")).toBeTruthy();
    expect(screen.getByText("Pix")).toBeTruthy();
    expect(screen.getByText("v0.3.1")).toBeTruthy();
    // Runtime group: Pi, Node, platform · arch.
    expect(screen.getByText("1.0.0")).toBeTruthy();
    expect(screen.getByText("25.0.0")).toBeTruthy();
    expect(screen.getByText("darwin · arm64")).toBeTruthy();
    // Bundled plugins: name left, version right — from the wire, never hardcoded.
    expect(screen.getByText("pi-claude-subagents")).toBeTruthy();
    expect(screen.getByText("0.3.9")).toBeTruthy();
    expect(screen.getByText("@local/lore-pi-extension")).toBeTruthy();
    expect(screen.getByText("1.5.1")).toBeTruthy();
    // No auto-request: the update probe fires only on the explicit click.
    expect(calls.some((entry) => entry.startsWith("POST /v1/about/check-update"))).toBe(false);
  });

  it("shows the new version with the install command and release-notes link", async () => {
    mount({ current: "0.3.1", latest: "0.4.0", updateAvailable: true });
    fireEvent.click(await screen.findByTestId("about-check-update"));
    expect(await screen.findByTestId("about-update-available")).toBeTruthy();
    expect(screen.getByText("Version 0.4.0 is available.")).toBeTruthy();
    expect(screen.getByTestId("about-update-command").textContent).toContain("pix update 0.4.0");
    const link = screen.getByRole("link", { name: "Release notes" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/FFatTiger/pix/releases/tag/v0.4.0");
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("reports up to date when latest equals current", async () => {
    mount({ current: "0.3.1", latest: "0.3.1", updateAvailable: false });
    fireEvent.click(await screen.findByTestId("about-check-update"));
    expect(await screen.findByTestId("about-update-latest")).toBeTruthy();
    expect(screen.getByText("Up to date (0.3.1).")).toBeTruthy();
    expect(screen.queryByTestId("about-update-command")).toBeNull();
  });

  it("reports unreachable when the registry probe fails closed", async () => {
    mount({ current: "0.3.1", latest: null, updateAvailable: false });
    fireEvent.click(await screen.findByTestId("about-check-update"));
    expect(await screen.findByTestId("about-update-unreachable")).toBeTruthy();
    expect(screen.getByText("Couldn't reach the update server.")).toBeTruthy();
  });
});
