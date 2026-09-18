import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { LoginPage, navigateAfterLogin } from "./LoginPage";
import { HttpClientProvider } from "@/app/http-context";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    Link: ({
      children,
      to,
    }: {
      children?: ReactNode;
      to?: string;
      search?: unknown;
    }) => <a href={typeof to === "string" ? to : "/"}>{children}</a>,
  };
});

function mockGateFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? `${input.pathname}${input.search}`
          : input.url;

    if (String(path).includes("/v1/gate/status")) {
      return new Response(
        JSON.stringify({ required: true, authenticated: false, mode: "local", status: "enabled" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (String(path).includes("/v1/gate/login")) {
      return new Response(JSON.stringify({ ok: true, next: "/" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
        <HttpClientProvider>{children}</HttpClientProvider>
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

describe("LoginPage success navigation", () => {
  let previousFetch: typeof fetch;

  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    previousFetch = globalThis.fetch;
    globalThis.fetch = mockGateFetch();
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("calls router navigate with session/cwd after successful login", async () => {
    renderLogin("/?session=deep&cwd=%2Frepo");

    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/",
        search: { session: "deep", cwd: "/repo" },
        replace: true,
      });
    });
  });

  it("shows sanitized next hint for deep links", async () => {
    renderLogin("/?session=x");
    const hint = await screen.findByText(/next:/i);
    expect(hint.textContent).toContain("session=x");
  });

  it("does not show next hint for home-only targets", async () => {
    renderLogin("/");
    // Wait for gate status to settle so we don't race.
    await screen.findByText(/required:/i);
    expect(screen.queryByText(/next:/i)).toBeNull();
  });
});
