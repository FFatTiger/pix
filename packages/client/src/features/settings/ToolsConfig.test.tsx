import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { ToolsConfig } from "./ToolsConfig";

/**
 * Persisted-only tools settings. Runtime apply/reload/setTools used to live
 * here; those tests are replaced because Settings now writes the global
 * `pixDefaultTools` file only. Current sessions are unchanged until they
 * next start or load. A connected runtime fake proves saving never consults
 * runtime state or invokes commands.
 */

const revision = "a".repeat(64);

const runtime = vi.hoisted(() => ({
  available: true,
  attached: true,
  capabilities: { capabilities: ["runtime.tools.write", "runtime.reload"] },
  setTools: vi.fn(),
  reload: vi.fn(),
}));
const useSelectedRuntime = vi.hoisted(() => vi.fn());
vi.mock("@/runtime", () => ({ useSelectedRuntime: useSelectedRuntime.mockReturnValue(runtime) }));

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

function namesField(): HTMLTextAreaElement {
  return screen.getByLabelText("Custom tool names") as HTMLTextAreaElement;
}

afterEach(() => {
  expect(useSelectedRuntime).not.toHaveBeenCalled();
  expect(runtime.setTools).not.toHaveBeenCalled();
  expect(runtime.reload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("ToolsConfig", () => {
  it("keeps every control disabled until the CAS save settles (one busy state)", async () => {
    let resolvePut: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((resolve) => { resolvePut = resolve; });
      }
      return json({ revision, selection: { mode: "all" } });
    });
    mount(fetchMock);

    fireEvent.change(await screen.findByLabelText("Custom tool names"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true));
    expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disable all" }).hasAttribute("disabled")).toBe(true);
    expect(namesField().hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Discard edits and reload saved selection" }).hasAttribute("disabled")).toBe(true);

    resolvePut(json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: [] } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
    expect(namesField().value).toBe("");
  });

  it("maps a CAS conflict to a fixed message, refetches, and never issues a runtime command", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      return json({ revision, selection: { mode: "all" } });
    });
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("button", { name: "Disable all" }));
    expect(await screen.findByText("The tool selection changed elsewhere. Review the latest values.")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "PUT").length).toBe(2));
    expect(screen.queryByText(/Retry apply|apply failed/i)).toBeNull();
  });

  it("enable-all persists null (all) and disable-all persists an empty allowlist", async () => {
    const puts: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return json({
          revision: "b".repeat(64),
          selection: body.toolNames === null ? { mode: "all" } : { mode: "custom", toolNames: body.toolNames },
        });
      }
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
    });
    mount(fetchMock);

    expect((await screen.findByLabelText("Custom tool names") as HTMLTextAreaElement).value).toBe("read\nlegacy-tool");
    fireEvent.click(screen.getByRole("button", { name: "Enable all" }));
    await waitFor(() => expect(puts[0]).toEqual({ expectedRevision: revision, toolNames: null }));
    fireEvent.click(screen.getByRole("button", { name: "Disable all" }));
    await waitFor(() => expect(puts[1]).toEqual({ expectedRevision: "b".repeat(64), toolNames: [] }));
  });

  it("saves a custom list with unknown names preserved and duplicates dropped", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["read", "legacy-tool", "codemode"] } });
      }
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
    });
    mount(fetchMock);

    const field = await screen.findByLabelText("Custom tool names") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "read\nlegacy-tool\ncodemode\nread\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({
      expectedRevision: revision,
      toolNames: ["read", "legacy-tool", "codemode"],
    }));
    await waitFor(() => expect(field.value).toBe("read\nlegacy-tool\ncodemode"));
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("native list is populated from saved names; editing it saves explicit custom", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["read"] } });
      }
      return json({ revision, selection: { mode: "native", toolNames: ["read", "bash"] } });
    });
    mount(fetchMock);

    expect(await screen.findByText(/Inheriting the Pi defaultTools setting/)).toBeTruthy();
    const field = screen.getByLabelText("Custom tool names") as HTMLTextAreaElement;
    expect(field.value).toBe("read\nbash");
    fireEvent.change(field, { target: { value: "read" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["read"] }));
  });

  it("keeps the draft and its original CAS revision through background reads and subsequent edits", async () => {
    let getCount = 0;
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      }
      getCount += 1;
      if (getCount === 1) return json({ revision, selection: { mode: "custom", toolNames: ["read"] } });
      return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["server-overwrite"] } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["settings.configure"] }}>
            <I18nProvider><ToolsConfig /></I18nProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    const field = await screen.findByLabelText("Custom tool names") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "drafted" } });
    await act(() => queryClient.refetchQueries({ queryKey: ["pix", "settings", "tools"] }));
    expect(getCount).toBe(2);
    expect(field.value).toBe("drafted");
    fireEvent.change(field, { target: { value: "drafted-again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The tool selection changed elsewhere. Review the latest values.")).toBeTruthy();
    expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["drafted-again"] });
    await waitFor(() => expect(getCount).toBe(3));
    expect(field.value).toBe("drafted-again");
    // Neither editing nor retrying after the conflict silently rebases the draft.
    fireEvent.change(field, { target: { value: "still-dirty" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["still-dirty"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard edits and reload saved selection" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Discard edits and reload saved selection" }));
    await waitFor(() => expect(field.value).toBe("server-overwrite"));
    expect(screen.queryByText("The tool selection changed elsewhere. Review the latest values.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(field, { target: { value: "intentional-new-edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: "b".repeat(64), toolNames: ["intentional-new-edit"] }));
  });

  it.each([
    [503, "UNAVAILABLE"],
    [400, "INVALID_INPUT"],
  ])("keeps typed edits after a failed save (%s)", async (status, code) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code, message: "raw detail" }, { status });
      return json({ revision, selection: { mode: "custom", toolNames: ["read"] } });
    });
    mount(fetchMock);
    const field = await screen.findByLabelText("Custom tool names") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "kept-edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save the tool selection.")).toBeTruthy();
    expect(field.value).toBe("kept-edit");
  });

  it("retains the draft if reloading saved values fails, then permits an explicit retry", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async () => {
      getCount += 1;
      if (getCount === 2) return json({ code: "UNAVAILABLE", message: "down" }, { status: 503 });
      return json({ revision, selection: { mode: "custom", toolNames: ["saved"] } });
    });
    mount(fetchMock);
    fireEvent.change(await screen.findByLabelText("Custom tool names"), { target: { value: "kept-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard edits and reload saved selection" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Tool settings are unavailable.");
    expect(namesField().value).toBe("kept-draft");
    fireEvent.click(screen.getByRole("button", { name: "Discard edits and reload saved selection" }));
    await waitFor(() => expect(namesField().value).toBe("saved"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows no picker and no fetch without settings.configure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(fetchMock, []);
    expect(await screen.findByText("Tool settings are unavailable.")).toBeTruthy();
    expect(screen.queryByLabelText("Custom tool names")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
