import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { GitPanel } from "./GitPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPanel(props: { cwd: string | undefined; canGit?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>{children}</HttpClientProvider>
    </QueryClientProvider>
  );
  return render(<GitPanel cwd={props.cwd} canGit={props.canGit ?? true} />, { wrapper: Wrapper });
}

const STATUS_FILES = [
  { filePath: "/proj/src/a.ts", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" },
  { filePath: "/proj/new.ts", status: "untracked", code: "U", indexStatus: "?", worktreeStatus: "?" },
];

describe("GitPanel", () => {
  let previous: typeof fetch;
  beforeEach(() => { previous = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previous; });

  it("never requests the API when the git capability is absent", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    renderPanel({ cwd: "/proj", canGit: false });
    expect(screen.getByText(/not available/i)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prompts to open a project when no cwd is set", () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderPanel({ cwd: undefined });
    expect(screen.getByText(/open a project/i)).toBeTruthy();
  });

  it("renders repository summary and changed files with status badges", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/git/status") {
        return json({ isGitRepository: true, repositoryRoot: "/proj", files: STATUS_FILES, additions: 3, deletions: 1 });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    expect(screen.getByText("new.ts")).toBeTruthy();
    expect(screen.getByText(/2 changed/)).toBeTruthy();
    expect(screen.getByText(/\+3 \/ −1/)).toBeTruthy();
  });

  it("loads and shows a diff when a changed file is selected", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/git/status") {
        return json({ isGitRepository: true, repositoryRoot: "/proj", files: STATUS_FILES, additions: 3, deletions: 1 });
      }
      if (url.pathname === "/v1/git/diff") {
        return json({ supported: true, status: "modified", patch: `@@ -1,1 +1,1 @@\n-old\n+new` });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/a.ts"));
    await waitFor(() => expect(screen.getByText(/\+new/)).toBeTruthy());
  });

  it("handles a non-repository cwd", async () => {
    globalThis.fetch = vi.fn(async () => json({ isGitRepository: false, repositoryRoot: null, files: [], additions: 0, deletions: 0 })) as unknown as typeof fetch;
    renderPanel({ cwd: "/plain" });
    await waitFor(() => expect(screen.getByText(/not a git repository/i)).toBeTruthy());
  });

  it("handles a clean working tree", async () => {
    globalThis.fetch = vi.fn(async () => json({ isGitRepository: true, repositoryRoot: "/proj", files: [], additions: 0, deletions: 0 })) as unknown as typeof fetch;
    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText(/working tree is clean/i)).toBeTruthy());
  });

  it("shows an error state with a retry control", async () => {
    let failing = true;
    globalThis.fetch = vi.fn(async () => {
      if (failing) return json({ code: "PATH_NOT_FOUND", message: "Path not found" }, 404);
      return json({ isGitRepository: true, repositoryRoot: "/proj", files: [], additions: 0, deletions: 0 });
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/unable to load git status/i);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/working tree is clean/i)).toBeTruthy());
  });

  it("re-fetches status when Refresh is pressed", async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/git/status") {
        count += 1;
        return json({ isGitRepository: true, repositoryRoot: "/proj", files: STATUS_FILES, additions: 3, deletions: 1 });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    expect(count).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(count).toBe(2));
  });
});
