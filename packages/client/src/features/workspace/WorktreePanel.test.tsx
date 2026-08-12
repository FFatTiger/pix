import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { WorktreePanel, describeWorktreeError } from "./WorktreePanel";
import { HttpError } from "@/api/http-client";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPanel(props: { cwd: string | undefined; canWorktree?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>{children}</HttpClientProvider>
    </QueryClientProvider>
  );
  return render(<WorktreePanel cwd={props.cwd} canWorktree={props.canWorktree ?? true} />, {
    wrapper: Wrapper,
  });
}

const MAIN = {
  path: "/proj",
  branch: "main",
  isMain: true,
  authorized: true,
};
const LINKED = {
  path: "/proj-worktrees/feature",
  branch: "feature/long-branch-name-that-should-not-break-layout",
  isMain: false,
  authorized: true,
};
const EXTERNAL = {
  path: "/tmp/external-wt",
  branch: null,
  isMain: false,
  authorized: false,
};

describe("WorktreePanel", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
  });

  it("never requests the API when the worktree capability is absent", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    renderPanel({ cwd: "/proj", canWorktree: false });
    expect(screen.getByText(/not available/i)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prompts to open a project when no cwd is set and issues zero requests", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    renderPanel({ cwd: undefined });
    expect(screen.getByText(/open a project/i)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders non-git status without worktree rows", async () => {
    globalThis.fetch = vi.fn(async () =>
      json({ projectRoot: "/plain", isGit: false, isTopLevel: false, worktrees: [] }),
    ) as unknown as typeof fetch;
    renderPanel({ cwd: "/plain" });
    await waitFor(() => expect(screen.getByText(/not a git repository/i)).toBeTruthy());
    expect(screen.queryByRole("list", { name: /git worktrees/i })).toBeNull();
  });

  it("renders main, linked, detached, and unauthorized rows with no action buttons", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      expect(url.pathname).toBe("/v1/worktrees");
      expect(url.searchParams.get("cwd")).toBe("/proj");
      return json({
        projectRoot: "/proj",
        isGit: true,
        isTopLevel: true,
        worktrees: [MAIN, LINKED, EXTERNAL],
      });
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("Detached")).toBeTruthy());
    // Two linked rows (authorized feature + external detached).
    expect(screen.getAllByText("linked").length).toBe(2);
    // Role chip "main" and branch label "main" both appear for the main worktree.
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("authorized").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("External · not authorized")).toBeTruthy();
    expect(screen.getByText("/tmp/external-wt")).toBeTruthy();
    // Unauthorized row stays visible — never hidden.
    expect(screen.getByText("External · not authorized").closest("li")).toBeTruthy();

    // Strictly read-only: no create/remove/force/open/switch/promote/session.
    const forbidden = /create|delete|remove|force|open|switch|promote|session/i;
    for (const button of screen.queryAllByRole("button")) {
      expect(button.textContent ?? "").not.toMatch(forbidden);
      expect(button.getAttribute("aria-label") ?? "").not.toMatch(forbidden);
    }
    // Only the refresh control is an action.
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
  });

  it("maps host errors to fixed sanitized copy and never shows raw body", async () => {
    globalThis.fetch = vi.fn(async () =>
      json(
        {
          code: "PATH_FORBIDDEN",
          message: "SECRET=/etc/passwd stack:Error at /secret/path",
        },
        403,
      ),
    ) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/outside the allowed roots/i);
    expect(alert.textContent).not.toMatch(/SECRET|stack|\/etc\/passwd|\/secret\/path/i);
  });

  it("fails closed on a malformed response (schema mismatch)", async () => {
    globalThis.fetch = vi.fn(async () =>
      json({ projectRoot: "/proj", isGit: true, worktrees: "nope" }),
    ) as unknown as typeof fetch;
    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/unable to load worktrees/i);
    expect(screen.queryByText("main")).toBeNull();
  });

  it("isolates query keys by cwd so A→B stale responses never overwrite B", async () => {
    let resolveA: ((value: Response) => void) | undefined;
    const aPromise = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const cwd = url.searchParams.get("cwd");
      if (cwd === "/proj-a") return aPromise;
      if (cwd === "/proj-b") {
        return json({
          projectRoot: "/repo-b-root",
          isGit: true,
          isTopLevel: true,
          worktrees: [{ path: "/repo-b-root", branch: "branch-b", isMain: true, authorized: true }],
        });
      }
      return json({});
    }) as unknown as typeof fetch;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>{children}</HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(<WorktreePanel cwd="/proj-a" canWorktree />, { wrapper: Wrapper });

    // Switch to B while A is still in flight.
    rerender(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <WorktreePanel cwd="/proj-b" canWorktree />
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("branch-b")).toBeTruthy());
    expect(screen.queryByText("branch-a")).toBeNull();

    // Late A response must not clobber B.
    await act(async () => {
      resolveA?.(
        json({
          projectRoot: "/repo-a-root",
          isGit: true,
          isTopLevel: true,
          worktrees: [{ path: "/repo-a-root", branch: "branch-a", isMain: true, authorized: true }],
        }),
      );
      await aPromise;
    });
    await waitFor(() => expect(screen.getByText("branch-b")).toBeTruthy());
    expect(screen.queryByText("branch-a")).toBeNull();
    // projectRoot summary + row path both show the same value.
    expect(screen.getAllByText("/repo-b-root").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("/repo-a-root")).toBeNull();
  });

  it("re-fetches when Refresh is pressed", async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => {
      count += 1;
      return json({
        projectRoot: "/proj",
        isGit: true,
        isTopLevel: true,
        worktrees: [MAIN],
      });
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    expect(count).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(count).toBe(2));
  });
});

describe("describeWorktreeError", () => {
  it("maps known codes to fixed copy", () => {
    expect(
      describeWorktreeError(
        new HttpError({ status: 400, path: "/v1/worktrees", message: "LEAK", code: "INVALID_PATH" }),
      ),
    ).toBe("Invalid project path.");
    expect(
      describeWorktreeError(
        new HttpError({ status: 403, path: "/v1/worktrees", message: "LEAK", code: "PATH_FORBIDDEN" }),
      ),
    ).toBe("Project path is outside the allowed roots.");
    expect(
      describeWorktreeError(
        new HttpError({ status: 404, path: "/v1/worktrees", message: "LEAK", code: "PATH_NOT_FOUND" }),
      ),
    ).toBe("Project path was not found.");
  });

  it("never echoes raw host messages", () => {
    const err = new HttpError({
      status: 500,
      path: "/v1/worktrees",
      message: "SECRET=/etc/passwd\nstack at /tmp",
      code: "INTERNAL",
    });
    const copy = describeWorktreeError(err);
    expect(copy).toBe("Unable to load worktrees.");
    expect(copy).not.toMatch(/SECRET|stack|\/etc|\/tmp/);
  });
});
