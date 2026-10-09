import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingLevelSchema, type HostCapability, type SubagentSettingsMutation, type SubagentSettingsResponse } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { queryKeys } from "@/api/query-keys";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { BuiltInCapabilitiesConfig } from "./BuiltInCapabilitiesConfig";
import { SubagentSettingsConfig } from "./SubagentSettingsConfig";

const useSelectedRuntime = vi.hoisted(() => vi.fn(() => { throw new Error("Settings must never consult runtime"); }));
vi.mock("@/runtime", () => ({ useSelectedRuntime }));
const revision = "a".repeat(64);
const empty: SubagentSettingsResponse = { revision, settings: { defaultModel: null, fallbackModel: null, agentOverrides: [] } };
const saved: SubagentSettingsResponse = {
  revision,
  settings: {
    defaultModel: "legacy/primary",
    fallbackModel: "legacy/fallback",
    agentOverrides: [{ name: "Custom CASE role", model: "private/unknown", fallbackModel: "private/backup", thinking: "max" }],
  },
};
const catalog = { models: [{ provider: "provider", id: "model/id", displayName: "Friendly model" }, { provider: "other", id: "backup", displayName: "Backup" }], defaultModel: null };
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function mount(fetchImpl: ReturnType<typeof vi.fn>, capabilities: HostCapability[] = ["settings.configure", "models"], builtIns = false) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><HttpClientProvider><CapabilityProvider host={{ mode: "local", capabilities }}><I18nProvider>
    {builtIns ? <BuiltInCapabilitiesConfig /> : <SubagentSettingsConfig />}
  </I18nProvider></CapabilityProvider></HttpClientProvider></QueryClientProvider>);
  return queryClient;
}
function server(initial = empty) {
  let current = initial;
  const writes: SubagentSettingsMutation[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/v1/models") {
      expect(init?.method).toBe("GET");
      return json(catalog);
    }
    expect(path).toBe("/v1/settings/subagents");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as SubagentSettingsMutation;
      writes.push(body);
      current = { revision: "b".repeat(64), settings: body.settings };
    }
    return json(current);
  });
  return { fetchMock, writes };
}
function select(label: string, value: string) { fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } }); }
function value(label: string) { return (screen.getByRole("combobox", { name: label }) as HTMLSelectElement).value; }
async function ready() { await screen.findByRole("combobox", { name: "Default model" }); }
function save() { fireEvent.click(screen.getByRole("button", { name: "Save" })); }
function reload() { fireEvent.click(screen.getByRole("button", { name: "Discard and reload" })); }

afterEach(() => {
  cleanup();
  expect(useSelectedRuntime).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("SubagentSettingsConfig", () => {
  it("selects native provider/id references, global fallback, and per-role thinking while preserving every custom role", async () => {
    const { fetchMock, writes } = server(saved);
    mount(fetchMock);
    await ready();
    const primary = screen.getByRole("combobox", { name: "Default model" });
    expect(within(primary).getByRole("option", { name: "provider/Friendly model" }).getAttribute("value")).toBe("provider/model/id");
    expect(value("Default model")).toBe("legacy/primary");
    expect(screen.getByRole("heading", { name: "Agent: Custom CASE role" })).toBeTruthy();
    expect(value("Custom CASE role model")).toBe("private/unknown");
    expect(within(screen.getByRole("combobox", { name: "Explore thinking" })).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", ...ThinkingLevelSchema.options]);
    select("Default model", "provider/model/id");
    select("Global fallback model", "other/backup");
    select("Explore model", "other/backup");
    select("Explore fallback model", "provider/model/id");
    select("Explore thinking", "high");
    save();
    await screen.findByText("Saved");
    expect(writes).toEqual([{ expectedRevision: revision, settings: {
      defaultModel: "provider/model/id", fallbackModel: "other/backup", agentOverrides: [
        ...saved.settings.agentOverrides,
        { name: "Explore", model: "other/backup", fallbackModel: "provider/model/id", thinking: "high" },
      ],
    } }]);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("edits exact role identities and preserves metadata-only and differently cased saved roles", async () => {
    const settings = { ...saved.settings, agentOverrides: [
      { name: "Explore", model: "saved/explorer", fallbackModel: "saved/backup", thinking: "minimal" as const },
      { name: "explore", model: "custom/explorer", fallbackModel: null, thinking: null },
      { name: "Metadata only", model: null, fallbackModel: null, thinking: null },
    ] };
    const { fetchMock, writes } = server({ revision, settings });
    mount(fetchMock);
    await ready();
    select("Explore model", "provider/model/id");
    save();
    await screen.findByText("Saved");
    expect(writes[0]?.settings.agentOverrides).toEqual([
      { ...settings.agentOverrides[0], model: "provider/model/id" },
      ...settings.agentOverrides.slice(1),
    ]);
    expect(value("explore model")).toBe("custom/explorer");
    expect(value("Metadata only thinking")).toBe("");
  });

  it("clears nullable values without fabricating untouched fixed-role entries", async () => {
    const { fetchMock, writes } = server(saved);
    mount(fetchMock);
    await ready();
    select("Default model", "");
    select("Global fallback model", "");
    select("Custom CASE role model", "");
    select("Custom CASE role fallback model", "");
    select("Custom CASE role thinking", "");
    save();
    await screen.findByText("Saved");
    expect(writes[0]?.settings).toEqual({ defaultModel: null, fallbackModel: null, agentOverrides: [{ name: "Custom CASE role", model: null, fallbackModel: null, thinking: null }] });
    expect(screen.getByText("Agent definitions or project settings may still provide a fallback.")).toBeTruthy();
  });

  it("editing only a global default keeps the saved role array empty", async () => {
    const { fetchMock, writes } = server();
    mount(fetchMock);
    await ready();
    select("Default model", "provider/model/id");
    save();
    await screen.findByText("Saved");
    expect(writes[0]?.settings.agentOverrides).toEqual([]);
  });

  it("does no HTTP and offers no form without settings.configure even when models and built-ins are allowed", () => {
    const fetchMock = vi.fn(() => { throw new Error("must not fetch"); });
    mount(fetchMock, ["models", "builtins.configure"]);
    expect(screen.getByText("Subagent settings are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configures defaults independently of built-ins capability or session activity", async () => {
    const { fetchMock, writes } = server();
    mount(fetchMock, ["settings.configure", "models"], true);
    await ready();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Applies to subsequent subagent launches.")).toBeTruthy();
    select("Default model", "provider/model/id");
    save();
    await screen.findByText("Saved");
    expect(writes).toHaveLength(1);
  });

  it("permits model settings while the Subagents feature toggle is off", async () => {
    const base = server();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/v1/settings/built-ins"
      ? Promise.resolve(json({ revision, capabilities: [{ id: "subagents", enabled: false }, { id: "todo", enabled: true }, { id: "ask_user_question", enabled: true }, { id: "side_chat", enabled: false }] }))
      : base.fetchMock(input, init));
    mount(fetchMock, ["settings.configure", "builtins.configure", "models"], true);
    await ready();
    expect(screen.getByRole("switch", { name: "Subagents" }).getAttribute("aria-checked")).toBe("false");
    select("Default model", "provider/model/id");
    save();
    await screen.findByText("Saved");
    expect(base.writes).toHaveLength(1);
  });

  it.each(["failure", "missing capability"])("keeps saved references and allows clears with model catalog %s", async (mode) => {
    const base = server(saved);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/v1/models"
      ? Promise.resolve(json({ message: "sensitive backend detail" }, 503))
      : base.fetchMock(input, init));
    mount(fetchMock, mode === "failure" ? ["settings.configure", "models"] : ["settings.configure"]);
    await ready();
    await screen.findByText("Model catalog unavailable. You can keep or clear saved references.");
    expect(value("Default model")).toBe("legacy/primary");
    expect(value("Custom CASE role model")).toBe("private/unknown");
    select("Global fallback model", "");
    save();
    await screen.findByText("Saved");
    expect(base.writes[0]?.settings).toEqual({ ...saved.settings, fallbackModel: null });
    expect(screen.queryByText("sensitive backend detail")).toBeNull();
    if (mode === "missing capability") expect(fetchMock.mock.calls.some(([path]) => String(path) === "/v1/models")).toBe(false);
  });

  it("shows catalog loading without erasing saved values or blocking a clear", async () => {
    const catalogRequest = deferred<Response>();
    const base = server(saved);
    mount(vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/v1/models" ? catalogRequest.promise : base.fetchMock(input, init)));
    await ready();
    expect(screen.getByText("Loading model catalog. Saved references remain available.")).toBeTruthy();
    select("Default model", "");
    save();
    await screen.findByText("Saved");
    expect(base.writes[0]?.settings.defaultModel).toBeNull();
    await act(async () => catalogRequest.resolve(json(catalog)));
  });

  it("fails closed for malformed settings and can retry loading", async () => {
    let valid = false;
    const fetchMock = vi.fn(async () => json(valid ? empty : { ...empty, unexpected: true }));
    mount(fetchMock, ["settings.configure"]);
    await screen.findByRole("alert");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    valid = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    await ready();
  });

  it("pins the first edit snapshot through a busy background refetch and uses its original CAS revision", async () => {
    let reads = 0;
    const refresh = deferred<Response>();
    const base = server(saved);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/v1/settings/subagents" && init?.method === "GET" && ++reads > 1) return refresh.promise;
      return base.fetchMock(input, init);
    });
    const queryClient = mount(fetchMock);
    await ready();
    select("Default model", "provider/model/id");
    let refetch!: Promise<unknown>;
    act(() => { refetch = queryClient.refetchQueries({ queryKey: queryKeys.settingsConfig.subagents() }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true));
    expect(screen.getAllByRole("combobox").every((control) => control.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "Discard and reload" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { refresh.resolve(json({ revision: "c".repeat(64), settings: { defaultModel: "changed/elsewhere", fallbackModel: null, agentOverrides: [] } })); await refetch; });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
    expect(value("Default model")).toBe("provider/model/id");
    expect(value("Custom CASE role model")).toBe("private/unknown");
    select("Explore thinking", "low");
    save();
    await screen.findByText("Saved");
    expect(base.writes[0]?.expectedRevision).toBe(revision);
    expect(base.writes[0]?.settings.agentOverrides[0]).toEqual(saved.settings.agentOverrides[0]);
  });

  it("disables every control during save and primes the returned authoritative settings", async () => {
    const pending = deferred<Response>();
    const base = server();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === "PUT" ? pending.promise : base.fetchMock(input, init));
    const queryClient = mount(fetchMock);
    await ready();
    select("Default model", "provider/model/id");
    save();
    await screen.findByRole("button", { name: "Saving…" });
    expect(screen.getAllByRole("combobox").every((control) => control.hasAttribute("disabled"))).toBe(true);
    expect(screen.getAllByRole("button").every((control) => control.hasAttribute("disabled"))).toBe(true);
    const response = { ...empty, revision: "d".repeat(64), settings: { ...empty.settings, defaultModel: "returned/model" } };
    await act(async () => pending.resolve(json(response)));
    await screen.findByText("Saved");
    expect(value("Default model")).toBe("returned/model");
    expect(queryClient.getQueryData(queryKeys.settingsConfig.subagents())).toEqual(response);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("keeps every edit and original revision through conflicts, failed reload, and retry; only successful explicit reload discards", async () => {
    let reads = 0;
    let failReload = false;
    const writes: SubagentSettingsMutation[] = [];
    const latest = { revision: "c".repeat(64), settings: { ...empty.settings, defaultModel: "latest/model" } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/v1/models") return json(catalog);
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)) as SubagentSettingsMutation);
        return json({ code: "CONFLICT", message: "private backend text" }, 409);
      }
      if (failReload) return json({ code: "UNAVAILABLE", message: "private backend text" }, 503);
      return json(++reads === 1 ? saved : latest);
    });
    mount(fetchMock);
    await ready();
    select("Default model", "provider/model/id");
    select("Global fallback model", "other/backup");
    select("Explore thinking", "xhigh");
    save();
    await screen.findByText(/Subagent settings changed elsewhere/);
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
    expect(value("Default model")).toBe("provider/model/id");
    expect(value("Explore thinking")).toBe("xhigh");
    failReload = true;
    reload();
    await screen.findByText("Subagent settings are unavailable.");
    expect(value("Global fallback model")).toBe("other/backup");
    expect(value("Custom CASE role model")).toBe("private/unknown");
    expect(screen.queryByText("private backend text")).toBeNull();
    failReload = false;
    save();
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[1]?.expectedRevision).toBe(revision);
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard and reload" }).hasAttribute("disabled")).toBe(false));
    reload();
    await waitFor(() => expect(value("Default model")).toBe("latest/model"));
    expect(screen.queryByRole("heading", { name: "Agent: Custom CASE role" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it.each(["network", "invalid", "malformed response"])("preserves the draft after %s save failure and allows retry", async (failure) => {
    const writes: SubagentSettingsMutation[] = [];
    const base = server(saved);
    let fail = true;
    mount(vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PUT") return base.fetchMock(input, init);
      const body = JSON.parse(String(init.body)) as SubagentSettingsMutation;
      writes.push(body);
      if (!fail) return json({ revision: "b".repeat(64), settings: body.settings });
      if (failure === "network") throw new Error("secret host detail");
      if (failure === "invalid") return json({ code: "INVALID_INPUT", message: "secret host detail" }, 400);
      return json({ settings: body.settings });
    }));
    await ready();
    select("Default model", "provider/model/id");
    select("Plan thinking", "max");
    save();
    await screen.findByRole("alert");
    expect(value("Default model")).toBe("provider/model/id");
    expect(value("Plan thinking")).toBe("max");
    expect(screen.queryByText("secret host detail")).toBeNull();
    fail = false;
    save();
    await screen.findByText("Saved");
    expect(writes[1]).toEqual(writes[0]);
  });
});
