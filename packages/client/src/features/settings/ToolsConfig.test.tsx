import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapability } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { ToolsConfig } from "./ToolsConfig";

/**
 * Persisted-only tools settings. The page edits the global `pixDefaultTools`
 * allowlist; capability-contributed tools are grouped display-only rows from
 * the capability catalog (active iff their capability is on) and never get
 * individual switches. Saving never consults runtime state or invokes
 * commands — a connected runtime fake proves it.
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

const builtInsOn = {
  revision: "c".repeat(64),
  capabilities: [
    { id: "subagents", enabled: true },
    { id: "todo", enabled: true },
    { id: "ask_user_question", enabled: true },
    { id: "side_chat", enabled: true },
    { id: "smart_compact", enabled: true },
  ],
};

function toolsFetch(selection: { mode: string; toolNames?: string[] }, builtIns: unknown = builtInsOn) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/v1/settings/tools" && init?.method === "PUT") {
      return json({ revision: "b".repeat(64), selection: JSON.parse(String(init.body)).toolNames === null ? { mode: "all" } : { mode: "custom", toolNames: JSON.parse(String(init.body)).toolNames } });
    }
    if (path === "/v1/settings/tools") return json({ revision, selection });
    if (path === "/v1/settings/built-ins") return json(builtIns);
    return json({});
  });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, hostCapabilities: HostCapability[] = ["settings.configure", "builtins.configure"]) {
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

function toolSwitch(label: string) {
  return screen.getByRole("switch", { name: label });
}

/** Editable palette labels (capability tools are NOT palette switches). */
const palette: [string, string][] = [
  ["read", "Read files"], ["write", "Write files"], ["edit", "Edit files"],
  ["bash", "Run commands"], ["powershell", "PowerShell"], ["grep", "Search contents"],
  ["find", "Find files"], ["ls", "List directories"], ["codemode", "Run code"],
  ["tool_search", "Search tools"],
];

afterEach(() => {
  expect(useSelectedRuntime).not.toHaveBeenCalled();
  expect(runtime.setTools).not.toHaveBeenCalled();
  expect(runtime.reload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("ToolsConfig", () => {
  it("lists capability groups display-only and the palette without capability switches", async () => {
    mount(toolsFetch({ mode: "all" }));
    await screen.findByRole("switch", { name: "Read files" });

    // Capability groups from the catalog, in registry order, tools as mono ids.
    for (const [id, label] of [["subagents", "Subagents"], ["todo", "Task list"], ["ask_user_question", "Ask user"], ["smart_compact", "Smart compaction"]] as const) {
      const group = screen.getByTestId(`tools-capability-${id}`);
      expect(group.textContent).toContain(label);
    }
    expect(screen.getByTestId("tools-capability-subagents").textContent).toContain("SendMessage");
    expect(screen.getByTestId("tools-capability-smart_compact").textContent).toContain("smart_context");
    expect(screen.getByTestId("tools-capability-smart_compact").textContent).not.toContain("smart_recall");

    // Exactly the 10 palette switches; capability tools have no switches.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(palette.length);
    for (const [, label] of palette) expect(toolSwitch(label)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Delegate to an agent" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Task list" })).toBeNull();
    // No mode/status note of any kind.
    expect(screen.queryByTestId("tools-selection-mode")).toBeNull();
  });

  it("hides a capability group when the capability is off", async () => {
    const off = {
      ...builtInsOn,
      capabilities: builtInsOn.capabilities.map((row) => row.id === "subagents" || row.id === "smart_compact" ? { ...row, enabled: false } : row),
    };
    mount(toolsFetch({ mode: "all" }, off));
    await screen.findByRole("switch", { name: "Read files" });
    expect(screen.queryByTestId("tools-capability-subagents")).toBeNull();
    expect(screen.queryByTestId("tools-capability-smart_compact")).toBeNull();
    expect(screen.getByTestId("tools-capability-todo")).toBeTruthy();
    expect(screen.getByTestId("tools-capability-ask_user_question")).toBeTruthy();
  });

  it("saves a custom allowlist from one palette change", async () => {
    let putBody: unknown;
    const fetchMock = toolsFetch({ mode: "all" });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/v1/settings/tools" && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: JSON.parse(String(init.body)).toolNames } });
      }
      if (path === "/v1/settings/tools") return json({ revision, selection: { mode: "all" } });
      if (path === "/v1/settings/built-ins") return json(builtInsOn);
      return json({});
    });
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    const body = putBody as { expectedRevision: string; toolNames: string[] };
    expect(body.expectedRevision).toBe(revision);
    // Everything except read (the toggled-off tool).
    expect(body.toolNames).toHaveLength(palette.length - 1);
    expect(body.toolNames.includes("read")).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));
  });

  it("enable-all persists null and disable-all persists an empty allowlist", async () => {
    const bodies: unknown[] = [];
    const fetchMock = toolsFetch({ mode: "custom", toolNames: ["read", "bash"] });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/v1/settings/tools" && init?.method === "PUT") {
        bodies.push(JSON.parse(String(init.body)));
        const saved = bodies.at(-1) as { toolNames: string[] | null };
        return json({ revision: "b".repeat(64), selection: saved.toolNames === null ? { mode: "all" } : { mode: "custom", toolNames: saved.toolNames } });
      }
      if (path === "/v1/settings/tools") return json({ revision, selection: { mode: "custom", toolNames: ["read", "bash"] } });
      if (path === "/v1/settings/built-ins") return json(builtInsOn);
      return json({});
    });
    mount(fetchMock);
    await screen.findByRole("switch", { name: "Read files" });

    fireEvent.click(screen.getByRole("button", { name: "Enable all" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { toolNames: string[] | null }).toolNames).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Disable all" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect((bodies[1] as { toolNames: string[] | null }).toolNames).toEqual([]);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("strips capability-owned names from the persisted allowlist and keeps unknown names editable", async () => {
    // A legacy custom list that still carries capability names plus one
    // unknown saved name: the capability names are neither switches nor
    // unknown rows; the unknown name stays an editable switch and saving
    // drops the capability names.
    let putBody: unknown;
    const selection = { mode: "custom", toolNames: ["read", "Agent", "SendMessage", "todo", "smart_compact", "mcp_custom"] };
    const fetchMock = toolsFetch(selection);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/v1/settings/tools" && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ revision: "b".repeat(64), selection: { mode: "custom", toolNames: JSON.parse(String(init.body)).toolNames } });
      }
      if (path === "/v1/settings/tools") return json({ revision, selection });
      if (path === "/v1/settings/built-ins") return json(builtInsOn);
      return json({});
    });
    mount(fetchMock);

    const unknown = await screen.findByRole("switch", { name: "mcp_custom" });
    expect(unknown.getAttribute("aria-checked")).toBe("true");
    expect(toolSwitch("Read files").getAttribute("aria-checked")).toBe("true");
    expect(toolSwitch("Run commands").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toolSwitch("Run commands"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toBeTruthy());
    expect([...(putBody as { toolNames: string[] }).toolNames].sort()).toEqual(["bash", "mcp_custom", "read"]);
  });

  it("maps a CAS conflict to fixed copy, refetches, and never issues a runtime command", async () => {
    let putCount = 0;
    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/v1/settings/tools" && init?.method === "PUT") {
        putCount += 1;
        return json({ code: "CONFLICT", message: "raw detail" }, { status: 409 });
      }
      if (path === "/v1/settings/tools") {
        getCount += 1;
        return json({ revision, selection: { mode: "all" } });
      }
      if (path === "/v1/settings/built-ins") return json(builtInsOn);
      return json({});
    });
    mount(fetchMock);

    fireEvent.click(await screen.findByRole("switch", { name: "Read files" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The tool selection changed elsewhere. Review the latest values.")).toBeTruthy();
    await waitFor(() => expect(getCount).toBeGreaterThan(1));
    expect(putCount).toBe(1);
    expect(runtime.setTools).not.toHaveBeenCalled();
  });

  it("shows no picker and no fetch without settings.configure", async () => {
    const fetchMock = vi.fn(() => { throw new Error("must not fetch"); });
    mount(fetchMock, ["builtins.configure"]);
    expect(await screen.findByText("Tool settings are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
