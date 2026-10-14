import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { CompactionConfig } from "./CompactionConfig";

const revision = "a".repeat(64);

const COMPACTION = {
  native: { enabled: true, reserveTokens: null, keepRecentTokens: null },
  smart: {
    autoTrigger: true, minContextPercent: 80, profile: "balanced",
    summaryModel: null, segmentationModel: null,
    summaryThinkingLevel: null, segmentationThinkingLevel: null,
    autoTriggerTimeoutMs: 300000, backupEnabled: true, scrubSecrets: true,
    focusWeighting: true, onlineDamageMonitor: true, adaptiveDamageFeedback: false,
  },
};

const BUILTINS_ON = { revision: "c".repeat(64), capabilities: [
  { id: "subagents", enabled: true },
  { id: "todo", enabled: true },
  { id: "ask_user_question", enabled: true },
  { id: "side_chat", enabled: true },
  { id: "smart_compact", enabled: true },
] };

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["settings.configure", "builtins.configure", "models"] }}>
          <I18nProvider><CompactionConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Default fetch stub: compaction + built-ins + models + gate-ish endpoints the tree may touch. */
function defaultFetch(overrides: { compaction?: unknown; builtIns?: unknown } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/v1/settings/compaction")) return json(overrides.compaction ?? { revision, settings: COMPACTION });
    if (path.includes("/v1/settings/built-ins")) return json(overrides.builtIns ?? BUILTINS_ON);
    if (path.includes("/v1/models")) return json({ models: [], defaultModel: null });
    return json({});
  });
}

describe("CompactionConfig", () => {
  it("renders the smart-compaction switch with its settings and no dirty bar", async () => {
    mount(defaultFetch());
    // One switch, shared with the Capabilities page — no separate auto-compaction switch.
    expect((await screen.findByRole("switch", { name: "Smart compaction" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Tidies long conversations automatically and keeps what matters.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Automatic compaction" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Trigger automatically" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Balanced")).toBeTruthy();
    expect(screen.getByText("80% used")).toBeTruthy();
    // Clean state: no save bar.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("edits draft fields and saves one CAS PUT with the full settings object", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/v1/settings/compaction") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), settings: (putBody as { settings: unknown }).settings });
      }
      if (path.includes("/v1/settings/compaction")) return json({ revision, settings: COMPACTION });
      if (path.includes("/v1/settings/built-ins")) return json(BUILTINS_ON);
      if (path.includes("/v1/models")) return json({ models: [], defaultModel: null });
      return json({});
    });
    mount(fetchMock);

    await screen.findByRole("switch", { name: "Smart compaction" });
    fireEvent.click(screen.getByRole("switch", { name: "Trigger automatically" }));
    fireEvent.click(screen.getByRole("radio", { name: "Aggressive" }));
    // Save bar appears once dirty.
    const save = await screen.findByRole("button", { name: /save/i });
    fireEvent.click(save);

    await waitFor(() => expect(putBody).toBeTruthy());
    const body = putBody as { expectedRevision: string; settings: { smart: { autoTrigger: boolean; profile: string } } };
    expect(body.expectedRevision).toBe(revision);
    expect(body.settings.smart.autoTrigger).toBe(false);
    expect(body.settings.smart.profile).toBe("aggressive");
  });

  it("hides every smart setting when the capability is off, with no status copy", async () => {
    mount(defaultFetch({ builtIns: { revision: "c".repeat(64), capabilities: BUILTINS_ON.capabilities.map((row) => row.id === "smart_compact" ? { ...row, enabled: false } : row) } }));
    const toggle = await screen.findByRole("switch", { name: "Smart compaction" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Collapsed: no threshold, profile, models, and no explanatory status text.
    expect(screen.queryByRole("switch", { name: "Trigger automatically" })).toBeNull();
    expect(screen.queryByText("Balanced")).toBeNull();
    expect(screen.queryByText(/built-in|fallback/i)).toBeNull();
  });

  it("writes the same built-ins capability the Capabilities page owns", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/v1/settings/built-ins") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "d".repeat(64), capabilities: (putBody as { capabilities: unknown }).capabilities });
      }
      if (path.includes("/v1/settings/compaction")) return json({ revision, settings: COMPACTION });
      if (path.includes("/v1/settings/built-ins")) return json(BUILTINS_ON);
      if (path.includes("/v1/models")) return json({ models: [], defaultModel: null });
      return json({});
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: "Smart compaction" }));
    await waitFor(() => expect(putBody).toBeTruthy());
    const body = putBody as { expectedRevision: string; capabilities: Array<{ id: string; enabled: boolean }> };
    expect(body.expectedRevision).toBe("c".repeat(64));
    expect(body.capabilities.find((row) => row.id === "smart_compact")?.enabled).toBe(false);
    // The other capability rows ride along unchanged — one shared store, not a second switch.
    expect(body.capabilities.filter((row) => row.id !== "smart_compact").every((row) => row.enabled)).toBe(true);
  });

  it("advanced fields stay hidden until expanded, then edit numeric token overrides", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/v1/settings/compaction") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), settings: (putBody as { settings: unknown }).settings });
      }
      if (path.includes("/v1/settings/compaction")) return json({ revision, settings: COMPACTION });
      if (path.includes("/v1/settings/built-ins")) return json(BUILTINS_ON);
      if (path.includes("/v1/models")) return json({ models: [], defaultModel: null });
      return json({});
    });
    mount(fetchMock);
    await screen.findByRole("switch", { name: "Smart compaction" });
    expect(screen.queryByLabelText("Reserve tokens")).toBeNull();
    // One disclosure only: the Advanced heading itself, never a second expander under it.
    expect(screen.queryByRole("button", { name: "Show advanced settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    const reserve = await screen.findByLabelText("Reserve tokens");
    fireEvent.change(reserve, { target: { value: "20000" } });
    const save = await screen.findByRole("button", { name: /save/i });
    fireEvent.click(save);
    await waitFor(() => expect(putBody).toBeTruthy());
    const body = putBody as { settings: { native: { reserveTokens: number | null } } };
    expect(body.settings.native.reserveTokens).toBe(20000);
  });

  it("surfaces the honest unavailable copy without settings.configure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not fetch"); }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: [] }}>
            <I18nProvider><CompactionConfig /></I18nProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Compaction settings are unavailable right now")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
