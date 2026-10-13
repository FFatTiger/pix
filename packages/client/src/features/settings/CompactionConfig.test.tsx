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
  it("renders both sections with current values and no dirty bar", async () => {
    mount(defaultFetch());
    expect((await screen.findByRole("switch", { name: "Automatic compaction" })).getAttribute("aria-checked")).toBe("true");
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

    await screen.findByRole("switch", { name: "Automatic compaction" });
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

  it("grays the smart block with the explicit hint when the capability is off", async () => {
    mount(defaultFetch({ builtIns: { revision: "c".repeat(64), capabilities: BUILTINS_ON.capabilities.map((row) => row.id === "smart_compact" ? { ...row, enabled: false } : row) } }));
    await screen.findByRole("switch", { name: "Automatic compaction" });
    expect(screen.getByText("Smart compaction is off — the built-in auto-compaction above carries the workload. Enable it on the Capabilities page.")).toBeTruthy();
    // The disabled fieldset blocks interaction with the smart controls.
    const fieldset = document.querySelector("fieldset[disabled]");
    expect(fieldset).toBeTruthy();
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
    await screen.findByRole("switch", { name: "Automatic compaction" });
    expect(screen.queryByLabelText("Reserve tokens")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show advanced settings" }));
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
