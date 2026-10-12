import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { SkillsConfig } from "./SkillsConfig";

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
          <I18nProvider><SkillsConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SkillsConfig global disk catalogs", () => {
  it("loads skills without a cwd query and shows pending then empty", async () => {
    let resolveGet: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/v1/skills");
      return new Promise<Response>((resolve) => { resolveGet = resolve; });
    });
    mount(fetchMock, ["skills"]);
    expect(await screen.findByText("Loading Skills…")).toBeTruthy();
    expect(screen.queryByText("No Skills.")).toBeNull();
    resolveGet(json({ skills: [] }));
    expect(await screen.findByText("No Skills.")).toBeTruthy();
  });

  it("reports a skills catalog error honestly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/v1/commands"
        ? json({ commands: [] })
        : json({ code: "UNAVAILABLE", message: "down" }, { status: 503 }));
    mount(fetchMock, ["skills"]);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No Skills.")).toBeNull();
  });

  it("lists commands once, here, with their source", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/v1/skills") return json({ skills: [] });
      if (url === "/v1/commands") return json({ commands: [{ name: "ping", source: "skill", description: "hi" }] });
      throw new Error(`unexpected ${url}`);
    });
    mount(fetchMock, ["skills"]);
    expect(await screen.findByText("/ping")).toBeTruthy();
    expect(screen.getByText("skill")).toBeTruthy();
  });

  it("shows pending and errors for commands without pretending they are empty", async () => {
    const responses = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      responses.set(String(input), resolve);
    }));
    mount(fetchMock, ["skills"]);
    expect(screen.getByText("Loading Skills…")).toBeTruthy();
    expect(screen.getByText("Loading Commands…")).toBeTruthy();
    expect(screen.queryByText("No Commands.")).toBeNull();
    await act(async () => {
      responses.get("/v1/skills")!(json({ skills: [] }));
      responses.get("/v1/commands")!(json({ code: "UNAVAILABLE", message: "down" }, { status: 503 }));
    });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.queryByText("No Commands.")).toBeNull();
  });

  it("does not fetch without the matching capability", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(fetchMock, []);
    expect(await screen.findByText("Skills catalog is not available.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the commands catalog with only the skills capability", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/v1/commands") return json({ commands: [] });
      return json({ skills: [] });
    });
    mount(fetchMock, ["skills"]);
    expect(await screen.findByText("No Commands.")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/v1/commands")).toHaveLength(1);
  });
});
