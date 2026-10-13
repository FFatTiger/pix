import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingLevelSchema, type HostCapability, type SubagentSettingsMutation, type SubagentSettingsResponse } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { queryKeys } from "@/api/query-keys";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { CapabilitiesConfig } from "./CapabilitiesConfig";
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
function mount(fetchImpl: ReturnType<typeof vi.fn>, capabilities: HostCapability[] = ["settings.configure", "models"], component: "subagents" | "capabilities" = "subagents") {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><HttpClientProvider><CapabilityProvider host={{ mode: "local", capabilities }}><I18nProvider>
    {component === "capabilities" ? <CapabilitiesConfig /> : <SubagentSettingsConfig />}
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
/** Scope to the settings section carrying the given heading (role cards share plain field labels). */
function scope(sectionTitle: string) {
  const heading = screen.getByRole("heading", { name: sectionTitle });
  return within(heading.closest("section")!);
}
function trigger(label: string, sectionTitle?: string) {
  return (sectionTitle ? scope(sectionTitle) : screen).getByRole("button", { name: label });
}
function listboxTriggers() {
  return screen.getAllByRole("button").filter((control) => control.getAttribute("aria-haspopup") === "listbox");
}
function closeMenus() {
  fireEvent.mouseDown(document.body);
}
function openMenu(label: string, sectionTitle?: string) {
  closeMenus();
  fireEvent.click(trigger(label, sectionTitle));
  const menu = document.querySelector(".ui-menu");
  if (!menu) throw new Error(`menu for ${label} did not open`);
  return menu as HTMLElement;
}
function optionValue(item: HTMLElement) {
  const title = item.getAttribute("title");
  if (title !== null) return title;
  return item.querySelector(".ui-menu-item-label")?.textContent ?? "";
}
function menuItems(menu: HTMLElement) {
  return within(menu).getAllByRole("button");
}
function select(label: string, next: string, sectionTitle?: string) {
  const menu = openMenu(label, sectionTitle);
  const item = menuItems(menu).find((candidate) => optionValue(candidate) === next);
  if (!item) throw new Error(`option ${next} not found for ${label}`);
  fireEvent.click(item);
}
function value(label: string, sectionTitle?: string) {
  const menu = openMenu(label, sectionTitle);
  const selected = menu.querySelector(".ui-menu-item.is-selected") as HTMLElement | null;
  const current = selected ? optionValue(selected) : "";
  closeMenus();
  return current;
}
async function ready() { await screen.findByRole("button", { name: "Default model" }); }
function save() { fireEvent.click(screen.getByRole("button", { name: "Save" })); }
function reload() { fireEvent.click(screen.getByRole("button", { name: "Discard" })); }

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
    const primaryMenu = openMenu("Default model");
    const friendly = menuItems(primaryMenu).find((item) => item.textContent?.includes("provider/Friendly model"));
    expect(optionValue(friendly!)).toBe("provider/model/id");
    closeMenus();
    expect(value("Default model")).toBe("legacy/primary");
    expect(screen.getByRole("heading", { name: "Custom CASE role" })).toBeTruthy();
    expect(value("Model", "Custom CASE role")).toBe("private/unknown");
    expect(menuItems(openMenu("Thinking effort", "Explorer (Explore)")).map(optionValue)).toEqual(["", ...ThinkingLevelSchema.options]);
    closeMenus();
    select("Default model", "provider/model/id");
    select("Fallback model", "other/backup", "Defaults");
    select("Model", "other/backup", "Explorer (Explore)");
    select("Fallback model", "provider/model/id", "Explorer (Explore)");
    select("Thinking effort", "high", "Explorer (Explore)");
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

  it("shows known types with a friendly name plus the raw id and a follow-default empty option", async () => {
    const { fetchMock } = server();
    mount(fetchMock);
    await ready();
    expect(screen.getByRole("heading", { name: "General purpose (general-purpose)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Explorer (Explore)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Planner (Plan)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Verifier (verification)" })).toBeTruthy();
    expect(menuItems(openMenu("Model", "Explorer (Explore)"))[0]?.textContent).toContain("Follow default");
    closeMenus();
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
    select("Model", "provider/model/id", "Explorer (Explore)");
    save();
    await screen.findByText("Saved");
    expect(writes[0]?.settings.agentOverrides).toEqual([
      { ...settings.agentOverrides[0], model: "provider/model/id" },
      ...settings.agentOverrides.slice(1),
    ]);
    expect(value("Model", "explore")).toBe("custom/explorer");
    expect(value("Thinking effort", "Metadata only")).toBe("");
  });

  it("clears nullable values without fabricating untouched fixed-role entries", async () => {
    const { fetchMock, writes } = server(saved);
    mount(fetchMock);
    await ready();
    select("Default model", "");
    select("Fallback model", "", "Defaults");
    select("Model", "", "Custom CASE role");
    select("Fallback model", "", "Custom CASE role");
    select("Thinking effort", "", "Custom CASE role");
    save();
    await screen.findByText("Saved");
    expect(writes[0]?.settings).toEqual({ defaultModel: null, fallbackModel: null, agentOverrides: [{ name: "Custom CASE role", model: null, fallbackModel: null, thinking: null }] });
    expect(screen.getByText("Subagent definitions or project settings may still provide a fallback.")).toBeTruthy();
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

  it("configures defaults without the built-ins capability and never renders feature switches", async () => {
    const { fetchMock, writes } = server();
    mount(fetchMock, ["settings.configure", "models"]);
    await ready();
    expect(screen.queryByRole("switch")).toBeNull();
    select("Default model", "provider/model/id");
    save();
    await screen.findByText("Saved");
    expect(writes).toHaveLength(1);
  });

  it("permits subagent model settings while the Subagents feature toggle is off", async () => {
    // The capabilities page shows the saved toggle honestly…
    const builtInsMock = vi.fn(async () => json({ revision, capabilities: [{ id: "subagents", enabled: false }, { id: "todo", enabled: true }, { id: "ask_user_question", enabled: true }, { id: "side_chat", enabled: false }] }));
    mount(builtInsMock, ["settings.configure", "builtins.configure", "models"], "capabilities");
    expect((await screen.findByRole("switch", { name: "Subagents" })).getAttribute("aria-checked")).toBe("false");
    cleanup();
    // …and the subagents page saves without ever consulting built-ins.
    const base = server();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/v1/settings/built-ins"
      ? Promise.reject(new Error("must not fetch built-ins"))
      : base.fetchMock(input, init));
    mount(fetchMock, ["settings.configure", "models"]);
    await ready();
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
    expect(value("Model", "Custom CASE role")).toBe("private/unknown");
    select("Fallback model", "", "Defaults");
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
    expect(listboxTriggers()).toHaveLength(0);
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
    expect(listboxTriggers().every((control) => control.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { refresh.resolve(json({ revision: "c".repeat(64), settings: { defaultModel: "changed/elsewhere", fallbackModel: null, agentOverrides: [] } })); await refetch; });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
    expect(value("Default model")).toBe("provider/model/id");
    expect(value("Model", "Custom CASE role")).toBe("private/unknown");
    select("Thinking effort", "low", "Explorer (Explore)");
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
    expect(listboxTriggers().every((control) => control.hasAttribute("disabled"))).toBe(true);
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
    select("Fallback model", "other/backup", "Defaults");
    select("Thinking effort", "xhigh", "Explorer (Explore)");
    save();
    await screen.findByText(/Subagent settings changed elsewhere/);
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
    expect(value("Default model")).toBe("provider/model/id");
    expect(value("Thinking effort", "Explorer (Explore)")).toBe("xhigh");
    failReload = true;
    reload();
    await screen.findByText("Subagent settings are unavailable.");
    expect(value("Fallback model", "Defaults")).toBe("other/backup");
    expect(value("Model", "Custom CASE role")).toBe("private/unknown");
    expect(screen.queryByText("private backend text")).toBeNull();
    failReload = false;
    save();
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[1]?.expectedRevision).toBe(revision);
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled")).toBe(false));
    reload();
    await waitFor(() => expect(value("Default model")).toBe("latest/model"));
    expect(screen.queryByRole("heading", { name: "Custom CASE role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
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
    select("Thinking effort", "max", "Planner (Plan)");
    save();
    await screen.findByRole("alert");
    expect(value("Default model")).toBe("provider/model/id");
    expect(value("Thinking effort", "Planner (Plan)")).toBe("max");
    expect(screen.queryByText("secret host detail")).toBeNull();
    fail = false;
    save();
    await screen.findByText("Saved");
    expect(writes[1]).toEqual(writes[0]);
  });
});
