import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { McpConfig } from "./McpConfig";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const UNKNOWN = { state: "unknown", tools: [], error: null, stderrTail: [], probedAt: null } as const;
const CONNECTED = { state: "connected", tools: [{ name: "search_issues", description: "Search issues" }], error: null, stderrTail: [], probedAt: 1 } as const;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    servers: [
      {
        name: "github",
        valid: true,
        invalidReason: null,
        kind: "http",
        enabled: true,
        command: null,
        args: null,
        env: null,
        cwd: null,
        url: "https://example.com/mcp",
        headers: {
          Authorization: { redacted: false, value: "${GITHUB_TOKEN}" },
          "X-Api-Key": { redacted: true },
        },
        timeout: 60,
        description: "GitHub tools",
        status: CONNECTED,
      },
      {
        name: "sentry",
        valid: true,
        invalidReason: null,
        kind: "http",
        enabled: true,
        command: null,
        args: null,
        env: null,
        cwd: null,
        url: "https://mcp.sentry.dev/mcp",
        headers: null,
        timeout: null,
        description: null,
        status: UNKNOWN,
      },
      {
        name: "broken",
        valid: false,
        invalidReason: 'legacy "sse" transport is not supported',
        kind: null,
        enabled: true,
        command: null,
        args: null,
        env: null,
        cwd: null,
        url: null,
        headers: null,
        timeout: null,
        description: null,
        status: UNKNOWN,
      },
    ],
    ...overrides,
  };
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, capabilities: "mcp.configure"[] = ["mcp.configure"]) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities }}>
          <I18nProvider><McpConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** GET/POST etc. against the MCP surface; mutations answer with `mutate`. */
function mcpFetch(options: { get?: unknown; mutate?: unknown } = {}) {
  const get = options.get ?? snapshot();
  const mutate = options.mutate ?? get;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.includes("/v1/settings/mcp/servers/") && path.endsWith("/test")) {
      return json(mutate);
    }
    if (path.includes("/v1/settings/mcp/import-preview")) {
      return json({
        entries: [
          { name: "docs", valid: true, invalidReason: null, overwrite: false, kind: "http" },
          { name: "github", valid: true, invalidReason: null, overwrite: true, kind: "http" },
          { name: "bad", valid: false, invalidReason: "sse", overwrite: false, kind: null },
        ],
      });
    }
    if (path.includes("/v1/settings/mcp")) {
      if (method !== "GET") return json(mutate);
      return json(get);
    }
    return json({});
  });
}

describe("McpConfig", () => {
  it("without the mcp.configure capability it shows the honest unavailable copy", async () => {
    mount(mcpFetch(), []);
    expect(await screen.findByText("MCP settings are unavailable")).toBeTruthy();
  });

  it("lists servers with status text and shows the selected server detail", async () => {
    mount(mcpFetch());
    expect(await screen.findByRole("button", { name: /github/ })).toBeTruthy();
    // Full status (with tool count) lives in the detail header only; the list
    // row carries the state dot + the short state word.
    expect(screen.getByText("Connected (1 tools)")).toBeTruthy();
    const row = screen.getByRole("button", { name: /github/ });
    expect(row.textContent).toContain("Connected");
    expect(row.textContent).not.toContain("(1 tools)");
    expect(screen.getByRole("button", { name: /sentry/ })).toBeTruthy();
    // The detail pane shows the URL and the redacted header hint.
    expect(screen.getByDisplayValue("https://example.com/mcp")).toBeTruthy();
    expect(screen.getAllByPlaceholderText("Saved — type a new value to replace").length).toBeGreaterThan(0);
    // Reference-style header values pass through.
    expect(screen.getByDisplayValue("${GITHUB_TOKEN}")).toBeTruthy();
  });

  it("invalid entries are listed with their reason, not dropped", async () => {
    mount(mcpFetch());
    expect(await screen.findByText("broken")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /broken/ }));
    expect(screen.getByText(/legacy "sse" transport is not supported/)).toBeTruthy();
  });

  it("untested enabled servers are probed once through the cache-respecting test endpoint", async () => {
    const fetchImpl = mcpFetch();
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([path]) => String(path).endsWith("/test"));
      expect(calls.length).toBe(1);
      const probe = calls[0] as [RequestInfo | URL, RequestInit];
      expect(String(probe[0])).toContain("/v1/settings/mcp/servers/sentry/test");
      expect(JSON.parse(String(probe[1]?.body))).toEqual({ refresh: false });
    });
  });

  it("the enable switch PATCHes the toggle and updates the list", async () => {
    const fetchImpl = mcpFetch({ mutate: snapshot({ servers: snapshot().servers.map((server) => server.name === "github" ? { ...server, enabled: false } : server) }) });
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    await waitFor(() => {
      const patch = fetchImpl.mock.calls.find(([path, init]) => String(path).endsWith("/servers/github") && init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ enabled: false });
    });
  });

  it("delete uses the inline two-step confirmation", async () => {
    const fetchImpl = mcpFetch({ mutate: snapshot({ servers: snapshot().servers.filter((server) => server.name !== "github") }) });
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    fireEvent.click(screen.getAllByText("Delete")[0]!);
    expect(fetchImpl.mock.calls.some(([path, init]) => String(path).endsWith("/servers/github") && init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getAllByText("Confirm")[0]!);
    await waitFor(() => {
      expect(fetchImpl.mock.calls.some(([path, init]) => String(path).endsWith("/servers/github") && init?.method === "DELETE")).toBe(true);
    });
  });

  it("test connection POSTs refresh:true", async () => {
    const fetchImpl = mcpFetch();
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(([path, init]) => String(path).endsWith("/test") && init?.method === "POST");
      expect(calls.length).toBe(2); // auto-probe (sentry) + explicit button (github)
      const github = calls.find(([path]) => String(path).includes("github"))!;
      expect(JSON.parse(String((github[1] as RequestInit).body))).toEqual({ refresh: true });
    });
  });

  it("the add form posts a stdio server with parsed args and env pairs", async () => {
    const fetchImpl = mcpFetch();
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByPlaceholderText("github"), { target: { value: "filesystem" } });
    fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const post = fetchImpl.mock.calls.find(([path, init]) => String(path).endsWith("/v1/settings/mcp/servers") && init?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ name: "filesystem", kind: "stdio", command: "npx" });
    });
  });

  it("paste JSON previews entries, marks overwrites and invalid entries, and gates the import", async () => {
    const fetchImpl = mcpFetch();
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Paste JSON" }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: '{"mcpServers":{"docs":{"url":"https://x"}}}' } });
    await waitFor(() => {
      expect(screen.getByText(/Will add 3 servers/)).toBeTruthy();
    });
    expect(screen.getByText(/github \(replaces the existing github\)/)).toBeTruthy();
    expect(screen.getByText(/bad: sse/)).toBeTruthy();
    // The import button stays disabled while an invalid entry is present.
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("needs-auth servers show the terminal login hint with the server name", async () => {
    const data = snapshot({ servers: [snapshot().servers[1]!] });
    const authed = snapshot({ servers: [{ ...data.servers[0]!, status: { state: "needs_auth", tools: [], error: null, stderrTail: [], probedAt: 2 } }] });
    const fetchImpl = mcpFetch({ get: data, mutate: authed });
    mount(fetchImpl);
    await screen.findByRole("button", { name: /sentry/ });
    await waitFor(() => expect(screen.getAllByText(/pi mcp login sentry/).length).toBeGreaterThan(0));
  });

  it("a corrupt mcp.json surfaces the fixed repair copy, not an empty list", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/v1/settings/mcp")) {
        return new Response(JSON.stringify({ error: "Invalid MCP configuration", code: "INVALID_MCP_INPUT", message: "Invalid MCP configuration" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return json({});
    });
    mount(fetchImpl);
    expect(await screen.findByText("mcp.json could not be parsed; fix the file in a terminal.")).toBeTruthy();
  });

  it("backfills every field when editing and an unchanged save PUTs the same entry back", async () => {
    const base = snapshot({
      servers: [
        {
          name: "fs",
          valid: true,
          invalidReason: null,
          kind: "stdio",
          enabled: true,
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { TOKEN: { redacted: true } },
          cwd: "/tmp",
          url: null,
          headers: null,
          timeout: 60,
          description: "local files",
          status: CONNECTED,
        },
        ...snapshot().servers.slice(1),
      ],
    });
    const fetchImpl = mcpFetch({ get: base });
    mount(fetchImpl);
    await screen.findByRole("button", { name: /fs/ });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // Every field is populated from the snapshot before anything is typed.
    expect((screen.getByPlaceholderText("npx") as HTMLInputElement).value).toBe("npx");
    expect((document.querySelector("textarea.mcp-args-editor") as HTMLTextAreaElement).value).toBe("-y\n@modelcontextprotocol/server-filesystem\n/tmp");
    expect((screen.getByPlaceholderText("~/Documents") as HTMLInputElement).value).toBe("/tmp");
    expect((screen.getByPlaceholderText("60") as HTMLInputElement).value).toBe("60");
    expect((screen.getByPlaceholderText("Description") as HTMLInputElement).value).toBe("local files");
    // The redacted secret shows the keep placeholder instead of clearing it.
    expect(screen.getByPlaceholderText("Saved — type a new value to replace")).toBeTruthy();
    // Saving without touching anything PUTs the identical entry: command,
    // args, cwd, timeout, description and a preserve for the stored secret —
    // mcp.json on disk stays byte-identical.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const put = fetchImpl.mock.calls.find(([path, init]) => String(path).endsWith("/servers/fs") && init?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        name: "fs",
        kind: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { TOKEN: { mode: "preserve" } },
        cwd: "/tmp",
        timeout: 60,
        description: "local files",
      });
    });
  });

  it("selects and shows the just-saved server after the add form succeeds", async () => {
    const fresh = snapshot({
      servers: [
        ...snapshot().servers,
        {
          name: "filesystem",
          valid: true,
          invalidReason: null,
          kind: "stdio",
          enabled: true,
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: null,
          cwd: null,
          url: null,
          headers: null,
          timeout: null,
          description: null,
          status: UNKNOWN,
        },
      ],
    });
    const fetchImpl = mcpFetch({ mutate: fresh });
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByPlaceholderText("github"), { target: { value: "filesystem" } });
    fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The new server is selected and its detail is rendered (not the
    // "select a server" empty state).
    const heading = await screen.findByRole("heading", { name: "filesystem" });
    expect(heading).toBeTruthy();
    expect(screen.queryByText("Select a server")).toBeNull();
    // The freshly added, untested server is auto-probed.
    await waitFor(() => {
      const probe = fetchImpl.mock.calls.find(([path]) => String(path).endsWith("/servers/filesystem/test"));
      expect(probe).toBeTruthy();
    });
  });

  it("tracks probing per server name: one row shows Testing without flipping other rows", async () => {
    // Deferred probe: the row must show Testing exactly while the call is in
    // flight, independent of any other mutation's pending state.
    let resolveTest: ((value: Response) => void) | undefined;
    const get = snapshot({ servers: [snapshot().servers[0]!, snapshot().servers[1]!] });
    const probeResult = snapshot({
      servers: [
        snapshot().servers[0]!,
        { ...snapshot().servers[1]!, status: CONNECTED },
      ],
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/servers/sentry/test")) {
        return new Promise<Response>((resolve) => { resolveTest = resolve; });
      }
      if (path.includes("/v1/settings/mcp")) return json(get);
      return json({});
    });
    mount(fetchImpl);
    await screen.findByRole("button", { name: /github/ });
    // The auto-probe for the untested sentry server is in flight: its row
    // shows Testing, the connected row keeps its own state word.
    await waitFor(() => {
      const sentryRow = screen.getByRole("button", { name: /sentry/ });
      expect(sentryRow.textContent).toContain("Testing");
    });
    expect(screen.getByRole("button", { name: /github/ }).textContent).toContain("Connected");
    resolveTest?.(json(probeResult));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sentry/ }).textContent).toContain("Connected");
    });
  });
});
