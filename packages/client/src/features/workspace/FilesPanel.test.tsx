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
    expect(screen.getByRole("alert").textContent).toMatch(/unable to list/i);
  });
});
