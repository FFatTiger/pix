import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ThemeProvider, useTheme } from "./useTheme";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { MarkdownBody } from "@/components/chat/MarkdownBody";

/**
 * Focused ThemeProvider tests: prove the single theme authority owns
 * list/resolve (cwd-scoped), the react-query cache is the ONE cache authority
 * (no private themeCache), failures are visible (builtins are never presented
 * as remote data; CSS is never silently cleared on resolve failure),
 * latest-intent-wins (no dropped clicks / no out-of-order overwrite), and a
 * MarkdownBody-style consumer mount never re-applies the theme.
 */

const THEME_SETS = [
  { name: "gruvbox", displayName: "Gruvbox", hasDark: true, hasLight: true, builtin: true },
  { name: "solarized", displayName: "Solarized", hasDark: true, hasLight: true, builtin: true },
];

const CSS: Record<string, Record<string, string>> = {
  gruvbox: { "--bg": "#282828" },
  solarized: { "--bg": "#eee8d5" },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface FetchControl {
  calls: string[];
  resolveCalls: () => string[];
  listCalls: () => string[];
  setFailList: (v: boolean) => void;
  setFailResolve: (names: Set<string>) => void;
  pending: Map<string, (r: Response) => void>;
}

function installFetch(opts: { deferred?: boolean } = {}): FetchControl {
  const calls: string[] = [];
  let failList = false;
  let failResolve = new Set<string>();
  const pending = new Map<string, (r: Response) => void>();

  const fetchImpl = vi.fn((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);

    if (path.includes("/v1/themes?")) {
      if (failList) return Promise.resolve(json({ error: "Catalog is unavailable" }, 503));
      return Promise.resolve(json({ themeSets: THEME_SETS }));
    }
    // resolve: /v1/themes/<name>?mode=&cwd=
    const after = path.split("/v1/themes/")[1] ?? "";
    const name = decodeURIComponent(after.split("?")[0] ?? "");
    const mode = new URL(path, "http://pix.local").searchParams.get("mode") ?? "dark";
    const respond = () => {
      if (failResolve.has(name)) return json({ error: "not found" }, 404);
      return json({ name, isDark: mode === "dark", cssVars: CSS[name] ?? { "--bg": "#000000" } });
    };
    if (!opts.deferred) return Promise.resolve(respond());
    return new Promise<Response>((resolve) => pending.set(path, resolve));
  });

  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return {
    calls,
    resolveCalls: () => calls.filter((p) => p.startsWith("/v1/themes/")),
    listCalls: () => calls.filter((p) => p.includes("/v1/themes?")),
    setFailList: (v) => { failList = v; },
    setFailResolve: (names) => { failResolve = names; },
    pending,
  };
}

function ThemeProbe() {
  const { themeName, isDark, resolveStatus, catalog, hasProject } = useTheme();
  return (
    <div data-testid="probe">
      {JSON.stringify({
        themeName,
        isDark,
        resolveStatus,
        catalogStatus: catalog.status,
        themeSets: catalog.themeSets?.length ?? null,
        hasProject,
      })}
    </div>
  );
}

function ThemeControls() {
  const { setTheme, setMode } = useTheme();
  return (
    <div>
      <button onClick={() => setTheme("solarized")}>pick-solarized</button>
      <button onClick={() => setTheme("gruvbox")}>pick-gruvbox</button>
      <button onClick={() => setTheme("")}>pick-default</button>
      <button onClick={() => setMode("light")}>mode-light</button>
    </div>
  );
}

/** Renders ThemeProvider ONCE; the child toggles a consumer on/off in-tree. */
function ConsumerSwitcher({ renderConsumer }: { renderConsumer: () => ReactNode }) {
  const [show, setShow] = useState(true);
  return (
    <div>
      <button onClick={() => setShow((s) => !s)}>toggle-consumer</button>
      {show ? renderConsumer() : null}
    </div>
  );
}

/** Stateful cwd drives a single ThemeProvider — how the router re-scopes. */
function CwdScopedTheme() {
  const [cwd, setCwd] = useState<string | null>("/repo");
  return (
    <div>
      <button onClick={() => setCwd("/repo2")}>to-repo2</button>
      <ThemeProvider cwd={cwd}>
        <ThemeProbe />
      </ThemeProvider>
    </div>
  );
}

function renderWithTheme(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HttpClientProvider>
        <I18nProvider>{children}</I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

function mountTheme(cwd: string | null, children?: ReactNode) {
  return renderWithTheme(<ThemeProvider cwd={cwd}>{children ?? <ThemeProbe />}</ThemeProvider>);
}

const probe = () => JSON.parse(screen.getByTestId("probe").textContent as string) as {
  themeName: string;
  isDark: boolean;
  resolveStatus: string;
  catalogStatus: string;
  themeSets: number | null;
  hasProject: boolean;
};

function storedTheme(name: string, mode = "dark") {
  localStorage.setItem("pi-theme", name);
  localStorage.setItem("pi-theme-mode", mode);
}

beforeEach(() => {
  localStorage.clear();
  const el = document.documentElement;
  delete el.dataset.theme;
  delete el.dataset.themeMode;
  delete el.dataset.themeResolvedMode;
  el.className = "";
  el.removeAttribute("style");
});

afterEach(() => {
  cleanup();
});

describe("ThemeProvider — cwd scoping + single cache authority", () => {
  it("fetches theme list/resolve with the mandatory project cwd and does not re-fetch on consumer remount (one cache authority)", async () => {
    storedTheme("gruvbox", "dark");
    const ctl = installFetch();
    mountTheme("/repo", <ConsumerSwitcher renderConsumer={() => <ThemeProbe />} />);

    await waitFor(() => {
      const p = probe();
      expect(p.catalogStatus).toBe("success");
      expect(p.themeName).toBe("gruvbox");
      expect(p.resolveStatus).toBe("success");
    });
    // Both list and resolve URLs carry cwd.
    expect(ctl.listCalls()).toContain("/v1/themes?cwd=%2Frepo");
    expect(ctl.resolveCalls()).toContain("/v1/themes/gruvbox?mode=dark&cwd=%2Frepo");
    // The resolved CSS reached the DOM (single apply authority).
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
    expect(document.documentElement.dataset.theme).toBe("gruvbox");
    const resolveCount = ctl.resolveCalls().length;

    // Unmount + remount the consumer within the SAME provider: the react-query
    // cache is the single authority — no new resolve, no re-apply.
    act(() => { fireEvent.click(screen.getByText("toggle-consumer")); });
    act(() => { fireEvent.click(screen.getByText("toggle-consumer")); });
    await waitFor(() => expect(probe().themeName).toBe("gruvbox"));
    expect(ctl.resolveCalls().length).toBe(resolveCount);
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
  });

  it("re-scopes on cwd change: a different project resolves through a distinct cache key", async () => {
    storedTheme("gruvbox", "dark");
    const ctl = installFetch();
    renderWithTheme(<CwdScopedTheme />);
    await waitFor(() => expect(probe().resolveStatus).toBe("success"));
    expect(ctl.resolveCalls()).toContain("/v1/themes/gruvbox?mode=dark&cwd=%2Frepo");

    act(() => { fireEvent.click(screen.getByText("to-repo2")); });
    await waitFor(() => {
      expect(ctl.resolveCalls()).toContain("/v1/themes/gruvbox?mode=dark&cwd=%2Frepo2");
      expect(probe().resolveStatus).toBe("success");
    });
  });

  it("no-project boot state never clears CSS and reports idle catalog", async () => {
    storedTheme("gruvbox", "dark");
    const ctl = installFetch();
    mountTheme(null);
    await waitFor(() => {
      expect(probe().catalogStatus).toBe("idle");
      expect(probe().resolveStatus).toBe("idle");
      expect(probe().hasProject).toBe(false);
    });
    expect(ctl.listCalls()).toHaveLength(0);
    expect(ctl.resolveCalls()).toHaveLength(0);
    // No clearing of the boot CSS / no dataset.theme fabrication.
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("ThemeProvider — latest user/OS intent wins", () => {
  it("never drops clicks: a rapid setTheme(A) → setTheme(B) settles on B even when A resolves late", async () => {
    storedTheme("gruvbox", "dark");
    const ctl = installFetch({ deferred: true });
    mountTheme("/repo", (
      <>
        <ThemeControls />
        <ThemeProbe />
      </>
    ));
    await waitFor(() => expect(ctl.resolveCalls()).toContain("/v1/themes/gruvbox?mode=dark&cwd=%2Frepo"));

    // User clicks A then B while the first resolve is still in flight.
    act(() => { fireEvent.click(screen.getByText("pick-solarized")); });
    act(() => { fireEvent.click(screen.getByText("pick-gruvbox")); });

    const aPath = "/v1/themes/solarized?mode=dark&cwd=%2Frepo";
    const bPath = "/v1/themes/gruvbox?mode=dark&cwd=%2Frepo";
    // Deliver the STALE (A) result first, then the latest (B).
    await act(async () => {
      ctl.pending.get(aPath)?.(json({ name: "solarized", isDark: true, cssVars: CSS.solarized }));
      await Promise.resolve();
    });
    await waitFor(() => expect(probe().themeName).toBe("gruvbox"));
    // A's late payload must NOT overwrite the latest selection: nothing from A
    // may reach the DOM (B is still resolving, so the last applied is still
    // the pre-click boot state).
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await act(async () => {
      ctl.pending.get(bPath)?.(json({ name: "gruvbox", isDark: true, cssVars: CSS.gruvbox }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(probe().resolveStatus).toBe("success");
      expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
      expect(document.documentElement.dataset.theme).toBe("gruvbox");
    });
  });

  it("system intent follows the resolved mode (dark boot default without matchMedia)", async () => {
    localStorage.setItem("pi-theme-mode", "system");
    localStorage.setItem("pi-theme", "gruvbox");
    const ctl = installFetch();
    mountTheme("/repo");
    await waitFor(() => expect(probe().resolveStatus).toBe("success"));
    expect(ctl.resolveCalls()).toContain("/v1/themes/gruvbox?mode=dark&cwd=%2Frepo");
    expect(document.documentElement.dataset.themeResolvedMode).toBe("dark");
  });
});

describe("ThemeProvider — failure visibility, never silent", () => {
  it("surfaces a remote catalog error as catalog.error with NO themeSets (builtins are not presented as remote data)", async () => {
    const ctl = installFetch();
    ctl.setFailList(true);
    mountTheme("/repo");
    await waitFor(() => expect(probe().catalogStatus).toBe("error"));
    expect(probe().themeSets).toBeNull();
  });

  it("keeps the last applied CSS when resolving a NEW theme fails (never silently clears)", async () => {
    storedTheme("gruvbox", "dark");
    const ctl = installFetch();
    mountTheme("/repo", (
      <>
        <ThemeControls />
        <ThemeProbe />
      </>
    ));
    await waitFor(() => {
      expect(probe().resolveStatus).toBe("success");
      expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
    });

    // Switching to solarized fails on the server.
    ctl.setFailResolve(new Set(["solarized"]));
    act(() => { fireEvent.click(screen.getByText("pick-solarized")); });
    await waitFor(() => expect(probe().resolveStatus).toBe("error"));
    // CSS is untouched: the last good theme stays, nothing is cleared.
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
    expect(document.documentElement.dataset.theme).toBe("gruvbox");
  });

  it("explicit Default clears back to the CSS-only theme (intent, not a failure)", async () => {
    storedTheme("gruvbox", "dark");
    installFetch();
    mountTheme("/repo", (
      <>
        <ThemeControls />
        <ThemeProbe />
      </>
    ));
    await waitFor(() => {
      expect(probe().resolveStatus).toBe("success");
      expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
    });
    act(() => { fireEvent.click(screen.getByText("pick-default")); });
    await waitFor(() => expect(probe().themeName).toBe(""));
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("ThemeProvider — no reapply per consumer mount", () => {
  it("mounting a MarkdownBody-style consumer does not re-trigger theme application", async () => {
    storedTheme("gruvbox", "dark");
    const ctl = installFetch();
    mountTheme("/repo", (
      <ConsumerSwitcher renderConsumer={() => <MarkdownBody>**hello** world</MarkdownBody>} />
    ));
    // MarkdownBody reads isDark from the shared context and renders.
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#282828");
    });
    const resolveCount = ctl.resolveCalls().length;
    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    setProperty.mockClear();

    // Unmount + remount the MarkdownBody consumer within the SAME provider:
    // shared state only — no new resolve, no theme-variable re-apply.
    act(() => { fireEvent.click(screen.getByText("toggle-consumer")); });
    act(() => { fireEvent.click(screen.getByText("toggle-consumer")); });
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    expect(ctl.resolveCalls().length).toBe(resolveCount);
    expect(setProperty.mock.calls.some(([k]) => k === "--bg")).toBe(false);
    setProperty.mockRestore();
  });
});
