import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { FilesPanel } from "./FilesPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPanel(props: { cwd: string | undefined; canFiles?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>{children}</HttpClientProvider>
    </QueryClientProvider>
  );
  return render(<FilesPanel cwd={props.cwd} canFiles={props.canFiles ?? true} />, { wrapper: Wrapper });
}

describe("FilesPanel", () => {
  let previous: typeof fetch;
  beforeEach(() => { previous = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previous; });

  it("never requests the API when the files capability is absent", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    renderPanel({ cwd: "/proj", canFiles: false });
    expect(screen.getByText(/not available/i)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prompts to open a project when no cwd is set", () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderPanel({ cwd: undefined });
    expect(screen.getByText(/open a project/i)).toBeTruthy();
  });

  it("lists the project root, navigates into a directory, and clamps at root", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      calls.push(`${url.pathname}?op=${params.op}&path=${params.path}`);
      if (url.pathname === "/v1/files" && params.op === "list") {
        if (params.path === "/proj") {
          return json({ path: "/proj", entries: [{ name: "src", isDir: true, isSymlink: false }, { name: "a.ts", isDir: false, isSymlink: false }] });
        }
        if (params.path === "/proj/src") {
          return json({ path: "/proj/src", entries: [{ name: "b.ts", isDir: false, isSymlink: false }] });
        }
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    // Root crumb is present and the Up button is disabled at the project root.
    expect(screen.getByRole("button", { name: "proj" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /Up/ }) as HTMLButtonElement).disabled).toBe(true);

    // Enter the directory.
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("b.ts")).toBeTruthy());
    expect(calls.some((c) => c.includes("path=/proj/src&op=list") || c.includes("path=/proj/src"))).toBe(true);
    expect((screen.getByRole("button", { name: /Up/ }) as HTMLButtonElement).disabled).toBe(false);

    // Walk back up to the project root.
    fireEvent.click(screen.getByRole("button", { name: /Up/ }));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    expect((screen.getByRole("button", { name: /Up/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads and previews a selected file with metadata", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        return json({ path: "/proj", entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
      }
      if (url.pathname === "/v1/files" && params.op === "meta") {
        return json({ path: "/proj/a.ts", size: 11, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "text/plain" });
      }
      if (url.pathname === "/v1/files" && params.op === "read") {
        return json({ content: "hello world", language: "typescript", size: 11 });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => expect(screen.getByText(/hello world/)).toBeTruthy());
  });

  it("shows a friendly message for a too-large file", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        return json({ path: "/proj", entries: [{ name: "big.log", isDir: false, isSymlink: false }] });
      }
      if (url.pathname === "/v1/files" && params.op === "meta") {
        return json({ path: "/proj/big.log", size: 999999, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "text/plain" });
      }
      if (url.pathname === "/v1/files" && params.op === "read") {
        return json({ code: "PREVIEW_TOO_LARGE", message: "Text preview is too large" }, 413);
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("big.log")).toBeTruthy());
    fireEvent.click(screen.getByText("big.log"));
    await waitFor(() => expect(screen.getByText(/too large to preview/i)).toBeTruthy());
  });

  it("shows a friendly message for a binary file", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        return json({ path: "/proj", entries: [{ name: "img.png", isDir: false, isSymlink: false }] });
      }
      if (url.pathname === "/v1/files" && params.op === "meta") {
        return json({ path: "/proj/img.png", size: 1024, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "image/png" });
      }
      if (url.pathname === "/v1/files" && params.op === "read") {
        return json({ code: "BINARY_FILE", message: "Binary files require raw preview" }, 415);
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("img.png")).toBeTruthy());
    fireEvent.click(screen.getByText("img.png"));
    await waitFor(() => expect(screen.getByText(/binary file/i)).toBeTruthy());
  });

  it("handles an empty directory and a list error", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list" && params.path === "/proj/empty") {
        return json({ path: "/proj/empty", entries: [] });
      }
      if (url.pathname === "/v1/files" && params.op === "list" && params.path === "/proj/broken") {
        return json({ code: "PATH_NOT_FOUND", message: "Path not found" }, 404);
      }
      return json({});
    }) as unknown as typeof fetch;

    const { rerender } = renderPanel({ cwd: "/proj/empty" });
    await waitFor(() => expect(screen.getByText(/empty/i)).toBeTruthy());

    rerender(<FilesPanel cwd="/proj/broken" canFiles={true} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/project path was not found/i);
  });

  it("canonicalizes a symlinked cwd and never reports a selected file as outside-root", async () => {
    // macOS: /tmp is a symlink to /private/tmp. The Host canonicalizes every
    // listing's `path`, so cwd="/tmp/proj" comes back as "/private/tmp/proj".
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        if (params.path === "/tmp/proj") {
          return json({ path: "/private/tmp/proj", entries: [{ name: "src", isDir: true, isSymlink: false }, { name: "a.ts", isDir: false, isSymlink: false }] });
        }
        if (params.path === "/private/tmp/proj/src") {
          return json({ path: "/private/tmp/proj/src", entries: [{ name: "b.ts", isDir: false, isSymlink: false }] });
        }
      }
      if (url.pathname === "/v1/files" && params.op === "meta" && params.path === "/private/tmp/proj/src/b.ts") {
        return json({ path: "/private/tmp/proj/src/b.ts", size: 12, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "text/plain" });
      }
      if (url.pathname === "/v1/files" && params.op === "read" && params.path === "/private/tmp/proj/src/b.ts") {
        return json({ content: "nested body", language: "typescript", size: 11 });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/tmp/proj" });
    // Root listing canonicalizes; navigation derives from the canonical path.
    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("b.ts")).toBeTruthy());
    // The breadcrumb chain reflects the canonical root, not the raw cwd.
    expect(screen.getByRole("button", { name: "proj" })).toBeTruthy();

    // Select and read the file: succeeds and must NOT raise the outside-root warning.
    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() => expect(screen.getByText(/nested body/)).toBeTruthy());
    expect(screen.queryByText(/outside the project root/i)).toBeNull();
  });

  it("ignores a stale directory-listing response after navigating away", async () => {
    // Drive a real navigation race: enter A (slow list), go back, enter B (fast),
    // then let A's delayed response land. The view must stay on B because the
    // current directory query is keyed by currentDir, not by arrival order.
    let resolveSlowA: (value: Response) => void = () => undefined;
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        if (params.path === "/proj") {
          return json({ path: "/proj", entries: [{ name: "A", isDir: true, isSymlink: false }, { name: "B", isDir: true, isSymlink: false }] });
        }
        if (params.path === "/proj/A") {
          return new Promise<Response>((resolve) => { resolveSlowA = resolve; });
        }
        if (params.path === "/proj/B") {
          return json({ path: "/proj/B", entries: [{ name: "b1.txt", isDir: false, isSymlink: false }] });
        }
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("A")).toBeTruthy());

    // Enter A — its listing stays pending.
    fireEvent.click(screen.getByText("A"));
    await waitFor(() => expect(screen.getByText(/loading directory/i)).toBeTruthy());

    // Navigate back to the root via the breadcrumb, then into B.
    fireEvent.click(screen.getByRole("button", { name: "proj" }));
    await waitFor(() => expect(screen.getByText("B")).toBeTruthy());
    fireEvent.click(screen.getByText("B"));
    await waitFor(() => expect(screen.getByText("b1.txt")).toBeTruthy());

    // A's stale response finally lands — it must NOT replace the current view.
    resolveSlowA(json({ path: "/proj/A", entries: [{ name: "a1.txt", isDir: false, isSymlink: false }] }));
    // Yield so any (incorrect) state update would flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText("b1.txt")).toBeTruthy();
    expect(screen.queryByText("a1.txt")).toBeNull();
  });

  it.each([
    ["INVALID_PATH", 400, /invalid project path/i],
    ["PATH_NOT_FOUND", 404, /project path was not found/i],
    ["NO_ALLOWED_ROOTS", 404, /no allowed roots are configured/i],
    ["PATH_FORBIDDEN", 403, /outside the allowed roots/i],
    ["INTERNAL", 500, /unable to list directory/i],
  ] as const)(
    "maps a list %s error to fixed copy and never shows the raw leak",
    async (code, status, expected) => {
      globalThis.fetch = vi.fn(async (input) => {
        const url = new URL(String(input), "http://pix.local");
        const params = Object.fromEntries(url.searchParams);
        if (url.pathname === "/v1/files" && params.op === "list") {
          return json({ code, message: "SECRET=/etc/passwd /Users/x/.agent stack" }, status);
        }
        return json({});
      }) as unknown as typeof fetch;

      renderPanel({ cwd: "/proj" });
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(expected);
      expect(alert.textContent).not.toMatch(/SECRET|\/etc\/passwd|\/Users\/x|stack|\.agent/i);
    },
  );

  it("maps a network failure on list to fixed copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED raw secret /var/key");
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/network error — unable to list directory/i);
    expect(alert.textContent).not.toMatch(/ECONNREFUSED|\/var\/key|secret/i);
  });

  it("maps an unknown read error to fixed copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        return json({ path: "/proj", entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
      }
      if (url.pathname === "/v1/files" && params.op === "meta") {
        return json({ path: "/proj/a.ts", size: 11, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "text/plain" });
      }
      if (url.pathname === "/v1/files" && params.op === "read") {
        return json({ code: "INTERNAL", message: "SECRET=/var/key stack at /secret" }, 500);
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/unable to read file/i);
    expect(alert.textContent).not.toMatch(/SECRET|\/var\/key|\/secret|stack/i);
  });
});
