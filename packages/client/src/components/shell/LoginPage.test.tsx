import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { LoginPage, navigateAfterLogin, resolveLoginGateState } from "./LoginPage";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

type GateStatusBody = {
  required: boolean;
  authenticated: boolean;
  mode: "local" | "lan";
  status: "enabled" | "disabled" | "unconfigured" | "error";
};

const ENABLED_STATUS: GateStatusBody = {
  required: true,
  authenticated: false,
  mode: "lan",
  status: "enabled",
};

const UNCONFIGURED_STATUS: GateStatusBody = {
  required: true,
  authenticated: false,
  mode: "lan",
  status: "unconfigured",
};

function mockGateFetch(
  options: {
    status?: GateStatusBody;
    login?: { status: number; body: unknown };
    setup?: { status: number; body: unknown; after?: GateStatusBody };
  } = {},
): typeof fetch {
  let current = options.status ?? ENABLED_STATUS;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  return vi.fn(async (input: RequestInfo | URL) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? `${input.pathname}${input.search}`
          : input.url;

    if (String(path).includes("/v1/gate/status")) {
      return json(current);
    }
    if (String(path).includes("/v1/gate/setup")) {
      if (options.setup) {
        // The host refused the setup — the state moved on (another browser
        // set the key), so the status endpoint reports the new state.
        current = options.setup.after ?? { ...current, status: "enabled", authenticated: true };
        return new Response(JSON.stringify(options.setup.body), {
          status: options.setup.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      current = { ...current, status: "enabled", authenticated: true };
      return json({ ok: true, next: "/" });
    }
    if (String(path).includes("/v1/gate/login")) {
      if (options.login) {
        return new Response(JSON.stringify(options.login.body), {
          status: options.login.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json({ ok: true, next: "/" });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function renderLogin(next?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <I18nProvider>{children}</I18nProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
  }

  return render(
    next === undefined ? <LoginPage /> : <LoginPage next={next} />,
    { wrapper: Wrapper },
  );
}

describe("navigateAfterLogin", () => {
  it("navigates with split to + search for deep links", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await navigateAfterLogin(
      navigate as never,
      "/?session=abc&cwd=%2Ftmp%2Fproj",
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/",
      search: { session: "abc", cwd: "/tmp/proj" },
      replace: true,
    });
  });

  it("falls back to home for evil next values", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await navigateAfterLogin(navigate as never, "//evil.example");
    expect(navigate).toHaveBeenCalledWith({
      to: "/",
      search: {},
      replace: true,
    });
  });

  it("does not navigate back to /login", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await navigateAfterLogin(navigate as never, "/login?next=%2F");
    expect(navigate).toHaveBeenCalledWith({
      to: "/",
      search: {},
      replace: true,
    });
  });

  it("navigates to bare home", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    await navigateAfterLogin(navigate as never, "/");
    expect(navigate).toHaveBeenCalledWith({
      to: "/",
      search: {},
      replace: true,
    });
  });
});

describe("resolveLoginGateState", () => {
  it("maps every host gate status onto a login screen state", () => {
    expect(resolveLoginGateState({ status: "enabled" })).toBe("form");
    expect(resolveLoginGateState({ status: "unconfigured" })).toBe("setup");
    expect(resolveLoginGateState({ status: "error" })).toBe("configError");
    expect(resolveLoginGateState({ status: "disabled" })).toBe("open");
    expect(resolveLoginGateState(undefined)).toBe("unknown");
  });
});

describe("LoginPage", () => {
  let previousFetch: typeof fetch;

  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    window.localStorage.clear();
    window.localStorage.setItem("pi-locale", "en");
    previousFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("calls router navigate with session/cwd after successful login", async () => {
    globalThis.fetch = mockGateFetch();
    renderLogin("/?session=deep&cwd=%2Frepo");

    fireEvent.change(await screen.findByLabelText(/access key/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/",
        search: { session: "deep", cwd: "/repo" },
        replace: true,
      });
    });
  });

  it("shows a continuation hint for deep links", async () => {
    globalThis.fetch = mockGateFetch();
    renderLogin("/?session=x");
    const hint = await screen.findByText(/return to the page you opened/i);
    expect(hint.textContent).toContain("return to the page you opened");
  });

  it("shows no continuation hint for home-only targets", async () => {
    globalThis.fetch = mockGateFetch();
    renderLogin("/");
    await screen.findByLabelText(/access key/i);
    expect(screen.queryByText(/return to the page you opened/i)).toBeNull();
  });

  it("never renders the gate debug fields", async () => {
    globalThis.fetch = mockGateFetch();
    renderLogin();
    await screen.findByLabelText(/access key/i);
    expect(document.body.textContent).not.toMatch(/required:/i);
    expect(document.body.textContent).not.toMatch(/authenticated:/i);
  });

  it("offers to set the first access key when the host has none", async () => {
    globalThis.fetch = mockGateFetch({ status: UNCONFIGURED_STATUS });
    renderLogin();

    expect(await screen.findByText(/set an access key/i)).toBeTruthy();
    expect(screen.getByLabelText(/^access key$/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm access key/i)).toBeTruthy();
    // The opt-out stays a secondary hint.
    expect(screen.getByText(/don't want an access key/i)).toBeTruthy();
    expect(screen.getByText('{"auth":{"disabled":true}}')).toBeTruthy();
    // There is nothing to sign in to yet.
    expect(screen.queryByRole("button", { name: /^sign in$/i })).toBeNull();
  });

  it("rejects a mismatching confirmation before sending it", async () => {
    globalThis.fetch = mockGateFetch({ status: UNCONFIGURED_STATUS });
    renderLogin();

    fireEvent.change(await screen.findByLabelText(/^access key$/i), {
      target: { value: "first-key" },
    });
    fireEvent.change(screen.getByLabelText(/confirm access key/i), {
      target: { value: "other-key" },
    });

    expect(await screen.findByText(/do not match/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /set access key/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets the access key and signs this browser in", async () => {
    globalThis.fetch = mockGateFetch({ status: UNCONFIGURED_STATUS });
    renderLogin();

    fireEvent.change(await screen.findByLabelText(/^access key$/i), {
      target: { value: "first-key" },
    });
    fireEvent.change(screen.getByLabelText(/confirm access key/i), {
      target: { value: "first-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set access key/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
    expect(calls.some((path) => path.includes("/v1/gate/setup"))).toBe(true);
  });

  it("switches to the sign-in form when the key was already set", async () => {
    globalThis.fetch = mockGateFetch({
      status: UNCONFIGURED_STATUS,
      setup: {
        status: 409,
        body: { ok: false, error: "An access key is already configured", message: "An access key is already configured", code: "AUTH_ALREADY_CONFIGURED" },
      },
    });
    renderLogin();

    fireEvent.change(await screen.findByLabelText(/^access key$/i), {
      target: { value: "first-key" },
    });
    fireEvent.change(screen.getByLabelText(/confirm access key/i), {
      target: { value: "first-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set access key/i }));

    expect(await screen.findByText(/already set/i)).toBeTruthy();
    // The page now asks for the existing key instead of setting a new one.
    expect(await screen.findByRole("button", { name: /^sign in$/i })).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("explains a broken authentication configuration", async () => {
    globalThis.fetch = mockGateFetch({
      status: { required: true, authenticated: false, mode: "lan", status: "error" },
    });
    renderLogin();

    expect(await screen.findByText(/authentication configuration error/i)).toBeTruthy();
    expect(screen.queryByLabelText(/access key/i)).toBeNull();
  });

  it("shows the fixed copy for a wrong password", async () => {
    globalThis.fetch = mockGateFetch({
      login: {
        status: 401,
        body: { ok: false, error: "Incorrect password", message: "Incorrect password" },
      },
    });
    renderLogin();

    fireEvent.change(await screen.findByLabelText(/access key/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That access key is not correct.");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("shows the fixed copy for a rate limited attempt", async () => {
    globalThis.fetch = mockGateFetch({
      login: {
        status: 429,
        body: {
          ok: false,
          error: "Too many login attempts, please retry later",
          message: "Too many login attempts, please retry later",
          code: "RATE_LIMITED",
          retryAfterSeconds: 12,
        },
      },
    });
    renderLogin();

    fireEvent.change(await screen.findByLabelText(/access key/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Too many attempts. Try again in 12 seconds.");
  });
});
