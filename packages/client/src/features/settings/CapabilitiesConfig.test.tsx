import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { CapabilitiesConfig } from "./CapabilitiesConfig";
import type { SettingsPageId } from "./settings-page";

const revision = "a".repeat(64);
const capabilities = [
  { id: "subagents", enabled: true },
  { id: "todo", enabled: true },
  { id: "ask_user_question", enabled: true },
  { id: "side_chat", enabled: false },
  { id: "smart_compact", enabled: true },
] as const;

const memory = {
  revision,
  provider: "lore",
  providerExplicit: true,
  lore: { configured: true, baseUrl: "https://api.loremem.com", source: "config", tokenConfigured: true },
};

const reload = vi.hoisted(() => vi.fn());
const useSelectedRuntime = vi.hoisted(() => vi.fn());
vi.mock("@/runtime", () => ({
  useSelectedRuntime: useSelectedRuntime.mockReturnValue({
    available: true,
    attached: true,
    capabilities: { capabilities: ["runtime.reload"] },
    reload,
  }),
}));

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function mount(
  fetchImpl: ReturnType<typeof vi.fn>,
  hostCapabilities: HostCapability[] = ["builtins.configure", "settings.configure"],
  onOpenPage?: (page: SettingsPageId) => void,
) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: hostCapabilities }}>
          <I18nProvider><CapabilitiesConfig {...(onOpenPage === undefined ? {} : { onOpenPage })} /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

function defaultFetch(overrides: { builtIns?: unknown; memory?: unknown } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/v1/settings/built-ins") return json(overrides.builtIns ?? { revision, capabilities });
    if (path === "/v1/settings/memory") return json(overrides.memory ?? memory);
    return json({});
  });
}

afterEach(() => {
  expect(useSelectedRuntime).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("CapabilitiesConfig overview", () => {
  it("shows one row per registered capability with positive descriptions and the memory choice", async () => {
    mount(defaultFetch());

    expect((await screen.findByRole("switch", { name: "Subagents" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Task list" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Ask user" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Side chat" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Smart compaction" }).getAttribute("aria-checked")).toBe("true");
    // Descriptions describe what the capability does — no off-consequence copy.
    expect(screen.getByText("Lets the model delegate work to subagents.")).toBeTruthy();
    expect(screen.getByText("Lets the model keep a task list.")).toBeTruthy();
    expect(screen.getByText("Lets the model ask you questions while it runs.")).toBeTruthy();
    // Memory is a choice row: the current provider is the status.
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("Keeps preferences, decisions and context across sessions.")).toBeTruthy();
    expect(screen.getByText("Lore")).toBeTruthy();
  });

  it("saves a CAS full replacement when a switch flips", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/v1/settings/built-ins" && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({
          revision: "b".repeat(64),
          capabilities: capabilities.map((row) => row.id === "todo" ? { ...row, enabled: false } : row),
        });
      }
      if (path === "/v1/settings/built-ins") return json({ revision, capabilities });
      if (path === "/v1/settings/memory") return json(memory);
      return json({});
    });
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("switch", { name: "Task list" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    const body = putBody as { expectedRevision: string; capabilities: Array<{ id: string; enabled: boolean }> };
    expect(body.expectedRevision).toBe(revision);
    expect(body.capabilities.find((row) => row.id === "todo")?.enabled).toBe(false);
    expect(body.capabilities.filter((row) => row.id !== "todo").every((row) => row.enabled)).toBe(true);
    expect((await screen.findByRole("switch", { name: "Task list" })).getAttribute("aria-checked")).toBe("false");
  });

  it("opens the detail settings page from a row entry and the memory row", async () => {
    const opened: string[] = [];
    const onOpenPage = (page: SettingsPageId) => opened.push(page);
    mount(defaultFetch(), ["builtins.configure", "settings.configure"], onOpenPage);

    fireEvent.click(await screen.findByRole("button", { name: "Open Subagents settings" }));
    expect(opened).toEqual(["subagents"]);

    fireEvent.click(screen.getByRole("button", { name: "Open Memory settings" }));
    expect(opened).toEqual(["subagents", "memory"]);

    fireEvent.click(screen.getByRole("button", { name: "Open Smart compaction settings" }));
    expect(opened).toEqual(["subagents", "memory", "compaction"]);
  });

  it("shows an honest dash for the memory choice when memory settings are not readable", async () => {
    mount(defaultFetch({ memory: { message: "backend detail" } }), ["builtins.configure", "settings.configure"]);
    await screen.findByRole("switch", { name: "Subagents" });
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders no memory value row control without settings.configure but still lists the capability", async () => {
    mount(defaultFetch(), ["builtins.configure"]);
    await screen.findByRole("switch", { name: "Subagents" });
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.queryByText("Lore")).toBeNull();
  });

  it("fails closed with fixed copy when built-ins cannot be read", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/settings/built-ins") return json({ message: "detail" }, 500);
      if (path === "/v1/settings/memory") return json(memory);
      return json({});
    });
    mount(fetchMock);
    expect(await screen.findByText("Capability settings are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
