import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { FilesPanel, SEARCH_DEBOUNCE_MS } from "./FilesPanel";

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

/**
 * Advance the 250ms debounce, flush the fetch promise chain, then tick a
 * non-zero slice so react-query's notifyManager `setTimeout(0)` delivers the
 * resolved data to the UI. Each step uses its own `act` so React renders
 * between them (a single act defers the query's creation until the end).
 * Must run inside a `vi.useFakeTimers()` scope.
 */
async function settleSearch() {
  await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
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

  it("never requests the file index for empty or single-character queries", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "a.ts", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    const indexCalls = () => calls.filter((c) => c.includes("/v1/file-index"));

    // One character: fixed hint, no request.
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getByText(/at least 2 characters/i)).toBeTruthy();
    expect(indexCalls()).toHaveLength(0);

    // Clear back to empty: directory browsing restored, still no request.
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    expect(screen.queryByText(/at least 2 characters/i)).toBeNull();
    expect(indexCalls()).toHaveLength(0);
  });

  it("debounces 250ms then requests the file index with the exact trimmed query", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "src/readme.md", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    const indexCalls = () => calls.filter((c) => c.includes("/v1/file-index"));

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "  readme  " } });
      // Trimmed query is ≥2 but the request must wait for the debounce.
      expect(indexCalls()).toHaveLength(0);
      await settleSearch();
      expect(indexCalls()).toHaveLength(1);
      expect(indexCalls()[0]).toBe("/v1/file-index?cwd=%2Fproj&q=readme");
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText("src/readme.md")).toBeTruthy());
  });

  it("rapid typing only ever requests the final query", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "foo" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      fireEvent.change(input, { target: { value: "foobar" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      fireEvent.change(input, { target: { value: "foobarbaz" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); });

      const queries = calls
        .filter((c) => c.includes("/v1/file-index"))
        .map((c) => new URL(c, "http://pix.local").searchParams.get("q"));
      expect(queries).toEqual(["foobarbaz"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports searching, empty, matches and truncation in the live status", async () => {
    let mode: "empty" | "two" | "truncated" = "empty";
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        if (mode === "empty") return json({ matches: [], truncated: false });
        if (mode === "truncated") return json({ matches: [{ path: "a.ts", isDir: false }, { path: "b.ts", isDir: false }], truncated: true });
        return json({ matches: [{ path: "a.ts", isDir: false }, { path: "b.ts", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    const status = () => screen.getByText(/searching|match|results|no matches/i);

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "query" } });
      expect(status().textContent).toBe("Searching…");
      await settleSearch();
      expect(status().textContent).toBe("No matches found.");

      mode = "two";
      fireEvent.change(input, { target: { value: "query2" } });
      await settleSearch();
      expect(status().textContent).toBe("2 matches found.");

      mode = "truncated";
      fireEvent.change(input, { target: { value: "query3" } });
      await settleSearch();
      expect(status().textContent).toBe("2 matches found. Results truncated.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a valid search result and previews it via meta + read", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "src/b.ts", isDir: false }], truncated: false });
      }
      if (url.pathname === "/v1/files" && params.op === "meta" && params.path === "/proj/src/b.ts") {
        return json({ path: "/proj/src/b.ts", size: 11, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "text/plain" });
      }
      if (url.pathname === "/v1/files" && params.op === "read" && params.path === "/proj/src/b.ts") {
        return json({ content: "searched body", language: "typescript", size: 11 });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "b.ts" } });
      await settleSearch();
    } finally {
      vi.useRealTimers();
    }

    const result = await screen.findByText("src/b.ts");
    expect(result.closest("button")?.getAttribute("title")).toBe("src/b.ts");
    fireEvent.click(result);
    await waitFor(() => expect(screen.getByText(/searched body/)).toBeTruthy());
    expect(calls.some((c) => c.includes("/v1/files") && c.includes("op=meta") && c.includes("path=%2Fproj%2Fsrc%2Fb.ts"))).toBe(true);
    expect(calls.some((c) => c.includes("/v1/files") && c.includes("op=read") && c.includes("path=%2Fproj%2Fsrc%2Fb.ts"))).toBe(true);
  });

  it("rejects a malicious search match: fixed message, no meta/read, no absolute path leak", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "../../etc/passwd", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "passwd" } });
      await settleSearch();
    } finally {
      vi.useRealTimers();
    }

    const result = await screen.findByText("../../etc/passwd");
    fireEvent.click(result);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/invalid search result/i));
    // The alert is fixed copy — it never echoes the malicious relative path.
    expect(screen.getByRole("alert").textContent).not.toMatch(/\.\.\/etc/);
    // No preview/read/meta was ever requested for the rejected match.
    expect(calls.filter((c) => c.includes("/v1/files") && (c.includes("op=meta") || c.includes("op=read")))).toHaveLength(0);
  });

  it("switching cwd clears the search and never requests the old query against the new cwd", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        if (params.path === "/projA" || params.path === "/projB") {
          return json({ path: params.path, entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
        }
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "alpha.ts", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    const { rerender } = renderPanel({ cwd: "/projA" });
    const input = await screen.findByLabelText("Search files");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "alpha" } });
      await settleSearch();
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText("alpha.ts")).toBeTruthy());

    rerender(<FilesPanel cwd="/projB" canFiles={true} />);
    expect((screen.getByLabelText("Search files") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    expect(screen.queryByText("alpha.ts")).toBeNull();
    expect(calls.some((c) => c.includes("/v1/file-index") && c.includes("cwd=%2FprojB"))).toBe(false);
  });

  it("a late q1 response never renders as the current q2 query", async () => {
    let resolveQ1: ((value: Response) => void) | undefined;
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        if (url.searchParams.get("q") === "foo") {
          return new Promise<Response>((resolve) => { resolveQ1 = resolve; });
        }
        return json({ matches: [{ path: "bar.ts", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "foo" } });
      await settleSearch();

      // Type the next query immediately: old q1 results must be hidden at once.
      fireEvent.change(input, { target: { value: "foobar" } });
      expect(screen.getByText("Searching…")).toBeTruthy();

      await settleSearch();
      expect(screen.getByText("bar.ts")).toBeTruthy();

      // The late q1 response lands — it must not replace the q2 view.
      resolveQ1?.(json({ matches: [{ path: "foo.ts", isDir: false }], truncated: false }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getByText("bar.ts")).toBeTruthy();
      expect(screen.queryByText("foo.ts")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdrawing the files capability hides results, stops requests, and restore flashes nothing", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "a.ts", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    const { rerender } = renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "alpha" } });
      await settleSearch();
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());

    const requestsBefore = calls.length;
    rerender(<FilesPanel cwd="/proj" canFiles={false} />);
    expect(screen.getByText(/not available/i)).toBeTruthy();
    expect(screen.queryByText("a.ts")).toBeNull();
    expect(screen.queryByLabelText("Search files")).toBeNull();
    expect(calls.length).toBe(requestsBefore);

    // Restore: search input is empty and no stale results flash.
    rerender(<FilesPanel cwd="/proj" canFiles={true} />);
    await waitFor(() => expect(screen.getByLabelText("Search files")).toBeTruthy());
    expect((screen.getByLabelText("Search files") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("a.ts")).toBeNull();
  });

  it("maps a file-index error to fixed copy and never shows the raw leak", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      if (url.pathname === "/v1/files" && url.searchParams.get("op") === "list") {
        return json({ path: "/proj", entries: [] });
      }
      if (url.pathname === "/v1/file-index") {
        return json({ code: "INTERNAL", message: "SECRET=/var/key stack at /etc/passwd" }, 500);
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "secret" } });
      await settleSearch();
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/unable to search files/i);
    expect(alert.textContent).not.toMatch(/SECRET|\/var\/key|etc\/passwd|stack/i);
  });

  it("clearing the search restores the preserved directory browsing", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), "http://pix.local");
      const params = Object.fromEntries(url.searchParams);
      if (url.pathname === "/v1/files" && params.op === "list") {
        if (params.path === "/proj") {
          return json({ path: "/proj", entries: [{ name: "docs", isDir: true, isSymlink: false }, { name: "readme.md", isDir: false, isSymlink: false }] });
        }
        if (params.path === "/proj/docs") {
          return json({ path: "/proj/docs", entries: [{ name: "deep.ts", isDir: false, isSymlink: false }] });
        }
      }
      if (url.pathname === "/v1/file-index") {
        return json({ matches: [{ path: "docs/deep.ts", isDir: false }], truncated: false });
      }
      return json({});
    }) as unknown as typeof fetch;

    renderPanel({ cwd: "/proj" });
    const input = await screen.findByLabelText("Search files");
    // Navigate into a subdirectory first — this is the directory to preserve.
    await waitFor(() => expect(screen.getByText("docs")).toBeTruthy());
    fireEvent.click(screen.getByText("docs"));
    await waitFor(() => expect(screen.getByText("deep.ts")).toBeTruthy());

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "deep" } });
      await settleSearch();
    } finally {
      vi.useRealTimers();
    }
    // Search mode replaces the directory list with search results.
    await waitFor(() => expect(screen.getByText("docs/deep.ts")).toBeTruthy());
    expect(screen.queryByText("deep.ts")).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    // Directory browsing returns at the preserved /proj/docs location.
    await waitFor(() => expect(screen.getByText("deep.ts")).toBeTruthy());
    expect(screen.queryByText("docs/deep.ts")).toBeNull();
  });
});
