import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { SettingsModal } from "./SettingsModal";

// jsdom has no matchMedia; a permissive desktop stub by default.
(globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => false,
  dispatchEvent: () => false,
});

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(initialTab?: string, capabilities: HostCapability[] = ["settings.configure"]) {
  vi.stubGlobal("fetch", vi.fn(async () => json({})));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities }}>
          <I18nProvider>
            <SettingsModal initialTab={initialTab as never} onCloseAction={() => {}} />
          </I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsModal information architecture", () => {
  it("renders scope groups once and pages without the old scope chip", () => {
    mount("appearance");
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Extensions")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
    // The nav carries no hint paragraph; the scope sentence lives on each
    // Agent page description instead.
    fireEvent.click(screen.getByTestId("settings-tab-providers"));
    expect(screen.getAllByText(/Shared by all sessions/).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Model providers" })).toBeTruthy();
    // The old per-page scope chip is gone.
    expect(screen.queryByText("this device")).toBeNull();
    expect(screen.queryByText("global")).toBeNull();
    for (const id of ["appearance", "input", "archive", "providers", "capabilities", "subagents", "tools", "session", "skills", "plugins", "access", "advanced"]) {
      expect(screen.getByTestId(`settings-tab-${id}`)).toBeTruthy();
    }
  });

  it("switches pages and marks the active nav item", () => {
    mount("appearance");
    expect(screen.getByTestId("settings-tab-appearance").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("settings-tab-tools"));
    expect(screen.getByTestId("settings-tab-tools").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("settings-tab-appearance").getAttribute("aria-current")).toBeNull();
    // Page header title switches (section headings may share the name).
    expect(screen.getAllByRole("heading", { name: "Tools" }).length).toBeGreaterThan(0);
  });

  it("mobile shows a list → detail flow with a back button", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      media: "(max-width: 640px)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })));
    mount("appearance");
    // Detail is hidden until a page is picked from the list.
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
    fireEvent.click(screen.getByTestId("settings-tab-access"));
    expect(screen.getAllByRole("heading", { name: "Access key" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("heading", { name: "Access key" })).toBeNull();
    expect(screen.getByTestId("settings-tab-access")).toBeTruthy();
  });
});

describe("SettingsModal unsaved-changes guard", () => {
  async function makeToolsDirty() {
    let revision = "a".repeat(64);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        revision = "b".repeat(64);
        return json({ revision, selection: { mode: "custom", toolNames: ["read"] } });
      }
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "bash"] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["settings.configure"] }}>
            <I18nProvider>
              <SettingsModal initialTab="tools" onCloseAction={() => {}} />
            </I18nProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeTruthy());
  }

  it("asks before leaving a dirty draft page and discards only on consent", async () => {
    await makeToolsDirty();
    fireEvent.click(screen.getByTestId("settings-tab-appearance"));
    // Guard opens; page has not switched yet.
    expect(screen.getByText("Leaving this page will discard your unsaved changes.")).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Tools" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getAllByRole("heading", { name: "Tools" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("settings-tab-appearance"));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getAllByRole("heading", { name: "Appearance" }).length).toBeGreaterThan(0);
    // The draft was discarded: no residual save bar on the tools page.
    fireEvent.click(screen.getByTestId("settings-tab-tools"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  });

  it("asks before closing the dialog with a dirty draft", async () => {
    await makeToolsDirty();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByText("Leaving this page will discard your unsaved changes.")).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Tools" }).length).toBeGreaterThan(0);
  });
});
