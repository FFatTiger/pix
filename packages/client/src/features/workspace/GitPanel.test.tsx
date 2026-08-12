import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { GitPanel, describeGitError } from "./GitPanel";
import { HttpError } from "@/api/http-client";

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
    expect(screen.getByRole("alert").textContent).toMatch(/project path was not found/i);

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

  it("maps a forbidden git status to fixed copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async () =>
      json(
        { code: "PATH_FORBIDDEN", message: "SECRET=/etc/passwd /Users/x/.agent stack:Error" },
        403,
      ),
    ) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/outside the allowed roots/i);
    expect(alert.textContent).not.toMatch(/SECRET|\/etc\/passwd|\/Users\/x|stack|\.agent/i);
  });

  it("maps an unknown git status error to fixed copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async () =>
      json({ code: "INTERNAL", message: "SECRET=/var/key stack at /secret" }, 500),
    ) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/unable to load git status/i);
    expect(alert.textContent).not.toMatch(/SECRET|\/var\/key|\/secret|stack/i);
  });

  it("maps a network failure to fixed copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED raw secret /var/key");
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/network error — unable to load git status/i);
    expect(alert.textContent).not.toMatch(/ECONNREFUSED|\/var\/key|secret/i);
  });

  it("maps a git diff error to fixed operation-appropriate copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/git/status") {
        return json({ isGitRepository: true, repositoryRoot: "/proj", files: STATUS_FILES, additions: 3, deletions: 1 });
      }
      if (url.pathname === "/v1/git/diff") {
        return json(
          { code: "PATH_FORBIDDEN", message: "SECRET=/etc/passwd stack at /secret" },
          403,
        );
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/a.ts"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/outside the allowed roots/i);
    expect(alert.textContent).not.toMatch(/SECRET|\/etc\/passwd|\/secret|stack/i);
  });
});

describe("describeGitError", () => {
  it.each([
    ["status", "CWD_REQUIRED", "Invalid project path."],
    ["status", "GIT_INPUT_REQUIRED", "Invalid project path."],
    ["status", "INVALID_PATH", "Invalid project path."],
    ["status", "INVALID_INPUT", "Invalid project path."],
    ["status", "PATH_FORBIDDEN", "Project path is outside the allowed roots."],
    ["status", "ROOT_REPLACED", "Project path is outside the allowed roots."],
    ["status", "PATH_NOT_FOUND", "Project path was not found."],
    ["status", "UNKNOWN_CODE", "Unable to load git status."],
    ["diff", "CWD_REQUIRED", "Invalid project path."],
    ["diff", "GIT_INPUT_REQUIRED", "Invalid project path."],
    ["diff", "PATH_FORBIDDEN", "Project path is outside the allowed roots."],
    ["diff", "PATH_NOT_FOUND", "Project path was not found."],
    ["diff", "UNKNOWN_CODE", "Unable to load diff."],
  ] as const)("maps %s %s to fixed copy", (operation, code, copy) => {
    const error = new HttpError({
      status: 400,
      path: `/v1/git/${operation}`,
      message: "LEAKED RAW /secret/path",
      code,
    });
    expect(describeGitError(error, operation)).toBe(copy);
  });

  it("maps network and timeout kinds, scoped to operation", () => {
    expect(
      describeGitError(
        new HttpError({ kind: "network", path: "/v1/git/status", message: "raw", code: "NETWORK_ERROR" }),
        "status",
      ),
    ).toBe("Network error — unable to load git status.");
    expect(
      describeGitError(
        new HttpError({ kind: "timeout", path: "/v1/git/diff", message: "raw", code: "TIMEOUT" }),
        "diff",
      ),
    ).toBe("Request timed out — unable to load diff.");
  });

  it("never echoes raw host messages", () => {
    const err = new HttpError({
      status: 500,
      path: "/v1/git/status",
      message: "SECRET=/etc/passwd\nstack at /tmp",
      code: "INTERNAL",
    });
    expect(describeGitError(err, "status")).toBe("Unable to load git status.");
    expect(describeGitError(err, "diff")).toBe("Unable to load diff.");
    expect(describeGitError(new Error("stack /Users/secret"), "status")).toBe("Unable to load git status.");
  });
});
