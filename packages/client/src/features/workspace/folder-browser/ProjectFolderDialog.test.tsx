import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { ProjectFolderDialog } from "./ProjectFolderDialog";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function stubFetch(handler: (url: URL) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
    handler(new URL(String(input), "http://pix.local"))
  )) as unknown as typeof fetch);
}

function mount(initialPath: string | null, onSelectAction = vi.fn(), onCancelAction = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <I18nProvider>
          <ProjectFolderDialog
            initialPath={initialPath}
            onCancelAction={onCancelAction}
            onSelectAction={onSelectAction}
          />
        </I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
  return { queryClient, onSelectAction, onCancelAction };
}

function browsePath(url: URL): string {
  return url.searchParams.get("path") ?? "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ProjectFolderDialog — server folder browsing", () => {
  it("starts at an authorized cwd, navigates with one click, and supports Up, breadcrumbs and root switching", async () => {
    const browseCalls: string[] = [];
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") {
        return json({ roots: ["/repo", "/other"], defaultCwd: "/repo" });
      }
      if (url.pathname === "/v1/cwd/browse") {
        const path = browsePath(url);
        browseCalls.push(path);
        switch (path) {
          case "/repo/a/b":
            return json({ path, parentPath: "/repo/a", directories: ["child"] });
          case "/repo/a/b/child":
            return json({ path, parentPath: "/repo/a/b", directories: [] });
          case "/repo/a":
            return json({ path, parentPath: "/repo", directories: ["sibling"] });
          case "/repo":
            return json({ path, parentPath: null, directories: ["a"] });
          case "/other":
            return json({ path, parentPath: null, directories: ["project"] });
          default:
            return json({ error: "not found", code: "PATH_NOT_FOUND" }, 404);
        }
      }
      return json({ error: "not found" }, 404);
    });
    mount("/repo/a/b");

    // Start: current cwd is inside an authorized root, so no default-root jump.
    expect(await screen.findByText("child")).toBeTruthy();
    expect(browseCalls[0]).toBe("/repo/a/b");

    // Single click enters the child directory.
    fireEvent.click(screen.getByTestId("folder-browser-directory"));
    await waitFor(() => expect(browseCalls).toContain("/repo/a/b/child"));

    // Up walks to the parent within the root (child → its parent → sibling).
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    expect(await screen.findByText("child")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    expect(await screen.findByText("sibling")).toBeTruthy();

    // Breadcrumb to the root.
    fireEvent.click(screen.getAllByTestId("folder-browser-crumb")[0]!);
    expect(await screen.findByText("a")).toBeTruthy();

    // Root switching is a real browse, not a client-side expansion.
    fireEvent.click(screen.getAllByTestId("folder-browser-root")[1]!);
    expect(await screen.findByText("project")).toBeTruthy();
    expect(screen.getAllByTestId("folder-browser-root")[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(browseCalls).toContain("/other");
  });

  it("falls back to the Host default root when the current cwd is not authorized", async () => {
    const browseCalls: string[] = [];
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") return json({ roots: ["/repo"], defaultCwd: "/repo" });
      const path = browsePath(url);
      browseCalls.push(path);
      return json({ path, parentPath: null, directories: [] });
    });
    mount("/outside/not-a-root");

    await waitFor(() => expect(browseCalls).toEqual(["/repo"]));
    expect(browseCalls).not.toContain("/outside/not-a-root");
  });

  it("selects the canonical browse path rather than the requested alias", async () => {
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") return json({ roots: ["/repo"], defaultCwd: "/repo" });
      if (browsePath(url) === "/repo/link") {
        return json({ path: "/repo/real", parentPath: "/repo", directories: [] });
      }
      return json({ error: "not found", code: "PATH_NOT_FOUND" }, 404);
    });
    const { onSelectAction } = mount("/repo/link");

    const confirm = screen.getByRole("button", { name: "Select folder" });
    expect(await screen.findByText("No subfolders here. You can select this folder.")).toBeTruthy();
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    expect(onSelectAction).toHaveBeenCalledWith("/repo/real");
  });

  it("distinguishes roots loading from browse loading and keeps confirm disabled until settled", async () => {
    const rootsResponse = deferred<Response>();
    const browseResponse = deferred<Response>();
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") return rootsResponse.promise;
      if (url.pathname === "/v1/cwd/browse") return browseResponse.promise;
      return json({ error: "not found" }, 404);
    });
    mount("/repo");

    const confirm = screen.getByRole("button", { name: "Select folder" }) as HTMLButtonElement;
    expect(screen.getByText("Loading folders…")).toBeTruthy();
    expect(confirm.disabled).toBe(true);

    await act(async () => {
      rootsResponse.resolve(json({ roots: ["/repo"], defaultCwd: "/repo" }));
      await Promise.resolve();
    });

    // Roots settled, but the current directory has not: still loading and
    // still not confirmable.
    expect(screen.getByText("Loading folders…")).toBeTruthy();
    expect(confirm.disabled).toBe(true);

    await act(async () => {
      browseResponse.resolve(json({ path: "/repo", parentPath: null, directories: ["src"] }));
      await Promise.resolve();
    });

    expect(await screen.findByText("src")).toBeTruthy();
    expect(confirm.disabled).toBe(false);
  });

  it("shows fixed roots-error copy (never the backend message) and retries", async () => {
    let rootsCalls = 0;
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") {
        rootsCalls += 1;
        if (rootsCalls === 1) {
          return json({ code: "BROWSE_FAILED", message: "raw /secret/path exploded" }, 500);
        }
        return json({ roots: ["/repo"], defaultCwd: "/repo" });
      }
      return json({ path: "/repo", parentPath: null, directories: ["src"] });
    });
    mount("/repo");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't load folders. Check the server connection and try again.");
    expect(document.body.textContent).not.toContain("/secret/path");
    const confirm = screen.getByRole("button", { name: "Select folder" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("src")).toBeTruthy();
    expect(rootsCalls).toBe(2);
  });

  it("shows fixed browse-error copy and retries the current path", async () => {
    let browseCalls = 0;
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") return json({ roots: ["/repo"], defaultCwd: "/repo" });
      browseCalls += 1;
      if (browseCalls === 1) {
        return json({ code: "PATH_FORBIDDEN", message: "denied /private" }, 403);
      }
      return json({ path: "/repo", parentPath: null, directories: ["src"] });
    });
    mount("/repo");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That folder isn't available to Pix.");
    expect(document.body.textContent).not.toContain("/private");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("src")).toBeTruthy();
    expect(browseCalls).toBe(2);
  });

  it("ignores a late response for a folder the user already navigated away from", async () => {
    const childResponse = deferred<Response>();
    stubFetch((url) => {
      if (url.pathname === "/v1/cwd/roots") return json({ roots: ["/repo"], defaultCwd: "/repo" });
      const path = browsePath(url);
      if (path === "/repo") return json({ path, parentPath: null, directories: ["child"] });
      if (path === "/repo/child") return childResponse.promise;
      return json({ error: "not found", code: "PATH_NOT_FOUND" }, 404);
    });
    mount("/repo");

    expect(await screen.findByText("child")).toBeTruthy();
    fireEvent.click(screen.getByTestId("folder-browser-directory"));

    // Return to the root before the child listing settles.
    fireEvent.click(screen.getAllByTestId("folder-browser-root")[0]!);
    expect(await screen.findByText("child")).toBeTruthy();

    await act(async () => {
      childResponse.resolve(json({ path: "/repo/child", parentPath: "/repo", directories: ["stale"] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The current observer stays on the root listing even after the late
    // child response settles.
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("child")).toBeTruthy();
  });
});
