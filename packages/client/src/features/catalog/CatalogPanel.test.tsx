import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpError } from "@/api/http-client";
import { CatalogPanel } from "./CatalogPanel";

function json(body: unknown, status = 200, code?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status >= 400) {
    const bodyCode =
      code ??
      (body !== null && typeof body === "object" && "code" in body && typeof (body as { code?: unknown }).code === "string"
        ? (body as { code: string }).code
        : "CATALOG_UNAVAILABLE");
    const message =
      body !== null && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : "raw host leak";
    return new Response(JSON.stringify({ message, code: bodyCode }), {
      status,
      headers,
    });
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function renderPanel(
  host: Partial<HostInfo> | null,
  props: { cwd?: string | undefined; open?: boolean; onClose?: () => void } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider {...(host === undefined ? {} : { host })}>{children}</CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  return {
    queryClient,
    ...render(
      <CatalogPanel
        cwd={props.cwd}
        open={props.open ?? true}
        onClose={props.onClose ?? (() => undefined)}
      />,
      { wrapper: Wrapper },
    ),
  };
}

type RouteHandler = (url: URL) => Response | Promise<Response>;

function makeRouter(handlers: Record<string, RouteHandler> = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://pix.local");
    const key = `${url.pathname}${url.search}`;
    calls.push(key);
    const pathKey = url.pathname;
    if (handlers[pathKey]) return handlers[pathKey]!(url);
    if (handlers[key]) return handlers[key]!(url);
    // default happy catalog payloads
    if (pathKey === "/v1/models") {
      return json({
        models: [
          { id: "m1", provider: "openai", displayName: "Model One", thinking: true, contextWindow: 128000 },
          { id: "m2", provider: "openai" },
        ],
        defaultModel: { id: "m1", provider: "openai" },
      });
    }
    if (pathKey === "/v1/auth/providers") {
      return json({
        providers: [
          { id: "openai", name: "OpenAI", methods: ["apiKey"] },
          { id: "anthropic", methods: ["oauth", "apiKey"] },
        ],
      });
    }
    if (pathKey.startsWith("/v1/auth/providers/") && pathKey.endsWith("/status")) {
      const id = decodeURIComponent(pathKey.split("/")[4] ?? "");
      if (id === "anthropic") {
        return json({ message: "status failed", code: "CATALOG_UNAVAILABLE" }, 503);
      }
      return json({
        status: { providerId: id, authorized: true, accountName: "user@example.com", expiresAt: 1_700_000_000_000 },
        configured: true,
      });
    }
    if (pathKey === "/v1/skills") {
      return json({
        skills: [{ name: "demo-skill", enabled: true, version: "1.0.0", updateAvailable: true, description: "A skill" }],
      });
    }
    if (pathKey === "/v1/plugins") {
      return json({ plugins: [{ name: "demo-plugin", enabled: false, version: "0.2" }] });
    }
    if (pathKey === "/v1/commands") {
      return json({ commands: [{ name: "ship", source: "skill", description: "Ship it" }] });
    }
    if (pathKey === "/v1/trust") {
      return json({
        cwd: url.searchParams.get("cwd"),
        level: "trusted",
        trusted: true,
        canReloadResources: { allowed: true, level: "trusted" },
      });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("CatalogPanel", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
    cleanup();
  });

  it("issues ZERO fetches and renders null with no catalog caps", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const { container } = renderPanel({ mode: "local", capabilities: [] }, { cwd: "/proj" });
    expect(container.firstChild).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it("providers-only with no cwd fetches providers/status only (no project catalog)", async () => {
    const { impl, calls } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["auth.providers"] }, { cwd: undefined });
    expect(screen.getByRole("tab", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Models" })).toBeNull();
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeTruthy());
    expect(calls.some((c) => c.startsWith("/v1/auth/providers"))).toBe(true);
    expect(calls.some((c) => c.startsWith("/v1/models"))).toBe(false);
    expect(calls.some((c) => c.startsWith("/v1/skills"))).toBe(false);
    expect(calls.some((c) => c.startsWith("/v1/plugins"))).toBe(false);
    expect(calls.some((c) => c.startsWith("/v1/commands"))).toBe(false);
    expect(calls.some((c) => c.startsWith("/v1/trust"))).toBe(false);
  });

  it("project tabs with no cwd show fixed empty and issue ZERO project requests", async () => {
    const { impl, calls } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["models", "skills", "plugins"] }, { cwd: undefined });
    expect(screen.getByRole("tab", { name: "Models" })).toBeTruthy();
    expect(screen.getByText("Open a project to browse models.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(screen.getByText("Open a project to browse skills.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(screen.getByText("Open a project to browse commands.")).toBeTruthy();
    // Only possible non-project request would be providers; not offered here.
    expect(calls).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });

  it("capability tabs: only negotiated tabs appear", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["models", "skills"] }, { cwd: "/proj" });
    expect(screen.getByRole("tab", { name: "Models" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Commands" })).toBeTruthy(); // skills ⇒ commands
    expect(screen.queryByRole("tab", { name: "Providers" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Plugins" })).toBeNull();
  });

  it("happy path renders models default badge, skills, plugins, commands and trust summary", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel(
      { mode: "local", capabilities: ["models", "auth.providers", "skills", "plugins"] },
      { cwd: "/proj" },
    );
    await waitFor(() => expect(screen.getByText("Model One")).toBeTruthy());
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("thinking")).toBeTruthy();
    // Trust summary (skills||plugins + cwd)
    await waitFor(() => expect(screen.getByText("Trusted")).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() => expect(screen.getByText("demo-skill")).toBeTruthy());
    expect(screen.getByText("enabled")).toBeTruthy();
    expect(screen.getByText("update")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Plugins" }));
    await waitFor(() => expect(screen.getByText("demo-plugin")).toBeTruthy());
    expect(screen.getByText("disabled")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    await waitFor(() => expect(screen.getByText("/ship")).toBeTruthy());
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("per-row provider status failure does not crash the list", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["auth.providers"] }, { cwd: "/proj" });
    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Status unavailable")).toBeTruthy());
    expect(screen.getByText("authorized")).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
  });

  it("omits an expiry that is finite but outside the JavaScript date range", async () => {
    const { impl } = makeRouter({
      "/v1/auth/providers": () => json({ providers: [{ id: "future", methods: ["apiKey"] }] }),
      "/v1/auth/providers/future/status": () =>
        json({
          status: { providerId: "future", authorized: true, expiresAt: Number.MAX_SAFE_INTEGER },
          configured: true,
        }),
    });
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["auth.providers"] }, { cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("future")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("authorized")).toBeTruthy());
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
    expect(screen.queryByText(/^exp /)).toBeNull();
  });

  it("sessiond-unavailable host override still serves catalog when caps present", async () => {
    // CapabilityProvider host override does not require bootstrap; sessiond down
    // must not close Catalog — only caps matter.
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel(
      { mode: "local", capabilities: ["models"] },
      { cwd: "/proj" },
    );
    await waitFor(() => expect(screen.getByText("Model One")).toBeTruthy());
  });

  it("maps fixed error copy and never renders raw host body", async () => {
    const { impl } = makeRouter({
      "/v1/models": () => json({ message: "secret path /Users/proxy/.agent", code: "PATH_FORBIDDEN" }, 403),
    });
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["models"] }, { cwd: "/proj" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Project path is outside the allowed roots."),
    );
    expect(screen.queryByText(/secret path/)).toBeNull();
    expect(screen.queryByText(/\.agent/)).toBeNull();
  });

  it("cwd A→B race does not paint A after switch", async () => {
    let resolveA: ((value: Response) => void) | null = null;
    const { impl } = makeRouter({
      "/v1/models": (url) => {
        const cwd = url.searchParams.get("cwd");
        if (cwd === "/a") {
          return new Promise<Response>((resolve) => {
            resolveA = resolve;
          });
        }
        return json({
          models: [{ id: "b-only", provider: "p", displayName: "Model B" }],
          defaultModel: null,
        });
      },
    });
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host: Partial<HostInfo> = { mode: "local", capabilities: ["models"] };
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={host}>{children}</CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const view = render(
      <CatalogPanel cwd="/a" open onClose={() => undefined} />,
      { wrapper: Wrapper },
    );
    // Switch to B before A resolves.
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={host}>
            <CatalogPanel cwd="/b" open onClose={() => undefined} />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Model B")).toBeTruthy());
    // Resolve stale A after B is showing — must not paint A.
    await act(async () => {
      resolveA?.(
        json({
          models: [{ id: "a-only", provider: "p", displayName: "Model A STALE" }],
          defaultModel: null,
        }),
      );
    });
    expect(screen.queryByText("Model A STALE")).toBeNull();
    expect(screen.getByText("Model B")).toBeTruthy();
  });

  it("cap revocation hides panel and issues no new catalog fetches after hide", async () => {
    const { impl, calls } = makeRouter();
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (caps: HostInfo["capabilities"]) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: caps }}>
            <CatalogPanel cwd="/proj" open onClose={() => undefined} />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const view = render(wrap(["models"]));
    await waitFor(() => expect(screen.getByText("Model One")).toBeTruthy());
    const before = calls.length;
    view.rerender(wrap([]));
    expect(view.container.firstChild).toBeNull();
    // No additional catalog requests after revocation.
    expect(calls.length).toBe(before);
  });

  it("has no mutation controls (install/login/toggle/save)", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel(
      { mode: "local", capabilities: ["models", "auth.providers", "skills", "plugins"] },
      { cwd: "/proj" },
    );
    await waitFor(() => expect(screen.getByText("Model One")).toBeTruthy());
    for (const name of ["Install", "Login", "Logout", "Save", "Toggle", "Update", "Discover", "Test"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("exposes a11y tablist/tab/tabpanel and close label", async () => {
    const onClose = vi.fn();
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["models", "auth.providers"] }, { cwd: "/proj", onClose });
    expect(screen.getByRole("tablist", { name: "Catalog sections" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Models" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close catalog panel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closed panel renders null without fetching", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const { container } = renderPanel(
      { mode: "local", capabilities: ["models"] },
      { cwd: "/proj", open: false },
    );
    expect(container.firstChild).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("describeCatalogError via panel", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
    cleanup();
  });

  it.each([
    ["CWD_REQUIRED", "Invalid project path."],
    ["INVALID_PATH", "Invalid project path."],
    ["PATH_FORBIDDEN", "Project path is outside the allowed roots."],
    ["ROOT_REPLACED", "Project path is outside the allowed roots."],
    ["PATH_NOT_FOUND", "Project path was not found."],
    ["CATALOG_UNAVAILABLE", "Catalog unavailable."],
    ["SOMETHING_ELSE", "Catalog unavailable."],
  ] as const)("maps %s to fixed copy", async (code, copy) => {
    const { impl } = makeRouter({
      "/v1/models": () => json({ message: "LEAK", code }, 400),
    });
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["models"] }, { cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(copy));
    expect(screen.queryByText("LEAK")).toBeNull();
  });

  it("maps network kind without body leak", async () => {
    // Force a network failure by rejecting fetch.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    renderPanel({ mode: "local", capabilities: ["models"] }, { cwd: "/proj" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Network error|Catalog unavailable/),
    );
  });
});

// Keep HttpError import used for type-level sanity in future assertions.
void HttpError;
