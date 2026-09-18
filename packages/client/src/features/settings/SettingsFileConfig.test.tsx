import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { SettingsFileConfig } from "./SettingsFileConfig";

const revision = "a".repeat(64);
const original = '{\n  "defaultProvider": "acme-gpt",\n}\n';

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, capabilities: HostCapability[] = ["models", "settings.configure"]) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities }}>
          <I18nProvider><SettingsFileConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SettingsFileConfig", () => {
  it("loads raw settings.json text and saves the edited text with the loaded revision", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/v1/settings/config");
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), content: "{\n  \"defaultProvider\": \"acme-grok\",\n}\n" });
      }
      return json({ revision, content: original });
    });
    mount(fetchMock);

    const editor = await screen.findByRole("textbox", { name: "settings.json" });
    expect(editor).toHaveProperty("value", original);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(editor, { target: { value: '{\n  "defaultProvider": "acme-grok",\n}\n' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toMatchObject({ expectedRevision: revision });
  });

  it("shows settings-specific conflict copy instead of generic catalog copy", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      return json({ revision, content: original });
    });
    mount(fetchMock);

    const editor = await screen.findByRole("textbox", { name: "settings.json" });
    fireEvent.change(editor, { target: { value: '{"defaultProvider": "x"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("settings.json changed elsewhere");
    expect(screen.queryByText(/raw detail|Catalog unavailable|Invalid project path/i)).toBeNull();
  });

  it("fails honestly without the settings.configure capability", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(fetchMock, ["models"]);
    expect(await screen.findByText("Editing settings.json is not available.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
