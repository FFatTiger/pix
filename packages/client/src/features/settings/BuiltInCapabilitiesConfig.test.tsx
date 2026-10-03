import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { RuntimeProvider } from "@/runtime";
import { BuiltInCapabilitiesConfig } from "./BuiltInCapabilitiesConfig";

const revision = "a".repeat(64);
const capabilities = [
  { id: "subagents", enabled: true },
  { id: "todo", enabled: true },
  { id: "ask_user_question", enabled: true },
  { id: "side_chat", enabled: false },
] as const;

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, hostCapabilities: HostCapability[] = ["builtins.configure"]) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: hostCapabilities }}>
          <RuntimeProvider>
            <I18nProvider><BuiltInCapabilitiesConfig /></I18nProvider>
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BuiltInCapabilitiesConfig", () => {
  it("shows all loadable features and saves a four-entry CAS full replacement", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/v1/settings/built-ins");
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({
          revision: "b".repeat(64),
          capabilities: capabilities.map((row) => row.id === "todo" ? { ...row, enabled: false } : row),
        });
      }
      return json({ revision, capabilities });
    });
    mount(fetchMock);

    expect((await screen.findByRole("switch", { name: "Subagents" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Side chat" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Task list" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toEqual({
      expectedRevision: revision,
      capabilities: capabilities.map((row) => row.id === "todo" ? { ...row, enabled: false } : row),
    });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Task list" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("does not fetch or fabricate controls without builtins.configure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(fetchMock, []);
    expect(await screen.findByText("Agent feature settings are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
