import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { WorkspacePanel } from "./WorkspacePanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPanel(host: Partial<HostInfo>, props: { cwd?: string; open?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>{children}</CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  return render(
    <WorkspacePanel
      cwd={props.cwd}
      open={props.open ?? true}
      onClose={() => undefined}
    />,
    { wrapper: Wrapper },
  );
}

/** A fetch router keyed by op/pathname so tests assert exact endpoint behavior. */
function makeRouter() {
  const calls: { pathname: string; params: Record<string, string> }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://pix.local");
    const params = Object.fromEntries(url.searchParams.entries());
    calls.push({ pathname: url.pathname, params });
    if (url.pathname === "/v1/files" && params.op === "list") {
      return json({ path: params.path, entries: [{ name: "src", isDir: true, isSymlink: false }, { name: "a.ts", isDir: false, isSymlink: false }] });
    }
    if (url.pathname === "/v1/files" && params.op === "meta") {
      return json({ path: params.path, size: 12, modified: "2026-01-01T00:00:00.000Z", isDirectory: false, mime: "text/plain" });
    }
    if (url.pathname === "/v1/files" && params.op === "read") {
      return json({ content: "hello world", language: "typescript", size: 11 });
    }
    if (url.pathname === "/v1/git/status") {
      return json({ isGitRepository: true, repositoryRoot: params.cwd, files: [], additions: 0, deletions: 0 });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("WorkspacePanel", () => {
  let previous: typeof fetch;
  beforeEach(() => { previous = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = previous; });

  it("issues ZERO api requests when neither files nor git is negotiated", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const { container } = renderPanel({ mode: "local", capabilities: [] }, { cwd: "/proj" });
    expect(container.firstChild).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it("offers only the Files tab when only files is negotiated", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["files"] }, { cwd: "/proj" });
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Git" })).toBeNull();
    // Files list is requested for the project root.
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
  });

  it("offers only the Git tab when only git is negotiated", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["git"] }, { cwd: "/proj" });
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Git" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeTruthy());
  });

  it("switches between Files and Git tabs and stops idle queries", async () => {
    const { impl, calls } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["files", "git"] }, { cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Git" }));
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeTruthy());
    // Git status was queried exactly once for the cwd.
    expect(calls.filter((c) => c.pathname === "/v1/git/status")).toHaveLength(1);
  });

  it("renders nothing when closed", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const { container } = renderPanel({ mode: "local", capabilities: ["files"] }, { cwd: "/proj", open: false });
    expect(container.firstChild).toBeNull();
  });
});
