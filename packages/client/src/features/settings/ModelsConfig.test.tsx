import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { ModelsConfig } from "./ModelsConfig";

const revision = "a".repeat(64);
const snapshot = {
  revision,
  providers: [{
    sourceId: "acme-deepseek",
    id: "acme-deepseek",
    baseUrl: "http://127.0.0.1:8090/v1",
    api: "openai-responses",
    apiKeyConfigured: true,
    modelsDefined: true,
    models: [{ sourceIndex: 0, id: "deepseek-v4-flash", reasoning: true, visibleInPicker: true }],
  }],
  availableProviders: [
    { id: "anthropic", name: "Anthropic", methods: ["oauth", "apiKey"], modelCount: 4 },
    { id: "openai", name: "OpenAI", methods: ["apiKey"], modelCount: 8 },
    { id: "github-copilot", name: "GitHub Copilot", methods: ["oauth"], modelCount: 20 },
  ],
};

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(
  fetchImpl: ReturnType<typeof vi.fn>,
  capabilities: ("models" | "models.configure" | "settings.configure")[] = ["models", "models.configure"],
) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities }}>
          <I18nProvider><ModelsConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

const twoModelSnapshot = {
  ...snapshot,
  providers: [{
    ...snapshot.providers[0],
    models: [
      { sourceIndex: 0, id: "deepseek-v4-flash", reasoning: true, visibleInPicker: true },
      { sourceIndex: 1, id: "deepseek-v4.1", visibleInPicker: false },
    ],
  }],
};

const visibilitySnapshot = {
  revision: "d".repeat(64),
  patterns: null,
  visible: [{ provider: "acme-deepseek", id: "deepseek-v4-flash" }],
  defaultModel: { provider: "acme-deepseek", id: "deepseek-v4-flash" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ModelsConfig", () => {
  it("renders the provider list with model sub-list detail and provider picker without exposing API-key material", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/v1/models/config");
      return json(snapshot);
    });
    mount(fetchMock);

    expect((await screen.findAllByText("acme-deepseek")).length).toBeGreaterThan(0);
    // The model is a sub-list row inside the provider detail, with a
    // readable reasoning badge (replacing the unexplained "T").
    const modelRow = screen.getByText("deepseek-v4-flash").closest("button")!;
    expect(modelRow).toBeTruthy();
    expect(screen.getByTitle("This model supports reasoning").textContent).toBe("Reasoning");
    expect(screen.queryByDisplayValue(/sk-/i)).toBeNull();
    expect(screen.getByPlaceholderText("••••••••••••••••••••••••••••••••").getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByPlaceholderText("Search providers…")).toBeTruthy();
    expect(screen.getByText("OpenAI / Anthropic compatible")).toBeTruthy();
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    // Subscription providers are visible but honestly disabled until the Host
    // mounts an OAuth mutation seam.
    expect(screen.getAllByText("GitHub Copilot")[0]?.closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("discovers models through the typed route, marks added rows, and adds selected models with parameters to the draft", async () => {
    let putBody: unknown;
    const discovery = {
      models: [
        { id: "deepseek-v4-flash", metadataSource: null },
        {
          id: "deepseek-v4.1",
          name: "DeepSeek V4.1",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 16384,
          cost: { input: 1.25, output: 10 },
          metadataSource: "models.dev",
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/v1/models/discover") return json(discovery);
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ ...snapshot, revision: "b".repeat(64) });
      }
      return json(snapshot);
    });
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");

    fireEvent.click(screen.getByRole("button", { name: "Fetch model list" }));
    // Existing model rows are visible but locked as already added.
    expect(await screen.findByText("DeepSeek V4.1")).toBeTruthy();
    expect(screen.getByText("Added").closest("label")!.querySelector("input")!.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("128K context · out 16K · image · reasoning")).toBeTruthy();

    fireEvent.click(screen.getByText("deepseek-v4.1").closest("label")!.querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: "Add selected (1)" }));
    // The addition lands in the DRAFT: the save bar enables and the PUT body
    // carries the models.dev parameters.
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toMatchObject({
      expectedRevision: revision,
      providers: [{
        models: [
          { id: "deepseek-v4-flash" },
          {
            id: "deepseek-v4.1",
            name: "DeepSeek V4.1",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 16384,
            cost: { input: 1.25, output: 10 },
          },
        ],
      }],
    });
  });

  it("enables fetch for a built-in provider without a Base URL and sends no baseUrl/api override", async () => {
    let discoverBody: unknown;
    const builtinSnapshot = {
      ...snapshot,
      providers: [{ ...snapshot.providers[0], sourceId: "openai", id: "openai", baseUrl: undefined, api: undefined }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/v1/models/discover") {
        discoverBody = JSON.parse(String(init!.body));
        return json({ models: [{ id: "gpt-5", metadataSource: null }] });
      }
      return json(builtinSnapshot);
    });
    mount(fetchMock);
    await screen.findAllByText("openai");
    const discover = screen.getByRole("button", { name: "Fetch model list" });
    expect(discover.hasAttribute("disabled")).toBe(false);
    expect(discover.getAttribute("title")).toBeNull();
    fireEvent.click(discover);
    await screen.findByText("gpt-5");
    // The authority resolves the built-in default endpoint/api itself — the
    // client must not invent an address or an api type.
    expect(discoverBody).toEqual({
      expectedRevision: revision,
      sourceId: "openai",
      providerId: "openai",
    });
  });

  it("disables the fetch button until an endpoint URL is set, with the reason as title", async () => {
    const noBaseUrl = {
      ...snapshot,
      providers: [{ ...snapshot.providers[0], baseUrl: undefined }],
    };
    const fetchMock = vi.fn(async () => json(noBaseUrl));
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");
    const discover = screen.getByRole("button", { name: "Fetch model list" });
    expect(discover.hasAttribute("disabled")).toBe(true);
    expect(discover.getAttribute("title")).toBe("Set an endpoint URL first.");
  });

  it("shows discovery failures honestly instead of an empty list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/v1/models/discover") {
        return json({ code: "CATALOG_UNAVAILABLE", message: "raw" }, { status: 503 });
      }
      return json(snapshot);
    });
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");
    fireEvent.click(screen.getByRole("button", { name: "Fetch model list" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Model configuration is not available.");
    expect(screen.queryByRole("button", { name: /Add selected/ })).toBeNull();
  });

  it("fills model parameters from models.dev into the draft and reports misses honestly", async () => {
    let metadataBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/v1/models/metadata") {
        metadataBody = JSON.parse(String(init!.body));
        return json({ metadata: { "deepseek-v4-flash": {
          reasoning: true,
          contextWindow: 64000,
          maxTokens: 8192,
          cost: { input: 0.27, output: 1.1 },
        } } });
      }
      return json(snapshot);
    });
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");
    fireEvent.click(screen.getByText("deepseek-v4-flash").closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Fill from models.dev" }));

    await waitFor(() => expect(metadataBody).toEqual({ ids: ["deepseek-v4-flash"], api: "openai-responses" }));
    await waitFor(() => expect(screen.getByDisplayValue("64000")).toBeTruthy());
    expect(screen.getByDisplayValue("8192")).toBeTruthy();
    expect(screen.getByDisplayValue("0.27")).toBeTruthy();
    // The fill only touches the draft: Save becomes enabled and can discard.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/No entry for this model/)).toBeNull();
  });

  it("shows the fixed miss copy when models.dev has no entry for the model", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/v1/models/metadata") return json({ metadata: { "deepseek-v4-flash": null } });
      return json(snapshot);
    });
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");
    fireEvent.click(screen.getByText("deepseek-v4-flash").closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Fill from models.dev" }));
    expect(await screen.findByText("No entry for this model on models.dev.")).toBeTruthy();
    expect(screen.queryByDisplayValue("64000")).toBeNull();
  });

  it("removes a stored API key only after an inline danger confirmation, without exposing it", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ ...snapshot, revision: "c".repeat(64), providers: [{ ...snapshot.providers[0], apiKeyConfigured: false }] });
      }
      return json(snapshot);
    });
    mount(fetchMock);

    const remove = await screen.findByRole("button", { name: "Remove stored key" });
    // Two-step confirm: arming alone changes nothing.
    fireEvent.click(remove);
    expect(screen.getByText("Delete?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("button", { name: "Keep stored key" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toMatchObject({ providers: [{ apiKey: { mode: "remove" } }] });
  });

  it("keeps Save disabled while a client-side validation error is showing", async () => {
    const fetchMock = vi.fn(async () => json(snapshot));
    mount(fetchMock);
    await screen.findAllByText("acme-deepseek");
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    // The new model has an empty id → validation error; Save must stay disabled.
    expect(await screen.findByText("Every model needs an ID.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    // Fixing the draft re-enables Save.
    const id = screen.getByText("ID *").parentElement!.querySelector("input")!;
    fireEvent.change(id, { target: { value: "fixed-model" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
  });

  it("shows model-specific conflict copy instead of a catalog or project-path error", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ code: "CONFLICT", message: "raw host detail" }, { status: 409 });
      return json(snapshot);
    });
    mount(fetchMock);
    const name = await screen.findByDisplayValue("acme-deepseek");
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Model configuration changed elsewhere");
    expect(screen.queryByText(/raw host detail|Invalid project path|Catalog unavailable/i)).toBeNull();
  });

  it("names the provider, model, and field when the server rejects with located details", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return json({
          code: "INVALID_INPUT",
          message: "Invalid model configuration",
          details: { provider: "acme-deepseek", model: "deepseek-v4-flash", field: "cost.cacheWrite" },
        }, { status: 400 });
      }
      return json(snapshot);
    });
    mount(fetchMock);
    const name = await screen.findByDisplayValue("acme-deepseek");
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("acme-deepseek / deepseek-v4-flash");
    expect(alert.textContent).toContain("cost.cacheWrite");
  });

  it("falls back to the generic invalid-configuration copy when details are malformed", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return json({ code: "INVALID_INPUT", message: "raw host detail", details: { provider: "p", extra: true } }, { status: 400 });
      }
      return json(snapshot);
    });
    mount(fetchMock);
    const name = await screen.findByDisplayValue("acme-deepseek");
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The model configuration is invalid");
    expect(alert.textContent).not.toContain("raw host detail");
    expect(alert.textContent).not.toContain("provider");
  });

  it("saves through the typed global route and preserves an unchanged secret server-side", async () => {
    let putBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/v1/models/config");
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return json({ ...snapshot, revision: "b".repeat(64), providers: [{ ...snapshot.providers[0], id: "renamed", sourceId: "renamed" }] });
      }
      return json(snapshot);
    });
    mount(fetchMock);

    const name = await screen.findByDisplayValue("acme-deepseek");
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody).toBeTruthy());
    expect(putBody).toMatchObject({
      expectedRevision: revision,
      providers: [{ sourceId: "acme-deepseek", id: "renamed", apiKey: { mode: "preserve" } }],
    });
    expect(JSON.stringify(putBody)).not.toContain("sk-");
  });

  it("renders no visibility switches without the settings.configure capability", async () => {
    const fetchMock = vi.fn(async () => json(snapshot));
    mount(fetchMock, ["models", "models.configure"]);
    await screen.findAllByText("acme-deepseek");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("commits a visibility toggle through the settings seam without touching models.json", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === "/v1/settings/model-visibility" && method === "PUT") {
        return json({ ...visibilitySnapshot, patterns: ["acme-deepseek/other"], visible: [{ provider: "acme-deepseek", id: "other" }] });
      }
      if (url === "/v1/settings/model-visibility") return json(visibilitySnapshot);
      return json(twoModelSnapshot);
    });
    mount(fetchMock, ["models", "models.configure", "settings.configure"]);
    await screen.findAllByText("acme-deepseek");

    // The hidden second model renders faded; its switch is the only toggle
    // that can move (deepseek-v4-flash is the last visible model and locks).
    const hiddenRow = screen.getByText("deepseek-v4.1").closest("li")!;
    expect(hiddenRow.style.opacity).toBe("0.55");
    expect(screen.getByRole("switch", { name: "Show deepseek-v4-flash in the model picker" }).hasAttribute("disabled")).toBe(true);

    // Toggling alone must surface and enable the save bar (its own dirty signal).
    fireEvent.click(screen.getByRole("switch", { name: "Show deepseek-v4.1 in the model picker" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url === "/v1/settings/model-visibility")).toBe(true));
    // No models.json write happened, and the visibility PUT carries the intent
    // plus the freshly fetched settings revision.
    expect(calls.some((call) => call.method === "PUT" && call.url === "/v1/models/config")).toBe(false);
    const put = calls.find((call) => call.method === "PUT" && call.url === "/v1/settings/model-visibility");
    expect(put?.body).toEqual({
      expectedRevision: visibilitySnapshot.revision,
      changes: [{ provider: "acme-deepseek", id: "deepseek-v4.1", visible: true }],
    });
    // The PUT body never carried models.json fields or draft-only keys.
    expect(JSON.stringify(put?.body)).not.toContain("visibleInPicker");
  });

  it("locks the switch of the last visible model and hints when the default model is hidden", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/v1/settings/model-visibility") return json(visibilitySnapshot);
      return json(snapshot);
    });
    mount(fetchMock, ["models", "models.configure", "settings.configure"]);
    await screen.findAllByText("acme-deepseek");

    // The only model is the last visible one: switch stays on and disabled.
    const toggle = screen.getByRole("switch", { name: "Show deepseek-v4-flash in the model picker" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(true);

    // Add a second model: the first unlocks; hiding the DEFAULT model surfaces
    // the fixed hint (server-side default points at deepseek-v4-flash).
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    const id = screen.getByText("ID *").parentElement!.querySelector("input")!;
    fireEvent.change(id, { target: { value: "second-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to acme-deepseek" }));
    const first = screen.getByRole("switch", { name: "Show deepseek-v4-flash in the model picker" });
    expect(first.hasAttribute("disabled")).toBe(false);
    fireEvent.click(first);
    expect(await screen.findByText("The default model is hidden. New sessions fall back to the first visible model.")).toBeTruthy();
    // The second model is now the last visible one and locks.
    expect(screen.getByRole("switch", { name: "Show second-model in the model picker" }).hasAttribute("disabled")).toBe(true);
  });

  it("saves models first, then visibility with the fresh settings revision", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/v1/settings/model-visibility") {
        order.push(`visibility:${method}`);
        if (method === "PUT") {
          return json({ ...visibilitySnapshot, revision: "e".repeat(64), patterns: ["acme-deepseek/other"], visible: [{ provider: "acme-deepseek", id: "other" }] });
        }
        return json(visibilitySnapshot);
      }
      if (url === "/v1/models/config" && method === "PUT") {
        order.push("models:PUT");
        return json({
          ...snapshot,
          revision: "b".repeat(64),
          providers: [{
            ...snapshot.providers[0],
            models: [
              { sourceIndex: 0, id: "deepseek-v4-flash", reasoning: true, visibleInPicker: true },
              { sourceIndex: 1, id: "other", visibleInPicker: true },
            ],
          }],
        });
      }
      return json(snapshot);
    });
    mount(fetchMock, ["models", "models.configure", "settings.configure"]);
    await screen.findAllByText("acme-deepseek");

    // Add a model (models.json dirty) AND hide the existing one (settings.json
    // dirty): one Save commits both in order.
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    const id = screen.getByText("ID *").parentElement!.querySelector("input")!;
    fireEvent.change(id, { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to acme-deepseek" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show deepseek-v4-flash in the model picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // models.json commits first; the visibility CAS revision is fetched fresh
    // (after the models write may have rewritten settings.json) and the
    // visibility intents go last. Extra read refreshes between the writes are
    // fine — no second models write may happen.
    await waitFor(() => expect(order[order.length - 1]).toBe("visibility:PUT"));
    expect(order.filter((call) => call !== "visibility:GET")).toEqual(["models:PUT", "visibility:PUT"]);
  });

  it("re-applies pending toggles when only the visibility half of a save fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/v1/settings/model-visibility") {
        if (method === "PUT") return json({ code: "CONFLICT", message: "raw" }, { status: 409 });
        return json(visibilitySnapshot);
      }
      if (url === "/v1/models/config" && method === "PUT") {
        return json({ ...snapshot, revision: "b".repeat(64) });
      }
      return json(snapshot);
    });
    mount(fetchMock, ["models", "models.configure", "settings.configure"]);
    await screen.findAllByText("acme-deepseek");

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    const id = screen.getByText("ID *").parentElement!.querySelector("input")!;
    fireEvent.change(id, { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to acme-deepseek" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show deepseek-v4-flash in the model picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Honest conflict copy; the models half committed, the toggle is still
    // pending (switch stays off, Save stays enabled for a retry).
    expect(await screen.findByText(/Model configuration changed elsewhere/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show deepseek-v4-flash in the model picker" }).getAttribute("aria-checked")).toBe("false"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false));
  });
});
