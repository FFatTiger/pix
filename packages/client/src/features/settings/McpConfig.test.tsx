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
    expect(screen.getAllByText("Connected (1 tools)").length).toBeGreaterThan(0);
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
});
