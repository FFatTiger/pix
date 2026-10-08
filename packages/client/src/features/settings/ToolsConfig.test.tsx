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

function mount(fetchImpl: ReturnType<typeof vi.fn>, hostCapabilities: HostCapability[] = ["settings.configure"], queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  vi.stubGlobal("fetch", fetchImpl);
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

function toolSwitch(label: string) {
  return screen.getByRole("switch", { name: label });
}

function expectChecked(label: string, checked: boolean) {
  expect(toolSwitch(label).getAttribute("aria-checked")).toBe(String(checked));
}

function expectBusy() {
  for (const control of [...screen.getAllByRole("switch"), ...screen.getAllByRole("button")]) {
    expect(control.hasAttribute("disabled")).toBe(true);
  }
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

const tools: [string, string][] = [
  ["read", "Read files"], ["write", "Write files"], ["edit", "Edit files"],
  ["bash", "Run commands"], ["powershell", "PowerShell"], ["grep", "Search contents"],
  ["find", "Find files"], ["ls", "List directories"], ["codemode", "Run code"],
  ["tool_search", "Search tools"], ["Agent", "Delegate to an agent"],
  ["SendMessage", "Message an agent"], ["TaskOutput", "Read agent output"],
  ["TaskStop", "Stop an agent"], ["todo", "Task list"], ["ask_user_question", "Ask a question"],
];
const reloadLabel = "Discard edits and reload saved selection";

// Switch interactions replace textarea edits: the same persistence, revision,
// failure and runtime-isolation checks now also verify membership and unknown rows.
afterEach(() => {
  expect(useSelectedRuntime).not.toHaveBeenCalled();
  expect(runtime.setTools).not.toHaveBeenCalled();
  expect(runtime.reload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("ToolsConfig", () => {
  it("shows exactly the fixed 16 switches without a textbox; one change from all saves custom", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: tools.map(([name]) => name).filter((name) => name !== "bash") } });
      }
      return json({ revision, selection: { mode: "all" } });
    });
    mount(fetchMock);
    await screen.findByRole("switch", { name: "Read files" });
    expect(screen.getAllByRole("switch")).toHaveLength(16);
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const [name, label] of tools) {
      expectChecked(label, true);
      expect(screen.getByText(`Tool identifier: ${name}`)).toBeTruthy();
    }
    expect(screen.getByTestId("tools-selection-mode").textContent).toContain("including tools added in the future");
    fireEvent.click(toolSwitch("Run commands"));
    expectChecked("Run commands", false);
    expect(screen.getByTestId("tools-selection-mode").textContent).toContain("Custom:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: revision, toolNames: tools.map(([name]) => name).filter((name) => name !== "bash") }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));
  });

  it("keeps every control disabled during save and subsequent refetch", async () => {
    const put = deferredResponse();
    const refresh = deferredResponse();
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return put.promise;
      if (++getCount > 1) return refresh.promise;
      return json({ revision, selection: { mode: "all" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mount(fetchMock, ["settings.configure"], queryClient);
    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    expectBusy();
    await act(async () => { put.resolve(json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: [] } })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
    let refetch!: Promise<void>;
    act(() => { refetch = queryClient.refetchQueries({ queryKey: ["pix", "settings", "tools"] }); });
    await waitFor(() => expect(getCount).toBe(2));
    await waitFor(expectBusy);
    await act(async () => {
      refresh.resolve(json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: [] } }));
      await refetch;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
    expectChecked("Read files", false);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("maps a CAS conflict to fixed copy, refetches, and never issues a runtime command", async () => {
    const refresh = deferredResponse();
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      if (++getCount > 1) return refresh.promise;
      return json({ revision, selection: { mode: "all" } });
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Disable all" }));
    expect(await screen.findByText("The tool selection changed elsewhere. Review the latest values.")).toBeTruthy();
    await waitFor(() => expect(getCount).toBe(2));
    expectBusy();
    expect(screen.queryByText(/raw detail|Retry apply|apply failed/i)).toBeNull();
    await act(async () => { refresh.resolve(json({ revision, selection: { mode: "all" } })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable all" }).hasAttribute("disabled")).toBe(false));
  });

  it("enable-all persists null and disable-all persists an empty allowlist, overriding drafts", async () => {
    const puts: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return json({ revision: "b".repeat(64), selection: body.toolNames === null ? { mode: "all" } : { mode: "custom", toolNames: body.toolNames } });
      }
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable all" }));
    await waitFor(() => expect(puts[0]).toEqual({ expectedRevision: revision, toolNames: null }));
    await waitFor(() => expectChecked("Read files", true));
    fireEvent.click(toolSwitch("Read files"));
    fireEvent.click(screen.getByRole("button", { name: "Disable all" }));
    await waitFor(() => expect(puts[1]).toEqual({ expectedRevision: "b".repeat(64), toolNames: [] }));
    await waitFor(() => expect(screen.getAllByRole("switch").every((row) => row.getAttribute("aria-checked") === "false")).toBe(true));
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("preserves saved order and case, drops duplicates, and keeps unknown switches editable", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["legacy-tool", "read", "agent", "Agent", "codemode"] } });
      }
      return json({ revision, selection: { mode: "custom", toolNames: ["legacy-tool", "read", "agent", "Agent", "read", "legacy-tool"] } });
    });
    mount(fetchMock);
    await screen.findByRole("switch", { name: "Read files" });
    expect(screen.getAllByRole("switch")).toHaveLength(18);
    for (const [, label] of tools) expectChecked(label, ["Read files", "Delegate to an agent"].includes(label));
    expectChecked("Saved tool: agent", true);
    expectChecked("Saved tool: legacy-tool", true);
    fireEvent.click(toolSwitch("Saved tool: agent"));
    expectChecked("Saved tool: agent", false);
    expectChecked("Delegate to an agent", true);
    fireEvent.click(toolSwitch("Saved tool: agent"));
    expectChecked("Saved tool: agent", true);
    // Restart the draft to assert deduplication preserves the original saved order.
    fireEvent.click(screen.getByRole("button", { name: reloadLabel }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));
    fireEvent.click(toolSwitch("Run code"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["legacy-tool", "read", "agent", "Agent", "codemode"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));
  });

  it("native membership uses resolved saved names and a switch change saves explicit custom", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["read", "native-extra"] } });
      }
      return json({ revision, selection: { mode: "native", toolNames: ["read", "bash", "native-extra"] } });
    });
    mount(fetchMock);
    expect(await screen.findByText(/Inheriting the Pi defaultTools setting/)).toBeTruthy();
    expectChecked("Read files", true);
    expectChecked("Run commands", true);
    expectChecked("Write files", false);
    expectChecked("Saved tool: native-extra", true);
    fireEvent.click(toolSwitch("Run commands"));
    expect(screen.getByTestId("tools-selection-mode").textContent).toContain("Custom:");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["read", "native-extra"] }));
  });

  it("keeps the draft and original CAS revision through background reads, edits, conflict and retry", async () => {
    let getCount = 0;
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      }
      getCount += 1;
      if (getCount === 1) return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
      return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: ["server-overwrite"] } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mount(fetchMock, ["settings.configure"], queryClient);
    fireEvent.click(await screen.findByRole("switch", { name: "Write files" }));
    await act(() => queryClient.refetchQueries({ queryKey: ["pix", "settings", "tools"] }));
    expect(getCount).toBe(2);
    expectChecked("Write files", true);
    expectChecked("Saved tool: legacy-tool", true);
    await waitFor(() => expectChecked("Saved tool: server-overwrite", false));
    fireEvent.click(toolSwitch("Run code"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The tool selection changed elsewhere. Review the latest values.")).toBeTruthy();
    expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["read", "legacy-tool", "write", "codemode"] });
    await waitFor(() => expect(getCount).toBe(3));
    expectChecked("Run code", true);
    expectChecked("Saved tool: legacy-tool", true);
    await waitFor(() => expect(toolSwitch("Read files").hasAttribute("disabled")).toBe(false));
    fireEvent.click(toolSwitch("Read files"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: revision, toolNames: ["legacy-tool", "write", "codemode"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: reloadLabel }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: reloadLabel }));
    await waitFor(() => expectChecked("Saved tool: server-overwrite", true));
    expect(screen.queryByRole("switch", { name: "Saved tool: legacy-tool" })).toBeNull();
    expectChecked("Write files", false);
    expect(screen.queryByText("The tool selection changed elsewhere. Review the latest values.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(toolSwitch("Read files"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toEqual({ expectedRevision: "b".repeat(64), toolNames: ["server-overwrite", "read"] }));
  });

  it.each([[503, "UNAVAILABLE"], [400, "INVALID_INPUT"]])("keeps switch edits after a failed save (%s)", async (status, code) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code, message: "raw detail" }, { status });
      return json({ revision, selection: { mode: "custom", toolNames: ["read", "legacy-tool"] } });
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    fireEvent.click(toolSwitch("Write files"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save the tool selection.")).toBeTruthy();
    expectChecked("Read files", false);
    expectChecked("Write files", true);
    expectChecked("Saved tool: legacy-tool", true);
    expect(screen.queryByText("raw detail")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("retains the draft if explicit reload fails, then permits a retry", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async () => {
      getCount += 1;
      if (getCount === 2) return json({ code: "UNAVAILABLE", message: "down" }, { status: 503 });
      return json({ revision, selection: { mode: "custom", toolNames: ["saved"] } });
    });
    mount(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    fireEvent.click(screen.getByRole("button", { name: reloadLabel }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Tool settings are unavailable.");
    expectChecked("Read files", true);
    expectChecked("Saved tool: saved", true);
    fireEvent.click(screen.getByRole("button", { name: reloadLabel }));
    await waitFor(() => expectChecked("Read files", false));
    expectChecked("Saved tool: saved", true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows no picker and no fetch without settings.configure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    mount(fetchMock, []);
    expect(await screen.findByText("Tool settings are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
