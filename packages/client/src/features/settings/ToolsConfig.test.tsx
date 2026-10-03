import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { ToolsConfig } from "./ToolsConfig";

/**
 * Determinated global tools-settings tests. The attached exact runtime is a
 * module-level fake (`useSelectedRuntime` mock) so apply timing, session
 * identity and failure injection are fully controlled without any real
 * runtime/WS machinery.
 */

const revision = "a".repeat(64);

interface FakeRuntime {
  available: boolean;
  attached: boolean;
  sessionId: string;
  epoch: string | null;
  snapshot: { state: { tools: { name: string; active: boolean }[] } } | null;
  capabilities: { capabilities: string[] } | null;
  setTools: ReturnType<typeof vi.fn>;
}

let runtime: FakeRuntime;

vi.mock("@/runtime", () => ({
  useSelectedRuntime: () => runtime,
}));

function fakeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  return {
    available: true,
    attached: true,
    sessionId: "session-1",
    epoch: "epoch-1",
    snapshot: {
      state: {
        tools: [
          { name: "read", active: true },
          { name: "bash", active: true },
          { name: "codemode", active: false },
        ],
      },
    },
    capabilities: { capabilities: ["runtime.tools.write"] },
    setTools: vi.fn(),
    ...overrides,
  };
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, hostCapabilities: HostCapability[] = ["settings.configure"]) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: hostCapabilities }}>
          <I18nProvider><ToolsConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ToolsConfig", () => {
  it("keeps every control disabled until save AND apply settle (one busy state)", async () => {
    // PUT resolves immediately; the session apply is deferred by the caller.
    let resolveApply: (value: void) => void = () => {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("PUT")) return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["read"] } });
      return json({ revision, selection: { mode: "all" } });
    });
    runtime = fakeRuntime({
      setTools: vi.fn(() => new Promise<void>((resolve) => { resolveApply = resolve; })),
    });
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "Disable all" }));
    await waitFor(() => expect(runtime.setTools).toHaveBeenCalledOnce());
    // PUT has resolved but the apply is still pending: controls stay disabled.
    expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disable all" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("switch", { name: "read" }).hasAttribute("disabled")).toBe(true);

    resolveApply();
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("switch", { name: "read" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("tools-apply-failed")).toBeNull();
  });

  it("reports saved-but-apply-failed and retries the apply without a second CAS write", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("/v1/settings/tools");
      if (init?.method === "PUT") return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: [] } });
      return json({ revision, selection: { mode: "custom", toolNames: ["read"] } });
    });
    let calls = 0;
    runtime = fakeRuntime({
      setTools: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("apply failed");
        return undefined;
      }),
    });
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "Disable all" }));
    expect(await screen.findByTestId("tools-apply-failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry apply" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2); // GET + PUT only

    await screen.getByRole("button", { name: "Retry apply" }).click();
    await waitFor(() => expect(runtime.setTools).toHaveBeenCalledTimes(2));
    // Retry re-applies the SAME exact names and never re-saves the global truth.
    expect(runtime.setTools).toHaveBeenLastCalledWith([], { includeExtensionTools: false });
    await waitFor(() => expect(screen.queryByTestId("tools-apply-failed")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps a CAS conflict to a fixed message, refetches, and never applies to the session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      return json({ revision, selection: { mode: "all" } });
    });
    runtime = fakeRuntime();
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "Disable all" }));
    expect(await screen.findByText("The tool selection changed elsewhere. Review the latest values.")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "PUT").length).toBe(2));
    expect(runtime.setTools).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tools-apply-failed")).toBeNull();
  });

  it("skips the session apply when the selection switches sessions mid-save (capture identity)", async () => {
    let resolvePut: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((resolve) => { resolvePut = resolve; });
      }
      return json({ revision, selection: { mode: "all" } });
    });
    runtime = fakeRuntime();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.stubGlobal("fetch", fetchMock);
    const tree = (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["settings.configure"] }}>
            <I18nProvider><ToolsConfig /></I18nProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const view = render(tree);

    fireEvent.click(await screen.findByRole("button", { name: "Disable all" }));
    // The CAS write is now pending (fetch invoked, response deferred).
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true));
    // The user switches to a different session while the CAS write is pending.
    runtime = fakeRuntime({ sessionId: "session-2", epoch: "epoch-2" });
    view.rerender(tree);
    resolvePut(json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: [] } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
    // The global save stands; the switched-to session was never touched.
    expect(runtime.setTools).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tools-apply-failed")).toBeNull();
  });

  it("without an attached session it still offers all-on/all-off and never activates a runtime", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ revision: "b".repeat(64), selection: { mode: "all" } });
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
    });
    runtime = fakeRuntime({ attached: false, available: true, snapshot: null });
    mount(fetchMock);

    expect(await screen.findByTestId("tools-no-session")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    // Saved names are surfaced as currently-unavailable, never as fake rows.
    expect(screen.getByTestId("tools-unavailable-names").textContent).toContain("legacy-tool");
    expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Enable all" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
    expect(runtime.setTools).not.toHaveBeenCalled();
  });

  it("custom row toggles keep the full saved allowlist (unavailable names preserved)", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["read", "legacy-tool", "codemode"] } });
      }
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
    });
    runtime = fakeRuntime();
    mount(fetchMock);

    expect((await screen.findByRole("switch", { name: "codemode" })).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "codemode" }));
    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["read", "legacy-tool", "codemode"] });
    // Applied to the session as the exact intersection with the registry.
    await waitFor(() => expect(runtime.setTools).toHaveBeenCalledWith(["read", "codemode"], { includeExtensionTools: false }));
  });

  it("native selection shows the RUNNING active flags and converts to custom on toggle", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["read", "bash"] } });
      }
      return json({ revision, selection: { mode: "native", toolNames: ["read"] } });
    });
    runtime = fakeRuntime();
    mount(fetchMock);

    expect(await screen.findByText(/Inheriting the Pi defaultTools setting/)).toBeTruthy();
    // Running flags: read/bash active, codemode inactive (not the native list).
    expect(screen.getByRole("switch", { name: "read" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "bash" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "codemode" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("switch", { name: "bash" }));
    await waitFor(() => expect(putBody).toBeTruthy());
    // Native -> custom keeps the saved native names (unavailable included).
    expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["read"] });
  });

  it("shows no picker and no fetch without settings.configure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    runtime = fakeRuntime();
    mount(fetchMock, []);
    expect(await screen.findByText("Tool settings are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
